/**
 * Cross-domain load + recovery analysis (v0.6.0).
 *
 * No external dependencies — operates on minimal record shapes so it can be
 * unit-tested in isolation and called from both the web client and (future)
 * server-side digest jobs.
 */

export interface LoadSet {
  performedAt: string;
  weightKg: number;
  reps: number;
  rpe?: number;
  /**
   * Snapshot of the lift's training max at the time the set was performed.
   * When present, the set's intensity factor (weight / TM) is used to weight
   * its tonnage contribution. Sets without a TM snapshot are treated as
   * accessory work and use a flat fallback IF (see ASSISTANCE_IF).
   */
  trainingMaxKgAtTime?: number;
  skipped?: boolean;
  deletedAt?: string;
}

export interface LoadCardio {
  performedAt: string;
  durationSec: number;
  rpe?: number;
  /**
   * Optional Strava-style HR zone seconds, indexed Z1..Z5 (length 5).
   * When present, used in place of duration to weight stress contribution.
   */
  hrZoneSeconds?: number[];
  /** Optional Strava suffer / relative effort score. */
  sufferScore?: number;
}

export interface LoadRecovery {
  /** YYYY-MM-DD */
  id: string;
  sleepHours?: number;
  hrv?: number;
  fatigue?: number;
  soreness?: number;
}

export interface WeeklyLoad {
  /** ISO date of Monday (week start). */
  weekStart: string;
  /** Sum of weight × reps across all completed strength sets, kg. */
  strengthTonnageKg: number;
  /**
   * Tonnage contributed by sets that had a TM snapshot (warmups + main +
   * supplemental work performed against a Wendler training max). Subset of
   * strengthTonnageKg.
   */
  tonnageMainKg: number;
  /**
   * Tonnage contributed by sets without a TM snapshot — accessory /
   * assistance work like chins, dumbbell rows, dips. Subset of
   * strengthTonnageKg.
   */
  tonnageAssistanceKg: number;
  /**
   * Intensity-weighted tonnage. For sets with a TM snapshot:
   *   contribution = reps × weight × (weight / TM)²
   * Squared IF makes top sets dominate while warmups effectively zero out.
   * Sets without a TM use a flat fallback IF (ASSISTANCE_IF) so accessory
   * volume doesn't disappear entirely. This is what the stress recipe uses.
   */
  weightedTonnageKg: number;
  /** Sum of cardio durations, minutes. */
  cardioMinutes: number;
  /**
   * HR-zone-weighted minutes contributed by Strava strength HR enrichments
   * this week. Folded into the stress score (capped at 10) but kept
   * separate from `cardioMinutes` so the cardio volume chart and the
   * polarized 80/10/10 distribution stay cardio-only.
   */
  strengthHrWeightedMin: number;
  /** Number of distinct days with at least one logged session. */
  trainingDays: number;
  /** Average RPE across completed sets (undefined if none reported). */
  avgRpe?: number;
  /** Average sleep hours over the week from recovery rows (if any). */
  avgSleep?: number;
  /** Mean fatigue score 1-10. */
  avgFatigue?: number;
  /**
   * Composite stress score, 0–100. Transparent recipe:
   *   tonnage   contribution: min(50, weightedTonnageKg / 100)         // IF²-weighted, not raw
   *   cardio    contribution: min(cardioCap, weightedCardioMinutes / 15) // HR-zone weighted; cap is 30 by default or dynamic (see dynamicCardioCap)
   *   strengthHR contribution: min(10, strengthHrWeightedMin / 15)     // Strava strength-HR enrichments (kept out of cardioMinutes)
   *   rpe       contribution: max(0, (avgRpe - 6) * 5)                 // when reported
   *   recovery  penalty:      max(0, (fatigue - 5) * 2) - max(0, (sleep - 7) * 2)
   * Higher = more accumulated stress; 80+ suggests pulling back.
   */
  stressScore: number;
}

function isoMonday(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // back to Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10);
}

// Parse an ISO timestamp normalising to UTC. Legacy rows that lacked a
// timezone marker would otherwise be interpreted as local time and drift
// across week boundaries unpredictably between devices.
function parseIsoUtc(iso: string): number {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) return new Date(iso).getTime();
  return new Date(iso + 'Z').getTime();
}

function inWeek(iso: string, weekStart: string): boolean {
  const ws = new Date(weekStart + 'T00:00:00Z').getTime();
  const we = ws + 7 * 86400000;
  const t = parseIsoUtc(iso);
  return t >= ws && t < we;
}

/**
 * Flat intensity factor used for sets without a TM snapshot (accessory /
 * assistance work). 0.55 sits between a typical warmup and a top set —
 * generous enough that 5×10 chinups doesn't disappear, conservative enough
 * that it can't dominate a tonnage-driven score.
 */
const ASSISTANCE_IF = 0.55;

/**
 * Per-set intensity factor. For sets with a TM snapshot, weight/TM clamped
 * to [0, 1.5] (over-1.0 sets can happen on AMRAP rep PRs once TM lags; we
 * still want them to register). Falls back to ASSISTANCE_IF when TM is
 * unknown.
 */
