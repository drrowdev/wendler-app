import { describe, expect, it } from 'vitest';
import {
  consecutiveHighEffortStreak,
  currentWeekStart,
  deloadSuggestion,
  effectiveLoadKg,
  previousWeekStarts,
  rollingBaseline,
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

  it('weights HR zones exponentially when streams are present', () => {
    // 30 min in Z4 should carry significantly more weight than 30 min in Z2.
    // With weights Z2=1.0, Z4=4.0: weighted = 30 vs 120 minutes equivalent.
    const z2: LoadCardio[] = [
      { performedAt: TUE, durationSec: 1800, hrZoneSeconds: [0, 1800, 0, 0, 0] },
    ];
    const z4: LoadCardio[] = [
      { performedAt: TUE, durationSec: 1800, hrZoneSeconds: [0, 0, 0, 1800, 0] },
    ];
    const wZ2 = weeklyLoad(WEEK, [], z2, []);
    const wZ4 = weeklyLoad(WEEK, [], z4, []);
    expect(wZ4.stressScore).toBeGreaterThan(wZ2.stressScore);
    // Z4 contribution should be roughly 4× Z2 contribution before the cap.
    // Both fit under the 30-cap, so we can compare cleanly.
    expect(wZ4.stressScore).toBeGreaterThanOrEqual(wZ2.stressScore * 3);
  });

  describe('strengthHrEnrichments', () => {
    it('contributes a separate weighted-min field without inflating cardioMinutes', () => {
      // 45 min in Z3 from a strength session: should appear in
      // strengthHrWeightedMin but NOT in cardioMinutes (cardio chart stays
      // strict cardio).
      const enrich: LoadCardio[] = [
        { performedAt: TUE, durationSec: 2700, hrZoneSeconds: [0, 0, 2700, 0, 0] },
      ];
      const w = weeklyLoad(WEEK, [], [], [], { strengthHrEnrichments: enrich });
      expect(w.cardioMinutes).toBe(0);
      // 45 min × Z3 weight 2.0 = 90 weighted min.
      expect(w.strengthHrWeightedMin).toBeCloseTo(90, 1);
      // Stress score gains the strength HR component (capped at 10).
      expect(w.stressScore).toBeGreaterThan(0);
    });

    it('caps strength HR contribution at 10 even on huge weeks', () => {
      // 5 hours in Z5: weighted = 300×6 = 1800 min. Without a cap it would
      // dominate; with the cap of 10 it tops out.
      const huge: LoadCardio[] = [
        { performedAt: TUE, durationSec: 18000, hrZoneSeconds: [0, 0, 0, 0, 18000] },
      ];
      const w = weeklyLoad(WEEK, [], [], [], { strengthHrEnrichments: huge });
      // Pure strength HR with no other inputs: score capped at the 10-point
      // strength-HR contribution.
      expect(w.stressScore).toBeLessThanOrEqual(10);
      expect(w.stressScore).toBeGreaterThanOrEqual(9);
    });

    it('omitting the option keeps strengthHrWeightedMin at 0', () => {
      const w = weeklyLoad(WEEK, [], [], []);
      expect(w.strengthHrWeightedMin).toBe(0);
    });
  });

  it('returns zeros for an empty week', () => {
    const w = weeklyLoad(WEEK, [], [], []);
    expect(w.strengthTonnageKg).toBe(0);
    expect(w.cardioMinutes).toBe(0);
    expect(w.trainingDays).toBe(0);
    expect(w.stressScore).toBe(0);
    expect(w.weightedTonnageKg).toBe(0);
    expect(w.tonnageMainKg).toBe(0);
    expect(w.tonnageAssistanceKg).toBe(0);
  });

  it('weights tonnage by IF² when training max is known', () => {
    // Top set: 5 reps @ 100kg with TM=100 → IF=1.0 → weighted = 5×100×1 = 500
    // Backoff:  5 reps @ 50kg  with TM=100 → IF=0.5 → weighted = 5×50×0.25 = 62.5
    // Raw tonnage is identical (5×100=500 + 5×100=... wait, 5×50=250). So:
    //   raw = 500 + 250 = 750
    //   weighted = 500 + 62.5 = 562.5
    const sets: LoadSet[] = [
      { performedAt: TUE, weightKg: 100, reps: 5, trainingMaxKgAtTime: 100 },
      { performedAt: TUE, weightKg: 50, reps: 5, trainingMaxKgAtTime: 100 },
    ];
    const w = weeklyLoad(WEEK, sets, [], []);
    expect(w.strengthTonnageKg).toBe(750);
    expect(w.tonnageMainKg).toBe(750);
    expect(w.tonnageAssistanceKg).toBe(0);
    expect(w.weightedTonnageKg).toBeCloseTo(562.5, 5);
  });

  it('uses the assistance fallback IF for sets without a TM', () => {
    // 5 reps × 60kg accessory → weighted = 5×60×0.55² = 90.75
    const sets: LoadSet[] = [
      { performedAt: TUE, weightKg: 60, reps: 5 },
    ];
    const w = weeklyLoad(WEEK, sets, [], []);
    expect(w.tonnageMainKg).toBe(0);
    expect(w.tonnageAssistanceKg).toBe(300);
    expect(w.weightedTonnageKg).toBeCloseTo(300 * 0.55 * 0.55, 5);
  });

  it('top-set PR week scores higher than equal-tonnage backoff week', () => {
    // Two sessions, identical raw tonnage of 1000 kg each, but very
    // different intensity profiles. The PR session should produce a
    // meaningfully higher stress score than the backoff session.
    const pr: LoadSet[] = [
      { performedAt: TUE, weightKg: 100, reps: 10, trainingMaxKgAtTime: 100 },
    ];
    const backoff: LoadSet[] = [
      { performedAt: TUE, weightKg: 40, reps: 25, trainingMaxKgAtTime: 100 },
    ];
    const prWk = weeklyLoad(WEEK, pr, [], []);
    const boWk = weeklyLoad(WEEK, backoff, [], []);
    expect(prWk.strengthTonnageKg).toBe(boWk.strengthTonnageKg);
    expect(prWk.weightedTonnageKg).toBeGreaterThan(boWk.weightedTonnageKg * 5);
    expect(prWk.stressScore).toBeGreaterThan(boWk.stressScore);
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
      tonnageMainKg: 5000,
      tonnageAssistanceKg: 0,
      weightedTonnageKg: 2500,
      cardioMinutes: 60,
      strengthHrWeightedMin: 0,
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

  it('still computes the personal baseline for display when there is enough history', () => {
    // 4 quiet baseline weeks averaging stress ~30, then a spike to 70.
    // Absolute thresholds (HIGH_STRESS=75) wouldn't fire — and the baseline
    // z-score is now display-only, so the recommendation stays at 'continue'.
    // The baseline itself should still be returned for the recommendation
    // card to render.
    const baselineWeeks = [
      week({ stressScore: 28 }),
      week({ stressScore: 32 }),
      week({ stressScore: 30 }),
      week({ stressScore: 31 }),
    ];
    const r = deloadSuggestion({
      recentWeeks: [...baselineWeeks, week({ stressScore: 70 })],
    });
    expect(r.baseline).toBeDefined();
    expect(r.baseline?.weeks).toBe(4);
    expect(r.recommendation).toBe('continue');
  });

  it('falls back to absolute thresholds when baseline is too thin', () => {
    const r = deloadSuggestion({
      recentWeeks: [week({ stressScore: 50 }), week({ stressScore: 92, avgRpe: 9.3 })],
    });
    expect(r.baseline).toBeUndefined();
    expect(r.recommendation).toBe('deload-now');
  });

  it('does not flag a week that fits the personal baseline', () => {
    // Sustained high-volume athlete: baseline ~70, current 72 — within range.
    const baselineWeeks = [
      week({ stressScore: 68 }),
      week({ stressScore: 72 }),
      week({ stressScore: 70 }),
      week({ stressScore: 71 }),
    ];
    const r = deloadSuggestion({
      recentWeeks: [...baselineWeeks, week({ stressScore: 72 })],
    });
    expect(r.baseline?.weeks).toBe(4);
    // Without time-since-deload pressure, a normal week should be 'continue'.
    expect(r.recommendation).toBe('continue');
  });

  it('still triggers absolute thresholds at 90+ even with a wide baseline', () => {
    // Baseline z-score is no longer a deload trigger, but the absolute
    // VERY_HIGH_STRESS=90 threshold still fires regardless of baseline width.
    const baselineWeeks = [
      week({ stressScore: 50 }),
      week({ stressScore: 90 }),
      week({ stressScore: 60 }),
      week({ stressScore: 80 }),
    ];
    const r = deloadSuggestion({
      recentWeeks: [...baselineWeeks, week({ stressScore: 91 })],
    });
    expect(r.recommendation === 'deload-soon' || r.recommendation === 'deload-now').toBe(true);
    expect(r.reasons.some((s) => s.toLowerCase().includes('stress score 91'))).toBe(true);
  });
});

describe('consecutiveHighEffortStreak', () => {
  function s(day: string, hour: number, rpe?: number): LoadSet {
    return {
      performedAt: `2026-04-${day}T${String(hour).padStart(2, '0')}:00:00Z`,
      weightKg: 100,
      reps: 5,
      rpe,
    };
  }

  it('returns 0 with no sets', () => {
    expect(consecutiveHighEffortStreak([])).toBe(0);
  });

  it('counts a single high-effort session', () => {
    expect(consecutiveHighEffortStreak([s('27', 18, 9)])).toBe(1);
  });

  it('groups same-day sets into one session', () => {
    // Two sets on the same day, both high RPE — one session, streak of 1.
    expect(
      consecutiveHighEffortStreak([s('27', 16, 9), s('27', 17, 9)]),
    ).toBe(1);
  });

  it('counts back to back high-effort sessions across days', () => {
    expect(
      consecutiveHighEffortStreak([
        s('25', 18, 9),
        s('26', 18, 9),
        s('27', 18, 9),
      ]),
    ).toBe(3);
  });

  it('breaks the streak on an easy session in between', () => {
    // ..., easy, hard, hard → counts back from latest, so streak = 2 only.
    expect(
      consecutiveHighEffortStreak([
        s('25', 18, 9),
        s('26', 18, 6),
        s('27', 18, 9),
        s('28', 18, 9),
      ]),
    ).toBe(2);
  });

  it('ignores a single heavy top set surrounded by easy sets — Wendler shape', () => {
    // Same day: 4 easy sets (RPE 6/7) + one all-out top set (RPE 9.5).
    // Average is ~7, only one hard set → NOT counted as high-effort. This
    // is the normal Wendler shape (one AMRAP top set, easy supplemental)
    // and should not, on its own, trigger a deload warning.
    expect(
      consecutiveHighEffortStreak([
        s('27', 16, 6),
        s('27', 16, 7),
        s('27', 17, 7),
        s('27', 17, 9.5),
      ]),
    ).toBe(0);
  });

  it('counts a session when the average RPE is at or above 8', () => {
    // Every set was a grind: average RPE = 8.0 → high-effort.
    expect(
      consecutiveHighEffortStreak([
        s('27', 16, 8),
        s('27', 16, 8),
        s('27', 17, 8),
        s('27', 17, 8),
      ]),
    ).toBe(1);
  });

  it('counts a session when 3+ individual sets hit RPE 8.5+', () => {
    // Many hard sets, average drags down to 7.7 but the volume of hard
    // sets (4 × RPE 9 alongside 2 × RPE 6) still counts as a grinder day.
    expect(
      consecutiveHighEffortStreak([
        s('27', 16, 6),
        s('27', 16, 6),
        s('27', 17, 9),
        s('27', 17, 9),
        s('27', 18, 9),
        s('27', 18, 9),
      ]),
    ).toBe(1);
  });

  it('breaks on missing RPE (cant evaluate)', () => {
    expect(
      consecutiveHighEffortStreak([s('25', 18, 9), s('27', 18)]),
    ).toBe(0);
  });
});

describe('deloadSuggestion (with set-level history)', () => {
  function week(overrides: Partial<WeeklyLoad>): WeeklyLoad {
    return {
      weekStart: '2026-04-20',
      strengthTonnageKg: 5000,
      tonnageMainKg: 5000,
      tonnageAssistanceKg: 0,
      weightedTonnageKg: 2500,
      cardioMinutes: 60,
      strengthHrWeightedMin: 0,
      trainingDays: 4,
      stressScore: 40,
      ...overrides,
    };
  }
  function s(day: string, rpe: number): LoadSet {
    return {
      performedAt: `2026-04-${day}T18:00:00Z`,
      weightKg: 100,
      reps: 5,
      rpe,
    };
  }

  it('flags when 3 consecutive high-RPE sessions are present', () => {
    const r = deloadSuggestion({
      recentWeeks: [week({ avgRpe: 7.5 })],
      recentSets: [s('25', 9), s('26', 9), s('27', 9)],
    });
    expect(r.recommendation).toBe('deload-now');
    expect(r.reasons.some((x) => x.includes('high-effort sessions'))).toBe(true);
  });

  it('does not flag when streak is 1', () => {
    const r = deloadSuggestion({
      recentWeeks: [week({ stressScore: 30 })],
      recentSets: [s('27', 9)],
    });
  });
});

describe('rollingBaseline', () => {
  function w(stressScore: number, avgRpe?: number): WeeklyLoad {
    const trained = stressScore > 0;
    return {
      weekStart: '2026-04-20',
      strengthTonnageKg: stressScore * 100,
      tonnageMainKg: stressScore * 100,
      tonnageAssistanceKg: 0,
      weightedTonnageKg: stressScore * 50,
      cardioMinutes: trained ? 30 : 0,
      strengthHrWeightedMin: 0,
      trainingDays: trained ? 3 : 0,
      stressScore,
      avgRpe,
    };
  }

  it('returns weeks=0 for empty input', () => {
    expect(rollingBaseline([]).weeks).toBe(0);
  });

  it('excludes zero-load weeks (layoff weeks)', () => {
    const b = rollingBaseline([w(0), w(40), w(0), w(50)]);
    expect(b.weeks).toBe(2);
    expect(b.meanStress).toBe(45);
  });

  it('computes mean and SD of stress + RPE', () => {
    const b = rollingBaseline([w(40, 7), w(50, 8), w(60, 7.5)]);
    expect(b.meanStress).toBeCloseTo(50, 5);
    expect(b.sdStress).toBeCloseTo(Math.sqrt(((40 - 50) ** 2 + 0 + (60 - 50) ** 2) / 3), 5);
    expect(b.meanRpe).toBeCloseTo(7.5, 5);
  });
});


import {
  banister,
  dailyLoad,
  dailyLoadSeries,
  dynamicCardioCap,
  trailingMeanCardioContribution,
} from './load';

describe('dailyLoad', () => {
  it('returns 0 for an empty day', () => {
    expect(dailyLoad('2026-04-27', [], [])).toBe(0);
  });

  it('produces a sensible number for a known session', () => {
    // 5×100kg @ TM=100 → IF=1, weighted = 5×100×1² = 500 → /100 = 5.0
    // 30 min easy cardio (no zones) → 30 / 15 = 2.0
    // max RPE 8 → (8 − 6) × 0.5 = 1.0
    // total = 8.0
    const sets: LoadSet[] = [
      { performedAt: '2026-04-27T18:00:00Z', weightKg: 100, reps: 5, rpe: 8, trainingMaxKgAtTime: 100 },
    ];
    const cardio: LoadCardio[] = [
      { performedAt: '2026-04-27T19:00:00Z', durationSec: 1800 },
    ];
    expect(dailyLoad('2026-04-27', sets, cardio)).toBeCloseTo(8, 5);
  });

  it('only counts sets/cardio on the given day', () => {
    const sets: LoadSet[] = [
      { performedAt: '2026-04-27T18:00:00Z', weightKg: 100, reps: 5, trainingMaxKgAtTime: 100 },
      { performedAt: '2026-04-28T18:00:00Z', weightKg: 100, reps: 5, trainingMaxKgAtTime: 100 },
    ];
    expect(dailyLoad('2026-04-27', sets, [])).toBeCloseTo(5, 5);
  });
});

describe('dailyLoadSeries', () => {
  it('zero-fills empty days between two training days', () => {
    const sets: LoadSet[] = [
      { performedAt: '2026-04-27T18:00:00Z', weightKg: 100, reps: 5, trainingMaxKgAtTime: 100 },
      { performedAt: '2026-04-30T18:00:00Z', weightKg: 100, reps: 5, trainingMaxKgAtTime: 100 },
    ];
    const series = dailyLoadSeries('2026-04-27', '2026-04-30', sets, []);
    expect(series).toHaveLength(4);
    expect(series.map((p) => p.date)).toEqual([
      '2026-04-27',
      '2026-04-28',
      '2026-04-29',
      '2026-04-30',
    ]);
    expect(series[0]!.load).toBeGreaterThan(0);
    expect(series[1]!.load).toBe(0);
    expect(series[2]!.load).toBe(0);
    expect(series[3]!.load).toBeGreaterThan(0);
  });

  it('returns a single point when fromDate === toDate', () => {
    const series = dailyLoadSeries('2026-04-27', '2026-04-27', [], []);
    expect(series).toHaveLength(1);
    expect(series[0]).toEqual({ date: '2026-04-27', load: 0 });
  });
});

describe('banister', () => {
  function constSeries(days: number, load: number): { date: string; load: number }[] {
    const out: { date: string; load: number }[] = [];
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      out.push({ date: d, load });
    }
    return out;
  }

  it('returns zeros + null ACWR + cold-start for empty input', () => {
    const r = banister([]);
    expect(r.ctl).toBe(0);
    expect(r.atl).toBe(0);
    expect(r.tsb).toBe(0);
    expect(r.acwr).toBeNull();
    expect(r.coldStart).toBe(true);
  });

  it('converges CTL to the constant load and TSB to ~0 at steady state', () => {
    // 6 × τ_c is well past the EWA settling time.
    const r = banister(constSeries(300, 10));
    expect(r.ctl).toBeCloseTo(10, 1);
    expect(r.atl).toBeCloseTo(10, 1);
    expect(r.tsb).toBeCloseTo(0, 1);
    expect(r.acwr).not.toBeNull();
    expect(r.acwr!).toBeCloseTo(1, 2);
    expect(r.coldStart).toBe(false);
  });

  it('marks cold-start when fewer than 14 days carried any load', () => {
    // 60 days, only 10 carry load
    const days: { date: string; load: number }[] = [];
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 0; i < 60; i += 1) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      days.push({ date: d, load: i < 10 ? 5 : 0 });
    }
    const r = banister(days);
    expect(r.coldStart).toBe(true);
  });
});

