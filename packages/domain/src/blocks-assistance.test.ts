import { describe, expect, it } from 'vitest';
import {
  assistanceLabel,
  categoryFromMovement,
  formatAssistancePrescription,
  hasAssistanceOverride,
  parseAssistancePrescription,
  resolveAssistance,
  type AssistanceEntry,
  type AssistancePlan,
  type ProgramBlock,
} from './blocks';

const baseBlock: ProgramBlock = {
  id: 'b1',
  name: 'Leader 1',
  kind: 'leader',
  weeksBeforeDeload: 3,
  includesDeload: true,
  supplementalTemplate: 'fsl',
  createdAt: '2026-01-01T00:00:00Z',
};

const ent = (id: string, name: string, sets = 3, reps = 10): AssistanceEntry => ({
  id,
  category: 'push',
  movementName: name,
  sets,
  reps,
});

describe('resolveAssistance', () => {
  it('returns empty when block has no plan', () => {
    expect(resolveAssistance(baseBlock, 1, 0)).toEqual([]);
  });

  it('returns the per-day default when no override exists', () => {
    const plan: AssistancePlan = {
      perDay: {
        0: [ent('a', 'DB Incline')],
        1: [ent('b', 'Inverted Row')],
      },
    };
    const block = { ...baseBlock, assistance: plan };
    expect(resolveAssistance(block, 1, 0)).toEqual(plan.perDay[0]);
    expect(resolveAssistance(block, 2, 1)).toEqual(plan.perDay[1]);
    expect(resolveAssistance(block, 'deload', 0)).toEqual(plan.perDay[0]);
  });

  it('per-week override fully replaces the per-day default', () => {
    const w2 = [ent('o1', 'Dips')];
    const plan: AssistancePlan = {
      perDay: { 0: [ent('a', 'DB Incline')] },
      perWeekDay: { '2|0': w2 },
    };
    const block = { ...baseBlock, assistance: plan };
    expect(resolveAssistance(block, 1, 0).map((e) => e.movementName)).toEqual(['DB Incline']);
    expect(resolveAssistance(block, 2, 0).map((e) => e.movementName)).toEqual(['Dips']);
    expect(resolveAssistance(block, 3, 0).map((e) => e.movementName)).toEqual(['DB Incline']);
  });

  it('returns empty if neither override nor day default exists', () => {
    const plan: AssistancePlan = { perDay: { 0: [ent('a', 'X')] } };
    const block = { ...baseBlock, assistance: plan };
    expect(resolveAssistance(block, 1, 5)).toEqual([]);
  });
});

describe('hasAssistanceOverride', () => {
  it('reports true only for keys present in perWeekDay', () => {
    const plan: AssistancePlan = {
      perDay: { 0: [ent('a', 'X')] },
      perWeekDay: { '2|0': [ent('b', 'Y')] },
    };
    const block = { ...baseBlock, assistance: plan };
    expect(hasAssistanceOverride(block, 2, 0)).toBe(true);
    expect(hasAssistanceOverride(block, 1, 0)).toBe(false);
    expect(hasAssistanceOverride(baseBlock, 1, 0)).toBe(false);
  });
});

