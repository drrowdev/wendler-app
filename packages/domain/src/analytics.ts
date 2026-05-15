import type { MainLift, Movement, MovementPattern, MuscleGroup, WendlerWeek } from './types';
import { epley1RM } from './e1rm';

export interface MinimalSet {
  movementId: string;
  performedAt: string; // ISO
  weightKg: number;
  reps: number;
  rpe?: number;
  kind: 'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance';
  isAmrap?: boolean;
  skipped?: boolean;
  deletedAt?: string;
  sessionId?: string;
  /**
   * Wendler 5/3/1 percentage of training max for this set, when known.
   * Lets analytics that need to know "which week's AMRAP was this?"
   * infer floor reps from intensity (5/3/1 top sets ≈ 85/90/95 %).
   */
  percentOfTm?: number;
  /** Snapshot of the lift's TM at the time the set was performed. */
  trainingMaxKgAtTime?: number;
}

export interface MinimalSession {
  id: string;
  performedAt: string; // ISO
  mainLift?: MainLift;
  week?: WendlerWeek;
  blockId?: string;
  /** Index of the training day-group within the week (0-based). */
  dayIndex?: number;
  /** Legacy per-lift completion flag. */
  completedAt?: string;
  /** Whole-workout completion flag (preferred when present). */
  workoutCompletedAt?: string;
}

/** Best e1RM observed per ISO calendar day (yyyy-mm-dd) for a movement. */
export interface E1rmPoint {
  date: string; // yyyy-mm-dd
  e1rm: number;
  weightKg: number;
  reps: number;
}

const isCounted = (s: MinimalSet) => !s.skipped && !s.deletedAt && s.weightKg > 0 && s.reps > 0;

// Pattern/category accounting (push/pull/lower/core balance). Counted as a
// working set even when weight is 0 so band, bodyweight, and isometric work
// like pallof press still show up — the chart switched from tonnage to set
// count precisely because tonnage silently dropped these.
const isCountedSet = (s: MinimalSet) => !s.skipped && !s.deletedAt && s.reps > 0;

export function isoDate(iso: string): string {
  return iso.slice(0, 10);
}