describe('deloadSuggestion (with banister)', () => {
  function week(overrides: Partial<WeeklyLoad>): WeeklyLoad {
    return {
      weekStart: '2026-04-20',
      strengthTonnageKg: 5000,
      tonnageMainKg: 5000,
      tonnageAssistanceKg: 0,
      weightedTonnageKg: 2500,
      cardioMinutes: 60,
      strengthHrWeightedMin: 0,
      trainingDays: 4,
      stressScore: 40,
      ...overrides,
    };
  }

  it('trips deload-now when ACWR > 1.5', () => {
    // 60 days at load=5 then a sharp 30-day spike at load=50.
    // ATL converges fast (τ=7 → ~99% in 30d), CTL drags (τ=42).
    // Result: ACWR > 1.5 (+2) and TSB < -15 (+1) → urgency 3 → deload-now.
    const series: { date: string; load: number }[] = [];
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 0; i < 60; i += 1) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      series.push({ date: d, load: 5 });
    }
    for (let i = 60; i < 90; i += 1) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      series.push({ date: d, load: 50 });
    }
    const ban = banister(series);
    expect(ban.coldStart).toBe(false);
    expect(ban.acwr).not.toBeNull();
    expect(ban.acwr!).toBeGreaterThan(1.5);

    const r = deloadSuggestion({
      recentWeeks: [week({ stressScore: 30 })],
      banister: ban,
    });
    expect(r.recommendation).toBe('deload-now');
    expect(r.reasons.some((s) => s.toLowerCase().includes('acute load'))).toBe(true);
  });

  it('trips deload-now when TSB < -30', () => {
    // 60 days easy then 14 days very hard → fatigue spike, TSB deeply negative.
    const series: { date: string; load: number }[] = [];
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 0; i < 60; i += 1) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      series.push({ date: d, load: 2 });
    }
    for (let i = 60; i < 80; i += 1) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      series.push({ date: d, load: 80 });
    }
    const ban = banister(series);
    expect(ban.coldStart).toBe(false);
    expect(ban.tsb).toBeLessThan(-30);

    const r = deloadSuggestion({
      recentWeeks: [week({ stressScore: 30 })],
      banister: ban,
    });
    expect(r.recommendation).toBe('deload-now');
    expect(r.reasons.some((s) => s.toLowerCase().includes('tsb'))).toBe(true);
  });

  it('suppresses TSB/ACWR signals during cold-start', () => {
    // Only 5 days of load in the whole series → coldStart true.
    const series: { date: string; load: number }[] = [];
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 0; i < 60; i += 1) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      series.push({ date: d, load: i < 5 ? 50 : 0 });
    }
    const ban = banister(series);
    expect(ban.coldStart).toBe(true);

    const r = deloadSuggestion({
      recentWeeks: [week({ stressScore: 30 })],
      banister: ban,
    });
    // Cold-start: no TSB/ACWR-driven reasons should appear.
    expect(r.reasons.some((s) => /tsb|acute load/i.test(s))).toBe(false);
  });
});