function setIntensityFactor(s: LoadSet): number {
  if (s.trainingMaxKgAtTime && s.trainingMaxKgAtTime > 0) {
    const raw = s.weightKg / s.trainingMaxKgAtTime;
    return Math.max(0, Math.min(1.5, raw));
  }
  return ASSISTANCE_IF;
}

/**
 * Compute the **effective load** in kilograms for a set, factoring in
 * bodyweight when the movement is bodyweight-loaded (pull-up, dip, push-up,
 * step-up, ring row, etc. — see `Movement.externallyLoadable` plus the
 * `equipment === 'bodyweight'` flag in db-schema).
 *
 *   - For a regular barbell/dumbbell set: returns `weightKg` unchanged.
 *   - For an unloaded bodyweight set: returns `bodyweightKg` if available,
 *     else `weightKg` (which is typically 0 or the user's manual entry).
 *   - For a loaded bodyweight set (vest/belt): returns `weightKg + bodyweightKg`
 *     so the e1RM math sees the real systemic load — a Pull-Up + 20kg @ 80kg BW
 *     is a 100kg lift, not a 20kg one.
 *
 * Pure function so it can be called from analytics, e1rm.ts, the prompt
 * builder, etc. — wherever the "real" load matters. Returns the raw
 * `weightKg` when `bodyweightKg` is not provided so existing analytics that
 * don't yet have bodyweight context degrade gracefully.
 */
export interface EffectiveLoadInput {
  /** The set's stored weight (vest/belt load for BW movements, total bar load otherwise). */
  weightKg: number;
  /** The user's bodyweight on the date the set was performed. Optional. */
  bodyweightKg?: number;
  /** Whether the movement is a bodyweight base (push-up, pull-up, etc.). */
  isBodyweight: boolean;
  /** Whether the movement carries the `externallyLoadable` tag. */
  isExternallyLoadable: boolean;
}

export function effectiveLoadKg(input: EffectiveLoadInput): number {
  const { weightKg, bodyweightKg, isBodyweight, isExternallyLoadable } = input;
  if (!isBodyweight) return weightKg;
  if (bodyweightKg == null || bodyweightKg <= 0) return weightKg;
  if (isExternallyLoadable) {
    // External load was logged as `weightKg`; add bodyweight for the real
    // systemic load. A user logging "0 kg" on a loaded pull-up still gets
    // their bodyweight credited (unloaded set).
    return weightKg + bodyweightKg;
  }
  // Bodyweight-only movement (no external load possible — pistol squat,
  // muscle-up, plank). `weightKg` is typically 0 for these; if the user
  // logged something anyway, treat as ADDITIONAL load (some users wear a
  // vest even on non-loadable movements). Default to bodyweight only.
  return weightKg > 0 ? weightKg + bodyweightKg : bodyweightKg;
}

/**
 * HR-zone-weighted cardio minutes (used when streams available):
 *   Z1 × 0.5, Z2 × 1.0, Z3 × 2.0, Z4 × 4.0, Z5 × 6.0 (per minute)
 * Edwards/Lucia-style: roughly exponential — Z5 is dramatically more
 * costly than Z3, not a flat linear ramp. Falls back to plain duration
 * when no zones reported. Exported so other modules (e.g. the suggester
 * cardio-fatigue signal) share one source of truth for the formula.
 */
export const CARDIO_ZONE_WEIGHTS = [0.5, 1.0, 2.0, 4.0, 6.0];

export function weightedCardioMinutes(items: ReadonlyArray<Pick<LoadCardio, 'durationSec' | 'hrZoneSeconds'>>): number {
  return items.reduce((acc, c) => {
    if (c.hrZoneSeconds && c.hrZoneSeconds.length >= 5) {
      let m = 0;
      for (let i = 0; i < 5; i += 1) {
        m += ((c.hrZoneSeconds[i] ?? 0) / 60) * (CARDIO_ZONE_WEIGHTS[i] ?? 1);
      }
      return acc + m;
    }
    return acc + c.durationSec / 60;
  }, 0);
}

export interface WeeklyLoadOptions {
  /**
   * Maximum cardio contribution to the stress score this week. Defaults to 30
   * (the historical static cap). Page code can pass a higher cap derived from
   * the trailing 6-week mean — see `dynamicCardioCap`.
   */
  cardioCap?: number;
  /**
   * Optional Strava strength-HR enrichments. Each one contributes HR-zone-
   * weighted minutes to a dedicated stress component (capped at 10). Kept
   * out of `cardioMinutes` and the polarized HR distribution so endurance
   * analytics stay cardio-only. Pass `[]` or omit to disable.
   */
  strengthHrEnrichments?: LoadCardio[];
}

