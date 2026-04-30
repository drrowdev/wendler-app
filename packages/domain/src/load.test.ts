import { describe, expect, it } from 'vitest';
import {
  currentWeekStart,
  deloadSuggestion,
  previousWeekStarts,
  weeklyLoad,
  type LoadCardio,
  type LoadRecovery,
  type LoadSet,
  type WeeklyLoad,
} from './load';

const WEEK = '2026-04-27'; // Mon
const TUE = '2026-04-28T18:00:00Z';
const WED = '2026-04-29T18:00:00Z';

describe('weeklyLoad', () => {
  it('aggregates tonnage, cardio, and days', () => {
    const sets: LoadSet[] = [
      { performedAt: TUE, weightKg: 100, reps: 5 },
      { performedAt: TUE, weightKg: 100, reps: 5 },
      { performedAt: WED, weightKg: 60, reps: 10, rpe: 7 },
    ];
    const cardio: LoadCardio[] = [{ performedAt: WED, durationSec: 1800 }];
    const recovery: LoadRecovery[] = [
      { id: '2026-04-27', sleepHours: 8, fatigue: 4 },
      { id: '2026-04-29', sleepHours: 7, fatigue: 5 },
    ];
    const w = weeklyLoad(WEEK, sets, cardio, recovery);
    expect(w.strengthTonnageKg).toBe(1600);
    expect(w.cardioMinutes).toBe(30);
    expect(w.trainingDays).toBe(2);
    expect(w.avgSleep).toBeCloseTo(7.5, 5);
    expect(w.stressScore).toBeGreaterThan(0);
    expect(w.stressScore).toBeLessThanOrEqual(100);
  });

  it('excludes skipped and deleted sets', () => {
    const sets: LoadSet[] = [
      { performedAt: TUE, weightKg: 100, reps: 5 },
      { performedAt: TUE, weightKg: 100, reps: 5, skipped: true },
      { performedAt: TUE, weightKg: 100, reps: 5, deletedAt: '2026-04-29T00:00:00Z' },
    ];
    const w = weeklyLoad(WEEK, sets, [], []);
    expect(w.strengthTonnageKg).toBe(500);
  });

  it('returns zeros for an empty week', () => {
    const w = weeklyLoad(WEEK, [], [], []);
    expect(w.strengthTonnageKg).toBe(0);
    expect(w.cardioMinutes).toBe(0);
    expect(w.trainingDays).toBe(0);
    expect(w.stressScore).toBe(0);
  });
});

describe('previousWeekStarts', () => {
  it('returns N Mondays oldest-first', () => {
    const starts = previousWeekStarts(new Date('2026-04-30T12:00:00Z'), 4);
    expect(starts).toHaveLength(4);
    expect(starts[3]).toBe('2026-04-27');
    expect(starts[0]).toBe('2026-04-06');
  });

  it('currentWeekStart is the Monday of the given date', () => {
    expect(currentWeekStart(new Date('2026-04-30T12:00:00Z'))).toBe('2026-04-27');
    expect(currentWeekStart(new Date('2026-04-27T00:00:00Z'))).toBe('2026-04-27');
  });
});

describe('deloadSuggestion', () => {
  function week(overrides: Partial<WeeklyLoad>): WeeklyLoad {
    return {
      weekStart: '2026-04-20',
      strengthTonnageKg: 5000,
      cardioMinutes: 60,
      trainingDays: 4,
      stressScore: 40,
      ...overrides,
    };
  }

  it('says continue when load is moderate', () => {
    const r = deloadSuggestion({
      recentWeeks: [week({ stressScore: 30 }), week({ stressScore: 35 })],
    });
    expect(r.recommendation).toBe('continue');
  });

  it('flags deload-now when fatigue + RPE + stress all elevated', () => {
    const r = deloadSuggestion({
      recentWeeks: [
        week({ stressScore: 60, avgRpe: 8.7, avgFatigue: 7.5 }),
        week({ stressScore: 92, avgRpe: 9.3, avgFatigue: 8 }),
      ],
    });
    expect(r.recommendation).toBe('deload-now');
    expect(r.reasons.length).toBeGreaterThan(1);
  });

  it('flags deload-soon when only one indicator is high', () => {
    const r = deloadSuggestion({
      recentWeeks: [week({ avgRpe: 8.6 })],
    });
    expect(r.recommendation).toBe('deload-soon');
  });

  it('counts time since last deload', () => {
    const r = deloadSuggestion({
      recentWeeks: [week({})],
      lastDeloadAt: '2026-03-01T00:00:00Z',
      now: new Date('2026-04-30T00:00:00Z'),
    });
    expect(r.recommendation === 'deload-soon' || r.recommendation === 'deload-now').toBe(true);
  });
});