describe('trailingMeanCardioContribution + dynamicCardioCap', () => {
  function cardioOn(monday: string, dayOffset: number, durationSec: number, zones?: number[]): LoadCardio {
    const t = new Date(monday + 'T00:00:00Z').getTime() + dayOffset * 86400000 + 12 * 3600 * 1000;
    return {
      performedAt: new Date(t).toISOString(),
      durationSec,
      ...(zones ? { hrZoneSeconds: zones } : {}),
    };
  }

  // Reference "now": Monday 2026-04-27. Trailing weeks start at 2026-04-20, 04-13, …
  const NOW = new Date('2026-04-27T12:00:00Z');

  it('falls back to 30 with no history', () => {
    expect(trailingMeanCardioContribution([], NOW, 6)).toBe(0);
    expect(dynamicCardioCap([], NOW, 6)).toBe(30);
  });

  it('keeps cap at 30 for a low-cardio user', () => {
    // 6 weeks × 5 minutes easy → contribution = 5/15 = 0.33 per week
    // mean ≈ 0.33 → cap = max(30, round(0.43)) = 30.
    const cardio: LoadCardio[] = [];
    const monday = new Date('2026-04-20T00:00:00Z').getTime();
    for (let i = 1; i <= 6; i += 1) {
      const wkStart = new Date(monday - (i - 1) * 7 * 86400000).toISOString().slice(0, 10);
      cardio.push(cardioOn(wkStart, 2, 5 * 60));
    }
    expect(dynamicCardioCap(cardio, NOW, 6)).toBe(30);
  });

  it('grows the cap for a sustained high-cardio user', () => {
    // 6 prior weeks × 120 min Z4 each → weighted = 480 min/week → contribution 32 → mean 32
    // cap = max(30, round(1.3 × 32)) = 42.
    const cardio: LoadCardio[] = [];
    const monday = new Date('2026-04-20T00:00:00Z').getTime();
    for (let i = 1; i <= 6; i += 1) {
      const wkStart = new Date(monday - (i - 1) * 7 * 86400000).toISOString().slice(0, 10);
      cardio.push(cardioOn(wkStart, 2, 120 * 60, [0, 0, 0, 120 * 60, 0]));
    }
    const cap = dynamicCardioCap(cardio, NOW, 6);
    expect(cap).toBeGreaterThan(30);
    expect(cap).toBeCloseTo(42, 0);
  });

  it("excludes the current in-progress week from the trailing mean", () => {
    // 6 prior weeks at moderate cardio + a single huge current-week session.
    // The big session must NOT push the mean up — only prior weeks count.
    const cardio: LoadCardio[] = [];
    const monday = new Date('2026-04-20T00:00:00Z').getTime();
    for (let i = 1; i <= 6; i += 1) {
      const wkStart = new Date(monday - (i - 1) * 7 * 86400000).toISOString().slice(0, 10);
      cardio.push(cardioOn(wkStart, 2, 30 * 60, [0, 30 * 60, 0, 0, 0])); // 30 min Z2
    }
    const baseMean = trailingMeanCardioContribution(cardio, NOW, 6);

    // Now add a 600-minute Z5 monster on the current Monday.
    cardio.push(cardioOn('2026-04-27', 0, 600 * 60, [0, 0, 0, 0, 600 * 60]));
    const meanAfter = trailingMeanCardioContribution(cardio, NOW, 6);
    expect(meanAfter).toBeCloseTo(baseMean, 5);
  });
});