export function weeklyLoad(
  weekStart: string,
  sets: LoadSet[],
  cardio: LoadCardio[],
  recovery: LoadRecovery[],
  options?: WeeklyLoadOptions,
): WeeklyLoad {
  const wkSets = sets.filter(
    (s) => !s.deletedAt && !s.skipped && inWeek(s.performedAt, weekStart),
  );
  const wkCardio = cardio.filter((c) => inWeek(c.performedAt, weekStart));
  const wkStrengthHr = (options?.strengthHrEnrichments ?? []).filter((c) =>
    inWeek(c.performedAt, weekStart),
  );
  const wkRecovery = recovery.filter((r) =>
    inWeek(r.id + 'T12:00:00Z', weekStart),
  );

  const strengthTonnageKg = wkSets.reduce((acc, s) => acc + s.weightKg * s.reps, 0);
  const tonnageMainKg = wkSets.reduce(
    (acc, s) =>
      acc +
      (s.trainingMaxKgAtTime && s.trainingMaxKgAtTime > 0 ? s.weightKg * s.reps : 0),
    0,
  );
  const tonnageAssistanceKg = strengthTonnageKg - tonnageMainKg;
  const weightedTonnageKg = wkSets.reduce((acc, s) => {
    const if_ = setIntensityFactor(s);
    return acc + s.weightKg * s.reps * if_ * if_;
  }, 0);
  const cardioMinutes = wkCardio.reduce((acc, c) => acc + c.durationSec, 0) / 60;
  const weightedMin = weightedCardioMinutes(wkCardio);
  const strengthHrWeightedMin = weightedCardioMinutes(wkStrengthHr);
  const cardioCap = options?.cardioCap ?? 30;

  const days = new Set<string>();
  for (const s of wkSets) days.add(s.performedAt.slice(0, 10));
  for (const c of wkCardio) days.add(c.performedAt.slice(0, 10));
  const trainingDays = days.size;

  const rpes = wkSets.map((s) => s.rpe).filter((r): r is number => typeof r === 'number');
  const avgRpe = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : undefined;

  const sleeps = wkRecovery.map((r) => r.sleepHours).filter((v): v is number => typeof v === 'number');
  const avgSleep = sleeps.length ? sleeps.reduce((a, b) => a + b, 0) / sleeps.length : undefined;

  const fatigues = wkRecovery.map((r) => r.fatigue).filter((v): v is number => typeof v === 'number');
  const avgFatigue = fatigues.length ? fatigues.reduce((a, b) => a + b, 0) / fatigues.length : undefined;

  let score = 0;
  // Intensity-weighted tonnage: a 5×5 @ TM%85 contributes far more than 5×20
  // @ TM%30 even at the same raw kg. Divisor halved (vs raw 200) to keep
  // typical week scores in the same ballpark after the IF² shrink.
  score += Math.min(50, weightedTonnageKg / 100);
  // Cardio cap defaults to 30 but can be raised by `dynamicCardioCap` once
  // the user has 6+ weeks of cardio history (so a sustained endurance phase
  // doesn't permanently flatten its own contribution).
  score += Math.min(cardioCap, weightedMin / 15);
  // Strength HR contribution: capped at 10 so it can't dominate the score
  // even on a week of brutal BBB sessions. Reflects the cardiovascular cost
  // captured by the HR monitor on top of the existing tonnage component.
  score += Math.min(10, strengthHrWeightedMin / 15);
  if (avgRpe !== undefined) score += Math.max(0, (avgRpe - 6) * 5);
  if (avgFatigue !== undefined) score += Math.max(0, (avgFatigue - 5) * 2);
  if (avgSleep !== undefined) score -= Math.max(0, (avgSleep - 7) * 2);
  score = Math.max(0, Math.min(100, score));

  return {
    weekStart,
    strengthTonnageKg,
    tonnageMainKg,
    tonnageAssistanceKg,
    weightedTonnageKg,
    cardioMinutes,
    strengthHrWeightedMin,
    trainingDays,
    avgRpe,
    avgSleep,
    avgFatigue,
    stressScore: Math.round(score),
  };
}

export function currentWeekStart(now: Date = new Date()): string {
  return isoMonday(now);
}

/**
 * Return `count` Monday-anchored ISO date strings ending at the **current**
 * week (the Monday of `now`'s week is the last entry). Misleading name kept
 * for backward compat; prefer `recentWeekStartsIncludingCurrent` in new code.
 *
 * Example: `previousWeekStarts(May 14 2026, 4)` →
 *   `['2026-04-27', '2026-05-04', '2026-05-11', '2026-05-13'? no — '2026-05-11']`
 * Actually: the Mondays of the last 4 weeks, including this week.
 *
 * @deprecated Use `recentWeekStartsIncludingCurrent` — the original name
 * suggests "weeks strictly before `now`" which is the opposite of what
 * this returns.
 */
export function previousWeekStarts(now: Date = new Date(), count: number): string[] {
  return recentWeekStartsIncludingCurrent(now, count);
}

/**
 * Return `count` Monday-anchored ISO date strings, the most recent of which
 * is the Monday of the week containing `now`. Order is oldest-first.
 */
