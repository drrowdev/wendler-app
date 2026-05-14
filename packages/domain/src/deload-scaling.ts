// Deload assistance scaling.
//
// Wendler's main-set waves already drop intensity on deload weeks (see
// waves.ts) and supplemental work is skipped (supplemental.ts). What's left
// untouched is **assistance volume** — and that's where most of the weekly
// fatigue actually sits. This module adds named, reversible scaling
// strategies for assistance, plus a recommender that picks one based on the
// same signals `return-plan.ts` uses (training trajectory, recovery,
// upcoming races, illness state).
//
// The output is a transform from each day's default `AssistanceEntry[]` to
// the scaled version; callers write that into
// `block.plan.assistanceOverrides[`deload|${dayId}`]` so the existing
// resolution path picks it up everywhere — `/day`, the block editor, the
// session log, etc.

import type {
  AssistanceCategory,
  AssistanceEntry,
  BlockPlan,
} from './blocks';
import type { MainLift } from './types';
import type {
  AmrapPerformance,
  IllnessSeverity,
  IllnessSignal,
  RaceSignal,
  RecoverySignal,
  TrendDirection,
} from './return-plan';
import {
  e1rmTrend,
  lastAmrapPerformance,
} from './return-plan';
import type { MinimalSet } from './analytics';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DeloadStrategy =
  | 'volume-half'
  | 'intensity-cut'
  | 'bodyweight-only'
  | 'mobility-recovery'
  | 'skip-assistance';

