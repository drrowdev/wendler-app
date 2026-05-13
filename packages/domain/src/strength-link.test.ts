import { describe, expect, it } from 'vitest';
import { dayGroupFulfilledKey, isStrengthLinkable } from './upcoming';

describe('dayGroupFulfilledKey', () => {
  it('combines block, week, dayIndex and date with stable separator', () => {
    expect(dayGroupFulfilledKey('block-1', 1, 0, '2026-04-27')).toBe('block-1|1|0|2026-04-27');
  });
  it('disambiguates same dayIndex across different weeks', () => {
    expect(dayGroupFulfilledKey('b', 1, 0, '2026-04-27')).not.toBe(
      dayGroupFulfilledKey('b', 2, 0, '2026-04-27'),
    );
  });
  it('disambiguates same date across different blocks', () => {
    expect(dayGroupFulfilledKey('b1', 1, 0, '2026-04-27')).not.toBe(
      dayGroupFulfilledKey('b2', 1, 0, '2026-04-27'),
    );
  });
  it('handles deload week tag', () => {
    expect(dayGroupFulfilledKey('b', 'deload', 0, '2026-04-27')).toBe('b|deload|0|2026-04-27');
  });
});

describe('isStrengthLinkable', () => {
  const w = { blockId: 'b1', week: 1 as const, dayIndex: 0 };
  it('matches when block, week and dayIndex are all equal', () => {
    expect(isStrengthLinkable(w, { blockId: 'b1', week: 1, dayIndex: 0 })).toBe(true);
  });
  it('rejects different block', () => {
    expect(isStrengthLinkable(w, { blockId: 'b2', week: 1, dayIndex: 0 })).toBe(false);
  });
  it('rejects different week (no cross-week linking)', () => {
    expect(isStrengthLinkable(w, { blockId: 'b1', week: 2, dayIndex: 0 })).toBe(false);
  });
  it('rejects different dayIndex (no cross-lift linking)', () => {
    expect(isStrengthLinkable(w, { blockId: 'b1', week: 1, dayIndex: 1 })).toBe(false);
  });
});
