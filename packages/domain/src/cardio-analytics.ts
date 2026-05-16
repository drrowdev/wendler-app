/**
 * Cardio aggregations for the Analytics page.
 *
 * Pure functions over a `MinimalCardio` shape so the domain package stays
 * free of Dexie / `db-schema` value-imports. Mirrors the structure of
 * `analytics.ts` (strength) so charts on the page can share `BarChart` /
 * `StackedBarChart` primitives without per-domain plumbing.
 */

import { isoWeekKey } from './analytics';
import { isoDayOfWeek } from './runPlan';
import { weightedCardioMinutes } from './load';
import type { CardioModality, RunPlanSlot, RunPlannedKind } from './types';

export type { CardioModality };

export interface MinimalCardio {
  id: string;
  performedAt: string;
  modality: CardioModality;
  durationSec: number;
  distanceKm?: number;
  hrZoneSeconds?: number[];
  plannedKind?: RunPlannedKind;
}

export const CARDIO_MODALITIES: CardioModality[] = [
  'run',
  'bike',
  'swim',
  'row',
  'walk',
  'padel',
  'other',
];

export const CARDIO_MODALITY_COLORS: Record<CardioModality, string> = {
  run: '#0ea5e9',
  bike: '#3b82f6',
  swim: '#06b6d4',
  row: '#a855f7',
  walk: '#22c55e',
  padel: '#f59e0b',
  other: '#64748b',
};

/**
 * Canonical accent colors. Use these instead of literal hex strings so
 * that "strength violet" / "cardio sky" look the same on /analytics,
 * /calendar, /cardio, the Today page, KPI sparklines, calendar heatmap,
 * etc. Tailwind equivalents:
 *   STRENGTH_ACCENT = violet-500
 *   CARDIO_ACCENT   = sky-500
 *
 * Strength used to be blue-500 (#3b82f6) but that read as too similar to
 * the cardio sky on cards that put both side by side. Violet provides
 * clear hue separation while staying out of emerald's "done/success"
 * lane and amber's padel lane.
 */
export const STRENGTH_ACCENT = '#8b5cf6';
export const CARDIO_ACCENT = '#0ea5e9';

export interface CardioWeekPoint {
  /** ISO week key, e.g. "2026-W18". */
  bucket: string;
  /** Per-modality minutes. Sparse; missing keys = 0. */
  minutesByModality: Partial<Record<CardioModality, number>>;
  /** Per-modality kilometres. Sparse; missing keys = 0. */
  kmByModality: Partial<Record<CardioModality, number>>;
  totalMinutes: number;
  totalKm: number;
  sessions: number;
}

/**
 * Bucket cardio sessions by ISO week, splitting per modality. Only sessions
 * with positive duration are counted; distance is optional and falls through
 * as 0 when missing.
 */
