import { describe, expect, it } from 'vitest';
import {
  advanceCursor,
  DEFAULT_DAY_ORDER,
  totalSessionsInBlock,
  tmPercentForLift,
  type ProgramBlock,
} from './blocks';

const block: ProgramBlock = {
  id: 'b1',
  name: 'Leader 1',
  kind: 'leader',
  weeksBeforeDeload: 3,
  includesDeload: true,
  supplementalTemplate: 'fsl',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('blocks', () => {
  it('totalSessionsInBlock counts weeks × days', () => {
    expect(totalSessionsInBlock(block, DEFAULT_DAY_ORDER)).toBe(16); // 4 weeks × 4 days
    expect(totalSessionsInBlock({ ...block, includesDeload: false }, DEFAULT_DAY_ORDER)).toBe(12);
  });

  it('advanceCursor walks day → week → null', () => {
    let c: { week: import('./types').WendlerWeek; dayIndex: number } | null = { week: 1, dayIndex: 0 };
    const seen: string[] = [];
    while (c) {
      seen.push(`${c.week}-${c.dayIndex}`);
      c = advanceCursor(c, block, DEFAULT_DAY_ORDER);
      if (seen.length > 20) break;
    }
    expect(seen).toHaveLength(16);
    expect(seen[0]).toBe('1-0');
    expect(seen[3]).toBe('1-3');
    expect(seen[4]).toBe('2-0');
    expect(seen[15]).toBe('deload-3');
  });

  it('advanceCursor stops before deload if block has none', () => {
    const noDeload = { ...block, includesDeload: false };
    let c: { week: import('./types').WendlerWeek; dayIndex: number } | null = { week: 3, dayIndex: 3 };
    expect(advanceCursor(c, noDeload, DEFAULT_DAY_ORDER)).toBeNull();
  });

  it('tmPercentForLift uses override or default', () => {
    expect(tmPercentForLift(block, 'squat', 0.85)).toBe(0.85);
    const override: ProgramBlock = { ...block, tmPercentByLift: { squat: 0.9 } };
    expect(tmPercentForLift(override, 'squat', 0.85)).toBe(0.9);
    expect(tmPercentForLift(override, 'press', 0.85)).toBe(0.85);
  });
});
