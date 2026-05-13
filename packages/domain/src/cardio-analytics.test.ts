import { describe, expect, it } from 'vitest';
import {
  aggregateHrZones,
  classifyIntensity,
  computeCardioFatigueShift,
  intensityLabel,
  polarizedSummary,
  runPlanAdherence,
  trainingCalendar,
  weeklyCardio,
  type MinimalCardio,
} from './cardio-analytics';
import type { RunPlanSlot } from './types';

const c = (over: Partial<MinimalCardio> = {}): MinimalCardio => ({
  id: over.id ?? 'a',
  performedAt: '2026-04-06T08:00:00Z', // Mon
  modality: 'run',
  durationSec: 45 * 60,
  ...over,
});

describe('weeklyCardio', () => {
  it('buckets per ISO week and splits by modality', () => {
    const out = weeklyCardio([
      c({ id: '1', performedAt: '2026-04-06T08:00:00Z', modality: 'run', durationSec: 30 * 60, distanceKm: 5 }),
      c({ id: '2', performedAt: '2026-04-08T08:00:00Z', modality: 'bike', durationSec: 60 * 60, distanceKm: 25 }),
      c({ id: '3', performedAt: '2026-04-13T08:00:00Z', modality: 'run', durationSec: 50 * 60, distanceKm: 8 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.bucket).toBe('2026-W15');
    expect(out[0]!.totalMinutes).toBe(90);
    expect(out[0]!.minutesByModality.run).toBe(30);
    expect(out[0]!.minutesByModality.bike).toBe(60);
    expect(out[0]!.totalKm).toBe(30);
    expect(out[1]!.bucket).toBe('2026-W16');
    expect(out[1]!.sessions).toBe(1);
  });

  it('skips zero-duration sessions', () => {
    const out = weeklyCardio([c({ durationSec: 0 })]);
    expect(out).toEqual([]);
  });
});

describe('aggregateHrZones', () => {
  it('sums per-zone seconds', () => {
    const out = aggregateHrZones([
      c({ hrZoneSeconds: [600, 1200, 300, 0, 0] }),
      c({ hrZoneSeconds: [120, 800, 200, 60, 0] }),
      c({ hrZoneSeconds: undefined }), // skipped
    ]);
    expect(out).toEqual([720, 2000, 500, 60, 0]);
  });

  it('returns zero array when nothing has zones', () => {
    expect(aggregateHrZones([c()])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('classifyIntensity', () => {
  // Helpers for round numbers — total 60 min unless noted.
  const z = (z1: number, z2: number, z3: number, z4: number, z5: number) => ({
    hrZoneSeconds: [z1, z2, z3, z4, z5].map((m) => m * 60),
    durationSec: (z1 + z2 + z3 + z4 + z5) * 60,
  });

  it('returns none when there is no zone data', () => {
    expect(classifyIntensity({ durationSec: 3600 }).tag).toBe('none');
  });

  it('returns none for very short sessions (<10 min default)', () => {
    expect(classifyIntensity(z(2, 4, 0, 0, 0)).tag).toBe('none');
  });

  it('tags a long ride dominated by Z1+Z2 with little hard work as easy', () => {
    // 50 min Z2, 10 min Z1, 5 min Z3 → easy 86%, hard 0%.
    const out = classifyIntensity(z(10, 50, 5, 0, 0));
    expect(out.tag).toBe('easy');
    expect(out.easyShare).toBeCloseTo(60 / 65, 2);
  });

  it('tags walks / cool-downs (Z1 ≥70%) as recovery', () => {
    expect(classifyIntensity(z(50, 10, 0, 0, 0)).tag).toBe('recovery');
  });

  it('tags interval workouts with ≥20% Z4+Z5 as hard', () => {
    // 10 min Z1 warm-up + 10 min Z4 + 5 min Z5 + 10 min Z2 cool-down.
    // hard share = 15/35 ≈ 0.43.
    expect(classifyIntensity(z(10, 10, 0, 10, 5)).tag).toBe('hard');
  });

  it('tags meaningful Z3 without hard work as threshold', () => {
    // 30 min Z3 + 20 min Z2 + 10 min Z1.  grey share = 0.5, hard = 0.
    expect(classifyIntensity(z(10, 20, 30, 0, 0)).tag).toBe('threshold');
  });

  it('tags a long aerobic with a small hard surge as mixed', () => {
    // 70% easy with a small but non-trivial Z4 surge that doesn't trip
    // the easy bucket's 10% hard ceiling and isn't enough for hard tag.
    // 40 min Z2 + 8 min Z4 + 12 min Z3.  easy=0.67, hard=0.13, grey=0.20.
    const out = classifyIntensity(z(0, 40, 12, 8, 0));
    expect(out.tag).toBe('mixed');
  });

  it('responds to changed thresholds', () => {
    const session = z(0, 40, 12, 8, 0);
    // Lower the hard cutoff so the same session classifies as hard.
    expect(classifyIntensity(session, { hardShareMin: 0.1 }).tag).toBe('hard');
  });

  it('intensityLabel produces human-friendly labels', () => {
    expect(intensityLabel('easy')).toBe('Easy');
    expect(intensityLabel('threshold')).toBe('Threshold');
    expect(intensityLabel('hard')).toBe('Hard');
    expect(intensityLabel('mixed')).toBe('Mixed');
    expect(intensityLabel('recovery')).toBe('Recovery');
    expect(intensityLabel('none')).toBe('');
  });
});

describe('polarizedSummary', () => {
  // Helper: total minutes in each of Z1..Z5.
  const z = (z1: number, z2: number, z3: number, z4: number, z5: number) =>
    [z1, z2, z3, z4, z5].map((m) => m * 60);

  it('returns no-data for empty zone array', () => {
    const out = polarizedSummary([0, 0, 0, 0, 0]);
    expect(out.verdict).toBe('no-data');
    expect(out.totalSec).toBe(0);
  });

  it('classifies a textbook 80/10 split as on-target', () => {
    // 80 min easy (Z1+Z2), 8 min Z3, 12 min Z4 → 80/8/12.
    const out = polarizedSummary(z(20, 60, 8, 12, 0));
    expect(out.easyShare).toBeCloseTo(0.8, 2);
    expect(out.hardShare).toBeCloseTo(0.12, 2);
    expect(out.verdict).toBe('on-target');
    expect(out.easy.status).toBe('ok');
    expect(out.grey.status).toBe('ok');
    expect(out.hard.status).toBe('ok');
  });

  it('flags too much hard work first', () => {
    // 60 min easy, 5 min Z3, 35 min hard → hard 35% > 25% cutoff.
    const out = polarizedSummary(z(20, 40, 5, 25, 10));
    expect(out.hard.status).toBe('high');
    expect(out.verdict).toBe('hard-too-high');
  });

  it('flags grey-zone overload when hard is in range', () => {
    // 50 min easy, 30 min Z3, 20 min hard → grey 30%, hard 20%.
    const out = polarizedSummary(z(15, 35, 30, 15, 5));
    expect(out.grey.status).toBe('high');
    expect(out.verdict).toBe('grey-too-high');
  });

  it('flags low easy when neither hard nor grey is the loud miss', () => {
    // 60 min easy, 8 min Z3, 22 min hard → easy 67%, hard 24% (in band),
    // grey 9% (ok). Should fire easy-too-low.
    const out = polarizedSummary(z(20, 40, 8, 18, 4));
    expect(out.easy.status).toBe('low');
    expect(out.verdict).toBe('easy-too-low');
  });

  it('honours overridden targets', () => {
    // Same 80/8/12 split — but if we demand 90% easy, easy becomes low.
    const out = polarizedSummary(z(20, 60, 8, 12, 0), {
      easyMin: 0.9,
      easyVerdictMin: 0.9,
    });
    expect(out.easy.status).toBe('low');
    expect(out.verdict).toBe('easy-too-low');
  });
});

describe('runPlanAdherence', () => {
  // 2026-04-06 is a Monday. dayOfWeek=0 (ISO Mon=0 in our scheme).
  const slots: RunPlanSlot[] = [
    { dayOfWeek: 0, kind: 'easy' },
    { dayOfWeek: 2, kind: 'quality' },
    { dayOfWeek: 5, kind: 'long' },
    { dayOfWeek: 6, kind: 'rest' },
  ];

  it('rates each non-rest slot over the window', () => {
    const now = new Date('2026-04-19T12:00:00Z'); // Sun, end of W16
    const sessions: MinimalCardio[] = [
      c({ id: 'm1', performedAt: '2026-04-06T08:00:00Z', plannedKind: 'easy' }),    // W15 Mon
      c({ id: 'w1', performedAt: '2026-04-08T08:00:00Z', plannedKind: 'quality' }), // W15 Wed
      c({ id: 'm2', performedAt: '2026-04-13T08:00:00Z', plannedKind: 'easy' }),    // W16 Mon
      // No W15 long, no W16 quality, no W16 long → mixed adherence
    ];
    const rows = runPlanAdherence(sessions, slots, now, 2);
    const easy = rows.find((r) => r.plannedKind === 'easy')!;
    const quality = rows.find((r) => r.plannedKind === 'quality')!;
    const long = rows.find((r) => r.plannedKind === 'long')!;
    expect(rows).toHaveLength(3);
    expect(easy.totalWeeks).toBe(2);
    expect(easy.hitWeeks).toBe(2);
    expect(quality.hitWeeks).toBe(1);
    expect(long.hitWeeks).toBe(0);
  });

  it('returns [] when no slots are configured', () => {
    expect(runPlanAdherence([], [], new Date(), 4)).toEqual([]);
    expect(runPlanAdherence([], null, new Date(), 4)).toEqual([]);
  });
});

describe('trainingCalendar', () => {
  it('flags days with strength and/or cardio activity', () => {
    const now = new Date('2026-04-10T12:00:00Z');
    const days = trainingCalendar(
      ['2026-04-10T08:00:00Z', '2026-04-08T18:00:00Z'],
      ['2026-04-09T07:00:00Z', '2026-04-08T19:00:00Z'],
      now,
      5,
    );
    expect(days).toHaveLength(5);
    const last = days[days.length - 1]!;
    expect(last.strength).toBe(true);
    expect(last.cardio).toBe(false);
    const apr8 = days.find((d) => d.date === '2026-04-08')!;
    expect(apr8.strength).toBe(true);
    expect(apr8.cardio).toBe(true);
  });
});

describe('computeCardioFatigueShift', () => {
  const NOW = new Date('2026-05-15T12:00:00Z'); // Fri

  // Helper: build a cardio session N days before NOW.
  const sessionDaysAgo = (
    daysAgo: number,
    durationMin: number,
    zones?: number[],
    modality: MinimalCardio['modality'] = 'run',
  ): Pick<MinimalCardio, 'modality' | 'performedAt' | 'durationSec' | 'hrZoneSeconds'> => ({
    modality,
    performedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    durationSec: durationMin * 60,
    hrZoneSeconds: zones,
  });

  it('returns 0 when there is no baseline data', () => {
    const out = computeCardioFatigueShift([sessionDaysAgo(2, 60)], NOW);
    expect(out.shift).toBe(0);
    expect(out.deltaPct).toBeNull();
    expect(out.recentWeightedMin).toBeCloseTo(60, 5);
  });

  it('returns 0 when recent ≤ baseline (steady-state training)', () => {
    // 4 sessions/week × 60 min in baseline → 12 sessions over 28d → 720 total → 180/wk avg.
    const baseline = [
      sessionDaysAgo(9, 60), sessionDaysAgo(11, 60), sessionDaysAgo(14, 60), sessionDaysAgo(16, 60),
      sessionDaysAgo(18, 60), sessionDaysAgo(21, 60), sessionDaysAgo(23, 60), sessionDaysAgo(25, 60),
      sessionDaysAgo(28, 60), sessionDaysAgo(30, 60), sessionDaysAgo(32, 60), sessionDaysAgo(34, 60),
    ];
    // Recent: 3 × 60min = 180 weighted-min → matches baseline /wk → delta = 0.
    const recent = [sessionDaysAgo(1, 60), sessionDaysAgo(3, 60), sessionDaysAgo(5, 60)];
    const out = computeCardioFatigueShift([...baseline, ...recent], NOW);
    expect(out.shift).toBe(0);
    expect(out.deltaPct).not.toBeNull();
    expect(out.deltaPct!).toBeLessThan(0.30);
  });

  it('returns -1 when recent runs ~+30-60% above the 28-day baseline', () => {
    // Baseline: ~240 min/week of easy cardio.
    const baseline = [
      sessionDaysAgo(9, 60), sessionDaysAgo(12, 60), sessionDaysAgo(14, 60), sessionDaysAgo(16, 60),
      sessionDaysAgo(19, 60), sessionDaysAgo(21, 60), sessionDaysAgo(23, 60), sessionDaysAgo(26, 60),
      sessionDaysAgo(28, 60), sessionDaysAgo(30, 60), sessionDaysAgo(33, 60), sessionDaysAgo(34, 60),
    ];
    // Recent: 4×60min easy + 1×60min bonus = 300 weighted-min (+50% vs 240×7/28=240/wk → wait baseline is 240*7/28).
    // Baseline weighted total = 12*60 = 720; per-week avg = 720*7/28 = 180.
    // Recent = 5*60 = 300. delta = (300-180)/180 = 0.667 → -2.
    // Let me adjust: drop one recent run for +50% target.
    // Use 4×60 recent = 240. delta = (240-180)/180 = 0.333 → -1 ✓
    const recent = [
      sessionDaysAgo(1, 60), sessionDaysAgo(3, 60), sessionDaysAgo(5, 60), sessionDaysAgo(6, 60),
    ];
    const out = computeCardioFatigueShift([...baseline, ...recent], NOW);
    expect(out.shift).toBe(-1);
    expect(out.deltaPct!).toBeGreaterThanOrEqual(0.30);
    expect(out.deltaPct!).toBeLessThan(0.60);
  });

  it('returns -2 when recent runs ≥+60% above the 28-day baseline', () => {
    // Baseline 12×60min = 720 total, 180/wk avg.
    const baseline = [
      sessionDaysAgo(9, 60), sessionDaysAgo(12, 60), sessionDaysAgo(14, 60), sessionDaysAgo(16, 60),
      sessionDaysAgo(19, 60), sessionDaysAgo(21, 60), sessionDaysAgo(23, 60), sessionDaysAgo(26, 60),
      sessionDaysAgo(28, 60), sessionDaysAgo(30, 60), sessionDaysAgo(33, 60), sessionDaysAgo(34, 60),
    ];
    // Recent: 5×60min = 300. delta = 0.667 → -2.
    const recent = [
      sessionDaysAgo(1, 60), sessionDaysAgo(2, 60), sessionDaysAgo(3, 60), sessionDaysAgo(5, 60), sessionDaysAgo(6, 60),
    ];
    const out = computeCardioFatigueShift([...baseline, ...recent], NOW);
    expect(out.shift).toBe(-2);
    expect(out.deltaPct!).toBeGreaterThanOrEqual(0.60);
  });

  it('weights HR zones — a Z3 run carries 2× the cost of a Z2 run of the same duration', () => {
    // 60 min entirely in Z2 vs 60 min entirely in Z3.
    const z2 = computeCardioFatigueShift([sessionDaysAgo(2, 60, [0, 60 * 60, 0, 0, 0])], NOW);
    const z3 = computeCardioFatigueShift([sessionDaysAgo(2, 60, [0, 0, 60 * 60, 0, 0])], NOW);
    expect(z2.recentWeightedMin).toBeCloseTo(60, 1); // 60 × 1.0
    expect(z3.recentWeightedMin).toBeCloseTo(120, 1); // 60 × 2.0
  });

  it('ignores future-dated sessions', () => {
    const sessions = [
      sessionDaysAgo(-3, 60), // future
      sessionDaysAgo(2, 60),
    ];
    const out = computeCardioFatigueShift(sessions, NOW);
    expect(out.recentWeightedMin).toBeCloseTo(60, 1); // only the past one
  });

  it('reports modality mix sorted by share descending', () => {
    const sessions = [
      sessionDaysAgo(1, 60, undefined, 'run'),     // 60 weighted
      sessionDaysAgo(3, 30, undefined, 'run'),     // 30
      sessionDaysAgo(2, 30, undefined, 'bike'),    // 30
      sessionDaysAgo(4, 20, undefined, 'walk'),    // 20
    ];
    const out = computeCardioFatigueShift(sessions, NOW);
    expect(out.recentModalityMix.length).toBe(3);
    expect(out.recentModalityMix[0]!.modality).toBe('run');
    expect(out.recentModalityMix[0]!.weightedMin).toBeCloseTo(90, 1);
    expect(out.recentModalityMix[0]!.sharePct).toBeCloseTo((90 / 140) * 100, 1);
    expect(out.recentModalityMix[1]!.modality).toBe('bike');
    expect(out.recentModalityMix[2]!.modality).toBe('walk');
  });

  it('returns empty modality mix when no recent cardio', () => {
    const out = computeCardioFatigueShift([], NOW);
    expect(out.recentModalityMix).toEqual([]);
  });
});