export interface DeloadScalingPlan {
  strategy: DeloadStrategy;
  /** Card title, ≤80 chars. */
  headline: string;
  /** Plain-English rationale referencing the signals that drove the pick. */
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DeloadScalingResult {
  primary: DeloadScalingPlan;
  alternatives: DeloadScalingPlan[];
}

export interface DeloadScalingInput {
  /** All counted sets across history. Used for e1RM trend / AMRAP analysis. */
  sets: MinimalSet[];
  /** Movement IDs that map to each main lift, for trend analysis. */
  mainLiftMovementIds?: Partial<Record<MainLift, string>>;
  upcomingRaces?: RaceSignal[];
  /** Recovery entries from the last ~3 days. */
  recoveryRecent?: RecoverySignal[];
  /** Currently active (unrecovered) illness, if any. */
  activeIllness?: { severity: IllnessSeverity; startedAt: string };
  /** Most recent recovered illness, if recoveredAt is within ~7 days. */
  recentlyRecoveredIllness?: IllnessSignal;
}

// ---------------------------------------------------------------------------
// Strategy transforms
// ---------------------------------------------------------------------------

const round05 = (n: number): number => Math.round(n * 2) / 2;

/**
 * `volume-half`: keep movements & loads, halve set count (min 1).
 * Reps and per-set targets stay the same.
 */
function transformVolumeHalf(entries: AssistanceEntry[]): AssistanceEntry[] {
  return entries.map((e) => ({
    ...e,
    sets: Math.max(1, Math.ceil(e.sets / 2)),
  }));
}

/**
 * `intensity-cut`: keep sets/reps; replace numeric loadHints with their value
 * scaled by 0.7. For non-numeric loadHints (e.g. "heavy", "bodyweight"), we
 * leave the entry unchanged but stamp a "deload load" note so the user knows
 * to drop weight for the week.
 */
function transformIntensityCut(entries: AssistanceEntry[]): AssistanceEntry[] {
  return entries.map((e) => {
    const hint = (e.loadHint ?? '').trim();
    const numericMatch = hint.match(/^(\d+(?:\.\d+)?)\s*(kg|lb|lbs)?$/i);
    if (numericMatch) {
      const val = Number(numericMatch[1]);
      const unit = numericMatch[2] ?? 'kg';
      return { ...e, loadHint: `${round05(val * 0.7)} ${unit}`.trim() };
    }
    if (!hint || /bodyweight|bw/i.test(hint)) {
      // Bodyweight / no-load entries don't need an intensity cut; leave as-is.
      return e;
    }
    // Non-numeric load hint (e.g. "heavy"): downgrade verbally.
    return { ...e, loadHint: 'light (deload)' };
  });
}

const BODYWEIGHT_SWAPS: Record<AssistanceCategory, { name: string; reps: number; repsMax?: number }> = {
  push: { name: 'Push-ups', reps: 10, repsMax: 20 },
  pull: { name: 'Inverted rows', reps: 8, repsMax: 12 },
  'single-leg': { name: 'Bodyweight split squats', reps: 8, repsMax: 12 },
  core: { name: 'Plank', reps: 30 }, // seconds
  carry: { name: 'Bodyweight carry (no load)', reps: 30 }, // seconds
  accessory: { name: 'Bodyweight accessory', reps: 12, repsMax: 20 },
  other: { name: 'Bodyweight movement', reps: 12, repsMax: 20 },
};

/**
 * `bodyweight-only`: swap each entry for a bodyweight analogue of the same
 * category. movementId is dropped (it pointed to the weighted exercise);
 * sets/reps come from the swap table. Plank is the one second-based swap.
 */
function transformBodyweightOnly(entries: AssistanceEntry[]): AssistanceEntry[] {
  return entries.map((e) => {
    const swap = BODYWEIGHT_SWAPS[e.category] ?? BODYWEIGHT_SWAPS.other;
    const isCore = e.category === 'core';
    const isCarry = e.category === 'carry';
    return {
      id: e.id,
      category: e.category,
      movementName: swap.name,
      sets: e.sets,
      reps: swap.reps,
      ...(swap.repsMax !== undefined ? { repsMax: swap.repsMax } : {}),
      ...(isCore || isCarry ? { unit: 'sec' as const } : {}),
      loadHint: 'bodyweight',
    };
  });
}

/**
 * `mobility-recovery`: replace assistance with a single mobility/movement-
 * quality block per day. Aggressive reset — the user does ~10 min of light
 * mobility work and that's it.
 */
function transformMobilityRecovery(
  entries: AssistanceEntry[],
): AssistanceEntry[] {
  if (entries.length === 0) return [];
  const seedId = entries[0]?.id ?? 'mobility-deload';
  return [
    {
      id: seedId,
      category: 'other',
      movementName: 'Mobility & movement quality',
      sets: 1,
      reps: 10, // minutes
      unit: 'sec', // closest existing unit; UI shows raw number; loadHint clarifies
      loadHint: '~10 min light mobility',
    },
  ];
}

/** `skip-assistance`: nothing this week. */
function transformSkip(_entries: AssistanceEntry[]): AssistanceEntry[] {
  return [];
}

const TRANSFORMS: Record<
  DeloadStrategy,
  (entries: AssistanceEntry[]) => AssistanceEntry[]
> = {
  'volume-half': transformVolumeHalf,
  'intensity-cut': transformIntensityCut,
  'bodyweight-only': transformBodyweightOnly,
  'mobility-recovery': transformMobilityRecovery,
  'skip-assistance': transformSkip,
};

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Build a fresh `assistanceOverrides` map for the deload week that scales
 * each day's default assistance using the chosen strategy. Returns the
 * complete map (existing non-deload overrides are preserved unchanged;
 * existing deload overrides are replaced).
 *
 * The function is pure — it does not mutate `plan`.
 */
export function applyDeloadScaling(
  plan: BlockPlan,
  strategy: DeloadStrategy,
): Record<string, AssistanceEntry[]> {
  const next: Record<string, AssistanceEntry[]> = {};
  // Preserve overrides from non-deload weeks verbatim.
  if (plan.assistanceOverrides) {
    for (const [k, v] of Object.entries(plan.assistanceOverrides)) {
      if (!k.startsWith('deload|')) next[k] = v;
    }
  }
  const transform = TRANSFORMS[strategy];
  for (const day of plan.days) {
    const scaled = transform(day.assistance);
    // Always write the row, even when empty, so the override is explicit.
    next[`deload|${day.id}`] = scaled;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Recommender
// ---------------------------------------------------------------------------

const STRATEGIES: DeloadStrategy[] = [
  'skip-assistance',
  'mobility-recovery',
  'bodyweight-only',
  'intensity-cut',
  'volume-half',
];

const HEADLINES: Record<DeloadStrategy, string> = {
  'volume-half': 'Halve the assistance volume',
  'intensity-cut': 'Keep volume, cut assistance loads ~30%',
  'bodyweight-only': 'Swap weighted assistance for bodyweight',
  'mobility-recovery': 'Replace assistance with mobility',
  'skip-assistance': 'Skip assistance this week',
};

interface RaceWindow {
  /** Days from today (the moment the recommendation is computed). */
  days: number;
  priority: 'A' | 'B' | 'C';
}

const todayUtc = (): Date => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function nearestRace(races: RaceSignal[] | undefined): RaceWindow | null {
  if (!races || races.length === 0) return null;
  const today = todayUtc().getTime();
  let best: RaceWindow | null = null;
  for (const r of races) {
    const ts = new Date(r.date + 'T00:00:00Z').getTime();
    if (Number.isNaN(ts)) continue;
    const days = Math.round((ts - today) / MS_PER_DAY);
    if (days < 0) continue;
    if (!best || days < best.days) {
      best = { days, priority: r.priority };
    }
  }
  return best;
}

function recoveryFlags(recent: RecoverySignal[] | undefined): {
  highFatigue: boolean;
  lowHrv: boolean;
} {
  if (!recent || recent.length === 0) return { highFatigue: false, lowHrv: false };
  const last3 = recent.slice(-3);
  const highFatigue = last3.some((r) => (r.fatigue ?? 0) >= 7);
  // Crude HRV trend: last value below the median of the prior values.
  const hrvs = recent.map((r) => r.hrv).filter((x): x is number => typeof x === 'number');
  let lowHrv = false;
  if (hrvs.length >= 3) {
    const last = hrvs[hrvs.length - 1];
    const prior = hrvs.slice(0, -1).slice(-5);
    if (last !== undefined && prior.length > 0) {
      const sorted = [...prior].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median !== undefined) {
        lowHrv = last < median * 0.95; // >5% below recent median
      }
    }
  }
  return { highFatigue, lowHrv };
}

function blockWasHard(
  sets: MinimalSet[],
  mainLiftMovementIds: Partial<Record<MainLift, string>> | undefined,
): { trend: TrendDirection; amrap: AmrapPerformance } {
  const today = new Date().toISOString().slice(0, 10);
  const lifts = Object.keys(mainLiftMovementIds ?? {}) as MainLift[];
  let trend: TrendDirection = 'flat';
  let amrap: AmrapPerformance = 'unknown';
  for (const lift of lifts) {
    const movementId = mainLiftMovementIds?.[lift];
    if (!movementId) continue;
    const t = e1rmTrend(sets, movementId, today);
    if (t === 'falling') trend = 'falling';
    else if (t === 'rising' && trend !== 'falling') trend = 'rising';
    const a = lastAmrapPerformance(sets, movementId);
    if (a === 'struggling') amrap = 'struggling';
    else if (a !== 'unknown' && amrap === 'unknown') amrap = a;
  }
  return { trend, amrap };
}

function plan(
  strategy: DeloadStrategy,
  rationale: string,
  confidence: 'high' | 'medium' | 'low' = 'medium',
): DeloadScalingPlan {
  return {
    strategy,
    headline: HEADLINES[strategy],
    rationale,
    confidence,
  };
}

function alternativesExcluding(primary: DeloadStrategy): DeloadScalingPlan[] {
  return STRATEGIES.filter((s) => s !== primary).map((s) =>
    plan(s, `Alternative if you'd prefer ${HEADLINES[s].toLowerCase()}.`, 'low'),
  );
}

/**
 * Decide which deload-assistance strategy to recommend.
 *
 * Precedence ladder (first match wins):
 *
 *   1. Active illness now → `skip-assistance`
 *   2. A-priority race within 7 days → `mobility-recovery`
 *   3. A-priority race within 8–14 days → `bodyweight-only`
 *   4. Recently recovered (≤7 days since recoveredAt) → `bodyweight-only`
 *   5. High fatigue (≥7 in last 3 days) OR HRV trending down → `intensity-cut`
 *   6. Block was hard (any AMRAP struggling OR any e1RM trend down) → `intensity-cut`
 *   7. Default → `volume-half`
 */
export function recommendDeloadScaling(
  input: DeloadScalingInput,
): DeloadScalingResult {
  // 1. Active illness
  if (input.activeIllness) {
    const sev = input.activeIllness.severity;
    return {
      primary: plan(
        'skip-assistance',
        `You're flagged as ${sev}-level sick. Drop assistance entirely; let the deload main sets do the work.`,
        'high',
      ),
      alternatives: alternativesExcluding('skip-assistance'),
    };
  }

  // 2 & 3. Upcoming A-race
  const race = nearestRace(input.upcomingRaces);
  if (race && race.priority === 'A' && race.days <= 7) {
    return {
      primary: plan(
        'mobility-recovery',
        `Your A-priority race is in ${race.days} day${race.days === 1 ? '' : 's'}. Swap assistance for mobility — keep the legs fresh.`,
        'high',
      ),
      alternatives: alternativesExcluding('mobility-recovery'),
    };
  }
  if (race && race.priority === 'A' && race.days <= 14) {
    return {
      primary: plan(
        'bodyweight-only',
        `Your A-priority race is ${race.days} days out. Bodyweight assistance keeps the pattern without adding fatigue.`,
        'high',
      ),
      alternatives: alternativesExcluding('bodyweight-only'),
    };
  }

  // 4. Recently recovered illness (within ~7 days of recoveredAt)
  if (input.recentlyRecoveredIllness?.recoveredAt) {
    const recoveredAt = input.recentlyRecoveredIllness.recoveredAt;
    const today = todayUtc().getTime();
    const recovTs = new Date(recoveredAt + 'T00:00:00Z').getTime();
    const daysSince = Math.round((today - recovTs) / MS_PER_DAY);
    if (daysSince >= 0 && daysSince <= 7) {
      return {
        primary: plan(
          'bodyweight-only',
          `You came back from being sick ${daysSince === 0 ? 'today' : `${daysSince} day${daysSince === 1 ? '' : 's'} ago`}. Bodyweight assistance lets you move without piling on volume.`,
          'high',
        ),
        alternatives: alternativesExcluding('bodyweight-only'),
      };
    }
  }

  // 5. Recovery flags
  const { highFatigue, lowHrv } = recoveryFlags(input.recoveryRecent);
  if (highFatigue || lowHrv) {
    const why = highFatigue
      ? 'fatigue has been ≥7 in the last few days'
      : 'HRV is trending down';
    return {
      primary: plan(
        'intensity-cut',
        `Your ${why}. Keep the volume but drop the loads ~30% so this week actually deloads.`,
        'medium',
      ),
      alternatives: alternativesExcluding('intensity-cut'),
    };
  }

  // 6. Hard block
  const { trend, amrap } = blockWasHard(input.sets, input.mainLiftMovementIds);
  if (trend === 'falling' || amrap === 'struggling') {
    const why = trend === 'falling'
      ? 'your e1RM trend has been negative'
      : 'your last AMRAP was a grind';
    return {
      primary: plan(
        'intensity-cut',
        `Block was rough — ${why}. Drop assistance loads ~30% to recover before the next cycle.`,
        'medium',
      ),
      alternatives: alternativesExcluding('intensity-cut'),
    };
  }

  // 7. Default
  const positive = trend === 'rising' || amrap === 'crushing';
  return {
    primary: plan(
      'volume-half',
      positive
        ? `The block went well — keep the movements and loads, just halve the sets so you walk in fresh next cycle.`
        : `Standard deload: keep the movements and loads, halve the sets.`,
      'high',
    ),
    alternatives: alternativesExcluding('volume-half'),
  };
}
