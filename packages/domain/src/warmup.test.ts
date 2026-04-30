import { describe, it, expect } from 'vitest';
import { buildWarmupSets, DEFAULT_WARMUP } from './warmup';

describe('warmup', () => {
  it('builds default 40/60/80 ramp floored to increment', () => {
    const sets = buildWarmupSets(100, 2.5);
    expect(sets.map((s) => s.weightKg)).toEqual([40, 60, 80]);
    expect(sets.map((s) => s.reps)).toEqual([5, 5, 3]);
    expect(sets.every((s) => s.kind === 'warmup')).toBe(true);
  });

  it('floors awkward weights down so warm-ups never exceed working weight', () => {
    // 87.5 kg working: 35 / 52.5 / 70
    const sets = buildWarmupSets(87.5, 2.5);
    expect(sets.map((s) => s.weightKg)).toEqual([35, 52.5, 70]);
  });

  it('respects a custom config', () => {
    const sets = buildWarmupSets(100, 5, { percents: [0.5, 0.7], reps: [8, 5] });
    expect(sets.map((s) => s.weightKg)).toEqual([50, 70]);
    expect(sets.map((s) => s.reps)).toEqual([8, 5]);
  });

  it('rejects mismatched lengths', () => {
    expect(() => buildWarmupSets(100, 2.5, { percents: [0.4], reps: [5, 5] })).toThrow();
  });

  it('exposes default config', () => {
    expect(DEFAULT_WARMUP.percents).toEqual([0.4, 0.6, 0.8]);
  });
});
