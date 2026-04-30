import { describe, it, expect } from 'vitest';
import { roundToIncrement, floorToIncrement } from './rounding';

describe('rounding', () => {
  it('rounds to nearest 2.5', () => {
    expect(roundToIncrement(101.2, 2.5)).toBe(100);
    expect(roundToIncrement(101.3, 2.5)).toBe(102.5);
    expect(roundToIncrement(0, 2.5)).toBe(0);
  });
  it('floors to increment', () => {
    expect(floorToIncrement(101.9, 2.5)).toBe(100);
    expect(floorToIncrement(102.5, 2.5)).toBe(102.5);
  });
  it('throws on bad increment', () => {
    expect(() => roundToIncrement(100, 0)).toThrow();
  });
});