describe('assistanceLabel', () => {
  it('formats reps as N×R Movement', () => {
    expect(assistanceLabel(ent('a', 'DB Incline Bench Press', 3, 10))).toBe(
      '3\u00d710 DB Incline Bench Press',
    );
  });

  it('formats rep ranges with an en-dash', () => {
    expect(
      assistanceLabel({ ...ent('a', 'Chinup'), reps: 8, repsMax: 10 }),
    ).toBe('3\u00d78\u201310 Chinup');
  });

  it('formats sec unit', () => {
    expect(
      assistanceLabel({ ...ent('a', 'Plank'), reps: 30, unit: 'sec' }),
    ).toBe('3\u00d730 sec Plank');
  });

  it('formats each-side / each-arm / each-leg', () => {
    expect(
      assistanceLabel({ ...ent('a', 'Pallof Press'), reps: 15, unit: 'each-side' }),
    ).toBe('3\u00d715 each side Pallof Press');
    expect(
      assistanceLabel({ ...ent('a', 'DB Row'), reps: 10, unit: 'each-arm' }),
    ).toBe('3\u00d710 each arm DB Row');
    expect(
      assistanceLabel({ ...ent('a', 'Single-leg RDL'), reps: 8, unit: 'each-leg' }),
    ).toBe('3\u00d78 each leg Single-leg RDL');
  });

  it('does not duplicate the upper bound when reps==repsMax', () => {
    expect(
      assistanceLabel({ ...ent('a', 'Pushup'), reps: 10, repsMax: 10 }),
    ).toBe('3\u00d710 Pushup');
  });

  it('appends + for AMRAP entries', () => {
    expect(assistanceLabel({ ...ent('a', 'Chinup'), reps: 8, isAmrap: true })).toBe(
      '3\u00d78+ Chinup',
    );
    expect(
      assistanceLabel({ ...ent('a', 'Chinup'), reps: 8, repsMax: 10, isAmrap: true }),
    ).toBe('3\u00d78\u201310+ Chinup');
  });
});

describe('categoryFromMovement', () => {
  it('maps push patterns to push', () => {
    expect(categoryFromMovement({ name: 'DB Bench Press', pattern: 'push-horizontal' })).toBe(
      'push',
    );
    expect(categoryFromMovement({ name: 'Push Press', pattern: 'push-vertical' })).toBe('push');
  });
  it('maps pull patterns to pull', () => {
    expect(categoryFromMovement({ name: 'Chinup', pattern: 'pull-vertical' })).toBe('pull');
    expect(categoryFromMovement({ name: 'Barbell Row', pattern: 'pull-horizontal' })).toBe('pull');
  });
  it('maps core to core', () => {
    expect(categoryFromMovement({ name: 'Plank', pattern: 'core' })).toBe('core');
  });
  it('maps squat/hinge to accessory by default; carry to its own carry category', () => {
    expect(categoryFromMovement({ name: 'Front Squat', pattern: 'squat' })).toBe('accessory');
    expect(categoryFromMovement({ name: 'Romanian Deadlift', pattern: 'hinge' })).toBe('accessory');
    expect(categoryFromMovement({ name: 'Farmer Carry', pattern: 'carry' })).toBe('carry');
    expect(categoryFromMovement({ name: 'Suitcase Carry', pattern: 'carry' })).toBe('carry');
  });
  it('detects single-leg work from name regardless of pattern', () => {
    expect(categoryFromMovement({ name: 'Bulgarian Split Squat', pattern: 'squat' })).toBe(
      'single-leg',
    );
    expect(categoryFromMovement({ name: 'DB Reverse Lunge', pattern: 'squat' })).toBe('single-leg');
    expect(categoryFromMovement({ name: 'Single-leg RDL', pattern: 'hinge' })).toBe('single-leg');
    expect(categoryFromMovement({ name: 'Step-up', pattern: 'squat' })).toBe('single-leg');
    expect(categoryFromMovement({ name: 'Pistol Squat', pattern: 'squat' })).toBe('single-leg');
  });
});

import {
  derivePlan,
  effectivePlan,
  resolveDayAssistance,
  hasDayAssistanceOverride,
  dayLabel,
  regeneratePlanForSchedule,
  type BlockPlan,
} from './blocks';
import type { MainLift } from './types';

