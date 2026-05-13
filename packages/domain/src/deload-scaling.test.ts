import { describe, expect, it } from 'vitest';
import {
  applyDeloadScaling,
  recommendDeloadScaling,
  type DeloadScalingInput,
} from './deload-scaling';
import type { AssistanceEntry, BlockPlan } from './blocks';

const entry = (over: Partial<AssistanceEntry> = {}): AssistanceEntry => ({
  id: over.id ?? 'a1',
  category: 'push',
  movementName: 'DB bench',
  sets: 3,
  reps: 10,
  loadHint: '20 kg',
  ...over,
});

const planFromDays = (days: AssistanceEntry[][]): BlockPlan => ({
  days: days.map((assistance, i) => ({
    id: `d${i}`,
    mainLifts: [],
    assistance,
  })),
});

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

describe('applyDeloadScaling — transforms', () => {
  it('volume-half halves sets (rounded up, min 1)', () => {
    const plan = planFromDays([[entry({ sets: 4 }), entry({ id: 'a2', sets: 1 })]]);
    const out = applyDeloadScaling(plan, 'volume-half');
    expect(out['deload|d0']).toEqual([
      expect.objectContaining({ id: 'a1', sets: 2 }),
      expect.objectContaining({ id: 'a2', sets: 1 }),
    ]);
  });

  it('intensity-cut scales numeric loadHint by 0.7 and rounds to 0.5', () => {
    const plan = planFromDays([[entry({ loadHint: '20 kg' }), entry({ id: 'a2', loadHint: '15.3kg' })]]);
    const out = applyDeloadScaling(plan, 'intensity-cut');
    expect(out['deload|d0']?.[0]?.loadHint).toBe('14 kg');
    expect(out['deload|d0']?.[1]?.loadHint).toBe('10.5 kg');
  });

  it('intensity-cut leaves bodyweight entries untouched', () => {
    const plan = planFromDays([[entry({ loadHint: 'bodyweight' }), entry({ id: 'a2', loadHint: '' })]]);
    const out = applyDeloadScaling(plan, 'intensity-cut');
    expect(out['deload|d0']?.[0]?.loadHint).toBe('bodyweight');
    expect(out['deload|d0']?.[1]?.loadHint).toBe('');
  });

  it('intensity-cut downgrades non-numeric load hints verbally', () => {
    const plan = planFromDays([[entry({ loadHint: 'heavy' })]]);
    const out = applyDeloadScaling(plan, 'intensity-cut');
    expect(out['deload|d0']?.[0]?.loadHint).toBe('light (deload)');
  });

  it('bodyweight-only swaps movements by category and stamps loadHint', () => {
    const plan = planFromDays([
      [
        entry({ category: 'push' }),
        entry({ id: 'a2', category: 'pull' }),
        entry({ id: 'a3', category: 'core' }),
      ],
    ]);
    const out = applyDeloadScaling(plan, 'bodyweight-only');
    const rows = out['deload|d0']!;
    expect(rows[0]?.movementName).toBe('Push-ups');
    expect(rows[0]?.loadHint).toBe('bodyweight');
    expect(rows[1]?.movementName).toBe('Inverted rows');
    expect(rows[2]?.movementName).toBe('Plank');
    expect(rows[2]?.unit).toBe('sec');
  });

  it('bodyweight-only preserves entry ids and order', () => {
    const plan = planFromDays([
      [entry({ id: 'X' }), entry({ id: 'Y', category: 'pull' })],
    ]);
    const out = applyDeloadScaling(plan, 'bodyweight-only');
    expect(out['deload|d0']?.map((e) => e.id)).toEqual(['X', 'Y']);
  });

  it('mobility-recovery collapses to a single mobility row when day has assistance', () => {
    const plan = planFromDays([[entry(), entry({ id: 'a2' })], []]);
    const out = applyDeloadScaling(plan, 'mobility-recovery');
    expect(out['deload|d0']).toHaveLength(1);
    expect(out['deload|d0']?.[0]?.movementName).toMatch(/mobility/i);
    expect(out['deload|d1']).toEqual([]);
  });

  it('skip-assistance produces empty arrays for every day', () => {
    const plan = planFromDays([[entry()], [entry({ id: 'a2' })]]);
    const out = applyDeloadScaling(plan, 'skip-assistance');
    expect(out['deload|d0']).toEqual([]);
    expect(out['deload|d1']).toEqual([]);
  });

  it('preserves non-deload overrides untouched', () => {
    const plan: BlockPlan = {
      days: [{ id: 'd0', mainLifts: [], assistance: [entry()] }],
      assistanceOverrides: {
        '1|d0': [entry({ id: 'wk1', sets: 5 })],
        'deload|d0': [entry({ id: 'old', sets: 99 })],
      },
    };
    const out = applyDeloadScaling(plan, 'volume-half');
    expect(out['1|d0']).toEqual([
      expect.objectContaining({ id: 'wk1', sets: 5 }),
    ]);
    // deload override is replaced, not merged
    expect(out['deload|d0']?.[0]?.id).toBe('a1');
    expect(out['deload|d0']?.[0]?.sets).toBe(2);
  });

  it('does not mutate the input plan', () => {
    const plan = planFromDays([[entry({ sets: 4 })]]);
    const before = JSON.stringify(plan);
    applyDeloadScaling(plan, 'volume-half');
    expect(JSON.stringify(plan)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Recommender — precedence ladder
// ---------------------------------------------------------------------------

const baseInput: DeloadScalingInput = { sets: [] };

const isoDaysFromNow = (days: number): string => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe('recommendDeloadScaling — precedence', () => {
  it('1) active illness → skip-assistance (overrides A-race)', () => {
    const out = recommendDeloadScaling({
      ...baseInput,
      activeIllness: { severity: 'mild', startedAt: isoDaysFromNow(-2) },
      upcomingRaces: [{ date: isoDaysFromNow(3), priority: 'A' }],
    });
    expect(out.primary.strategy).toBe('skip-assistance');
    expect(out.primary.confidence).toBe('high');
  });

  it('2) A-race within 7 days → mobility-recovery', () => {
    const out = recommendDeloadScaling({
      ...baseInput,
      upcomingRaces: [{ date: isoDaysFromNow(5), priority: 'A' }],
    });
    expect(out.primary.strategy).toBe('mobility-recovery');
  });

  it('3) A-race within 8–14 days → bodyweight-only', () => {
    const out = recommendDeloadScaling({
      ...baseInput,
      upcomingRaces: [{ date: isoDaysFromNow(10), priority: 'A' }],
    });
    expect(out.primary.strategy).toBe('bodyweight-only');
  });

  it('B-priority race in 5 days does NOT trigger mobility-recovery', () => {
    const out = recommendDeloadScaling({
      ...baseInput,
      upcomingRaces: [{ date: isoDaysFromNow(5), priority: 'B' }],
    });
    expect(out.primary.strategy).not.toBe('mobility-recovery');
  });

  it('4) recently recovered illness → bodyweight-only', () => {
    const out = recommendDeloadScaling({
      ...baseInput,
      recentlyRecoveredIllness: {
        severity: 'moderate',
        startedAt: isoDaysFromNow(-10),
        recoveredAt: isoDaysFromNow(-3),
      },
    });
    expect(out.primary.strategy).toBe('bodyweight-only');
  });

  it('5) high fatigue (≥7) → intensity-cut', () => {
    const out = recommendDeloadScaling({
      ...baseInput,
      recoveryRecent: [
        { date: isoDaysFromNow(-2), fatigue: 8 },
        { date: isoDaysFromNow(-1), fatigue: 7 },
      ],
    });
    expect(out.primary.strategy).toBe('intensity-cut');
  });

  it('5) HRV trending down → intensity-cut', () => {
    const out = recommendDeloadScaling({
      ...baseInput,
      recoveryRecent: [
        { date: isoDaysFromNow(-5), hrv: 60 },
        { date: isoDaysFromNow(-4), hrv: 62 },
        { date: isoDaysFromNow(-3), hrv: 61 },
        { date: isoDaysFromNow(-2), hrv: 50 },
      ],
    });
    expect(out.primary.strategy).toBe('intensity-cut');
  });

  it('7) default → volume-half', () => {
    const out = recommendDeloadScaling(baseInput);
    expect(out.primary.strategy).toBe('volume-half');
    expect(out.primary.confidence).toBe('high');
  });

  it('always returns 4 alternatives that exclude the primary', () => {
    const out = recommendDeloadScaling(baseInput);
    expect(out.alternatives).toHaveLength(4);
    expect(out.alternatives.map((a) => a.strategy)).not.toContain(
      out.primary.strategy,
    );
  });

  it('every plan has a non-empty headline and rationale', () => {
    const out = recommendDeloadScaling(baseInput);
    for (const p of [out.primary, ...out.alternatives]) {
      expect(p.headline.length).toBeGreaterThan(0);
      expect(p.rationale.length).toBeGreaterThan(0);
    }
  });
});

describe('recommendDeloadScaling — race priority filter', () => {
  it('considers only the nearest upcoming race', () => {
    const out = recommendDeloadScaling({
      ...baseInput,
      upcomingRaces: [
        { date: isoDaysFromNow(40), priority: 'A' }, // far future, ignored
        { date: isoDaysFromNow(3), priority: 'A' }, // wins
      ],
    });
    expect(out.primary.strategy).toBe('mobility-recovery');
  });

  it('ignores past races', () => {
    const out = recommendDeloadScaling({
      ...baseInput,
      upcomingRaces: [{ date: isoDaysFromNow(-5), priority: 'A' }],
    });
    expect(out.primary.strategy).toBe('volume-half');
  });
});
