import { describe, expect, it } from 'vitest';
import { nextSeventhWeekRecommendation, SEVENTH_WEEK_VARIANTS } from './seventh-week';
import type { BlockKind, ProgramBlock } from './blocks';
import type { SeventhWeekKind } from './types';

function block(
  i: number,
  kind: BlockKind,
  opts: {
    completed?: boolean;
    scheme?: 'classic-531' | '5s-pro';
    seventhWeekKind?: SeventhWeekKind;
  } = {},
): ProgramBlock {
  const created = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
  return {
    id: `b${i}`,
    name: `Block ${i}`,
    kind,
    weeksBeforeDeload: kind === 'seventh-week' ? 1 : 3,
    supplementalTemplate: 'fsl',
    mainScheme: opts.scheme ?? 'classic-531',
    seventhWeekKind: opts.seventhWeekKind,
    createdAt: created,
    sequenceIndex: i,
    ...(opts.completed ? { completedAt: created } : {}),
  };
}

describe('nextSeventhWeekRecommendation', () => {
  it('no blocks → no prompt', () => {
    expect(nextSeventhWeekRecommendation([]).recommended).toBeNull();
  });

  it('single Leader done → no prompt (Wendler stacks two)', () => {
    const r = nextSeventhWeekRecommendation([block(0, 'leader', { completed: true })]);
    expect(r.recommended).toBeNull();
    expect(r.reason).toMatch(/one leader/i);
  });

  it('two Leaders done → recommend Deload', () => {
    const r = nextSeventhWeekRecommendation([
      block(0, 'leader', { completed: true }),
      block(1, 'leader', { completed: true }),
    ]);
    expect(r.recommended).toBe('deload');
  });

  it('three Leaders done → still recommend Deload', () => {
    const r = nextSeventhWeekRecommendation([
      block(0, 'leader', { completed: true }),
      block(1, 'leader', { completed: true }),
      block(2, 'leader', { completed: true }),
    ]);
    expect(r.recommended).toBe('deload');
  });

  it('Anchor done with classic 5/3/1 → recommend TM Test', () => {
    const r = nextSeventhWeekRecommendation([
      block(0, 'leader', { completed: true }),
      block(1, 'leader', { completed: true }),
      block(2, 'seventh-week', { completed: true, seventhWeekKind: 'deload' }),
      block(3, 'anchor', { completed: true, scheme: 'classic-531' }),
    ]);
    expect(r.recommended).toBe('tm-test');
  });

  it('Anchor done with 5s-PRO → recommend PR Test', () => {
    const r = nextSeventhWeekRecommendation([
      block(0, 'anchor', { completed: true, scheme: '5s-pro' }),
    ]);
    expect(r.recommended).toBe('pr-test');
  });

  it('does not double-prompt while a 7w block is queued or in progress', () => {
    const r = nextSeventhWeekRecommendation([
      block(0, 'leader', { completed: true }),
      block(1, 'leader', { completed: true }),
      block(2, 'seventh-week', { seventhWeekKind: 'deload' }), // not completed
    ]);
    expect(r.recommended).toBeNull();
    expect(r.reason).toMatch(/already/i);
  });

  it('uncompleted Leader after the pair does not consume the prompt', () => {
    const r = nextSeventhWeekRecommendation([
      block(0, 'leader', { completed: true }),
      block(1, 'leader', { completed: true }),
      block(2, 'leader'), // not yet completed
    ]);
    expect(r.recommended).toBe('deload');
  });

  it('standalone blocks are skipped (do not count toward Leader pair)', () => {
    const r = nextSeventhWeekRecommendation([
      block(0, 'leader', { completed: true }),
      block(1, 'standalone', { completed: true }),
      block(2, 'leader', { completed: true }),
    ]);
    // 2 trailing leaders (with a standalone in between) → still recommend Deload
    expect(r.recommended).toBe('deload');
  });

  it('after a completed 7w block the trailing run resets', () => {
    const r = nextSeventhWeekRecommendation([
      block(0, 'leader', { completed: true }),
      block(1, 'leader', { completed: true }),
      block(2, 'seventh-week', { completed: true, seventhWeekKind: 'deload' }),
      block(3, 'leader', { completed: true }),
    ]);
    // Only one Leader since the 7w → no prompt
    expect(r.recommended).toBeNull();
  });

  it('exposes blurbs for every variant', () => {
    expect(SEVENTH_WEEK_VARIANTS['tm-test'].title).toMatch(/TM Test/);
    expect(SEVENTH_WEEK_VARIANTS.deload.title).toMatch(/Deload/);
    expect(SEVENTH_WEEK_VARIANTS['pr-test'].title).toMatch(/PR Test/);
  });
});
