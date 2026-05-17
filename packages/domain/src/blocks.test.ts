import { describe, expect, it } from 'vitest';
import {
  advanceCursor,
  computeLongRunDays,
  DEFAULT_DAY_ORDER,
  defaultAssistanceVolumeForKind,
  effectiveAssistanceVolumeForPhase,
  effectiveDayGroups,
  effectivePlan,
  effectiveScheduleDays,
  normalizeScheduleDays,
  totalSessionsInBlock,
  tmPercentForLift,
  weekStartDate,
  type ProgramBlock,
  type ProgramSchedule,
} from './blocks';

const block: ProgramBlock = {
  id: 'b1',
  name: 'Leader 1',
  kind: 'leader',
  weeksBeforeDeload: 3,
  supplementalTemplate: 'fsl',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('blocks', () => {
  it('totalSessionsInBlock counts weeks × days', () => {
    expect(totalSessionsInBlock(block, DEFAULT_DAY_ORDER)).toBe(12); // 3 weeks × 4 days
  });

  it('advanceCursor walks group → week → null', () => {
    let c: { week: import('./types').WendlerWeek; groupIndex: number } | null = { week: 1, groupIndex: 0 };
    const seen: string[] = [];
    while (c) {
      seen.push(`${c.week}-${c.groupIndex}`);
      c = advanceCursor(c, block, DEFAULT_DAY_ORDER.length);
      if (seen.length > 20) break;
    }
    // 3 weeks × 4 day-groups = 12 sessions, no built-in deload.
    expect(seen).toHaveLength(12);
    expect(seen[0]).toBe('1-0');
    expect(seen[3]).toBe('1-3');
    expect(seen[4]).toBe('2-0');
    expect(seen[seen.length - 1]).toBe('3-3');
  });

  it('advanceCursor walks paired-day groups (2 lifts/day → 2 groups/week)', () => {
    // 4 lifts split across 2 paired days = 2 groups/week. 3 work weeks → 6 sessions.
    let c: { week: import('./types').WendlerWeek; groupIndex: number } | null = { week: 1, groupIndex: 0 };
    const seen: string[] = [];
    while (c) {
      seen.push(`${c.week}-${c.groupIndex}`);
      c = advanceCursor(c, block, 2);
      if (seen.length > 12) break;
    }
    expect(seen).toEqual(['1-0', '1-1', '2-0', '2-1', '3-0', '3-1']);
  });

  it('advanceCursor returns null at the end of the last work week', () => {
    const c: { week: import('./types').WendlerWeek; groupIndex: number } = { week: 3, groupIndex: 3 };
    expect(advanceCursor(c, block, DEFAULT_DAY_ORDER.length)).toBeNull();
  });

  it('tmPercentForLift uses override or default', () => {
    expect(tmPercentForLift(block, 'squat', 0.85)).toBe(0.85);
    const override: ProgramBlock = { ...block, tmPercentByLift: { squat: 0.9 } };
    expect(tmPercentForLift(override, 'squat', 0.85)).toBe(0.9);
    expect(tmPercentForLift(override, 'press', 0.85)).toBe(0.85);
  });
});

describe('normalizeScheduleDays', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeScheduleDays(undefined)).toBeUndefined();
  });

  it('returns empty array for empty input', () => {
    expect(normalizeScheduleDays([])).toEqual([]);
  });

  it('upgrades legacy MainLift[][] to ScheduleDay[]', () => {
    expect(normalizeScheduleDays([['press', 'deadlift'], ['bench', 'squat']])).toEqual([
      { mainLifts: ['press', 'deadlift'] },
      { mainLifts: ['bench', 'squat'] },
    ]);
  });

  it('preserves empty groups (accessory days) in legacy shape', () => {
    expect(normalizeScheduleDays([['press', 'deadlift'], [], ['bench', 'squat']])).toEqual([
      { mainLifts: ['press', 'deadlift'] },
      { mainLifts: [] },
      { mainLifts: ['bench', 'squat'] },
    ]);
  });

  it('passes through ScheduleDay[] shape, including labels', () => {
    expect(
      normalizeScheduleDays([
        { mainLifts: ['press'], label: 'Heavy day' },
        { mainLifts: [], label: 'Pulls + arms' },
      ]),
    ).toEqual([
      { mainLifts: ['press'], label: 'Heavy day' },
      { mainLifts: [], label: 'Pulls + arms' },
    ]);
  });
});

