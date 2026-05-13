import { describe, expect, it } from 'vitest';
import {
  bestE1rmSeries,
  blockCompletion,
  categorizePattern,
  dailyVolume,
  isoWeekKey,
  muscleVolume,
  pushPullBalance,
  weeklyPushPullBalance,
  weeklyVolume,
  type MinimalSession,
  type MinimalSet,
} from './analytics';
import type { Movement } from './types';

const set = (over: Partial<MinimalSet> = {}): MinimalSet => ({
  movementId: 'm1',
  performedAt: '2026-04-01T10:00:00Z',
  weightKg: 100,
  reps: 5,
  kind: 'main',
  ...over,
});

const mv = (over: Partial<Movement> & Pick<Movement, 'id'>): Movement => ({
  name: 'Test',
  equipment: 'barbell',
  pattern: 'squat',
  primaryMuscles: ['quads'],
  secondaryMuscles: [],
  ...over,
});

describe('analytics', () => {
  describe('bestE1rmSeries', () => {
    it('keeps the best e1RM per day, ignores warmups/skipped/deleted', () => {
      const sets: MinimalSet[] = [
        set({ performedAt: '2026-04-01T10:00:00Z', weightKg: 100, reps: 5 }), // e1RM 116.7
        set({ performedAt: '2026-04-01T10:30:00Z', weightKg: 110, reps: 3 }), // e1RM 121
        set({ performedAt: '2026-04-01T11:00:00Z', weightKg: 60, reps: 5, kind: 'warmup' }),
        set({ performedAt: '2026-04-02T10:00:00Z', weightKg: 105, reps: 5, skipped: true }),
        set({ performedAt: '2026-04-03T10:00:00Z', weightKg: 95, reps: 8 }),
      ];
      const series = bestE1rmSeries(sets, 'm1');
      expect(series.length).toBe(2);
      expect(series[0]!.date).toBe('2026-04-01');
      expect(series[0]!.e1rm).toBeCloseTo(121, 1);
      expect(series[1]!.date).toBe('2026-04-03');
    });

    it('returns empty array when no matching sets', () => {
      expect(bestE1rmSeries([set()], 'other')).toEqual([]);
    });
  });

  describe('dailyVolume / weeklyVolume', () => {
    it('sums tonnage, set count and reps per day', () => {
      const sets: MinimalSet[] = [
        set({ performedAt: '2026-04-01T10:00:00Z', weightKg: 100, reps: 5 }),
        set({ performedAt: '2026-04-01T11:00:00Z', weightKg: 100, reps: 5 }),
        set({ performedAt: '2026-04-02T10:00:00Z', weightKg: 80, reps: 10 }),
      ];
      const daily = dailyVolume(sets);
      expect(daily.length).toBe(2);
      expect(daily[0]!.tonnageKg).toBe(1000);
      expect(daily[0]!.sets).toBe(2);
      expect(daily[0]!.reps).toBe(10);
      expect(daily[1]!.tonnageKg).toBe(800);
    });

    it('weeklyVolume buckets by ISO week', () => {
      const sets: MinimalSet[] = [
        set({ performedAt: '2026-03-30T10:00:00Z', weightKg: 100, reps: 5 }), // W14
        set({ performedAt: '2026-04-02T10:00:00Z', weightKg: 100, reps: 5 }), // W14
        set({ performedAt: '2026-04-07T10:00:00Z', weightKg: 100, reps: 5 }), // W15
      ];
      const wk = weeklyVolume(sets);
      expect(wk.length).toBe(2);
      expect(wk[0]!.tonnageKg).toBe(1000);
      expect(wk[1]!.tonnageKg).toBe(500);
    });

    it('isoWeekKey formats as yyyy-Www with zero-padded week', () => {
      expect(isoWeekKey('2026-01-05T00:00:00Z')).toBe('2026-W02');
      expect(isoWeekKey('2026-04-01T00:00:00Z')).toBe('2026-W14');
    });
  });

  describe('pushPullBalance', () => {
    const movements: Movement[] = [
      mv({ id: 'bench', pattern: 'push-horizontal' }),
      mv({ id: 'row', pattern: 'pull-horizontal' }),
      mv({ id: 'squat', pattern: 'squat' }),
      mv({ id: 'plank', pattern: 'core' }),
      mv({ id: 'pallof', pattern: 'core' }),
    ];

    it('counts working sets per category and computes push/pull set ratio', () => {
      const sets: MinimalSet[] = [
        set({ movementId: 'bench', weightKg: 100, reps: 5 }),
        set({ movementId: 'bench', weightKg: 100, reps: 5 }),
        set({ movementId: 'row', weightKg: 80, reps: 10 }),
        set({ movementId: 'row', weightKg: 80, reps: 10 }),
        set({ movementId: 'row', weightKg: 80, reps: 10 }),
        set({ movementId: 'row', weightKg: 80, reps: 10 }),
        set({ movementId: 'squat', weightKg: 120, reps: 5 }),
        set({ movementId: 'plank', weightKg: 1, reps: 60 }),
      ];
      const bal = pushPullBalance(sets, movements);
      expect(bal.push).toBe(2);
      expect(bal.pull).toBe(4);
      expect(bal.lower).toBe(1);
      expect(bal.core).toBe(1);
      expect(bal.pushPullRatio).toBeCloseTo(0.5, 3);
    });

    it('counts zero-weight band/bodyweight sets so core work shows up', () => {
      const sets: MinimalSet[] = [
        set({ movementId: 'pallof', weightKg: 0, reps: 12 }),
        set({ movementId: 'pallof', weightKg: 0, reps: 12 }),
        set({ movementId: 'pallof', weightKg: 0, reps: 12 }),
      ];
      const bal = pushPullBalance(sets, movements);
      expect(bal.core).toBe(3);
    });

    it('still drops skipped, deleted, or zero-rep sets', () => {
      const sets: MinimalSet[] = [
        set({ movementId: 'pallof', weightKg: 0, reps: 0 }),
        set({ movementId: 'pallof', weightKg: 0, reps: 12, skipped: true }),
        set({ movementId: 'pallof', weightKg: 0, reps: 12, deletedAt: '2026-01-01T00:00:00Z' }),
      ];
      const bal = pushPullBalance(sets, movements);
      expect(bal.core).toBe(0);
    });

    it('returns null pushPullRatio when no pull volume', () => {
      const sets = [set({ movementId: 'bench' })];
      const bal = pushPullBalance(sets, movements);
      expect(bal.pushPullRatio).toBeNull();
    });

    it('weeklyPushPullBalance buckets working sets per ISO week', () => {
      const sets: MinimalSet[] = [
        set({ movementId: 'bench', performedAt: '2026-03-30T10:00:00Z', weightKg: 100, reps: 5 }),
        set({ movementId: 'bench', performedAt: '2026-03-30T10:05:00Z', weightKg: 100, reps: 5 }),
        set({ movementId: 'row', performedAt: '2026-03-31T10:00:00Z', weightKg: 80, reps: 10 }),
        set({ movementId: 'pallof', performedAt: '2026-03-31T10:30:00Z', weightKg: 0, reps: 12 }),
        set({ movementId: 'squat', performedAt: '2026-04-07T10:00:00Z', weightKg: 120, reps: 5 }),
      ];
      const wk = weeklyPushPullBalance(sets, movements);
      expect(wk.length).toBe(2);
      expect(wk[0]!.bucket).toBe('2026-W14');
      expect(wk[0]!.push).toBe(2);
      expect(wk[0]!.pull).toBe(1);
      expect(wk[0]!.core).toBe(1);
      expect(wk[0]!.total).toBe(4);
      expect(wk[1]!.lower).toBe(1);
      expect(wk[1]!.total).toBe(1);
    });
  });

  describe('categorizePattern', () => {
    it('maps patterns to high-level categories', () => {
      expect(categorizePattern('push-horizontal')).toBe('push');
      expect(categorizePattern('push-vertical')).toBe('push');
      expect(categorizePattern('pull-horizontal')).toBe('pull');
      expect(categorizePattern('squat')).toBe('lower');
      expect(categorizePattern('hinge')).toBe('lower');
      expect(categorizePattern('core')).toBe('core');
      expect(categorizePattern('carry')).toBe('other');
    });
  });

  describe('muscleVolume', () => {
    it('credits primary muscles 1.0× and secondary 0.5×', () => {
      const movements: Movement[] = [
        mv({
          id: 'bench',
          pattern: 'push-horizontal',
          primaryMuscles: ['chest'],
          secondaryMuscles: ['triceps', 'shoulders'],
        }),
      ];
      const sets = [set({ movementId: 'bench', weightKg: 100, reps: 5 })];
      const m = muscleVolume(sets, movements);
      expect(m.chest).toBe(500);
      expect(m.triceps).toBe(250);
      expect(m.shoulders).toBe(250);
    });
  });

  describe('blockCompletion', () => {
    it('reports completion %, lift counts, and tonnage', () => {
      // Two distinct day-groups completed (week 1, dayIndex 0 and 1) plus
      // one not-yet-completed deadlift row on day 2. Planned defaults to 12.
      const sessions: MinimalSession[] = [
        { id: 's1', performedAt: '2026-04-01', mainLift: 'squat', blockId: 'b1', week: 1, dayIndex: 0, completedAt: '2026-04-01T11:00:00Z' },
        { id: 's2', performedAt: '2026-04-03', mainLift: 'bench', blockId: 'b1', week: 1, dayIndex: 1, completedAt: '2026-04-03T11:00:00Z' },
        { id: 's3', performedAt: '2026-04-05', mainLift: 'deadlift', blockId: 'b1', week: 1, dayIndex: 2 }, // not completed
        { id: 'sx', performedAt: '2026-04-02', mainLift: 'press', blockId: 'other', week: 1, dayIndex: 0, completedAt: '2026-04-02T11:00:00Z' },
      ];
      const sets: MinimalSet[] = [
        { ...set({ weightKg: 100, reps: 5 }), sessionId: 's1' } as MinimalSet & { sessionId: string },
        { ...set({ weightKg: 80, reps: 10 }), sessionId: 's2' } as MinimalSet & { sessionId: string },
        { ...set({ weightKg: 999, reps: 1 }), sessionId: 'sx' } as MinimalSet & { sessionId: string },
      ];
      const r = blockCompletion('b1', sessions, sets);
      expect(r.sessionsPlanned).toBe(12);
      expect(r.sessionsCompleted).toBe(2);
      expect(r.completionPercent).toBeCloseTo((2 / 12) * 100, 3);
      expect(r.liftCounts.squat).toBe(1);
      expect(r.liftCounts.bench).toBe(1);
      expect(r.liftCounts.deadlift).toBe(0);
      expect(r.tonnageKg).toBe(100 * 5 + 80 * 10);
      expect(r.startedAt).toBe('2026-04-01T11:00:00Z');
      expect(r.finishedAt).toBe('2026-04-03T11:00:00Z');
    });

    it('counts WORKOUTS, not lift rows — multi-lift day = 1 day completed', () => {
      // Mon: bench + deadlift, both done → 1 workout. Wed: squat + press, both
      // done → 1 workout. Fri: anchor row (no mainLift) → 1 workout.
      // Planned 1 week × 3 days = 3.
      const stamp = '2026-05-04T12:00:00Z';
      const sessions: MinimalSession[] = [
        { id: 'a', performedAt: '2026-05-04', mainLift: 'bench', blockId: 'b1', week: '7w', dayIndex: 0, workoutCompletedAt: stamp },
        { id: 'b', performedAt: '2026-05-04', mainLift: 'deadlift', blockId: 'b1', week: '7w', dayIndex: 0, workoutCompletedAt: stamp },
        { id: 'c', performedAt: '2026-05-06', mainLift: 'squat', blockId: 'b1', week: '7w', dayIndex: 1, workoutCompletedAt: stamp },
        { id: 'd', performedAt: '2026-05-06', mainLift: 'press', blockId: 'b1', week: '7w', dayIndex: 1, workoutCompletedAt: stamp },
        { id: 'e', performedAt: '2026-05-08', blockId: 'b1', week: '7w', dayIndex: 2, workoutCompletedAt: stamp },
      ];
      const r = blockCompletion('b1', sessions, [], { weeksPerBlock: 1, daysPerWeek: 3 });
      expect(r.sessionsPlanned).toBe(3);
      expect(r.sessionsCompleted).toBe(3);
      expect(r.completionPercent).toBe(100);
      expect(r.liftCounts.squat).toBe(1);
      expect(r.liftCounts.bench).toBe(1);
      expect(r.liftCounts.deadlift).toBe(1);
      expect(r.liftCounts.press).toBe(1);
    });

    it('dedupes duplicate lift rows on the same day (race-condition safety)', () => {
      // Two squat rows for the same (week, dayIndex) — race in
      // useDaySessionRow created both. Should count as 1 squat, 1 day done.
      const stamp = '2026-05-07T10:46:00Z';
      const sessions: MinimalSession[] = [
        { id: 's1', performedAt: '2026-05-07T10:08Z', mainLift: 'squat', blockId: 'b1', week: '7w', dayIndex: 1, workoutCompletedAt: stamp },
        { id: 's2', performedAt: '2026-05-07T10:14Z', mainLift: 'squat', blockId: 'b1', week: '7w', dayIndex: 1, workoutCompletedAt: stamp },
        { id: 's3', performedAt: '2026-05-07T10:14Z', mainLift: 'press', blockId: 'b1', week: '7w', dayIndex: 1, workoutCompletedAt: stamp },
      ];
      const r = blockCompletion('b1', sessions, [], { weeksPerBlock: 1, daysPerWeek: 3 });
      expect(r.sessionsCompleted).toBe(1);
      expect(r.liftCounts.squat).toBe(1);
      expect(r.liftCounts.press).toBe(1);
    });
  });
});
