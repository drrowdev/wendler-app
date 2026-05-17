import { describe, it, expect } from 'vitest';
import { slotAppliesOnDate, weekRangeForBlock } from './cardio-slot-resolve';
import type { CardioPlanSlot } from './types';
import type { ProgramBlock } from './blocks';

function makeBlock(over: Partial<ProgramBlock> = {}): ProgramBlock {
  return {
    id: 'b1',
    name: 'Anchor 1',
    kind: 'anchor',
    weeksBeforeDeload: 3,
    includesDeload: false,
    supplementalTemplate: 'fsl',
    createdAt: '2026-05-11T00:00:00.000Z',
    startedAt: '2026-05-11', // Monday of Wk 1
    ...over,
  };
}

function makeSlot(over: Partial<CardioPlanSlot> = {}): CardioPlanSlot {
  return {
    dayOfWeek: 4, // Fri
    modality: 'bike',
    kind: 'z2',
    ...over,
  };
}

describe('slotAppliesOnDate', () => {
  it('rejects wrong weekday', () => {
    const slot = makeSlot();
    const blocks = new Map([['b1', makeBlock()]]);
    expect(slotAppliesOnDate(slot, '2026-05-18', /* Mon */ 0, blocks)).toBe(false);
  });

  it('unscoped slot renders every matching weekday', () => {
    const slot = makeSlot();
    const blocks = new Map<string, ProgramBlock>();
    // any Friday past or future
    expect(slotAppliesOnDate(slot, '2025-01-03', 4, blocks)).toBe(true);
    expect(slotAppliesOnDate(slot, '2030-12-27', 4, blocks)).toBe(true);
  });

  it('dynamic: appliesToWeeks=[2,3,deload] respects block startedAt=2026-05-11', () => {
    const block = makeBlock({ startedAt: '2026-05-11', weeksBeforeDeload: 3 });
    const blocks = new Map([['b1', block]]);
    const slot = makeSlot({
      linkedBlockId: 'b1',
      appliesToWeeks: ['2', '3', 'deload'],
    });
    // Wk 1 Friday May 15 → out
    expect(slotAppliesOnDate(slot, '2026-05-15', 4, blocks)).toBe(false);
    // Wk 2 Friday May 22 → in
    expect(slotAppliesOnDate(slot, '2026-05-22', 4, blocks)).toBe(true);
    // Wk 3 Friday May 29 → in
    expect(slotAppliesOnDate(slot, '2026-05-29', 4, blocks)).toBe(true);
    // Deload Friday Jun 5 → in
    expect(slotAppliesOnDate(slot, '2026-06-05', 4, blocks)).toBe(true);
    // Post-deload Friday Jun 12 → out
    expect(slotAppliesOnDate(slot, '2026-06-12', 4, blocks)).toBe(false);
  });

  it('dynamic resolution moves with block startedAt change (self-healing)', () => {
    const slot = makeSlot({
      linkedBlockId: 'b1',
      appliesToWeeks: ['2'],
    });
    // Block thinks it started May 4 — Wk 2 = May 11-17
    const blocksA = new Map([['b1', makeBlock({ startedAt: '2026-05-04' })]]);
    expect(slotAppliesOnDate(slot, '2026-05-15', 4, blocksA)).toBe(true);
    expect(slotAppliesOnDate(slot, '2026-05-22', 4, blocksA)).toBe(false);
    // User corrects startedAt to May 11 — Wk 2 shifts to May 18-24
    const blocksB = new Map([['b1', makeBlock({ startedAt: '2026-05-11' })]]);
    expect(slotAppliesOnDate(slot, '2026-05-15', 4, blocksB)).toBe(false);
    expect(slotAppliesOnDate(slot, '2026-05-22', 4, blocksB)).toBe(true);
  });

  it('falls back to static effectiveFrom/Until when linked block has no startedAt', () => {
    const blocks = new Map([['b1', makeBlock({ startedAt: undefined })]]);
    const slot = makeSlot({
      linkedBlockId: 'b1',
      appliesToWeeks: ['2', '3', 'deload'],
      effectiveFrom: '2026-05-18',
      effectiveUntil: '2026-06-07',
    });
    expect(slotAppliesOnDate(slot, '2026-05-15', 4, blocks)).toBe(false);
    expect(slotAppliesOnDate(slot, '2026-05-22', 4, blocks)).toBe(true);
    expect(slotAppliesOnDate(slot, '2026-06-12', 4, blocks)).toBe(false);
  });

  it('legacy static-only slot still works', () => {
    const blocks = new Map<string, ProgramBlock>();
    const slot = makeSlot({
      effectiveFrom: '2026-05-18',
      effectiveUntil: '2026-06-07',
    });
    expect(slotAppliesOnDate(slot, '2026-05-15', 4, blocks)).toBe(false);
    expect(slotAppliesOnDate(slot, '2026-05-22', 4, blocks)).toBe(true);
    expect(slotAppliesOnDate(slot, '2026-06-12', 4, blocks)).toBe(false);
  });
});

describe('weekRangeForBlock', () => {
  it('resolves the standard 3-weeks-before-deload schedule', () => {
    const block = makeBlock({ weeksBeforeDeload: 3 });
    const start = new Date('2026-05-11T00:00:00');
    expect(weekRangeForBlock(block, start, '1')).toEqual({
      startIso: '2026-05-11',
      endIso: '2026-05-17',
    });
    expect(weekRangeForBlock(block, start, '2')).toEqual({
      startIso: '2026-05-18',
      endIso: '2026-05-24',
    });
    expect(weekRangeForBlock(block, start, '3')).toEqual({
      startIso: '2026-05-25',
      endIso: '2026-05-31',
    });
    expect(weekRangeForBlock(block, start, 'deload')).toEqual({
      startIso: '2026-06-01',
      endIso: '2026-06-07',
    });
  });
});
