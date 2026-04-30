import { describe, expect, it } from 'vitest';
import { buildSupplementalSets } from './supplemental';

const TM = 100;

describe('buildSupplementalSets', () => {
  it('returns empty for none/custom/deload', () => {
    expect(buildSupplementalSets({ templateId: 'none', trainingMaxKg: TM, week: 1, roundingKg: 2.5 })).toEqual([]);
    expect(buildSupplementalSets({ templateId: 'custom', trainingMaxKg: TM, week: 1, roundingKg: 2.5 })).toEqual([]);
    expect(buildSupplementalSets({ templateId: 'fsl', trainingMaxKg: TM, week: 'deload', roundingKg: 2.5 })).toEqual([]);
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

  it('Spinal Tap: 3×3 at top working %', () => {
    const w3 = buildSupplementalSets({ templateId: 'spinal-tap', trainingMaxKg: TM, week: 3, roundingKg: 2.5 });
    expect(w3).toHaveLength(3);
    expect(w3[0]).toMatchObject({ weightKg: 95, reps: 3 });
  });

  it('Widowmaker: 1×20 at first working %', () => {
    const sets = buildSupplementalSets({ templateId: 'widowmaker', trainingMaxKg: TM, week: 1, roundingKg: 2.5 });
    expect(sets).toEqual([
      { kind: 'supplemental', weightKg: 65, reps: 20, percentOfTm: 0.65 },
    ]);
  });
});
