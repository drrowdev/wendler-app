import type { MainLift, Movement, MovementPattern, MuscleGroup } from './types';
import { epley1RM } from './e1rm';

export interface MinimalSet {
  movementId: string;
  performedAt: string; // ISO
  weightKg: number;
  reps: number;
  rpe?: number;
  kind: 'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance' | 'joker';
  isAmrap?: boolean;
  skipped?: boolean;
  deletedAt?: string;
  sessionId?: string;
}

export interface MinimalSession {
  id: string;
  performedAt: string; // ISO
  mainLift?: MainLift;
  week?: 1 | 2 | 3 | 'deload';
  blockId?: string;
  completedAt?: string;
}

/** Best e1RM observed per ISO calendar day (yyyy-mm-dd) for a movement. */
export interface E1rmPoint {
  date: string; // yyyy-mm-dd
  e1rm: number;
  weightKg: number;
  reps: number;
}

const isCounted = (s: MinimalSet) => !s.skipped && !s.deletedAt && s.weightKg > 0 && s.reps > 0;

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
  /** Tonnage push/pull ratio. 1.0 = balanced. < 1 means more pull, > 1 more push. */
  pushPullRatio: number | null;
}

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
    if (!isCounted(s)) continue;
    const mv = byMovement.get(s.movementId);
    if (!mv) continue;
    const cat = categorizePattern(mv.pattern);
    out[cat] += s.weightKg * s.reps;
  }
  if (out.pull > 0) out.pushPullRatio = out.push / out.pull;
  return out;
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
  sessionsPlanned: number;
  sessionsCompleted: number;
  completionPercent: number;
  liftCounts: Record<MainLift, number>;
  tonnageKg: number;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Block completion: sessions completed within the block / planned (3 weeks * 4 lifts = 12 by default,
 * or 4 weeks if the block includes a deload).
 */
export function blockCompletion(
  blockId: string,
  sessions: MinimalSession[],
  sets: MinimalSet[],
  options: { weeksPerBlock?: number; liftsPerWeek?: number } = {},
): BlockCompletion {
  const weeks = options.weeksPerBlock ?? 3;
  const lifts = options.liftsPerWeek ?? 4;
  const planned = weeks * lifts;
  const blockSessions = sessions.filter((s) => s.blockId === blockId);
  const completed = blockSessions.filter((s) => !!s.completedAt);
  const liftCounts: Record<MainLift, number> = { squat: 0, bench: 0, deadlift: 0, press: 0 };
  for (const s of completed) {
    if (s.mainLift) liftCounts[s.mainLift] += 1;
  }
  const sessionIds = new Set(blockSessions.map((s) => s.id));
  const tonnage = sets
    .filter((s) => s.sessionId && sessionIds.has(s.sessionId) && isCounted(s))
    .reduce((acc, s) => acc + s.weightKg * s.reps, 0);
  const dates = completed
    .map((s) => s.completedAt!)
    .sort();
  return {
    blockId,
    sessionsPlanned: planned,
    sessionsCompleted: completed.length,
    completionPercent: planned > 0 ? Math.min(100, (completed.length / planned) * 100) : 0,
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
