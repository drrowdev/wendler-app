import { describe, expect, it } from 'vitest';
import {
  bestE1rmSeries,
  blockCompletion,
  categorizePattern,
  dailyVolume,
  isoWeekKey,
  muscleVolume,
  pushPullBalance,
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
    ];

    it('aggregates tonnage by category and computes push/pull ratio', () => {
      const sets: MinimalSet[] = [
        set({ movementId: 'bench', weightKg: 100, reps: 5 }), // push 500
        set({ movementId: 'row', weightKg: 80, reps: 10 }), // pull 800
        set({ movementId: 'squat', weightKg: 120, reps: 5 }), // lower 600
        set({ movementId: 'plank', weightKg: 1, reps: 60 }), // core 60
      ];
      const bal = pushPullBalance(sets, movements);
      expect(bal.push).toBe(500);
      expect(bal.pull).toBe(800);
      expect(bal.lower).toBe(600);
      expect(bal.core).toBe(60);
      expect(bal.pushPullRatio).toBeCloseTo(0.625, 3);
    });

    it('returns null pushPullRatio when no pull volume', () => {
      const sets = [set({ movementId: 'bench' })];
      const bal = pushPullBalance(sets, movements);
      expect(bal.pushPullRatio).toBeNull();
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
      const sessions: MinimalSession[] = [
        { id: 's1', performedAt: '2026-04-01', mainLift: 'squat', blockId: 'b1', completedAt: '2026-04-01T11:00:00Z' },
        { id: 's2', performedAt: '2026-04-03', mainLift: 'bench', blockId: 'b1', completedAt: '2026-04-03T11:00:00Z' },
        { id: 's3', performedAt: '2026-04-05', mainLift: 'deadlift', blockId: 'b1' }, // not completed
        { id: 'sx', performedAt: '2026-04-02', mainLift: 'press', blockId: 'other', completedAt: '2026-04-02T11:00:00Z' },
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
  });
});