describe('effectiveDayGroups / effectiveScheduleDays', () => {
  const baseSchedule: ProgramSchedule = {
    id: 'singleton',
    dayOrder: DEFAULT_DAY_ORDER,
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('falls back to auto-grouped dayOrder when dayGroups is unset', () => {
    expect(effectiveDayGroups({ ...baseSchedule, liftsPerDay: 2 })).toEqual([
      ['press', 'deadlift'],
      ['bench', 'squat'],
    ]);
  });

  it('falls back to auto-grouped dayOrder when dayGroups is empty', () => {
    expect(effectiveDayGroups({ ...baseSchedule, dayGroups: [] })).toHaveLength(4);
  });

  it('preserves accessory days (empty groups) in explicit dayGroups', () => {
    const sched: ProgramSchedule = {
      ...baseSchedule,
      dayGroups: [
        { mainLifts: ['press', 'deadlift'] },
        { mainLifts: [] },
        { mainLifts: ['bench', 'squat'] },
      ],
    };
    expect(effectiveDayGroups(sched)).toEqual([
      ['press', 'deadlift'],
      [],
      ['bench', 'squat'],
    ]);
  });

  it('preserves accessory days from legacy MainLift[][] shape', () => {
    const sched = {
      ...baseSchedule,
      // intentional legacy shape — still accepted via normalizeScheduleDays
      dayGroups: [['press', 'deadlift'], [], ['bench', 'squat']] as unknown as ProgramSchedule['dayGroups'],
    } satisfies ProgramSchedule;
    expect(effectiveDayGroups(sched)).toEqual([
      ['press', 'deadlift'],
      [],
      ['bench', 'squat'],
    ]);
  });

  it('effectiveScheduleDays surfaces labels', () => {
    const sched: ProgramSchedule = {
      ...baseSchedule,
      dayGroups: [
        { mainLifts: ['press', 'deadlift'], label: 'Push/Pull' },
        { mainLifts: [], label: 'Accessory' },
      ],
    };
    expect(effectiveScheduleDays(sched)).toEqual([
      { mainLifts: ['press', 'deadlift'], label: 'Push/Pull' },
      { mainLifts: [], label: 'Accessory' },
    ]);
  });
});

describe('effectivePlan label inheritance from schedule', () => {
  const sched: ProgramSchedule = {
    id: 'singleton',
    dayOrder: ['press', 'deadlift', 'bench', 'squat'],
    liftsPerDay: 2,
    updatedAt: '2026-01-01T00:00:00Z',
    dayGroups: [
      { mainLifts: ['press', 'deadlift'], label: 'Upper/Pull' },
      { mainLifts: ['bench', 'squat'], label: 'Bench/Squat' },
    ],
  };

  it('inherits the program-level day labels for days with no own label', () => {
    const blk: ProgramBlock = {
      ...block,
      plan: {
        days: [
          { id: 'd1', mainLifts: ['press', 'deadlift'], assistance: [] },
          { id: 'd2', mainLifts: ['bench', 'squat'], assistance: [] },
        ],
      },
    };
    const plan = effectivePlan(blk, sched);
    expect(plan.days.map((d) => d.label)).toEqual(['Upper/Pull', 'Bench/Squat']);
  });

  it('program-level schedule label always wins over block-level label', () => {
    const blk: ProgramBlock = {
      ...block,
      plan: {
        days: [
          { id: 'd1', mainLifts: ['press', 'deadlift'], label: 'My OHP day', assistance: [] },
          { id: 'd2', mainLifts: ['bench', 'squat'], assistance: [] },
        ],
      },
    };
    const plan = effectivePlan(blk, sched);
    expect(plan.days.map((d) => d.label)).toEqual(['Upper/Pull', 'Bench/Squat']);
  });

  it('falls back to the block-level label when the schedule has no label', () => {
    const schedNoLabels: ProgramSchedule = {
      id: 'singleton',
      dayOrder: ['press', 'deadlift', 'bench', 'squat'],
      liftsPerDay: 2,
      updatedAt: '2026-01-01T00:00:00Z',
      dayGroups: [{ mainLifts: ['press', 'deadlift'] }, { mainLifts: ['bench', 'squat'] }],
    };
    const blk: ProgramBlock = {
      ...block,
      plan: {
        days: [
          { id: 'd1', mainLifts: ['press', 'deadlift'], label: 'My OHP day', assistance: [] },
          { id: 'd2', mainLifts: ['bench', 'squat'], assistance: [] },
        ],
      },
    };
    const plan = effectivePlan(blk, schedNoLabels);
    expect(plan.days.map((d) => d.label)).toEqual(['My OHP day', undefined]);
  });

  it('does not mutate the original block.plan when inheriting', () => {
    const blk: ProgramBlock = {
      ...block,
      plan: {
        days: [
          { id: 'd1', mainLifts: ['press', 'deadlift'], assistance: [] },
          { id: 'd2', mainLifts: ['bench', 'squat'], assistance: [] },
        ],
      },
    };
    effectivePlan(blk, sched);
    expect(blk.plan!.days[0]!.label).toBeUndefined();
    expect(blk.plan!.days[1]!.label).toBeUndefined();
  });

  describe('weekStartDate', () => {
    const anchor = '2026-05-04T00:00:00Z';

    it('returns undefined for the 7th-week scope (separate one-week block)', () => {
      expect(weekStartDate(anchor, 3, '7w')).toBeUndefined();
    });

    it('returns undefined when the anchor is missing', () => {
      expect(weekStartDate(undefined, 3, 1)).toBeUndefined();
      expect(weekStartDate(null, 3, 1)).toBeUndefined();
    });

    it('week 1 == anchor', () => {
      expect(weekStartDate(anchor, 3, 1)?.toISOString()).toBe('2026-05-04T00:00:00.000Z');
    });

    it('week 2 == anchor + 7 days', () => {
      expect(weekStartDate(anchor, 3, 2)?.toISOString()).toBe('2026-05-11T00:00:00.000Z');
    });

    it('week 3 == anchor + 14 days', () => {
      expect(weekStartDate(anchor, 3, 3)?.toISOString()).toBe('2026-05-18T00:00:00.000Z');
    });

    it('deload week == anchor + (weeksBeforeDeload * 7) days', () => {
      // 3 work weeks → deload starts at week 4 = +21 days
      expect(weekStartDate(anchor, 3, 'deload')?.toISOString()).toBe('2026-05-25T00:00:00.000Z');
      // 5 work weeks → deload starts at week 6 = +35 days
      expect(weekStartDate(anchor, 5, 'deload')?.toISOString()).toBe('2026-06-08T00:00:00.000Z');
    });

    it('returns undefined for an unparseable anchor string', () => {
      expect(weekStartDate('not-a-date', 3, 1)).toBeUndefined();
    });

    it('accepts a Date instance as anchor', () => {
      const d = new Date('2026-05-04T00:00:00Z');
      expect(weekStartDate(d, 3, 2)?.toISOString()).toBe('2026-05-11T00:00:00.000Z');
    });
  });

  describe('effectiveAssistanceVolumeForPhase', () => {
    it('returns the stored value unchanged in normal phase', () => {
      expect(effectiveAssistanceVolumeForPhase('high', 'normal')).toBe('high');
      expect(effectiveAssistanceVolumeForPhase('standard', 'normal')).toBe('standard');
      expect(effectiveAssistanceVolumeForPhase('minimal', 'normal')).toBe('minimal');
    });

    it('always returns minimal in deload phase', () => {
      expect(effectiveAssistanceVolumeForPhase('high', 'deload')).toBe('minimal');
      expect(effectiveAssistanceVolumeForPhase('standard', 'deload')).toBe('minimal');
      expect(effectiveAssistanceVolumeForPhase('minimal', 'deload')).toBe('minimal');
    });

    it('always returns minimal in taper phase (most aggressive)', () => {
      expect(effectiveAssistanceVolumeForPhase('high', 'taper')).toBe('minimal');
      expect(effectiveAssistanceVolumeForPhase('standard', 'taper')).toBe('minimal');
      expect(effectiveAssistanceVolumeForPhase('minimal', 'taper')).toBe('minimal');
    });

    it('demotes only `high` in peak phase; `standard` stays standard', () => {
      // Peak is a sharpening phase, not a full taper — `standard` should
      // not collapse to `minimal` because that fights multi-mandate goal
      // profiles (e.g. marathon-prep requires ≥3 mandatory slots, which
      // structurally need ≥75 reps versus minimal's 50-rep main-day cap).
      expect(effectiveAssistanceVolumeForPhase('high', 'peak')).toBe('standard');
      expect(effectiveAssistanceVolumeForPhase('standard', 'peak')).toBe('standard');
      expect(effectiveAssistanceVolumeForPhase('minimal', 'peak')).toBe('minimal');
    });

    it('leaves custom volumes unchanged in any phase', () => {
      const custom = { preset: 'custom' as const, mainDayReps: 80, accessoryReps: 200, accessoryMovements: 6 };
      expect(effectiveAssistanceVolumeForPhase(custom, 'normal')).toEqual(custom);
      expect(effectiveAssistanceVolumeForPhase(custom, 'deload')).toEqual(custom);
      expect(effectiveAssistanceVolumeForPhase(custom, 'taper')).toEqual(custom);
      expect(effectiveAssistanceVolumeForPhase(custom, 'peak')).toEqual(custom);
    });
  });

  describe('defaultAssistanceVolumeForKind', () => {
    // Leader = volume block for the main lifts (heavy supplemental already
    // provides systemic load). Anchor = intensity block (light supplemental,
    // room for accessory variety). The defaults flipped in v276 to match
    // Wendler's actual structure.
    it('leader → standard (supplemental already provides volume)', () => {
      expect(defaultAssistanceVolumeForKind('leader')).toBe('standard');
    });

    it('anchor → high (room for accessory work; main work is short)', () => {
      expect(defaultAssistanceVolumeForKind('anchor')).toBe('high');
    });

    it('standalone → standard (neutral default, no leader/anchor cadence)', () => {
      expect(defaultAssistanceVolumeForKind('standalone')).toBe('standard');
    });

    it('seventh-week → minimal regardless of variant', () => {
      expect(defaultAssistanceVolumeForKind('seventh-week', 'deload')).toBe('minimal');
      expect(defaultAssistanceVolumeForKind('seventh-week', 'tm-test')).toBe('minimal');
      expect(defaultAssistanceVolumeForKind('seventh-week', 'pr-test')).toBe('minimal');
    });
  });

  describe('computeLongRunDays', () => {
    it('returns undefined when slots is undefined or empty', () => {
      const days = [{ weekday: 0 }, { weekday: 2 }];
      expect(computeLongRunDays(days, undefined)).toBeUndefined();
      expect(computeLongRunDays(days, [])).toBeUndefined();
    });

    it('returns undefined when slots contain no "long" entries', () => {
      const days = [{ weekday: 0 }, { weekday: 2 }];
      expect(
        computeLongRunDays(days, [
          { dayOfWeek: 0, kind: 'easy' },
          { dayOfWeek: 2, kind: 'tempo' },
        ]),
      ).toBeUndefined();
    });

    it('returns indices of days whose weekday matches a "long" slot', () => {
      const days = [{ weekday: 0 }, { weekday: 1 }, { weekday: 3 }];
      // Long run on Wed (dow=2) and Sat (dow=5); none match our days
      expect(
        computeLongRunDays(days, [
          { dayOfWeek: 2, kind: 'long' },
          { dayOfWeek: 5, kind: 'long' },
        ]),
      ).toBeUndefined();
      // Long run on Mon (dow=0) and Thu (dow=3) — both match
      expect(
        computeLongRunDays(days, [
          { dayOfWeek: 0, kind: 'long' },
          { dayOfWeek: 3, kind: 'long' },
        ]),
      ).toEqual([0, 2]);
    });

    it('falls back to label parsing when weekday is missing', () => {
      const days = [{ label: 'Mon' }, { label: 'Tue' }, { label: 'Sat' }];
      // Long run on Sat (dow=5)
      expect(
        computeLongRunDays(days, [{ dayOfWeek: 5, kind: 'long' }]),
      ).toEqual([2]);
    });

    it('ignores non-long slots even when their dayOfWeek matches', () => {
      const days = [{ weekday: 2 }];
      expect(
        computeLongRunDays(days, [
          { dayOfWeek: 2, kind: 'easy' },
          { dayOfWeek: 2, kind: 'tempo' },
        ]),
      ).toBeUndefined();
    });

    it('ignores long slots whose modality is not run (bike/swim/row/etc)', () => {
      const days = [{ weekday: 5 }];
      // A long bike ride on Sat should NOT count as a long-run day —
      // the pre-long-run veto on heavy lower-body is running-chain
      // specific.
      expect(
        computeLongRunDays(days, [
          { dayOfWeek: 5, kind: 'long', modality: 'bike' },
        ]),
      ).toBeUndefined();
      expect(
        computeLongRunDays(days, [
          { dayOfWeek: 5, kind: 'long', modality: 'swim' },
        ]),
      ).toBeUndefined();
    });

    it('still counts long slots without an explicit modality field (back-compat with pre-v20 RunPlan rows)', () => {
      const days = [{ weekday: 5 }];
      expect(
        computeLongRunDays(days, [
          { dayOfWeek: 5, kind: 'long' }, // no modality field set
        ]),
      ).toEqual([0]);
    });

    it('counts the run-long slot and ignores the bike-long slot when both share a weekday', () => {
      const days = [{ weekday: 5 }];
      expect(
        computeLongRunDays(days, [
          { dayOfWeek: 5, kind: 'long', modality: 'run' },
          { dayOfWeek: 5, kind: 'long', modality: 'bike' },
        ]),
      ).toEqual([0]);
    });
  });
});