describe('derivePlan', () => {
  it('groups dayOrder into single-lift days by default', () => {
    const plan = derivePlan({}, ['press', 'deadlift', 'bench', 'squat']);
    expect(plan.days.map((d) => d.mainLifts)).toEqual([
      ['press'], ['deadlift'], ['bench'], ['squat'],
    ]);
    expect(plan.days.every((d) => d.id.startsWith('legacy:'))).toBe(true);
  });

  it('respects liftsPerDay grouping', () => {
    const plan = derivePlan({}, ['press', 'deadlift', 'bench', 'squat'], 2);
    expect(plan.days.map((d) => d.mainLifts)).toEqual([
      ['press', 'deadlift'],
      ['bench', 'squat'],
    ]);
  });

  it('migrates legacy assistance.perDay into day.assistance', () => {
    const a = ent('a1', 'Chinup');
    const plan = derivePlan(
      { assistance: { perDay: { 0: [a] } } },
      ['press', 'deadlift', 'bench', 'squat'],
    );
    expect(plan.days[0]?.assistance).toEqual([a]);
    expect(plan.days[1]?.assistance).toEqual([]);
  });

  it('migrates legacy perWeekDay overrides keyed by index → dayId', () => {
    const o = ent('o1', 'Pushup');
    const plan = derivePlan(
      { assistance: { perDay: {}, perWeekDay: { '1|2': [o] } } },
      ['press', 'deadlift', 'bench', 'squat'],
    );
    expect(plan.assistanceOverrides?.['1|legacy:2']).toEqual([o]);
  });

  it('schedule overload preserves accessory-day slot and label', () => {
    const plan = derivePlan(
      {},
      {
        dayOrder: ['squat', 'press'] as MainLift[],
        liftsPerDay: 1,
        dayGroups: [
          { mainLifts: ['squat'] as MainLift[] },
          { mainLifts: [] as MainLift[], label: 'Conditioning' },
          { mainLifts: ['press'] as MainLift[] },
        ],
      },
    );
    expect(plan.days).toHaveLength(3);
    expect(plan.days[0]?.mainLifts).toEqual(['squat']);
    expect(plan.days[1]?.mainLifts).toEqual([]);
    expect(plan.days[1]?.label).toBe('Conditioning');
    expect(plan.days[2]?.mainLifts).toEqual(['press']);
  });
});

describe('effectivePlan', () => {
  it('returns block.plan when set', () => {
    const plan: BlockPlan = { days: [{ id: 'd1', mainLifts: ['press'], assistance: [] }] };
    const got = effectivePlan({ plan }, ['press', 'deadlift', 'bench', 'squat']);
    expect(got).toBe(plan);
  });
  it('falls back to derivePlan when missing', () => {
    const got = effectivePlan({}, ['press', 'deadlift']);
    expect(got.days).toHaveLength(2);
  });
});

describe('resolveDayAssistance', () => {
  const a = ent('a1', 'Chinup');
  const o = ent('o1', 'Pushup');
  const plan: BlockPlan = {
    days: [{ id: 'd1', mainLifts: ['press'], assistance: [a] }],
    assistanceOverrides: { '1|d1': [o] },
  };
  it('returns override when present', () => {
    expect(resolveDayAssistance(plan, 1, 'd1')).toEqual([o]);
  });
  it('falls back to day default', () => {
    expect(resolveDayAssistance(plan, 2, 'd1')).toEqual([a]);
  });
  it('returns empty for unknown dayId', () => {
    expect(resolveDayAssistance(plan, 1, 'nope')).toEqual([]);
  });
  it('reports override presence', () => {
    expect(hasDayAssistanceOverride(plan, 1, 'd1')).toBe(true);
    expect(hasDayAssistanceOverride(plan, 2, 'd1')).toBe(false);
  });
});

describe('dayLabel', () => {
  it('uses explicit label', () => {
    expect(dayLabel({ id: 'd1', label: 'Heavy day', mainLifts: [], assistance: [] }, 0))
      .toBe('Heavy day');
  });
  it('falls back to Day N', () => {
    expect(dayLabel({ id: 'd1', mainLifts: ['press'], assistance: [] }, 2))
      .toBe('Day 3');
  });
  it('marks pure-assistance days', () => {
    expect(dayLabel({ id: 'd1', mainLifts: [], assistance: [] }, 0))
      .toBe('Day 1 · Assistance only');
  });
});

