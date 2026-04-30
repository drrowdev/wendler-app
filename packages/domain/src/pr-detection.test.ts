import { describe, it, expect } from 'vitest';
import { detectPrs } from './pr-detection';

describe('pr-detection', () => {
  it('flags first ever set as both weight and e1RM PR', () => {
    const prs = detectPrs({ weightKg: 100, reps: 5 }, { sets: [] });
    expect(prs.find((p) => p.kind === 'weight')?.value).toBe(100);
    expect(prs.find((p) => p.kind === 'reps-at-weight')?.value).toBe(5);
    expect(prs.find((p) => p.kind === 'e1rm')).toBeDefined();
  });

  it('detects rep-at-weight PR without weight PR', () => {
    const prs = detectPrs(
      { weightKg: 100, reps: 7 },
      { sets: [{ weightKg: 100, reps: 5 }, { weightKg: 110, reps: 1 }] },
    );
    expect(prs.find((p) => p.kind === 'weight')).toBeUndefined();
    expect(prs.find((p) => p.kind === 'reps-at-weight')?.value).toBe(7);
  });

  it('detects no PRs when set is below history', () => {
    const prs = detectPrs(
      { weightKg: 80, reps: 3 },
      { sets: [{ weightKg: 100, reps: 5 }, { weightKg: 80, reps: 5 }] },
    );
    expect(prs).toHaveLength(0);
  });

  it('flags only weight PR if reps drop', () => {
    const prs = detectPrs(
      { weightKg: 105, reps: 1 },
      { sets: [{ weightKg: 100, reps: 5 }] },
    );
    expect(prs.find((p) => p.kind === 'weight')).toBeDefined();
    // e1RM: 100×5 = 116.67, 105×1 = 108.5 → no e1RM PR
    expect(prs.find((p) => p.kind === 'e1rm')).toBeUndefined();
  });
});