export function recentWeekStartsIncludingCurrent(
  now: Date = new Date(),
  count: number,
): string[] {
  const out: string[] = [];
  const monday = new Date(isoMonday(now) + 'T00:00:00Z');
  for (let i = 0; i < count; i += 1) {
    const d = new Date(monday.getTime() - i * 7 * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}

/**
 * Return `count` Monday-anchored ISO date strings for the `count` weeks
 * STRICTLY BEFORE `now`'s week. Order is oldest-first. Use this when you
 * genuinely want "the prior N weeks, not including this one" (e.g. for
 * computing a baseline that excludes the in-progress week).
 */
export function priorWeekStarts(now: Date = new Date(), count: number): string[] {
  const out: string[] = [];
  const monday = new Date(isoMonday(now) + 'T00:00:00Z');
  for (let i = 1; i <= count; i += 1) {
    const d = new Date(monday.getTime() - i * 7 * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Session-level signal: consecutive high-effort streak
// ---------------------------------------------------------------------------

/**
 * Group sets into sessions based on time proximity. A session is a contiguous
 * run of sets where each is within `gapMs` of the previous (default 18h —
 * comfortably covers same-day work, splits across separate training days).
 * Returns sessions oldest-first.
 */
function groupSetsIntoSessions(sets: LoadSet[], gapMs: number): LoadSet[][] {
  const live = sets.filter((s) => !s.deletedAt && !s.skipped);
  const sorted = [...live].sort((a, b) =>
    a.performedAt < b.performedAt ? -1 : a.performedAt > b.performedAt ? 1 : 0,
  );
  const sessions: LoadSet[][] = [];
  for (const s of sorted) {
    const last = sessions[sessions.length - 1];
    const lastTime = last ? new Date(last[last.length - 1]!.performedAt).getTime() : 0;
    const t = new Date(s.performedAt).getTime();
    if (last && t - lastTime <= gapMs) {
      last.push(s);
    } else {
      sessions.push([s]);
    }
  }
  return sessions;
}

/**
 * Longest tail run of sessions that count as "high effort", measured by
 * either:
 *   - the **average RPE across non-warmup sets** in the session ≥ a soft
 *     threshold (default 8.0), OR
 *   - **3 or more individual sets at RPE ≥ `threshold`** (default 8.5)
 *
 * Counts backward from the most recent session. The combined rule captures
 * "the whole session was a grind" or "many sets were brutal" without
 * being tripped by a single heavy AMRAP top set surrounded by easy
 * supplemental/assistance work (Wendler's normal shape).
 *
 * Returns 0 when no sets are provided or RPE is never reported.
 */
export function consecutiveHighEffortStreak(
  sets: LoadSet[],
  threshold = 8.5,
  gapMs = 18 * 3600 * 1000,
): number {
  const sessions = groupSetsIntoSessions(sets, gapMs);
  // The session-average threshold sits 0.5 below the per-set threshold:
  // a session where the typical set is RPE 8 is hard; one outlier set at
  // 9 surrounded by 6s and 7s is not.
  const sessionAvgThreshold = threshold - 0.5;
  const hardSetMinCount = 3;
  let streak = 0;
  // Limit how many consecutive no-RPE sessions we'll skip over before
  // giving up. Avoids letting an extended layoff or Strava-imported set
  // ride atop an ancient hard streak.
  let consecutiveSkips = 0;
  const MAX_SKIPS = 1;
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    // Use working RPEs only; warmups rarely carry an RPE in practice but
    // any future schema change that defaults warmups should not silently
    // pull the session average down.
    const work = (sessions[i] as Array<LoadSet & { kind?: string }>).filter(
      (s) => s.kind !== 'warmup',
    );
    const rpes = work
      .map((s) => s.rpe)
      .filter((r): r is number => typeof r === 'number');
    if (rpes.length === 0) {
      // No RPE recorded for this session — neither confirms nor breaks the
      // streak. Skip a bounded number of times so a single unlogged session
      // doesn't erase real history, then stop walking back.
      consecutiveSkips += 1;
      if (consecutiveSkips > MAX_SKIPS) break;
      continue;
    }
    consecutiveSkips = 0;
    const avgRpe = rpes.reduce((a, b) => a + b, 0) / rpes.length;
    const hardSetCount = rpes.filter((r) => r >= threshold).length;
    const isHighEffort = avgRpe >= sessionAvgThreshold || hardSetCount >= hardSetMinCount;
    if (isHighEffort) streak += 1;
    else break;
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Rolling baseline (personalises stress/RPE thresholds)
// ---------------------------------------------------------------------------

export interface LoadBaseline {
  /** Number of trained weeks contributing to the baseline. */
  weeks: number;
  /** Mean weekly stressScore over the baseline window. */
  meanStress: number;
  /**
   * Sample standard deviation of weekly stressScore (Bessel-corrected),
   * floored at STRESS_SD_FLOOR so 2–3-week baselines don't produce an
   * unrealistically tight z-distribution that classes every new week as
   * an outlier.
   */
  sdStress: number;
  /** Mean avgRpe across baseline weeks where RPE was reported. */
  meanRpe?: number;
  /** Sample SD of avgRpe across baseline weeks where RPE was reported. */
  sdRpe?: number;
}

const STRESS_SD_FLOOR = 5;
const RPE_SD_FLOOR = 0.3;

/**
 * Build a personal baseline from a list of weekly summaries (typically the
 * 4 weeks immediately preceding the week being evaluated). Weeks with no
 * training are excluded so a recent layoff doesn't artificially deflate
 * the baseline. Returns `weeks: 0` when there's nothing to baseline against.
 *
 * SD computed with Bessel correction (N-1 denominator) because the 4 baseline
 * weeks are a *sample* of the user's long-run distribution, not the whole
 * population. With N=2 a population-SD denominator returns ~½ the true
 * spread, making the z-test in `deloadSuggestion` over-reject (every week
 * looks like an outlier). Floors prevent zero-variance baselines from
 * dividing by ~0 when all weeks happen to share the same stress score.
 */
export function rollingBaseline(weeks: WeeklyLoad[]): LoadBaseline {
  const trained = weeks.filter(
    (w) => w.stressScore > 0 || w.strengthTonnageKg > 0 || w.cardioMinutes > 0,
  );
  if (trained.length === 0) {
    return { weeks: 0, meanStress: 0, sdStress: STRESS_SD_FLOOR };
  }
  const stresses = trained.map((w) => w.stressScore);
  const meanStress = stresses.reduce((a, b) => a + b, 0) / stresses.length;
  const stressVariance =
    stresses.length > 1
      ? stresses.reduce((a, b) => a + (b - meanStress) ** 2, 0) / (stresses.length - 1)
      : 0;
  const sdStress = Math.max(STRESS_SD_FLOOR, Math.sqrt(stressVariance));
  const rpes = trained
    .map((w) => w.avgRpe)
    .filter((v): v is number => typeof v === 'number');
  const meanRpe = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : undefined;
  let sdRpe: number | undefined;
  if (meanRpe !== undefined) {
    const rpeVariance =
      rpes.length > 1
        ? rpes.reduce((a, b) => a + (b - meanRpe) ** 2, 0) / (rpes.length - 1)
        : 0;
    sdRpe = Math.max(RPE_SD_FLOOR, Math.sqrt(rpeVariance));
  }
  return {
    weeks: trained.length,
    meanStress,
    sdStress,
    meanRpe,
    sdRpe,
  };
}

// ---------------------------------------------------------------------------
// Deload suggestion engine
// ---------------------------------------------------------------------------

export type DeloadRecommendation = 'continue' | 'deload-soon' | 'deload-now';

export interface DeloadSuggestion {
  recommendation: DeloadRecommendation;
  reasons: string[];
  /** 0..1 confidence in the recommendation. */
  confidence: number;
  /** Personal baseline used to evaluate the latest week, if any. */
  baseline?: LoadBaseline;
}

export interface DeloadInputs {
  /** Last few weekly load summaries, oldest first, most recent last. */
  recentWeeks: WeeklyLoad[];
  /** ISO date of the last completed deload session, if any. */
  lastDeloadAt?: string;
  /** Today's date (defaults to now). */
  now?: Date;
  /**
   * Optional set-level history for the past ~2 weeks. When provided, enables
   * the `consecutive high-effort streak` urgency signal which catches the
   * "three RPE-9 sessions in a row, but the weekly average looks fine"
   * failure mode. Pass an empty array (or omit) to skip the signal.
   */
  recentSets?: LoadSet[];
  /**
   * Optional Banister CTL/ATL/TSB result computed from the user's daily
   * load series. When present and not in cold-start mode, ACWR and TSB
   * contribute to urgency. Cold-start results are ignored so a user back
   * from a layoff doesn't get flagged on day 1.
   */
  banister?: BanisterResult;
}

const HIGH_RPE = 8.5;
const VERY_HIGH_RPE = 9.2;
const HIGH_FATIGUE = 7;
const LOW_SLEEP = 6;
const HIGH_STRESS = 75;
const VERY_HIGH_STRESS = 90;
const WEEKS_BETWEEN_DELOADS_SOFT = 4;
const WEEKS_BETWEEN_DELOADS_HARD = 6;
/** Minimum trained weeks required before the personal baseline takes over from absolute thresholds. */
const BASELINE_MIN_WEEKS = 2;

export function deloadSuggestion(input: DeloadInputs): DeloadSuggestion {
  const reasons: string[] = [];
  let urgency = 0; // 0..3+: 0=continue, 1=deload-soon, 2-3=deload-now

  const last = input.recentWeeks[input.recentWeeks.length - 1];
  // Up to 4 weeks immediately before the latest one, used as a personal baseline.
  const baselineSrc = input.recentWeeks.slice(0, -1).slice(-4);
  const baseline = rollingBaseline(baselineSrc);
  const hasBaseline = baseline.weeks >= BASELINE_MIN_WEEKS;

  if (last) {
    // ---- RPE: prefer baseline-relative when we have enough history ----
    if (
      hasBaseline &&
      baseline.meanRpe !== undefined &&
      last.avgRpe !== undefined
    ) {
      const sd = Math.max(baseline.sdRpe ?? 0, RPE_SD_FLOOR);
      const z = (last.avgRpe - baseline.meanRpe) / sd;
      if (z >= 2) {
        reasons.push(
          `RPE ${last.avgRpe.toFixed(1)} — well above your ${baseline.meanRpe.toFixed(1)} baseline.`,
        );
        urgency += 2;
      } else if (z >= 1) {
        reasons.push(
          `RPE ${last.avgRpe.toFixed(1)} above your ${baseline.meanRpe.toFixed(1)} baseline.`,
        );
        urgency += 1;
      }
    } else if (last.avgRpe !== undefined && last.avgRpe >= VERY_HIGH_RPE) {
      reasons.push(`Last week's average RPE was ${last.avgRpe.toFixed(1)} — very high.`);
      urgency += 2;
    } else if (last.avgRpe !== undefined && last.avgRpe >= HIGH_RPE) {
      reasons.push(`Average RPE rising (${last.avgRpe.toFixed(1)}).`);
      urgency += 1;
    }

    // ---- Fatigue / sleep stay absolute (subjective scale, not load-driven) ----
    if (last.avgFatigue !== undefined && last.avgFatigue >= HIGH_FATIGUE) {
      reasons.push(`Subjective fatigue averaging ${last.avgFatigue.toFixed(1)}/10.`);
      urgency += 1;
    }
    if (last.avgSleep !== undefined && last.avgSleep < LOW_SLEEP) {
      reasons.push(`Sleep averaging ${last.avgSleep.toFixed(1)}h — under 6.`);
      urgency += 1;
    }

    // ---- Stress score: absolute thresholds only.
    // The personal baseline (mean ± SD) is computed and surfaced via the
    // `baseline` field for display, but no longer feeds urgency — TSB/ACWR
    // are now the load-relative trigger.
    if (last.stressScore >= VERY_HIGH_STRESS) {
      reasons.push(`Stress score ${last.stressScore} — well above threshold.`);
      urgency += 2;
    } else if (last.stressScore >= HIGH_STRESS) {
      reasons.push(`Stress score ${last.stressScore} approaching threshold.`);
      urgency += 1;
    }
  }

  // ---- Rolling-window ACWR (Gabbett-style thresholds) ----
  // Use the **uncoupled rolling** ACWR for the >1.3 watch / >1.5 risk
  // thresholds — these were validated on rolling means, not Banister EWAs.
  // TSB still drives the form-fatigue checks below since Banister CTL/ATL
  // *is* the right model for that.
  const ban = input.banister;
  if (ban && !ban.coldStart) {
    const acwrForThresholds = ban.acwrRolling;
    if (acwrForThresholds !== null && acwrForThresholds > 1.5) {
      reasons.push(`Acute load ${acwrForThresholds.toFixed(2)}× chronic — high injury risk.`);
      urgency += 2;
    } else if (acwrForThresholds !== null && acwrForThresholds > 1.3) {
      reasons.push(`Acute load ${acwrForThresholds.toFixed(2)}× chronic — above sweet spot.`);
      urgency += 1;
    }
    if (ban.tsb < -30) {
      reasons.push(`Form deeply negative (TSB ${ban.tsb.toFixed(0)}).`);
      urgency += 2;
    } else if (ban.tsb < -15) {
      reasons.push(`Form negative (TSB ${ban.tsb.toFixed(0)} — fatigue accumulating).`);
      urgency += 1;
    }
  }

  // Consecutive high-effort sessions catch streaks that weekly averages
  // smooth away (3× RPE-9 in a row, then one easy session, weekly avg fine).
  // A 3-session streak is strong enough to trigger deload-now on its own.
  if (input.recentSets && input.recentSets.length > 0) {
    const streak = consecutiveHighEffortStreak(input.recentSets);
    if (streak >= 3) {
      reasons.push(`${streak} high-effort sessions in a row (avg RPE ≥ 8 or 3+ sets at RPE 8.5+).`);
      urgency += 3;
    } else if (streak >= 2) {
      reasons.push(`${streak} high-effort sessions back-to-back.`);
      urgency += 1;
    }
  }

  if (input.lastDeloadAt) {
    const ageDays = Math.floor(
      ((input.now?.getTime() ?? Date.now()) - new Date(input.lastDeloadAt).getTime()) / 86400000,
    );
    const ageWeeks = Math.floor(ageDays / 7);
    if (ageWeeks >= WEEKS_BETWEEN_DELOADS_HARD) {
      reasons.push(`${ageWeeks} weeks since last deload — overdue.`);
      urgency += 2;
    } else if (ageWeeks >= WEEKS_BETWEEN_DELOADS_SOFT) {
      reasons.push(`${ageWeeks} weeks since last deload.`);
      urgency += 1;
    }
  }

  let recommendation: DeloadRecommendation;
  if (urgency >= 3) recommendation = 'deload-now';
  else if (urgency >= 1) recommendation = 'deload-soon';
  else recommendation = 'continue';

  if (reasons.length === 0) {
    reasons.push('All indicators within normal range — keep training.');
  }
  // Baseline-grounded calls earn a confidence boost; cold-start calls cap lower.
  const baselineBoost = hasBaseline ? 0.1 : 0;
  const confidence = Math.min(
    1,
    0.4 + 0.15 * urgency + 0.05 * input.recentWeeks.length + baselineBoost,
  );

  return {
    recommendation,
    reasons,
    confidence: Number(confidence.toFixed(2)),
    baseline: hasBaseline ? baseline : undefined,
  };
}


// ---------------------------------------------------------------------------
// Daily load + Banister CTL/ATL/TSB (fitness/fatigue/form) model
// ---------------------------------------------------------------------------

/**
 * Single-day load number combining strength + cardio (+ a small RPE bump).
 * Uses the same scaling as the weekly stress score so daily numbers add up
 * to roughly weekly ones — the absolute scale doesn't matter as long as
 * CTL/ATL/TSB are computed consistently from the same series.
 */
export function dailyLoad(
  day: string,
  sets: LoadSet[],
  cardio: LoadCardio[],
): number {
  const live = sets.filter(
    (s) => !s.deletedAt && !s.skipped && s.performedAt.slice(0, 10) === day,
  );
  const dayCardio = cardio.filter((c) => c.performedAt.slice(0, 10) === day);

  const weightedTonnage = live.reduce((acc, s) => {
    const if_ = setIntensityFactor(s);
    return acc + s.weightKg * s.reps * if_ * if_;
  }, 0);
  const cardioMin = weightedCardioMinutes(dayCardio);

  let load = weightedTonnage / 100 + cardioMin / 15;

  // RPE bump — mirrors the v344 streak-detection rule rather than the old
  // `Math.max(...rpes)` shape. Why: the max-RPE rule let one AMRAP top set
  // at RPE 9 add the same load as a full session of grinders, which fed
  // straight into CTL/ATL/TSB/ACWR and could falsely trip the deload
  // engine on what was a normal Wendler day (one hard top set, easy
  // assistance).
  //
  // New rule (additive, conservative):
  //   - session-average pressure: max(0, (avgRpe − 6) × 0.4)
  //   - many-hard-sets bonus:     min(1.0, hardSetCount × 0.2) where
  //     hardSetCount = number of sets at RPE ≥ 8.5
  // The two combine into roughly the same scale as the old (max − 6) × 0.5
  // for a uniformly hard session, but a single high-RPE outlier no longer
  // tips the scales by itself.
  const rpes = live.map((s) => s.rpe).filter((r): r is number => typeof r === 'number');
  if (rpes.length) {
    const avgRpe = rpes.reduce((acc, r) => acc + r, 0) / rpes.length;
    const hardSetCount = rpes.filter((r) => r >= 8.5).length;
    const avgBump = Math.max(0, (avgRpe - 6) * 0.4);
    const hardBump = Math.min(1, hardSetCount * 0.2);
    load += avgBump + hardBump;
  }
  return load;
}

/**
 * Build a daily load series from `fromDate` to `toDate` (inclusive, UTC days).
 * Empty days are zero-filled — essential so the EWA correctly decays during
 * rest days rather than just stretching the gap between events.
 */
export function dailyLoadSeries(
  fromDate: string,
  toDate: string,
  sets: LoadSet[],
  cardio: LoadCardio[],
): { date: string; load: number }[] {
  const start = new Date(fromDate + 'T00:00:00Z').getTime();
  const end = new Date(toDate + 'T00:00:00Z').getTime();
  const out: { date: string; load: number }[] = [];
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push({ date: d, load: dailyLoad(d, sets, cardio) });
  }
  return out;
}

export interface BanisterPoint {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
}

export interface BanisterResult {
  /** Chronic Training Load — fitness (42-day EWA, last day). */
  ctl: number;
  /** Acute Training Load — fatigue (7-day EWA, last day). */
  atl: number;
  /** Training Stress Balance — form (CTL − ATL, last day). */
  tsb: number;
  /**
   * Acute:Chronic Workload Ratio (ATL / CTL on Banister EWA series).
   * Kept for backward compatibility, but **not the metric the >1.5
   * deload-risk threshold should be judged against** — Gabbett's
   * "sweet spot 0.8–1.3 / danger > 1.5" thresholds were validated on
   * rolling-window means, not EWMAs. Use `acwrRolling` for that check.
   */
  acwr: number | null;
  /**
   * Uncoupled rolling-window ACWR — last 7 days of load divided by the
   * prior 28 days (no overlap). This matches the Gabbett-style
   * literature thresholds the deload engine enforces.
   * `null` if there's insufficient history (need ≥ 7 acute + 28 chronic days).
   */
  acwrRolling: number | null;
  /** Per-day series for charting. */
  series: BanisterPoint[];
  /**
   * True when fewer than 14 of the days in the series carried any load.
   * Callers should suppress TSB/ACWR-driven recommendations in this state
   * so a returning user doesn't get told to deload on day 1.
   */
  coldStart: boolean;
}

export interface BanisterOptions {
  /** Time constant for CTL (chronic). Default 42 days. */
  ctlTau?: number;
  /** Time constant for ATL (acute). Default 7 days. */
  atlTau?: number;
}

/**
 * Standard Banister recursive EWA:
 *   today = yesterday + (load_today − yesterday) / τ
 * Seeded at 0 (cold start). Returns the last day's CTL/ATL/TSB/ACWR plus
 * the full per-day series for charting.
 *
 * Two ACWR values are returned:
 *   - `acwr` (legacy): ATL / CTL on the EWA series. Useful as a smoothness-
 *     adjusted measure but the Gabbett thresholds (>1.3 watch, >1.5 risk)
 *     were not validated against this distribution.
 *   - `acwrRolling`: **uncoupled** rolling-window ACWR — `sum(last 7 days) /
 *     7` divided by `sum(days 8..35 ago) / 28`. The acute window is excluded
 *     from the chronic window (avoiding the Gabbett 2019 mathematical-coupling
 *     critique). This is the metric the deload engine should drive thresholds
 *     from.
 */
export function banister(
  series: { date: string; load: number }[],
  options?: BanisterOptions,
): BanisterResult {
  const ctlTau = options?.ctlTau ?? 42;
  const atlTau = options?.atlTau ?? 7;
  let ctl = 0;
  let atl = 0;
  const points: BanisterPoint[] = [];
  let nonZeroDays = 0;
  for (const p of series) {
    ctl = ctl + (p.load - ctl) / ctlTau;
    atl = atl + (p.load - atl) / atlTau;
    points.push({ date: p.date, ctl, atl, tsb: ctl - atl });
    if (p.load > 0) nonZeroDays += 1;
  }
  const finalCtl = points.length ? points[points.length - 1]!.ctl : 0;
  const finalAtl = points.length ? points[points.length - 1]!.atl : 0;
  const acwr = finalCtl < 1e-3 ? null : finalAtl / finalCtl;
  return {
    ctl: finalCtl,
    atl: finalAtl,
    tsb: finalCtl - finalAtl,
    acwr,
    acwrRolling: acwrUncoupled(series),
    series: points,
    coldStart: nonZeroDays < 14,
  };
}

/**
 * Uncoupled rolling-window ACWR — Gabbett's "sweet spot 0.8–1.3, risk > 1.5"
 * thresholds were validated against rolling means with the acute window
 * *excluded* from the chronic window (Gabbett 2019 critique of coupled
 * ACWR's mathematical bias).
 *
 *   acute  = sum(load over last 7 days)  / 7
 *   chronic = sum(load over the 28 days BEFORE that) / 28
 *   acwr   = acute / chronic
 *
 * Returns null when the input doesn't span the required 35 most-recent days
 * (need 7 acute + 28 chronic), or when chronic mean is effectively zero
 * (returning user — caller should suppress thresholds in cold-start).
 *
 * Exported separately so tests and callers can sanity-check the value
 * independently of the Banister EWA series.
 */
export function acwrUncoupled(
  series: ReadonlyArray<{ date: string; load: number }>,
): number | null {
  if (series.length < 7 + 28) return null;
  const tail = series.slice(-(7 + 28));
  const chronicWindow = tail.slice(0, 28);
  const acuteWindow = tail.slice(28);
  const chronicMean =
    chronicWindow.reduce((acc, p) => acc + p.load, 0) / 28;
  const acuteMean = acuteWindow.reduce((acc, p) => acc + p.load, 0) / 7;
  if (chronicMean < 1e-3) return null;
  return acuteMean / chronicMean;
}

// ---------------------------------------------------------------------------
// Dynamic cardio cap (trailing 6-week mean)
// ---------------------------------------------------------------------------

/**
 * Mean per-week cardio contribution to the stress score over the last
 * `weeks` *completed* weeks (excluding the current in-progress week — that
 * way today's big run doesn't immediately self-cap by raising the cap and
 * then capping itself against the new ceiling). Returns 0 when there's no
 * cardio history; `dynamicCardioCap` keeps the static 30-floor in that case.
 */
export function trailingMeanCardioContribution(
  cardio: LoadCardio[],
  now: Date = new Date(),
  weeks = 6,
): number {
  const currentMonday = isoMonday(now);
  const cur = new Date(currentMonday + 'T00:00:00Z').getTime();
  const contribs: number[] = [];
  for (let i = 1; i <= weeks; i += 1) {
    const ws = new Date(cur - i * 7 * 86400000).toISOString().slice(0, 10);
    const wkCardio = cardio.filter((c) => inWeek(c.performedAt, ws));
    contribs.push(weightedCardioMinutes(wkCardio) / 15);
  }
  if (contribs.length === 0) return 0;
  return contribs.reduce((a, b) => a + b, 0) / contribs.length;
}

/**
 * Resolved cardio cap given the user's recent cardio history:
 *   max(30, round(1.3 × trailingMeanCardioContribution(6 weeks)))
 * Pass into `weeklyLoad(..., { cardioCap })`.
 */
export function dynamicCardioCap(
  cardio: LoadCardio[],
  now: Date = new Date(),
  weeks = 6,
): number {
  const mean = trailingMeanCardioContribution(cardio, now, weeks);
  return Math.max(30, Math.round(1.3 * mean));
}