describe('parseAssistancePrescription', () => {
  it('parses simple sets x reps', () => {
    expect(parseAssistancePrescription('3x10')).toEqual({ sets: 3, reps: 10 });
    expect(parseAssistancePrescription('3X10')).toEqual({ sets: 3, reps: 10 });
    expect(parseAssistancePrescription('3 × 10')).toEqual({ sets: 3, reps: 10 });
  });
  it('parses rep ranges with - – —', () => {
    expect(parseAssistancePrescription('3x8-10')).toEqual({ sets: 3, reps: 8, repsMax: 10 });
    expect(parseAssistancePrescription('3x8\u201310')).toEqual({ sets: 3, reps: 8, repsMax: 10 });
    expect(parseAssistancePrescription('3x10-10')).toEqual({ sets: 3, reps: 10 });
  });
  it('parses sec / seconds unit', () => {
    expect(parseAssistancePrescription('5x30 sec')).toEqual({ sets: 5, reps: 30, unit: 'sec' });
    expect(parseAssistancePrescription('3x60 seconds')).toEqual({ sets: 3, reps: 60, unit: 'sec' });
    expect(parseAssistancePrescription('3x45s')).toEqual({ sets: 3, reps: 45, unit: 'sec' });
  });
  it('parses each side / arm / leg variants', () => {
    expect(parseAssistancePrescription('3x10 each side')).toEqual({ sets: 3, reps: 10, unit: 'each-side' });
    expect(parseAssistancePrescription('3x10 ea')).toEqual({ sets: 3, reps: 10, unit: 'each-side' });
    expect(parseAssistancePrescription('3x10 /side')).toEqual({ sets: 3, reps: 10, unit: 'each-side' });
    expect(parseAssistancePrescription('4x12 each arm')).toEqual({ sets: 4, reps: 12, unit: 'each-arm' });
    expect(parseAssistancePrescription('3x8 each leg')).toEqual({ sets: 3, reps: 8, unit: 'each-leg' });
  });
  it('rejects unparseable input', () => {
    expect(parseAssistancePrescription('hello')).toBeNull();
    expect(parseAssistancePrescription('3x10 foo')).toBeNull();
    expect(parseAssistancePrescription('0x10')).toBeNull();
  });
  it('parses trailing + as isAmrap', () => {
    expect(parseAssistancePrescription('3x8+')).toEqual({ sets: 3, reps: 8, isAmrap: true });
    expect(parseAssistancePrescription('3x8-10+')).toEqual({
      sets: 3,
      reps: 8,
      repsMax: 10,
      isAmrap: true,
    });
    expect(parseAssistancePrescription('3x10+ each side')).toEqual({
      sets: 3,
      reps: 10,
      unit: 'each-side',
      isAmrap: true,
    });
  });
});

describe('formatAssistancePrescription', () => {
  it('round-trips through the parser', () => {
    const cases = [
      '3x10',
      '3x8-10',
      '5x30 sec',
      '3x10 each side',
      '4x12 each arm',
      '3x8 each leg',
      '3x8+',
      '3x8-10+',
    ];
    for (const c of cases) {
      const parsed = parseAssistancePrescription(c)!;
      const formatted = formatAssistancePrescription(parsed).replace('\u00d7', 'x');
      expect(formatted).toBe(c);
    }
  });
});

