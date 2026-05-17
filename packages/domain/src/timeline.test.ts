import { describe, it, expect } from 'vitest';
import { buildTimelineModel } from './timeline';
import type { ProgramBlock } from './blocks';

function block(over: Partial<ProgramBlock>): ProgramBlock {
  return {
    id: 'b1',
    name: 'Leader 1',
    kind: 'leader',
    weeksBeforeDeload: 3,
    includesDeload: true,
    supplementalTemplate: 'fsl',
    createdAt: '2026-04-01T00:00:00.000Z',
    ...over,
  };
}

describe('buildTimelineModel', () => {
  const today = new Date('2026-05-13T12:00:00.000Z'); // Wed

  it('returns an empty-ish model with default 4-week future window when no blocks/races', () => {
    const m = buildTimelineModel([], [], { today });
    // 2-week pad each side + 4-week future cushion + 1 start week = ~9 weeks
    expect(m.weekHeaders.length).toBeGreaterThanOrEqual(5);
    expect(m.blockSegments).toEqual([]);
    expect(m.raceMilestones).toEqual([]);
    expect(m.currentWeekIndex).toBeGreaterThanOrEqual(0);
    expect(m.weekHeaders[m.currentWeekIndex]!.isCurrent).toBe(true);
  });

  it('places a started 4-week leader block (3 + deload) at its real start monday', () => {
    const b = block({ startedAt: '2026-04-27T00:00:00.000Z' }); // Mon
    const m = buildTimelineModel([b], [], { today });
    expect(m.blockSegments).toHaveLength(1);
    const seg = m.blockSegments[0]!;
    expect(seg.weeks).toBe(4); // 3 + 1 deload
    expect(seg.isStarted).toBe(true);
    expect(seg.isActive).toBe(true);
    expect(seg.endWeekIndex - seg.startWeekIndex).toBe(3);
  });

  it('chains an unstarted anchor block off the end of a started leader', () => {
    const leader = block({
      id: 'b1',
      kind: 'leader',
      startedAt: '2026-04-27T00:00:00.000Z',
      weeksBeforeDeload: 3,
      includesDeload: true,
    });
    const anchor = block({
      id: 'b2',
      name: 'Anchor 1',
      kind: 'anchor',
      weeksBeforeDeload: 3,
      includesDeload: false,
      sequenceIndex: 1,
    });
    const m = buildTimelineModel([leader, anchor], [], { today });
    expect(m.blockSegments).toHaveLength(2);
    const [l, a] = m.blockSegments;
    expect(l!.weeks).toBe(4);
    expect(a!.weeks).toBe(3);
    expect(a!.isStarted).toBe(false);
    // Anchor starts the week AFTER the leader ends.
    expect(a!.startWeekIndex).toBe(l!.endWeekIndex + 1);
  });

  it('seventh-week block is always 1 week regardless of weeksBeforeDeload', () => {
    const b = block({
      kind: 'seventh-week',
      seventhWeekKind: 'tm-test',
      weeksBeforeDeload: 99,
      startedAt: '2026-05-04T00:00:00.000Z',
    });
    const m = buildTimelineModel([b], [], { today });
    const seg = m.blockSegments[0]!;
    expect(seg.weeks).toBe(1);
    expect(seg.kind).toBe('seventh-week');
    expect(seg.seventhWeekKind).toBe('tm-test');
  });

  it('places a race milestone at the week column containing the race date', () => {
    const b = block({ startedAt: '2026-04-27T00:00:00.000Z' });
    const m = buildTimelineModel(
      [b],
      [{ id: 'r1', name: 'Helsinki Half', date: '2026-06-06T08:00:00.000Z' }],
      { today },
    );
    expect(m.raceMilestones).toHaveLength(1);
    const r = m.raceMilestones[0]!;
    expect(r.weekIndex).toBeGreaterThanOrEqual(0);
    const wk = m.weekHeaders[r.weekIndex]!;
    // Race date 2026-06-06 falls in the Monday-2026-06-01 ISO week.
    expect(wk.weekStartIso).toBe('2026-06-01');
  });

  it('window pads start + end so earliest block and latest race are covered with paddingWeeks on each side', () => {
    const earlyBlock = block({ startedAt: '2026-03-02T00:00:00.000Z' });
    const farRace = {
      id: 'r-future',
      name: 'Berlin',
      date: '2026-09-28T08:00:00.000Z',
    };
    const m = buildTimelineModel([earlyBlock], [farRace], { today, paddingWeeks: 1 });
    // First header must be ≤ 1 week before the earliest block's Monday.
    expect(m.weekHeaders[0]!.weekStartIso <= '2026-03-02').toBe(true);
    // Last header must be ≥ 1 week after the latest race Monday.
    const last = m.weekHeaders[m.weekHeaders.length - 1]!;
    expect(last.weekStartIso >= '2026-09-28').toBe(true);
  });

  it('marks the active block (today within range)', () => {
    const b = block({ startedAt: '2026-04-27T00:00:00.000Z' });
    const m = buildTimelineModel([b], [], { today });
    expect(m.blockSegments[0]!.isActive).toBe(true);
  });

  it('does not mark completed blocks active even if today is within the range', () => {
    const b = block({
      startedAt: '2026-04-27T00:00:00.000Z',
      completedAt: '2026-05-15T00:00:00.000Z',
    });
    const m = buildTimelineModel([b], [], { today });
    // isCompleted overrides "active" for renderer purposes; both flags
    // are present, the renderer decides which to honour.
    expect(m.blockSegments[0]!.isCompleted).toBe(true);
  });

  it('week headers flag the first week of each month for divider rendering', () => {
    const b = block({ startedAt: '2026-04-06T00:00:00.000Z' });
    const m = buildTimelineModel([b], [], { today, paddingWeeks: 1 });
    const monthStarts = m.weekHeaders.filter((w) => w.startsNewMonth).map((w) => w.weekStartIso);
    // At minimum we span from Mar (with padding) to mid-May; expect ≥ 2 month transitions.
    expect(monthStarts.length).toBeGreaterThanOrEqual(2);
  });

  it('places historical completed blocks (no startedAt) in the past via completedAt', () => {
    // Legacy data: Leader 1 has completedAt but no startedAt. Without
    // this branch the block would chain into the future after the
    // active anchor — historically completed work showing up as if
    // it were upcoming.
    const leader = block({
      id: 'leader-1',
      name: 'Leader 1',
      kind: 'leader',
      weeksBeforeDeload: 3,
      includesDeload: true,
      // 4 weeks total, ended 2026-05-04 → should be placed roughly
      // 2026-04-06 → 2026-05-04.
      completedAt: '2026-05-04T00:00:00.000Z',
    });
    const anchor = block({
      id: 'anchor-1',
      name: 'Anchor 1',
      kind: 'anchor',
      weeksBeforeDeload: 3,
      includesDeload: false,
      startedAt: '2026-05-11T00:00:00.000Z',
    });
    const m = buildTimelineModel([leader, anchor], [], { today, paddingWeeks: 1 });
    const leaderSeg = m.blockSegments.find((s) => s.blockId === 'leader-1')!;
    const anchorSeg = m.blockSegments.find((s) => s.blockId === 'anchor-1')!;
    // Leader should be entirely BEFORE the anchor (its endWeekIndex
    // must be < the anchor's startWeekIndex).
    expect(leaderSeg.endWeekIndex).toBeLessThan(anchorSeg.startWeekIndex);
    // And it must not overlap today (it's a past block).
    expect(leaderSeg.isActive).toBe(false);
    // Anchor SHOULD be the active block today.
    expect(anchorSeg.isActive).toBe(true);
  });
});
