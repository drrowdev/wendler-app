import { describe, it, expect } from 'vitest';
import { epley1RM, suggestNewTrainingMax } from './e1rm';

describe('e1rm', () => {
  it('computes Epley correctly', () => {
    // 100 kg × 5 reps → 100 * (1 + 5/30) = 116.666...
    expect(epley1RM(100, 5)).toBeCloseTo(116.6667, 3);
    // 100 × 1 → 100
    expect(epley1RM(100, 1)).toBeCloseTo(103.333, 2);
  });
  it('caps reps at 12', () => {
    expect(epley1RM(100, 20)).toBe(epley1RM(100, 12));
  });
  it('returns 0 for invalid input', () => {
    expect(epley1RM(0, 5)).toBe(0);
    expect(epley1RM(100, 0)).toBe(0);
  });
  it('suggests a new TM at 90% of e1RM', () => {
    // 100 kg × 5 = e1RM 116.67, 90% = 105
    expect(suggestNewTrainingMax(100, 5)).toBeCloseTo(105, 1);
  });
});
