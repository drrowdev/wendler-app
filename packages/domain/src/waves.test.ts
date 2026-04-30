import { describe, it, expect } from 'vitest';
import { buildMainSets, WAVES } from './waves';

describe('waves', () => {
  it('week 1 is 65/75/85 with AMRAP at top', () => {
    const sets = buildMainSets({ trainingMaxKg: 100, week: 1, roundingKg: 2.5 });
    expect(sets.map((s) => s.weightKg)).toEqual([65, 75, 85]);
    expect(sets[2]?.isAmrap).toBe(true);
    expect(sets[2]?.kind).toBe('amrap');
  });

  it('week 2 is 70/80/90', () => {
    const sets = buildMainSets({ trainingMaxKg: 100, week: 2, roundingKg: 2.5 });
    expect(sets.map((s) => s.weightKg)).toEqual([70, 80, 90]);
    expect(sets[2]?.reps).toBe(3);
  });

  it('week 3 is 75/85/95', () => {
    const sets = buildMainSets({ trainingMaxKg: 100, week: 3, roundingKg: 2.5 });
    expect(sets.map((s) => s.weightKg)).toEqual([75, 85, 95]);
    expect(sets[2]?.reps).toBe(1);
  });

  it('deload is 40/50/60 with no AMRAP', () => {
    const sets = buildMainSets({ trainingMaxKg: 100, week: 'deload', roundingKg: 2.5 });
    expect(sets.map((s) => s.weightKg)).toEqual([40, 50, 60]);
    expect(sets.every((s) => !s.isAmrap)).toBe(true);
  });

  it('rounds awkward TMs sensibly', () => {
    // TM 87.5 kg, week 1: 56.875 / 65.625 / 74.375 → 57.5 / 65 / 75
    const sets = buildMainSets({ trainingMaxKg: 87.5, week: 1, roundingKg: 2.5 });
    expect(sets.map((s) => s.weightKg)).toEqual([57.5, 65, 75]);
  });

  it('exposes the wave table', () => {
    expect(WAVES[1]).toHaveLength(3);
    expect(WAVES.deload).toHaveLength(3);
  });
});
