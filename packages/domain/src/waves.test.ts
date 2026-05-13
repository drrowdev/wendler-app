import { describe, it, expect } from 'vitest';
import { buildMainSets, SEVENTH_WEEK_WAVES, WAVES } from './waves';

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

  describe('5s PRO scheme', () => {
    it('week 1: same percentages but every set is 5 reps with no AMRAP', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 1,
        roundingKg: 2.5,
        scheme: '5s-pro',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([65, 75, 85]);
      expect(sets.every((s) => s.reps === 5)).toBe(true);
      expect(sets.every((s) => !s.isAmrap)).toBe(true);
      expect(sets.every((s) => s.kind === 'main')).toBe(true);
    });

    it('week 2: 70/80/90 all sets of 5', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 2,
        roundingKg: 2.5,
        scheme: '5s-pro',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([70, 80, 90]);
      expect(sets.every((s) => s.reps === 5)).toBe(true);
    });

    it('deload is unchanged regardless of scheme', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 'deload',
        roundingKg: 2.5,
        scheme: '5s-pro',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([40, 50, 60]);
    });
  });

  describe('3/5/1 scheme', () => {
    it('week 1 runs the 3s wave: 70/80/90 with AMRAP top set of 3', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 1,
        roundingKg: 2.5,
        scheme: '351',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([70, 80, 90]);
      expect(sets.map((s) => s.reps)).toEqual([3, 3, 3]);
      expect(sets[2]?.isAmrap).toBe(true);
      expect(sets[2]?.kind).toBe('amrap');
    });

    it('week 2 runs the 5s wave: 65/75/85 with AMRAP top set of 5', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 2,
        roundingKg: 2.5,
        scheme: '351',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([65, 75, 85]);
      expect(sets.map((s) => s.reps)).toEqual([5, 5, 5]);
      expect(sets[2]?.isAmrap).toBe(true);
    });

    it('week 3 is unchanged: 75/85/95 with 5/3/1+', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 3,
        roundingKg: 2.5,
        scheme: '351',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([75, 85, 95]);
      expect(sets.map((s) => s.reps)).toEqual([5, 3, 1]);
      expect(sets[2]?.isAmrap).toBe(true);
    });

    it('deload is unchanged regardless of scheme', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 'deload',
        roundingKg: 2.5,
        scheme: '351',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([40, 50, 60]);
      expect(sets.every((s) => !s.isAmrap)).toBe(true);
    });
  });

  describe('amrapMainIndices override', () => {
    it('forces AMRAP on the specified index in 5s PRO', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 1,
        roundingKg: 2.5,
        scheme: '5s-pro',
        amrapMainIndices: [2],
      });
      expect(sets[0]?.isAmrap).toBeUndefined();
      expect(sets[1]?.isAmrap).toBeUndefined();
      expect(sets[2]?.isAmrap).toBe(true);
      expect(sets[2]?.kind).toBe('amrap');
      expect(sets[2]?.reps).toBe(5);
    });

    it('adds AMRAP to a non-top set in classic 5/3/1 without losing the default top AMRAP', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 1,
        roundingKg: 2.5,
        amrapMainIndices: [1],
      });
      expect(sets[1]?.isAmrap).toBe(true);
      expect(sets[1]?.kind).toBe('amrap');
      expect(sets[2]?.isAmrap).toBe(true);
    });

    it('ignores override on deload', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: 'deload',
        roundingKg: 2.5,
        amrapMainIndices: [0, 1, 2],
      });
      expect(sets.every((s) => !s.isAmrap)).toBe(true);
    });
  });

  describe('7th-week protocol', () => {
    it('TM Test: 70/80/90/100 with top set labelled "3–5"', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: '7w',
        roundingKg: 2.5,
        seventhWeekKind: 'tm-test',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([70, 80, 90, 100]);
      expect(sets.map((s) => s.reps)).toEqual([5, 5, 5, 3]);
      expect(sets[3]?.repsLabelOverride).toBe('3–5');
      expect(sets.every((s) => !s.isAmrap)).toBe(true);
      expect(sets.every((s) => s.kind === 'main')).toBe(true);
    });

    it('Deload: 70/80/90/100 with top set TM × 1', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: '7w',
        roundingKg: 2.5,
        seventhWeekKind: 'deload',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([70, 80, 90, 100]);
      expect(sets.map((s) => s.reps)).toEqual([5, 5, 1, 1]);
      expect(sets[1]?.repsLabelOverride).toBe('3–5');
      expect(sets[3]?.repsLabelOverride).toBeUndefined();
      expect(sets[3]?.percentOfTm).toBe(1);
    });

    it('PR Test: top set labelled "PR" at TM', () => {
      const sets = buildMainSets({
        trainingMaxKg: 100,
        week: '7w',
        roundingKg: 2.5,
        seventhWeekKind: 'pr-test',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([70, 80, 90, 100]);
      expect(sets[3]?.repsLabelOverride).toBe('PR');
      expect(sets[3]?.reps).toBe(1);
    });

    it('5s PRO scheme does not change the 7th-week shape', () => {
      const tm = buildMainSets({
        trainingMaxKg: 100,
        week: '7w',
        roundingKg: 2.5,
        seventhWeekKind: 'tm-test',
        scheme: '5s-pro',
      });
      expect(tm.map((s) => s.weightKg)).toEqual([70, 80, 90, 100]);
      expect(tm[3]?.repsLabelOverride).toBe('3–5');
    });

    it('rounds awkward TMs', () => {
      // TM 87.5 kg, deload variant: 70/80/90/100 of TM, rounded to 2.5 kg.
      // Note: 87.5 × 0.7 ≈ 61.249… in IEEE-754 so it rounds down to 60.
      const sets = buildMainSets({
        trainingMaxKg: 87.5,
        week: '7w',
        roundingKg: 2.5,
        seventhWeekKind: 'deload',
      });
      expect(sets.map((s) => s.weightKg)).toEqual([60, 70, 80, 87.5]);
    });

    it('exposes the wave table for all three variants', () => {
      expect(SEVENTH_WEEK_WAVES['tm-test']).toHaveLength(4);
      expect(SEVENTH_WEEK_WAVES.deload).toHaveLength(4);
      expect(SEVENTH_WEEK_WAVES['pr-test']).toHaveLength(4);
    });

    it('falls back to deload when seventhWeekKind is omitted', () => {
      const sets = buildMainSets({ trainingMaxKg: 100, week: '7w', roundingKg: 2.5 });
      expect(sets[3]?.reps).toBe(1);
      expect(sets[1]?.repsLabelOverride).toBe('3–5');
    });
  });
});