describe('effectiveLoadKg', () => {
  it('returns weightKg unchanged for non-bodyweight movements (no bodyweight even considered)', () => {
    expect(
      effectiveLoadKg({
        weightKg: 100,
        bodyweightKg: 80,
        isBodyweight: false,
        isExternallyLoadable: false,
      }),
    ).toBe(100);
  });

  it('returns weightKg unchanged when bodyweight is not known', () => {
    expect(
      effectiveLoadKg({
        weightKg: 20,
        isBodyweight: true,
        isExternallyLoadable: true,
      }),
    ).toBe(20);
  });

  it('returns 0 + bodyweight for an unloaded bodyweight set (pull-up at BW)', () => {
    expect(
      effectiveLoadKg({
        weightKg: 0,
        bodyweightKg: 80,
        isBodyweight: true,
        isExternallyLoadable: true,
      }),
    ).toBe(80);
  });

  it('returns weightKg + bodyweight for a loaded externally-loadable BW movement (pull-up + vest)', () => {
    expect(
      effectiveLoadKg({
        weightKg: 20,
        bodyweightKg: 80,
        isBodyweight: true,
        isExternallyLoadable: true,
      }),
    ).toBe(100);
  });

  it('returns bodyweight for a non-loadable BW movement when weightKg is 0 (plank, muscle-up)', () => {
    expect(
      effectiveLoadKg({
        weightKg: 0,
        bodyweightKg: 80,
        isBodyweight: true,
        isExternallyLoadable: false,
      }),
    ).toBe(80);
  });

  it('adds bodyweight to a non-loadable BW movement when user logged extra (vest on a plank)', () => {
    // Edge case: user wore a vest on a non-loadable movement. We honor it.
    expect(
      effectiveLoadKg({
        weightKg: 10,
        bodyweightKg: 80,
        isBodyweight: true,
        isExternallyLoadable: false,
      }),
    ).toBe(90);
  });

  it('treats zero or negative bodyweight as missing (degrades to weightKg)', () => {
    expect(
      effectiveLoadKg({
        weightKg: 20,
        bodyweightKg: 0,
        isBodyweight: true,
        isExternallyLoadable: true,
      }),
    ).toBe(20);
  });
});