describe('regeneratePlanForSchedule', () => {
  let n = 0;
  const newId = () => 'gen-' + (++n);

  it('preserves dayIds, assistance, and label up to min(old, new)', () => {
    n = 0;
    const oldPlan = {
      days: [
        { id: 'd1', label: 'Squat day', mainLifts: ['squat'], assistance: [{ id: 'a1', category: 'pull', movementName: 'Chinup', sets: 3, reps: 10 }] },
        { id: 'd2', mainLifts: ['bench'], assistance: [] },
      ],
    };
    const next = regeneratePlanForSchedule(oldPlan as any, ['press', 'deadlift', 'bench', 'squat'], 2, newId);
    expect(next.days).toHaveLength(2);
    expect(next.days[0]!.id).toBe('d1');
    expect(next.days[0]!.label).toBe('Squat day');
    expect(next.days[0]!.mainLifts).toEqual(['press', 'deadlift']);
    expect(next.days[0]!.assistance).toHaveLength(1);
    expect(next.days[1]!.id).toBe('d2');
    expect(next.days[1]!.mainLifts).toEqual(['bench', 'squat']);
  });

  it('appends fresh days with empty assistance when growing', () => {
    n = 0;
    const oldPlan = {
      days: [{ id: 'd1', mainLifts: ['squat'], assistance: [] }],
    };
    const next = regeneratePlanForSchedule(oldPlan as any, ['press', 'deadlift', 'bench', 'squat'], 1, newId);
    expect(next.days.map((d: any) => d.id)).toEqual(['d1', 'gen-1', 'gen-2', 'gen-3']);
    expect(next.days.map((d: any) => d.mainLifts[0])).toEqual(['press', 'deadlift', 'bench', 'squat']);
  });

  it('drops orphan overrides when shrinking', () => {
    n = 0;
    const oldPlan = {
      days: [
        { id: 'd1', mainLifts: ['squat'], assistance: [] },
        { id: 'd2', mainLifts: ['bench'], assistance: [] },
        { id: 'd3', mainLifts: ['press'], assistance: [] },
        { id: 'd4', mainLifts: ['deadlift'], assistance: [] },
      ],
      assistanceOverrides: {
        '1|d1': [{ id: 'k1', category: 'pull', movementName: 'Row', sets: 3, reps: 10 }],
        '1|d3': [{ id: 'k2', category: 'core', movementName: 'Plank', sets: 3, reps: 30 }],
      },
    };
    const next = regeneratePlanForSchedule(oldPlan as any, ['press', 'deadlift', 'bench', 'squat'], 2, newId);
    expect(next.days).toHaveLength(2);
    // d1 + d2 kept, d3 + d4 dropped → only override on d1 survives
    expect(next.assistanceOverrides).toEqual({ '1|d1': oldPlan.assistanceOverrides['1|d1'] });
  });

  it('ScheduleDay[] overload propagates accessory-day labels into new days', () => {
    n = 0;
    const oldPlan = {
      days: [{ id: 'd1', mainLifts: ['squat'], assistance: [] }],
    };
    const next = regeneratePlanForSchedule(
      oldPlan as any,
      [
        { mainLifts: ['squat'] as MainLift[] },
        { mainLifts: [] as MainLift[], label: 'Conditioning' },
        { mainLifts: ['press'] as MainLift[] },
      ],
      newId,
    );
    expect(next.days).toHaveLength(3);
    expect(next.days[0]!.id).toBe('d1');
    expect(next.days[0]!.label).toBeUndefined();
    expect(next.days[1]!.id).toBe('gen-1');
    expect(next.days[1]!.mainLifts).toEqual([]);
    expect(next.days[1]!.label).toBe('Conditioning');
    expect(next.days[2]!.id).toBe('gen-2');
    expect(next.days[2]!.label).toBeUndefined();
  });

  it('user-customized labels survive a re-shape', () => {
    n = 0;
    const oldPlan = {
      days: [{ id: 'd1', mainLifts: ['squat'], assistance: [], label: 'Heavy day' }],
    };
    const next = regeneratePlanForSchedule(
      oldPlan as any,
      [{ mainLifts: ['press'] as MainLift[], label: 'Schedule label' }],
      newId,
    );
    expect(next.days[0]!.label).toBe('Heavy day');
  });
});
