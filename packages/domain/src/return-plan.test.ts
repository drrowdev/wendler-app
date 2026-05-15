import { describe, expect, it } from 'vitest';
import {
  illnessDaysOut,
  e1rmTrend,
  lastAmrapPerformance,
  recommendReturnPlan,
  type BlockState,
  type IllnessSignal,
  type MinimalSet,
  type ReturnPlanInput,
} from './index';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function illness(over: Partial<IllnessSignal> = {}): IllnessSignal {
  return {
    severity: 'mild',
    startedAt: '2026-04-01',
    recoveredAt: '2026-04-02',
    ...over,
  };
}

function block(over: Partial<BlockState> = {}): BlockState {
  return {
    cycleNumber: 6,
    week: 2,
    phase: 'standard',
    ...over,
  };
}

function set(over: Partial<MinimalSet> = {}): MinimalSet {
  return {
    movementId: 'press',
    performedAt: '2026-03-01T10:00:00Z',
    weightKg: 100,
    reps: 5,
    kind: 'main',
    ...over,
  };
}

function input(over: Partial<ReturnPlanInput> = {}): ReturnPlanInput {
  return {
    illness: illness(),
    blockState: block(),
    sets: [],
    mainLiftMovementIds: { press: 'press', bench: 'bench', squat: 'squat', deadlift: 'deadlift' },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('illnessDaysOut', () => {
  it('counts inclusively (same day = 1 day)', () => {
    expect(illnessDaysOut(illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-01' }))).toBe(1);
  });
  it('counts a 5-day stretch correctly', () => {
    expect(illnessDaysOut(illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-05' }))).toBe(5);
  });
});

describe('e1rmTrend', () => {
  it('returns "unknown" with too few data points', () => {
    expect(e1rmTrend([], 'press', '2026-04-10')).toBe('unknown');
    expect(
      e1rmTrend(
        [set({ performedAt: '2026-04-01T10:00:00Z', weightKg: 100, reps: 5, isAmrap: true })],
        'press',
        '2026-04-10',
      ),
    ).toBe('unknown');
  });

  it('detects a clear upward trend', () => {
    const sets: MinimalSet[] = [
      set({ performedAt: '2026-03-01T10:00:00Z', weightKg: 100, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-08T10:00:00Z', weightKg: 102.5, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-15T10:00:00Z', weightKg: 105, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-22T10:00:00Z', weightKg: 107.5, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-29T10:00:00Z', weightKg: 110, reps: 5, isAmrap: true }),
    ];
    expect(e1rmTrend(sets, 'press', '2026-04-05')).toBe('rising');
  });

  it('detects a clear downward trend', () => {
    const sets: MinimalSet[] = [
      set({ performedAt: '2026-03-01T10:00:00Z', weightKg: 110, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-08T10:00:00Z', weightKg: 107.5, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-15T10:00:00Z', weightKg: 105, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-22T10:00:00Z', weightKg: 102.5, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-29T10:00:00Z', weightKg: 100, reps: 5, isAmrap: true }),
    ];
    expect(e1rmTrend(sets, 'press', '2026-04-05')).toBe('falling');
  });

  it('returns "flat" when the slope is small', () => {
    const sets: MinimalSet[] = [
      set({ performedAt: '2026-03-01T10:00:00Z', weightKg: 100, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-08T10:00:00Z', weightKg: 100.2, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-15T10:00:00Z', weightKg: 99.8, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-22T10:00:00Z', weightKg: 100.1, reps: 5, isAmrap: true }),
    ];
    expect(e1rmTrend(sets, 'press', '2026-04-05')).toBe('flat');
  });

  it('is cadence-independent: 1x/wk vs 2x/wk same true progress → same verdict', () => {
    // 1x/wk: 4 points spread over 21 days, +1 kg/week → "rising"
    const onceWeekly: MinimalSet[] = [
      set({ performedAt: '2026-03-01T10:00:00Z', weightKg: 100, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-08T10:00:00Z', weightKg: 101, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-15T10:00:00Z', weightKg: 102, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-22T10:00:00Z', weightKg: 103, reps: 5, isAmrap: true }),
    ];
    // 2x/wk: 7 points over the same 21 days, same +1 kg/week rate.
    const twiceWeekly: MinimalSet[] = [
      set({ performedAt: '2026-03-01T10:00:00Z', weightKg: 100.0, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-04T10:00:00Z', weightKg: 100.5, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-08T10:00:00Z', weightKg: 101.0, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-11T10:00:00Z', weightKg: 101.5, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-15T10:00:00Z', weightKg: 102.0, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-18T10:00:00Z', weightKg: 102.5, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-22T10:00:00Z', weightKg: 103.0, reps: 5, isAmrap: true }),
    ];
    // Pre-fix: per-point slope halved on 2x cadence → could be classed
    // as "flat" while 1x got "rising". Post-fix: both report the same.
    expect(e1rmTrend(onceWeekly, 'press', '2026-04-05')).toBe('rising');
    expect(e1rmTrend(twiceWeekly, 'press', '2026-04-05')).toBe('rising');
  });

  it('returns "unknown" when span < 14 days even with 3+ points', () => {
    // 3 points all in one week — slope is meaningless, don't pretend.
    const sets: MinimalSet[] = [
      set({ performedAt: '2026-04-01T10:00:00Z', weightKg: 100, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-04-03T10:00:00Z', weightKg: 103, reps: 5, isAmrap: true }),
      set({ performedAt: '2026-04-05T10:00:00Z', weightKg: 106, reps: 5, isAmrap: true }),
    ];
    expect(e1rmTrend(sets, 'press', '2026-04-08')).toBe('unknown');
  });
});

describe('lastAmrapPerformance', () => {
  it('returns "unknown" with no AMRAPs', () => {
    expect(lastAmrapPerformance([], 'press')).toBe('unknown');
  });
  it('returns "crushing" for ≥8 reps on the most recent AMRAP', () => {
    const sets: MinimalSet[] = [
      set({ performedAt: '2026-03-01T10:00:00Z', reps: 5, isAmrap: true }),
      set({ performedAt: '2026-03-15T10:00:00Z', reps: 9, isAmrap: true }), // most recent
    ];
    expect(lastAmrapPerformance(sets, 'press')).toBe('crushing');
  });
  it('returns "struggling" for ≤2 reps on the most recent AMRAP', () => {
    const sets: MinimalSet[] = [
      set({ performedAt: '2026-03-15T10:00:00Z', reps: 1, isAmrap: true }),
    ];
    expect(lastAmrapPerformance(sets, 'press')).toBe('struggling');
  });
  it('returns "on-target" for mid-range reps', () => {
    const sets: MinimalSet[] = [
      set({ performedAt: '2026-03-15T10:00:00Z', reps: 5, isAmrap: true }),
    ];
    expect(lastAmrapPerformance(sets, 'press')).toBe('on-target');
  });
});

// ---------------------------------------------------------------------------
// recommendReturnPlan — strategy selection
// ---------------------------------------------------------------------------

describe('recommendReturnPlan — strategy table', () => {
  it('returns null when illness has not been marked recovered', () => {
    const result = recommendReturnPlan(
      input({ illness: { ...illness(), recoveredAt: '' as unknown as string } }),
    );
    expect(result).toBeNull();
  });

  it('1–2 day mild → skip-amrap-today', () => {
    const result = recommendReturnPlan(input());
    expect(result?.primary.strategy).toBe('skip-amrap-today');
  });

  it('1–2 day moderate → replay-current-week (residual fatigue)', () => {
    const result = recommendReturnPlan(
      input({ illness: illness({ severity: 'moderate' }) }),
    );
    expect(result?.primary.strategy).toBe('replay-current-week');
  });

  it('3 days mild mid-cycle → replay-current-week', () => {
    const result = recommendReturnPlan(
      input({
        illness: illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-03' }),
      }),
    );
    expect(result?.primary.strategy).toBe('replay-current-week');
  });

  it('5 days mild mid-cycle → restart-cycle-tm-hold', () => {
    const result = recommendReturnPlan(
      input({
        illness: illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-05' }),
      }),
    );
    expect(result?.primary.strategy).toBe('restart-cycle-tm-hold');
  });

  it('7 days mild mid-cycle → restart-cycle-tm-down-5 with TM adjustment', () => {
    const result = recommendReturnPlan(
      input({
        illness: illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-07' }),
      }),
    );
    expect(result?.primary.strategy).toBe('restart-cycle-tm-down-5');
    expect(result?.primary.tmAdjustmentPercent).toBe(-0.05);
  });

  it('14+ days mild → reset-with-ramp', () => {
    const result = recommendReturnPlan(
      input({
        illness: illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-14' }),
      }),
    );
    expect(result?.primary.strategy).toBe('reset-with-ramp');
    expect(result?.primary.tmAdjustmentPercent).toBe(-0.05);
  });

  it('1 day during deload → extend-deload', () => {
    const result = recommendReturnPlan(
      input({
        illness: illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-01' }),
        blockState: block({ phase: 'deload', week: 'deload' }),
      }),
    );
    expect(result?.primary.strategy).toBe('extend-deload');
  });
});

// ---------------------------------------------------------------------------
// Severity floor: severe is never lighter than restart-cycle-tm-hold
// ---------------------------------------------------------------------------

describe('recommendReturnPlan — severity floor', () => {
  const severeStrategies = new Set([
    'restart-cycle-tm-hold',
    'restart-cycle-tm-down-5',
    'reset-with-ramp',
    'reschedule-meet',
  ]);

  it.each([
    ['1 day', '2026-04-01', '2026-04-01'],
    ['3 days', '2026-04-01', '2026-04-03'],
    ['7 days', '2026-04-01', '2026-04-07'],
    ['14 days', '2026-04-01', '2026-04-14'],
  ])('severe %s → strategy ≥ restart-cycle-tm-hold', (_label, started, recovered) => {
    const result = recommendReturnPlan(
      input({ illness: illness({ severity: 'severe', startedAt: started, recoveredAt: recovered }) }),
    );
    expect(severeStrategies.has(result!.primary.strategy)).toBe(true);
  });

  it('severe ≥14 days → reset-with-ramp with TM −10%', () => {
    const result = recommendReturnPlan(
      input({
        illness: illness({ severity: 'severe', startedAt: '2026-04-01', recoveredAt: '2026-04-15' }),
      }),
    );
    expect(result?.primary.strategy).toBe('reset-with-ramp');
    expect(result?.primary.tmAdjustmentPercent).toBe(-0.1);
  });
});

// ---------------------------------------------------------------------------
// A-race override
// ---------------------------------------------------------------------------

describe('recommendReturnPlan — A-race override', () => {
  it('A-race within 4 weeks always selects reschedule-meet', () => {
    const result = recommendReturnPlan(
      input({
        upcomingRaces: [{ date: '2026-04-15', priority: 'A' }],
      }),
    );
    expect(result?.primary.strategy).toBe('reschedule-meet');
  });

  it('A-race beyond 4 weeks does NOT override', () => {
    const result = recommendReturnPlan(
      input({
        // 60 days out — well beyond the taper window
        upcomingRaces: [{ date: '2026-06-01', priority: 'A' }],
      }),
    );
    expect(result?.primary.strategy).not.toBe('reschedule-meet');
  });

  it('B-race never triggers reschedule-meet (only A)', () => {
    const result = recommendReturnPlan(
      input({
        upcomingRaces: [{ date: '2026-04-15', priority: 'B' }],
      }),
    );
    expect(result?.primary.strategy).not.toBe('reschedule-meet');
  });

  it('C-race is ignored entirely', () => {
    const result = recommendReturnPlan(
      input({
        upcomingRaces: [{ date: '2026-04-10', priority: 'C' }],
      }),
    );
    expect(result?.primary.strategy).toBe('skip-amrap-today');
  });

  it('A-race within 4w wins even over a 14-day severe illness', () => {
    const result = recommendReturnPlan(
      input({
        illness: illness({ severity: 'severe', startedAt: '2026-04-01', recoveredAt: '2026-04-15' }),
        upcomingRaces: [{ date: '2026-05-05', priority: 'A' }],
      }),
    );
    expect(result?.primary.strategy).toBe('reschedule-meet');
  });
});

// ---------------------------------------------------------------------------
// Modifier nudges
// ---------------------------------------------------------------------------

describe('recommendReturnPlan — modifiers', () => {
  it('rising trend mention appears in rationale for mid-cycle replay', () => {
    const sets: MinimalSet[] = [
      set({ movementId: 'press', performedAt: '2026-03-01T10:00:00Z', weightKg: 100, reps: 5, isAmrap: true }),
      set({ movementId: 'press', performedAt: '2026-03-08T10:00:00Z', weightKg: 102.5, reps: 5, isAmrap: true }),
      set({ movementId: 'press', performedAt: '2026-03-15T10:00:00Z', weightKg: 105, reps: 5, isAmrap: true }),
      set({ movementId: 'press', performedAt: '2026-03-22T10:00:00Z', weightKg: 107.5, reps: 5, isAmrap: true }),
      set({ movementId: 'press', performedAt: '2026-03-29T10:00:00Z', weightKg: 110, reps: 5, isAmrap: true }),
    ];
    const result = recommendReturnPlan(
      input({
        illness: illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-03' }),
        sets,
      }),
    );
    expect(result?.primary.strategy).toBe('replay-current-week');
    expect(result?.primary.rationale.toLowerCase()).toContain('trending up');
  });

  it('struggling AMRAPs lower confidence on mid-cycle replay', () => {
    const sets: MinimalSet[] = [
      set({ movementId: 'press', performedAt: '2026-03-29T10:00:00Z', reps: 1, isAmrap: true }),
    ];
    const result = recommendReturnPlan(
      input({
        illness: illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-03' }),
        sets,
      }),
    );
    expect(result?.primary.strategy).toBe('replay-current-week');
    expect(result?.primary.confidence).toBe('medium');
    expect(result?.primary.rationale.toLowerCase()).toMatch(/light|conservatively/);
  });

  it('high post-recovery fatigue upgrades 1-day mild to replay-week', () => {
    const result = recommendReturnPlan(
      input({
        recoveryAfter: [
          { date: '2026-04-03', fatigue: 8 },
          { date: '2026-04-04', fatigue: 7 },
        ],
      }),
    );
    expect(result?.primary.strategy).toBe('replay-current-week');
  });
});

// ---------------------------------------------------------------------------
// Output shape contract
// ---------------------------------------------------------------------------

describe('recommendReturnPlan — output shape', () => {
  it('always returns a non-empty headline and rationale', () => {
    const result = recommendReturnPlan(input());
    expect(result?.primary.headline.length).toBeGreaterThan(0);
    expect(result?.primary.rationale.length).toBeGreaterThan(0);
  });

  it('always returns at least one alternative', () => {
    const result = recommendReturnPlan(input());
    expect(result?.alternatives.length).toBeGreaterThanOrEqual(1);
  });

  it('handles a brand-new user with empty history', () => {
    const result = recommendReturnPlan({
      illness: illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-04' }),
      blockState: block(),
      sets: [],
      mainLiftMovementIds: {},
    });
    // 4 days mild mid-cycle → replay-current-week
    expect(result).not.toBeNull();
    expect(result!.primary.strategy).toBe('replay-current-week');
  });

  it('reset-with-ramp / restart-cycle strategies expose tmAdjustmentPercent', () => {
    const result = recommendReturnPlan(
      input({ illness: illness({ startedAt: '2026-04-01', recoveredAt: '2026-04-14' }) }),
    );
    expect(result?.primary.tmAdjustmentPercent).toBeLessThan(0);
  });

  it('skip-amrap-today / replay-current-week / extend-deload do NOT auto-adjust TM', () => {
    const result = recommendReturnPlan(input());
    expect(result?.primary.strategy).toBe('skip-amrap-today');
    expect(result?.primary.tmAdjustmentPercent).toBeUndefined();
  });
});
