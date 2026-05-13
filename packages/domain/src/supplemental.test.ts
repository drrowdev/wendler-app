import { describe, expect, it } from 'vitest';
import { buildSupplementalSets } from './supplemental';

const TM = 100;

describe('buildSupplementalSets', () => {
  it('returns empty for none/custom/deload/7w', () => {
    expect(buildSupplementalSets({ templateId: 'none', trainingMaxKg: TM, week: 1, roundingKg: 2.5 })).toEqual([]);
    expect(buildSupplementalSets({ templateId: 'custom', trainingMaxKg: TM, week: 1, roundingKg: 2.5 })).toEqual([]);
    expect(buildSupplementalSets({ templateId: 'fsl', trainingMaxKg: TM, week: 'deload', roundingKg: 2.5 })).toEqual([]);
    expect(buildSupplementalSets({ templateId: 'fsl', trainingMaxKg: TM, week: '7w', roundingKg: 2.5 })).toEqual([]);
    expect(buildSupplementalSets({ templateId: 'bbb', trainingMaxKg: TM, week: '7w', roundingKg: 2.5 })).toEqual([]);
    expect(buildSupplementalSets({ templateId: 'spinal-tap', trainingMaxKg: TM, week: '7w', roundingKg: 2.5 })).toEqual([]);
  });

  it('FSL: 5×5 at first working % each week', () => {
    const w1 = buildSupplementalSets({ templateId: 'fsl', trainingMaxKg: TM, week: 1, roundingKg: 2.5 });
    expect(w1).toHaveLength(5);
    expect(w1[0]).toMatchObject({ weightKg: 65, reps: 5, kind: 'supplemental', percentOfTm: 0.65 });
    const w3 = buildSupplementalSets({ templateId: 'fsl', trainingMaxKg: TM, week: 3, roundingKg: 2.5 });
    expect(w3[0]!.weightKg).toBe(75);
  });

  it('FSL AMRAP: single set, isAmrap=true', () => {
    const sets = buildSupplementalSets({ templateId: 'fsl-amrap', trainingMaxKg: TM, week: 2, roundingKg: 2.5 });
    expect(sets).toHaveLength(1);
    expect(sets[0]!.isAmrap).toBe(true);
    expect(sets[0]!.weightKg).toBe(70);
  });

  it('BBB: 5×10 at 50/60/70%', () => {
    const w1 = buildSupplementalSets({ templateId: 'bbb', trainingMaxKg: TM, week: 1, roundingKg: 2.5 });
    expect(w1).toHaveLength(5);
    expect(w1.every((s) => s.reps === 10)).toBe(true);
    expect(w1[0]!.weightKg).toBe(50);
    expect(buildSupplementalSets({ templateId: 'bbb', trainingMaxKg: TM, week: 2, roundingKg: 2.5 })[0]!.weightKg).toBe(60);
    expect(buildSupplementalSets({ templateId: 'bbb', trainingMaxKg: TM, week: 3, roundingKg: 2.5 })[0]!.weightKg).toBe(70);
  });

  it('SSL: 5×5 at second working %', () => {
    const w1 = buildSupplementalSets({ templateId: 'ssl', trainingMaxKg: TM, week: 1, roundingKg: 2.5 });
    expect(w1[0]!.weightKg).toBe(75);
    expect(w1).toHaveLength(5);
  });

  it('Spinal Tap: 3 ramping sets at 5/3/1 percentages (Wk3: 75/85/95)', () => {
    const w3 = buildSupplementalSets({ templateId: 'spinal-tap', trainingMaxKg: TM, week: 3, roundingKg: 2.5 });
    expect(w3).toHaveLength(3);
    expect(w3[0]).toMatchObject({ weightKg: 75, reps: 3, percentOfTm: 0.75 });
    expect(w3[1]).toMatchObject({ weightKg: 85, reps: 3, percentOfTm: 0.85 });
    expect(w3[2]).toMatchObject({ weightKg: 95, reps: 3, percentOfTm: 0.95 });
    const w1 = buildSupplementalSets({ templateId: 'spinal-tap', trainingMaxKg: TM, week: 1, roundingKg: 2.5 });
    expect(w1.map((s) => s.percentOfTm)).toEqual([0.65, 0.75, 0.85]);
    const w2 = buildSupplementalSets({ templateId: 'spinal-tap', trainingMaxKg: TM, week: 2, roundingKg: 2.5 });
    expect(w2.map((s) => s.percentOfTm)).toEqual([0.7, 0.8, 0.9]);
  });

  it('Spinal Tap: setsOverride controls cycles through the 3-percentage ramp', () => {
    // 6 sets => 2 cycles of (65/75/85) for week 1.
    const sets = buildSupplementalSets({
      templateId: 'spinal-tap', trainingMaxKg: TM, week: 1, roundingKg: 2.5, setsOverride: 6,
    });
    expect(sets).toHaveLength(6);
    expect(sets.map((s) => s.percentOfTm)).toEqual([0.65, 0.75, 0.85, 0.65, 0.75, 0.85]);
  });

  it('Widowmaker: 1×20 at first working %', () => {
    const sets = buildSupplementalSets({ templateId: 'widowmaker', trainingMaxKg: TM, week: 1, roundingKg: 2.5 });
    expect(sets).toEqual([
      { kind: 'supplemental', weightKg: 65, reps: 20, percentOfTm: 0.65 },
    ]);
  });

  describe('setsOverride', () => {
    it('drops FSL from 5 to 3 sets when overridden', () => {
      const sets = buildSupplementalSets({
        templateId: 'fsl', trainingMaxKg: TM, week: 1, roundingKg: 2.5, setsOverride: 3,
      });
      expect(sets).toHaveLength(3);
      expect(sets.every((s) => s.weightKg === 65 && s.reps === 5)).toBe(true);
    });

    it('extends BBB to 7 sets when overridden', () => {
      const sets = buildSupplementalSets({
        templateId: 'bbb', trainingMaxKg: TM, week: 1, roundingKg: 2.5, setsOverride: 7,
      });
      expect(sets).toHaveLength(7);
    });

    it('clamps override into [1, 20]', () => {
      expect(buildSupplementalSets({
        templateId: 'fsl', trainingMaxKg: TM, week: 1, roundingKg: 2.5, setsOverride: 0,
      })).toHaveLength(1);
      expect(buildSupplementalSets({
        templateId: 'fsl', trainingMaxKg: TM, week: 1, roundingKg: 2.5, setsOverride: 999,
      })).toHaveLength(20);
    });

    it('ignores override on single-set templates', () => {
      expect(buildSupplementalSets({
        templateId: 'widowmaker', trainingMaxKg: TM, week: 1, roundingKg: 2.5, setsOverride: 5,
      })).toHaveLength(1);
      expect(buildSupplementalSets({
        templateId: 'fsl-amrap', trainingMaxKg: TM, week: 1, roundingKg: 2.5, setsOverride: 5,
      })).toHaveLength(1);
    });
  });
});
