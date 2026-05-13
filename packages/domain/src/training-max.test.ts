import { describe, it, expect } from 'vitest';
import { computeTrainingMax } from './training-max';

describe('training-max', () => {
  it('Wendler default 85% TM rounds to nearest increment', () => {
    // 100 kg 1RM → 85 kg TM
    expect(computeTrainingMax(100, { tmPercent: 0.85, roundingKg: 2.5 })).toBe(85);
    // 102.5 kg → 87.125 → rounds to 87.5
    expect(computeTrainingMax(102.5, { tmPercent: 0.85, roundingKg: 2.5 })).toBe(87.5);
  });
  it('handles 90% TM', () => {
    expect(computeTrainingMax(140, { tmPercent: 0.9, roundingKg: 2.5 })).toBe(125);
  });
  it('rejects invalid input', () => {
    expect(() => computeTrainingMax(0, { tmPercent: 0.85, roundingKg: 2.5 })).toThrow();
    expect(() => computeTrainingMax(100, { tmPercent: 0, roundingKg: 2.5 })).toThrow();
    expect(() => computeTrainingMax(100, { tmPercent: 1, roundingKg: 2.5 })).toThrow();
  });
});
