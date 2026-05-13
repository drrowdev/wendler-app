import { describe, expect, it } from 'vitest';
import { projectUpcomingWorkouts } from './upcoming';
import type { ProgramBlock, ProgramSchedule } from './blocks';

function makeBlock(overrides: Partial<ProgramBlock> = {}): ProgramBlock {
  return {
    id: 'b1',
    name: 'Block 1',
    kind: 'leader',
    weeksBeforeDeload: 3,
    includesDeload: false,
    supplementalTemplate: 'fsl',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<ProgramSchedule> = {}): ProgramSchedule {
  return {
    id: 'singleton',
    dayOrder: ['press', 'deadlift', 'bench', 'squat'],
    activeBlockId: 'b1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('projectUpcomingWorkouts', () => {
  it('mid-week activation places later-in-week days into the current week', () => {
    // Schedule has Mon/Thu sessions. Activated mid-week on Wednesday.
    // Expected: Wk1 Day 1 (Thu) lands on THIS Thursday (today+1).
    // Wk1 Day 0 (Mon) skips to NEXT Mon (since this Mon is past).
    // Output is sorted chronologically so Thu comes first.
    // Without this, the whole block would shift to next week (incident
    // 2026-05-13 — Anchor activated on a Wednesday surfaced no Wk1
    // sessions in the current week).
    const block = makeBlock();
    const schedule = makeSchedule({
      dayGroups: [
        { mainLifts: ['press'], weekday: 0, label: 'Mon' },
        { mainLifts: ['bench'], weekday: 3, label: 'Thu' },
      ],
      cursor: { blockId: 'b1', week: 1, groupIndex: 0 },
    });
    // Wed 2026-05-13.
    const from = new Date(2026, 4, 13);
    const out = projectUpcomingWorkouts(block, schedule, from, { maxItems: 4 });
    // Sorted by date: Thu (this week May 14) before Mon (next week May 18).
    expect(out[0]?.date).toBe('2026-05-14');
    expect(out[0]?.week).toBe(1);
    expect(out[0]?.dayIndex).toBe(1); // Thursday slot
    expect(out[1]?.date).toBe('2026-05-18');
    expect(out[1]?.week).toBe(1);
    expect(out[1]?.dayIndex).toBe(0); // Monday slot
  });

  it('projects each weekday-anchored day onto the next matching calendar date', () => {
    // Mon=0 Press, Tue=1 Deadlift, Thu=3 Bench, Fri=4 Squat. From cursor at week1/group0.
    const block = makeBlock();
    const schedule = makeSchedule({
      dayGroups: [
        { mainLifts: ['press'], weekday: 0, label: 'Mon' },
        { mainLifts: ['deadlift'], weekday: 1, label: 'Tue' },
        { mainLifts: ['bench'], weekday: 3, label: 'Thu' },
        { mainLifts: ['squat'], weekday: 4, label: 'Fri' },
      ],
      cursor: { blockId: 'b1', week: 1, groupIndex: 0 },
    });
    // Sunday 2026-04-26 — week begins next day.
    const from = new Date(2026, 3, 26);
    const out = projectUpcomingWorkouts(block, schedule, from, { maxItems: 6 });
    expect(out.slice(0, 4).map((u) => u.date)).toEqual([
      '2026-04-27', // Mon
      '2026-04-28', // Tue
      '2026-04-30', // Thu
      '2026-05-01', // Fri
    ]);
    expect(out[4]?.date).toBe('2026-05-04'); // next week Mon
    expect(out[4]?.week).toBe(2);
    expect(out[0]?.mainLifts).toEqual(['press']);
  });

  it('respects mid-week cursor and skips already-completed days', () => {
    const block = makeBlock();
    const schedule = makeSchedule({
      dayGroups: [
        { mainLifts: ['press'], weekday: 0 },
        { mainLifts: ['deadlift'], weekday: 1 },
        { mainLifts: ['bench'], weekday: 3 },
        { mainLifts: ['squat'], weekday: 4 },
      ],
      cursor: { blockId: 'b1', week: 1, groupIndex: 2 }, // next is Thu
    });
    // Wed 2026-04-29 — Thursday is tomorrow.
    const from = new Date(2026, 3, 29);
    const out = projectUpcomingWorkouts(block, schedule, from, { maxItems: 3 });
    expect(out.map((u) => u.date)).toEqual(['2026-04-30', '2026-05-01', '2026-05-04']);
    expect(out[0]?.dayIndex).toBe(2);
  });

  it('skips days with no resolvable weekday when fill is disabled', () => {
    const block = makeBlock();
    const schedule = makeSchedule({
      dayGroups: [
        { mainLifts: ['press'], weekday: 0, label: 'Mon' },
        { mainLifts: ['deadlift'], label: 'Heavy day' }, // unparseable
        { mainLifts: ['bench'], weekday: 3, label: 'Thu' },
      ],
      cursor: { blockId: 'b1', week: 1, groupIndex: 0 },
    });
    const from = new Date(2026, 3, 26); // Sun
    const out = projectUpcomingWorkouts(block, schedule, from, {
      maxItems: 5,
      fillMissingWeekdays: false,
    });
    // Only the two anchored days project; the unanchored one is dropped.
    expect(out.map((u) => u.dayIndex)).toEqual([0, 2, 0, 2, 0]);
    expect(out.slice(0, 2).map((u) => u.date)).toEqual(['2026-04-27', '2026-04-30']);
  });

  it('fill skips weekdays already explicitly assigned to other groups', () => {
    // 2-day schedule. Group 0 explicitly Thu (3); group 1 unset. The smart
    // fill must give group 1 the OTHER slot in the 2-day pattern (Mon)
    // rather than duplicating Thursday.
    const block = makeBlock({ weeksBeforeDeload: 1 });
    const schedule = makeSchedule({
      dayGroups: [
        { mainLifts: ['press'], weekday: 3, label: 'Thu' },
        { mainLifts: ['bench'] }, // unset
      ],
      cursor: { blockId: 'b1', week: 1, groupIndex: 0 },
    });
    const from = new Date(2026, 3, 26); // Sun
    const out = projectUpcomingWorkouts(block, schedule, from, { maxItems: 4 });
    const weekdays = out.map((u) => u.weekday).sort();
    expect(weekdays).toContain(0); // Mon must appear
    expect(weekdays).toContain(3); // Thu must appear
    expect(out.find((u) => u.dayIndex === 1)?.weekday).toBe(0);
  });

  it('fills missing weekdays from a default Wendler weekly pattern by default', () => {
    // 2-day schedule with no weekdays at all → defaults to Mon + Thu.
    const block = makeBlock({ weeksBeforeDeload: 1 });
    const schedule = makeSchedule({
      dayGroups: [{ mainLifts: ['press'] }, { mainLifts: ['bench'] }],
      cursor: { blockId: 'b1', week: 1, groupIndex: 0 },
    });
    const from = new Date(2026, 3, 26); // Sun
    const out = projectUpcomingWorkouts(block, schedule, from, { maxItems: 4 });
    expect(out.map((u) => u.weekday)).toEqual([0, 3, 0, 3]);
    expect(out.slice(0, 2).map((u) => u.date)).toEqual(['2026-04-27', '2026-04-30']);
  });

  it('honours horizonDays and stops at end of block', () => {
    const block = makeBlock({ weeksBeforeDeload: 3, includesDeload: true });
    const schedule = makeSchedule({
      dayGroups: [{ mainLifts: ['press'], weekday: 0 }],
      cursor: { blockId: 'b1', week: 1, groupIndex: 0 },
    });
    const from = new Date(2026, 3, 26);
    const all = projectUpcomingWorkouts(block, schedule, from, { maxItems: 99 });
    // 3 weeks + deload = 4 Mondays.
    expect(all).toHaveLength(4);
    expect(all[3]?.week).toBe('deload');
    const horizon = projectUpcomingWorkouts(block, schedule, from, {
      horizonDays: 10,
    });
    expect(horizon).toHaveLength(2);
  });

  it('starts at week 1 / group 0 when cursor is missing or for another block', () => {
    const block = makeBlock();
    const schedule = makeSchedule({
      dayGroups: [{ mainLifts: ['press'], weekday: 0 }],
      cursor: { blockId: 'other', week: 3, groupIndex: 0 },
    });
    const from = new Date(2026, 3, 26);
    const out = projectUpcomingWorkouts(block, schedule, from, { maxItems: 1 });
    expect(out[0]?.week).toBe(1);
    expect(out[0]?.dayIndex).toBe(0);
  });

  it('chains projection through subsequent blocks once the active one ends', () => {
    // 7th-week block ends after a single week (advanceCursor returns null
    // once it walks off the recognized week sequence).
    const active = makeBlock({ id: 'b1', kind: 'seventh-week', seventhWeekKind: 'deload' });
    const next = makeBlock({ id: 'b2', kind: 'leader' });
    const schedule = makeSchedule({
      dayGroups: [{ mainLifts: ['press'], weekday: 0 }],
      cursor: { blockId: 'b1', week: '7w', groupIndex: 0 },
    });
    const from = new Date(2026, 3, 26); // Sun
    const out = projectUpcomingWorkouts(active, schedule, from, {
      subsequentBlocks: [next],
      maxItems: 99,
    });
    // 1 from active 7w block + 3 from next leader block = 4 Mondays.
    expect(out.map((u) => u.blockId)).toEqual(['b1', 'b2', 'b2', 'b2']);
    expect(out.map((u) => u.date)).toEqual([
      '2026-04-27',
      '2026-05-04',
      '2026-05-11',
      '2026-05-18',
    ]);
  });

  it('falls back to weekdayByGroupIndex hints for unlabelled days', () => {
    const block = makeBlock();
    const schedule = makeSchedule({
      dayGroups: [
        { mainLifts: ['press'] }, // no weekday, no label
        { mainLifts: ['bench'], weekday: 3, label: 'Thu' },
      ],
      cursor: { blockId: 'b1', week: 1, groupIndex: 0 },
    });
    const from = new Date(2026, 3, 26); // Sun
    // Without hints AND without auto-fill, group 0 is silently dropped.
    const noHints = projectUpcomingWorkouts(block, schedule, from, {
      maxItems: 99,
      fillMissingWeekdays: false,
    });
    expect(noHints.map((u) => u.dayIndex)).toEqual([1, 1, 1]);
    // With a Mon hint for group 0, Monday workouts are now projected.
    const withHints = projectUpcomingWorkouts(block, schedule, from, {
      maxItems: 4,
      weekdayByGroupIndex: new Map([[0, 0]]),
    });
    expect(withHints.map((u) => u.dayIndex)).toEqual([0, 1, 0, 1]);
    expect(withHints.map((u) => u.date)).toEqual([
      '2026-04-27', // Mon
      '2026-04-30', // Thu
      '2026-05-04', // Mon
      '2026-05-07', // Thu
    ]);
  });

  it('suppresses planned slots whose fulfilledKey is in the set (off-day linked workout)', () => {
    const block = makeBlock();
    const schedule = makeSchedule({
      dayGroups: [
        { mainLifts: ['press'], weekday: 0, label: 'Mon' },
        { mainLifts: ['deadlift'], weekday: 1, label: 'Tue' },
        { mainLifts: ['bench'], weekday: 3, label: 'Thu' },
        { mainLifts: ['squat'], weekday: 4, label: 'Fri' },
      ],
      cursor: { blockId: 'b1', week: 1, groupIndex: 0 },
    });
    const from = new Date(2026, 3, 26);
    // Mark Monday 2026-04-27's Press slot as fulfilled (e.g. user
    // logged it on Tuesday and pinned it back to Monday).
    const fulfilledKeys = new Set(['b1|1|0|2026-04-27']);
    const out = projectUpcomingWorkouts(block, schedule, from, { maxItems: 4, fulfilledKeys });
    // First entry should now be Tuesday's Deadlift, not Monday's Press.
    expect(out[0]?.date).toBe('2026-04-28');
    expect(out[0]?.dayIndex).toBe(1);
    // Suppression must not consume a maxItems slot — we still get 4 results.
    expect(out).toHaveLength(4);
  });
});