export function bestE1rmSeries(sets: MinimalSet[], movementId: string): E1rmPoint[] {
  const byDay = new Map<string, E1rmPoint>();
  for (const s of sets) {
    if (s.movementId !== movementId || !isCounted(s) || s.kind === 'warmup') continue;
    const day = isoDate(s.performedAt);
    const e1rm = epley1RM(s.weightKg, s.reps);
    const cur = byDay.get(day);
    if (!cur || e1rm > cur.e1rm) {
      byDay.set(day, { date: day, e1rm, weightKg: s.weightKg, reps: s.reps });
    }
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface VolumePoint {
  /** ISO date for daily, yyyy-Www for weekly. */
  bucket: string;
  tonnageKg: number;
  sets: number;
  reps: number;
}

/** Tonnage = sum(weight × reps) over counted sets, bucketed per ISO calendar day. */
export function dailyVolume(sets: MinimalSet[]): VolumePoint[] {
  const byDay = new Map<string, VolumePoint>();
  for (const s of sets) {
    if (!isCounted(s)) continue;
    const day = isoDate(s.performedAt);
    const cur = byDay.get(day) ?? { bucket: day, tonnageKg: 0, sets: 0, reps: 0 };
    cur.tonnageKg += s.weightKg * s.reps;
    cur.sets += 1;
    cur.reps += s.reps;
    byDay.set(day, cur);
  }
  return [...byDay.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

/** Returns yyyy-Www (ISO 8601 week). */
export function isoWeekKey(iso: string): string {
  const d = new Date(iso + (iso.length <= 10 ? 'T00:00:00Z' : ''));
  // ISO week: Thursday determines the year.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function weeklyVolume(sets: MinimalSet[]): VolumePoint[] {
  const byWeek = new Map<string, VolumePoint>();
  for (const s of sets) {
    if (!isCounted(s)) continue;
    const wk = isoWeekKey(s.performedAt);
    const cur = byWeek.get(wk) ?? { bucket: wk, tonnageKg: 0, sets: 0, reps: 0 };
    cur.tonnageKg += s.weightKg * s.reps;
    cur.sets += 1;
    cur.reps += s.reps;
    byWeek.set(wk, cur);
  }
  return [...byWeek.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

/**
 * Weekly assistance volume, bucketed by ISO week. Uses **rep count** rather
 * than tonnage because most assistance work (curls, dips, lateral raises,
 * carries) is bodyweight or light-DB and would be silently dropped from a
 * tonnage chart. Includes only sets with `kind === 'assistance'`.
 */
export function weeklyAssistanceReps(sets: MinimalSet[]): VolumePoint[] {
  const byWeek = new Map<string, VolumePoint>();
  for (const s of sets) {
    if (s.kind !== 'assistance') continue;
    if (!isCountedSet(s)) continue;
    const wk = isoWeekKey(s.performedAt);
    const cur = byWeek.get(wk) ?? { bucket: wk, tonnageKg: 0, sets: 0, reps: 0 };
    cur.tonnageKg += s.weightKg * s.reps;
    cur.sets += 1;
    cur.reps += s.reps;
    byWeek.set(wk, cur);
  }
  return [...byWeek.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

export type PushPullCategory = 'push' | 'pull' | 'lower' | 'core' | 'other';

export function categorizePattern(pattern: MovementPattern): PushPullCategory {
  switch (pattern) {
    case 'push-horizontal':
    case 'push-vertical':
      return 'push';
    case 'pull-horizontal':
    case 'pull-vertical':
      return 'pull';
    case 'squat':
    case 'hinge':
      return 'lower';
    case 'core':
      return 'core';
    default:
      return 'other';
  }
}

export interface PushPullBalance {
  push: number;
  pull: number;
  lower: number;
  core: number;
  other: number;
  /** Working-set push/pull ratio. 1.0 = balanced. < 1 means more pull, > 1 more push. */
  pushPullRatio: number | null;
}

/**
 * Distribution of working sets by movement pattern category. Counts each
 * counted set as 1 unit regardless of load — this is the standard way to
 * track weekly volume across mixed-load work (heavy barbell + bodyweight +
 * band) since tonnage isn't comparable across those modalities.
 */
export function pushPullBalance(
  sets: MinimalSet[],
  movements: Movement[],
): PushPullBalance {
  const byMovement = new Map(movements.map((m) => [m.id, m]));
  const out: PushPullBalance = {
    push: 0,
    pull: 0,
    lower: 0,
    core: 0,
    other: 0,
    pushPullRatio: null,
  };
  for (const s of sets) {
    if (!isCountedSet(s)) continue;
    const mv = byMovement.get(s.movementId);
    if (!mv) continue;
    const cat = categorizePattern(mv.pattern);
    out[cat] += 1;
  }
  if (out.pull > 0) out.pushPullRatio = out.push / out.pull;
  return out;
}

export interface WeeklyBalancePoint {
  /** yyyy-Www */
  bucket: string;
  push: number;
  pull: number;
  lower: number;
  core: number;
  other: number;
  total: number;
}

/** Push/pull/lower/core working-set count bucketed per ISO week. */
export function weeklyPushPullBalance(
  sets: MinimalSet[],
  movements: Movement[],
): WeeklyBalancePoint[] {
  const byMovement = new Map(movements.map((m) => [m.id, m]));
  const byWeek = new Map<string, WeeklyBalancePoint>();
  for (const s of sets) {
    if (!isCountedSet(s)) continue;
    const mv = byMovement.get(s.movementId);
    if (!mv) continue;
    const wk = isoWeekKey(s.performedAt);
    const cur =
      byWeek.get(wk) ??
      { bucket: wk, push: 0, pull: 0, lower: 0, core: 0, other: 0, total: 0 };
    const cat = categorizePattern(mv.pattern);
    cur[cat] += 1;
    cur.total += 1;
    byWeek.set(wk, cur);
  }
  return [...byWeek.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

/** Tonnage attributed per muscle group. Primary muscles get full credit, secondary get 0.5x. */
export function muscleVolume(
  sets: MinimalSet[],
  movements: Movement[],
): Record<MuscleGroup, number> {
  const byMovement = new Map(movements.map((m) => [m.id, m]));
  const out: Partial<Record<MuscleGroup, number>> = {};
  for (const s of sets) {
    if (!isCounted(s)) continue;
    const mv = byMovement.get(s.movementId);
    if (!mv) continue;
    const ton = s.weightKg * s.reps;
    for (const m of mv.primaryMuscles) {
      out[m] = (out[m] ?? 0) + ton;
    }
    for (const m of mv.secondaryMuscles) {
      out[m] = (out[m] ?? 0) + ton * 0.5;
    }
  }
  return out as Record<MuscleGroup, number>;
}

export interface BlockCompletion {
  blockId: string;
  /** Number of training days planned in this block (days × weeks). */
  sessionsPlanned: number;
  /**
   * Number of distinct training days that have any session row stamped with
   * a workout-complete (or per-lift complete) timestamp. Counts WORKOUTS, not
   * lift rows — a multi-lift day with both lifts done is still one workout.
   */
  sessionsCompleted: number;
  completionPercent: number;
  /**
   * Per-lift completion counts. Deduplicated on (week, dayIdx, mainLift) so
   * accidentally-duplicated session rows (race in useDaySessionRow) don't
   * double-count.
   */
  liftCounts: Record<MainLift, number>;
  tonnageKg: number;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Block completion measured in **training days completed / training days
 * planned**.
 *
 * - `daysPlanned` (= sessionsPlanned for back-compat) defaults to `3 weeks * 4
 *   day-groups = 12`. Callers that know the block's actual plan should pass
 *   `weeksPerBlock` (1 for deload, 3 otherwise) and `daysPerWeek` (the plan's
 *   day-group count). For example a deload with 3 training days = 1 × 3 = 3.
 * - `daysCompleted` counts distinct `(week, dayIndex)` pairs in this block
 *   where any session row has `workoutCompletedAt` (or legacy `completedAt`)
 *   set. So a multi-lift day with bench + deadlift = 1 day completed, not 2.
 * - `liftCounts` deduplicates on `(week, dayIndex, mainLift)`, so a buggy
 *   duplicate squat row won't inflate the squat count.
 */
export function blockCompletion(
  blockId: string,
  sessions: MinimalSession[],
  sets: MinimalSet[],
  options: {
    /** @deprecated alias for `daysPerWeek`. Kept so old callers/tests still work (3*4=12). */
    liftsPerWeek?: number;
    weeksPerBlock?: number;
    daysPerWeek?: number;
  } = {},
): BlockCompletion {
  const weeks = options.weeksPerBlock ?? 3;
  const daysPerWeek = options.daysPerWeek ?? options.liftsPerWeek ?? 4;
  const planned = weeks * daysPerWeek;
  const blockSessions = sessions.filter((s) => s.blockId === blockId);
  const completedRows = blockSessions.filter(
    (s) => !!(s.workoutCompletedAt ?? s.completedAt),
  );

  // Distinct (week, dayIndex) pairs that have at least one completed row.
  // Rows missing week or dayIndex (legacy data) fall back to the
  // calendar-day of `performedAt` so they still collapse into one workout.
  const dayKey = (s: MinimalSession): string => {
    if (s.week !== undefined && s.dayIndex !== undefined) {
      return `${s.week}-${s.dayIndex}`;
    }
    return `date-${s.performedAt.slice(0, 10)}`;
  };
  const completedDays = new Set<string>();
  for (const s of completedRows) {
    completedDays.add(dayKey(s));
  }

  // liftCounts: dedupe on (week, dayIndex, mainLift). A duplicate-row race
  // would otherwise count squat twice for the same workout.
  const liftCounts: Record<MainLift, number> = { squat: 0, bench: 0, deadlift: 0, press: 0 };
  const liftSeen = new Set<string>();
  for (const s of completedRows) {
    if (!s.mainLift) continue;
    const key = `${dayKey(s)}|${s.mainLift}`;
    if (liftSeen.has(key)) continue;
    liftSeen.add(key);
    liftCounts[s.mainLift] += 1;
  }

  const sessionIds = new Set(blockSessions.map((s) => s.id));
  const tonnage = sets
    .filter((s) => s.sessionId && sessionIds.has(s.sessionId) && isCounted(s))
    .reduce((acc, s) => acc + s.weightKg * s.reps, 0);
  const dates = completedRows
    .map((s) => (s.workoutCompletedAt ?? s.completedAt)!)
    .sort();
  return {
    blockId,
    sessionsPlanned: planned,
    sessionsCompleted: completedDays.size,
    completionPercent: planned > 0 ? Math.min(100, (completedDays.size / planned) * 100) : 0,
    liftCounts,
    tonnageKg: tonnage,
    startedAt: dates[0],
    finishedAt: dates[dates.length - 1],
  };
}

interface SetWithSessionId extends MinimalSet {
  sessionId?: string;
}
export type _SetWithSessionId = SetWithSessionId;