export function weeklyCardio(sessions: MinimalCardio[]): CardioWeekPoint[] {
  const byWeek = new Map<string, CardioWeekPoint>();
  for (const c of sessions) {
    if (!c.durationSec || c.durationSec <= 0) continue;
    const wk = isoWeekKey(c.performedAt);
    const cur =
      byWeek.get(wk) ??
      ({
        bucket: wk,
        minutesByModality: {},
        kmByModality: {},
        totalMinutes: 0,
        totalKm: 0,
        sessions: 0,
      } satisfies CardioWeekPoint);
    const minutes = c.durationSec / 60;
    const km = c.distanceKm ?? 0;
    cur.minutesByModality[c.modality] =
      (cur.minutesByModality[c.modality] ?? 0) + minutes;
    cur.kmByModality[c.modality] = (cur.kmByModality[c.modality] ?? 0) + km;
    cur.totalMinutes += minutes;
    cur.totalKm += km;
    cur.sessions += 1;
    byWeek.set(wk, cur);
  }
  return [...byWeek.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

/**
 * Sum `hrZoneSeconds` across the supplied sessions. Returns a length-5 array
 * (Z1..Z5). Sessions without zone data contribute zero.
 */
export function aggregateHrZones(sessions: MinimalCardio[]): number[] {
  const totals = [0, 0, 0, 0, 0];
  for (const c of sessions) {
    const zones = c.hrZoneSeconds;
    if (!zones || zones.length === 0) continue;
    for (let i = 0; i < 5; i++) {
      totals[i]! += zones[i] ?? 0;
    }
  }
  return totals;
}

// ──────────────────────────────────────────────────────────────────────
// Cardio fatigue signal (suggester input)
// ──────────────────────────────────────────────────────────────────────

/**
 * Compares the trailing 7 days of HR-zone-weighted cardio minutes to a
 * 28-day rolling baseline. Returns a small integer the assistance suggester
 * uses to trim accessory volume when actual cardio load has spiked above
 * what the user's recent rhythm suggests.
 *
 * Returns:
 *   0   — no cut (delta below light threshold, or no baseline data yet)
 *   -1  — light cut (delta in [+30%, +60%))
 *   -2  — heavier cut (delta ≥ +60%)
 *
 * Why weighted minutes? They capture intensity, not just duration: a 60-min
 * tempo run carries 2× the cost of a 60-min easy run. Single scalar, one
 * source of truth (see `weightedCardioMinutes` in load.ts).
 *
 * Why 28-day baseline? Long enough to smooth a single hard week, short
 * enough that a sustained ramp (marathon prep) eventually shifts it. A
 * 14-day window over-reacts to noise; 28-day lags by ~2 weeks which is the
 * right shape — multi-week overreach builds visible delta, deliberate ramps
 * are absorbed.
 *
 * Caller is responsible for **suppressing** this signal during the deload
 * and taper phases: the assistance budget is already cut upstream there,
 * and stacking another cut would crater volume. The signal fires in
 * `normal` and `peak` phases (peak phase doesn't down-shift assistance, so
 * the cardio cut is doing fresh work — exactly when you need it most).
 */
export const CARDIO_FATIGUE_BASELINE_DAYS = 28;
export const CARDIO_FATIGUE_LIGHT_THRESHOLD = 0.30;
export const CARDIO_FATIGUE_HEAVY_THRESHOLD = 0.60;
/** Hard cap on prompt-side trim, surfaced in the prompt body. */
export const CARDIO_FATIGUE_MAX_TRIM_PCT = 0.20;

export type CardioFatigueShift = -2 | -1 | 0;

export interface CardioFatigueSignal {
  shift: CardioFatigueShift;
  /** Last-7-day weighted minutes. */
  recentWeightedMin: number;
  /** Average per-week weighted minutes across the trailing 28-day window (excluding the current week). */
  baselineWeightedMin: number;
  /** (recent - baseline) / baseline; null when baseline is 0 / undefined. */
  deltaPct: number | null;
  /**
   * Modality breakdown of the trailing 7-day weighted minutes, sorted by
   * share descending. Empty array when no recent cardio. Surfaced in the
   * prompt so the LLM can apply movement-overlap reasoning (e.g. running →
   * trim posterior-chain compounds first; cycling → trim quad/glute work).
   */
  recentModalityMix: Array<{ modality: CardioModality; weightedMin: number; sharePct: number }>;
}

export function computeCardioFatigueShift(
  sessions: ReadonlyArray<Pick<MinimalCardio, 'modality' | 'performedAt' | 'durationSec' | 'hrZoneSeconds'>>,
  now: Date = new Date(),
): CardioFatigueSignal {
  const nowMs = now.getTime();
  const dayMs = 86_400_000;
  const recentCutoff = nowMs - 7 * dayMs;
  const baselineCutoff = nowMs - (7 + CARDIO_FATIGUE_BASELINE_DAYS) * dayMs;

  const recent: Pick<MinimalCardio, 'modality' | 'durationSec' | 'hrZoneSeconds'>[] = [];
  const baseline: Pick<MinimalCardio, 'durationSec' | 'hrZoneSeconds'>[] = [];
  for (const s of sessions) {
    if (!s.durationSec || s.durationSec <= 0) continue;
    const t = new Date(s.performedAt).getTime();
    if (!Number.isFinite(t)) continue;
    if (t > nowMs) continue; // future-dated; ignore
    if (t >= recentCutoff) {
      recent.push(s);
    } else if (t >= baselineCutoff) {
      baseline.push(s);
    }
  }

  const recentWeightedMin = weightedCardioMinutes(recent);
  const baselineTotal = weightedCardioMinutes(baseline);
  // Convert the 28-day baseline total to a per-week average so the comparison
  // is week-vs-week.
  const baselineWeightedMin = baselineTotal * (7 / CARDIO_FATIGUE_BASELINE_DAYS);

  // Per-modality breakdown of the trailing 7-day weighted minutes. Used by
  // the prompt to surface "dominant modality: run (87%)" so the LLM can pick
  // overlap-correct trim targets without a hardcoded movement list.
  const byModality = new Map<CardioModality, number>();
  for (const s of recent) {
    const w = weightedCardioMinutes([s]);
    byModality.set(s.modality, (byModality.get(s.modality) ?? 0) + w);
  }
  const recentModalityMix =
    recentWeightedMin > 0
      ? Array.from(byModality.entries())
          .map(([modality, weightedMin]) => ({
            modality,
            weightedMin,
            sharePct: (weightedMin / recentWeightedMin) * 100,
          }))
          .sort((a, b) => b.weightedMin - a.weightedMin)
      : [];

  if (baselineWeightedMin <= 0) {
    return { shift: 0, recentWeightedMin, baselineWeightedMin, deltaPct: null, recentModalityMix };
  }

  const deltaPct = (recentWeightedMin - baselineWeightedMin) / baselineWeightedMin;
  let shift: CardioFatigueShift = 0;
  if (deltaPct >= CARDIO_FATIGUE_HEAVY_THRESHOLD) shift = -2;
  else if (deltaPct >= CARDIO_FATIGUE_LIGHT_THRESHOLD) shift = -1;
  return { shift, recentWeightedMin, baselineWeightedMin, deltaPct, recentModalityMix };
}

// ──────────────────────────────────────────────────────────────────────
// Per-session intensity tagging (polarized model)
// ──────────────────────────────────────────────────────────────────────

/**
 * Polarized-model intensity tag for a single cardio session.
 *
 *  - `easy`      — predominantly Z1+Z2; the bread-and-butter aerobic stuff
 *                  that the 80/20 rule wants 80% of your training to be.
 *  - `threshold` — meaningful Z3 (tempo / sweet spot) without crossing
 *                  into hard intervals.
 *  - `hard`      — significant Z4+Z5 (LT, VO2max, intervals).
 *  - `mixed`     — long aerobic with a non-trivial hard component, e.g.
 *                  a long ride that includes some surges.
 *  - `recovery`  — almost entirely Z1; walk / cool-down / commute-style
 *                  effort that's below the productive aerobic range.
 *  - `none`      — no HR zone data, or session too short to classify
 *                  (default <10 min).
 */
export type IntensityTag = 'easy' | 'threshold' | 'hard' | 'mixed' | 'recovery' | 'none';

export interface IntensityClassification {
  tag: IntensityTag;
  /** Z1+Z2 share of zone time, 0..1. */
  easyShare: number;
  /** Z3 share of zone time, 0..1. */
  greyShare: number;
  /** Z4+Z5 share of zone time, 0..1. */
  hardShare: number;
}

const NONE: IntensityClassification = {
  tag: 'none',
  easyShare: 0,
  greyShare: 0,
  hardShare: 0,
};

/**
 * Classify a single cardio session into a polarized-model intensity tag.
 * Pure rule over `hrZoneSeconds`; runs at render time on data we already
 * have, no extra Strava calls. Re-tunes automatically if the user edits
 * their LTHR (zone borders shift → time-in-zone shifts → tag re-derives).
 *
 * Defaults (tweak via opts):
 *   - `minSec` 600 — sessions under 10 min are too noisy, returns 'none'.
 *   - `recoveryZ1Share` 0.70 — Z1 alone over 70% → 'recovery'.
 *   - `easyShare` 0.80 + `hardShare` 0.10 — easy if mostly Z1+Z2 with
 *     little hard work.
 *   - `hardShare` 0.20 — any 20%+ in Z4+Z5 → 'hard' (intervals or test).
 *   - `greyShare` 0.25 — meaningful Z3 without much hard work → 'threshold'.
 */
export function classifyIntensity(
  session: { hrZoneSeconds?: number[]; durationSec?: number },
  opts?: {
    minSec?: number;
    recoveryZ1Share?: number;
    easyShareMin?: number;
    easyHardMax?: number;
    hardShareMin?: number;
    greyShareMin?: number;
  },
): IntensityClassification {
  const minSec = opts?.minSec ?? 600;
  const recoveryZ1Share = opts?.recoveryZ1Share ?? 0.7;
  const easyShareMin = opts?.easyShareMin ?? 0.8;
  const easyHardMax = opts?.easyHardMax ?? 0.1;
  const hardShareMin = opts?.hardShareMin ?? 0.2;
  const greyShareMin = opts?.greyShareMin ?? 0.25;

  const zones = session.hrZoneSeconds;
  if (!zones || zones.length < 5) return NONE;
  const total = zones.reduce((a, b) => a + (b ?? 0), 0);
  if (total <= 0) return NONE;
  // Use total zone time when available; fall back to durationSec.
  const reference = session.durationSec && session.durationSec > 0 ? session.durationSec : total;
  if (reference < minSec) return NONE;

  const z1 = (zones[0] ?? 0) / total;
  const z2 = (zones[1] ?? 0) / total;
  const z3 = (zones[2] ?? 0) / total;
  const z4 = (zones[3] ?? 0) / total;
  const z5 = (zones[4] ?? 0) / total;
  const easyShare = z1 + z2;
  const greyShare = z3;
  const hardShare = z4 + z5;

  let tag: IntensityTag;
  if (hardShare >= hardShareMin) {
    tag = 'hard';
  } else if (z1 >= recoveryZ1Share) {
    tag = 'recovery';
  } else if (easyShare >= easyShareMin && hardShare < easyHardMax) {
    tag = 'easy';
  } else if (greyShare >= greyShareMin) {
    tag = 'threshold';
  } else {
    tag = 'mixed';
  }
  return { tag, easyShare, greyShare, hardShare };
}

/** Short human label for an intensity tag (UI badge). */
export function intensityLabel(tag: IntensityTag): string {
  switch (tag) {
    case 'easy':
      return 'Easy';
    case 'threshold':
      return 'Threshold';
    case 'hard':
      return 'Hard';
    case 'mixed':
      return 'Mixed';
    case 'recovery':
      return 'Recovery';
    default:
      return '';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Aggregate polarization summary (window-level)
// ──────────────────────────────────────────────────────────────────────

/** A miss reason for the polarization verdict, in priority order. */
export type PolarizedVerdictKind =
  | 'on-target'
  | 'hard-too-high'
  | 'grey-too-high'
  | 'easy-too-low'
  | 'no-data';

export interface PolarizedSummary {
  /** Total seconds across Z1..Z5 in the window. */
  totalSec: number;
  /** Z1+Z2 share of total, 0..1. */
  easyShare: number;
  /** Z3 share of total, 0..1. */
  greyShare: number;
  /** Z4+Z5 share of total, 0..1. */
  hardShare: number;
  /** Bucket-vs-target evaluation. */
  easy: { share: number; target: number; status: 'low' | 'ok' | 'high' };
  grey: { share: number; target: number; status: 'ok' | 'high' };
  hard: { share: number; targetMin: number; targetMax: number; status: 'low' | 'ok' | 'high' };
  /** Single most-actionable verdict line. */
  verdict: PolarizedVerdictKind;
  /** Pre-rendered verdict text suitable for the UI. */
  verdictText: string;
}

const DEFAULT_TARGETS = {
  /** Lower bound on Easy (Z1+Z2) share. */
  easyMin: 0.8,
  /** Upper bound on Grey (Z3) share. */
  greyMax: 0.1,
  /** Hard (Z4+Z5) share target band. */
  hardMin: 0.1,
  hardMax: 0.25,
  /**
   * Lower band for the verdict line. Aligned with `easyMin` (0.80) so the
   * "Easy share is below 80%" verdict fires whenever the per-bucket arrow
   * marks easy as 'low'. Keeping the verdict at a looser band (e.g. 0.70)
   * would produce a contradictory card in the 70–80% window — bucket
   * arrow says "Easy 75% ↓" amber and verdict says "On target" emerald
   * at the same time. One threshold, one message.
   */
  easyVerdictMin: 0.8,
  /** Grey share that triggers a verdict callout (vs. the strict greyMax). */
  greyVerdictMax: 0.15,
};

/**
 * Roll a length-5 zone-seconds array into a polarized-model summary
 * (Easy / Grey / Hard) with per-bucket vs-target evaluation and a single
 * actionable verdict line.
 *
 * Targets default to the standard polarized prescription:
 *   - Easy (Z1+Z2)  ≥ 80%
 *   - Grey (Z3)     ≤ 10%
 *   - Hard (Z4+Z5)  10..25%
 *
 * Verdict priority (only one fires):
 *   1. hard-too-high  — risk of over-reach
 *   2. grey-too-high  — classic "junk miles" pattern
 *   3. easy-too-low   — not enough aerobic base
 *   4. on-target      — solid distribution
 */
export function polarizedSummary(
  zoneSeconds: number[],
  opts?: Partial<typeof DEFAULT_TARGETS>,
): PolarizedSummary {
  const t = { ...DEFAULT_TARGETS, ...(opts ?? {}) };
  const z1 = zoneSeconds[0] ?? 0;
  const z2 = zoneSeconds[1] ?? 0;
  const z3 = zoneSeconds[2] ?? 0;
  const z4 = zoneSeconds[3] ?? 0;
  const z5 = zoneSeconds[4] ?? 0;
  const totalSec = z1 + z2 + z3 + z4 + z5;
  if (totalSec <= 0) {
    return {
      totalSec: 0,
      easyShare: 0,
      greyShare: 0,
      hardShare: 0,
      easy: { share: 0, target: t.easyMin, status: 'low' },
      grey: { share: 0, target: t.greyMax, status: 'ok' },
      hard: { share: 0, targetMin: t.hardMin, targetMax: t.hardMax, status: 'low' },
      verdict: 'no-data',
      verdictText: 'No HR-zone data in this window yet.',
    };
  }
  const easyShare = (z1 + z2) / totalSec;
  const greyShare = z3 / totalSec;
  const hardShare = (z4 + z5) / totalSec;
  const easyStatus: 'low' | 'ok' | 'high' = easyShare < t.easyMin ? 'low' : 'ok';
  const greyStatus: 'ok' | 'high' = greyShare > t.greyMax ? 'high' : 'ok';
  const hardStatus: 'low' | 'ok' | 'high' =
    hardShare < t.hardMin ? 'low' : hardShare > t.hardMax ? 'high' : 'ok';

  let verdict: PolarizedVerdictKind;
  let verdictText: string;
  if (hardShare > t.hardMax) {
    verdict = 'hard-too-high';
    verdictText =
      `Hard share above ${pct(t.hardMax)} — risk of over-reach; ` +
      'consider an easier week.';
  } else if (greyShare > t.greyVerdictMax) {
    verdict = 'grey-too-high';
    verdictText =
      'Too much time in Z3 — push easy days easier and hard days harder.';
  } else if (easyShare < t.easyVerdictMin) {
    verdict = 'easy-too-low';
    verdictText =
      `Easy share is below ${pct(t.easyMin)} — add more truly easy ` +
      '(Z1+Z2) volume, or back off Z3/Z4 if it\u2019s crowding out base mileage.';
  } else {
    verdict = 'on-target';
    verdictText = 'On target — solid 80/20 distribution.';
  }

  return {
    totalSec,
    easyShare,
    greyShare,
    hardShare,
    easy: { share: easyShare, target: t.easyMin, status: easyStatus },
    grey: { share: greyShare, target: t.greyMax, status: greyStatus },
    hard: { share: hardShare, targetMin: t.hardMin, targetMax: t.hardMax, status: hardStatus },
    verdict,
    verdictText,
  };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export interface RunPlanAdherenceRow {
  dayOfWeek: number; // 0=Mon … 6=Sun
  plannedKind: RunPlannedKind;
  /** Number of weeks in the window where this slot was satisfied. */
  hitWeeks: number;
  /** Total weeks in the window. */
  totalWeeks: number;
  /** hitWeeks / totalWeeks (0..1). */
  rate: number;
}

/**
 * Per-slot run-plan adherence over the last `weeks` ISO weeks. A slot is
 * "hit" in a given week when at least one logged run on that weekday carries
 * a `plannedKind` matching the slot. Rest slots are skipped.
 *
 * The aggregator is intentionally lenient: an exact match counts; a
 * manually-tagged match (planMatch === 'manual') also counts because the
 * user has confirmed the run filled the slot.
 */
export function runPlanAdherence(
  sessions: MinimalCardio[],
  slots: RunPlanSlot[] | null | undefined,
  now: Date = new Date(),
  weeks = 8,
): RunPlanAdherenceRow[] {
  if (!slots || slots.length === 0) return [];

  const cutoff = new Date(now.getTime() - weeks * 7 * 86400_000);
  // Bucket runs by ISO week + day-of-week → set of plannedKinds present.
  const seen = new Map<string, Set<RunPlannedKind>>();
  for (const c of sessions) {
    if (c.modality !== 'run') continue;
    if (!c.plannedKind) continue;
    const performed = new Date(c.performedAt);
    if (performed < cutoff) continue;
    const wk = isoWeekKey(c.performedAt);
    const dow = isoDayOfWeek(performed);
    const key = `${wk}|${dow}`;
    const set = seen.get(key) ?? new Set<RunPlannedKind>();
    set.add(c.plannedKind);
    seen.set(key, set);
  }

  // Enumerate the last `weeks` ISO weeks present in the window so we have
  // a stable denominator even when a week had zero runs.
  const weekKeys = new Set<string>();
  for (let i = 0; i < weeks; i++) {
    const d = new Date(now.getTime() - i * 7 * 86400_000);
    weekKeys.add(isoWeekKey(d.toISOString()));
  }
  const totalWeeks = weekKeys.size;

  const rows: RunPlanAdherenceRow[] = [];
  for (const slot of slots) {
    if (slot.kind === 'rest') continue;
    let hits = 0;
    for (const wk of weekKeys) {
      const set = seen.get(`${wk}|${slot.dayOfWeek}`);
      if (set && set.has(slot.kind)) hits += 1;
    }
    rows.push({
      dayOfWeek: slot.dayOfWeek,
      plannedKind: slot.kind,
      hitWeeks: hits,
      totalWeeks,
      rate: totalWeeks > 0 ? hits / totalWeeks : 0,
    });
  }
  rows.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  return rows;
}

/**
 * Build a per-day timeline (yyyy-mm-dd → flags) for the last `days` days.
 * Used by the cross-domain training calendar card. Intentionally generic over
 * its inputs so the page can pass strength `performedAt` lists alongside
 * cardio sessions without a Dexie dependency here.
 */
export interface CalendarDay {
  /** yyyy-mm-dd in the user's local timezone. */
  date: string;
  strength: boolean;
  cardio: boolean;
}

export function trainingCalendar(
  strengthDates: string[],
  cardioDates: string[],
  now: Date = new Date(),
  days = 84,
): CalendarDay[] {
  const local = (iso: string) => {
    const d = new Date(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };
  const strength = new Set(strengthDates.map(local));
  const cardio = new Set(cardioDates.map(local));

  const out: CalendarDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    out.push({
      date: key,
      strength: strength.has(key),
      cardio: cardio.has(key),
    });
  }
  return out;
}
