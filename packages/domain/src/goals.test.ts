import { describe, expect, it } from 'vitest';
import {
  deadlineInfo,
  evaluateHabitGoal,
  evaluateRaceGoal,
  evaluateStrengthPrGoal,
  evaluateStrengthTrend,
  summarizeGoal,
  type GoalLike,
} from './goals';

const NOW = new Date('2026-05-07T12:00:00Z');

function isoDaysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

describe('deadlineInfo', () => {
  it('reports overdue, today, days, weeks, months', () => {
    expect(deadlineInfo(isoDaysFromNow(-3), NOW)?.label).toBe('3d overdue');
    expect(deadlineInfo(isoDaysFromNow(0), NOW)?.label).toBe('today');
    expect(deadlineInfo(isoDaysFromNow(5), NOW)?.label).toBe('5d left');
    expect(deadlineInfo(isoDaysFromNow(21), NOW)?.label).toBe('3w left');
    expect(deadlineInfo(isoDaysFromNow(120), NOW)?.label).toBe('4mo left');
    expect(deadlineInfo(undefined, NOW)).toBeUndefined();
  });
});

describe('evaluateStrengthPrGoal', () => {
  const goal: GoalLike = {
    id: 'g1',
    kind: 'strength-pr',
    title: '200kg DL',
    target: 200,
    targetUnit: 'kg',
    createdAt: NOW.toISOString(),
  };
  it('returns 0 progress with no e1RM data', () => {
    const r = evaluateStrengthPrGoal(goal, undefined);
    expect(r?.progressPct).toBe(0);
    expect(r?.status).toBe('far');
  });
  it('classifies bands correctly', () => {
    expect(evaluateStrengthPrGoal(goal, 80)?.status).toBe('far'); // 0.4
    expect(evaluateStrengthPrGoal(goal, 130)?.status).toBe('on-track'); // 0.65
    expect(evaluateStrengthPrGoal(goal, 175)?.status).toBe('close'); // 0.875
    expect(evaluateStrengthPrGoal(goal, 200)?.status).toBe('achieved');
    expect(evaluateStrengthPrGoal(goal, 250)?.progressPct).toBe(1);
  });
  it('returns undefined for non-strength goals', () => {
    expect(evaluateStrengthPrGoal({ ...goal, kind: 'habit' }, 100)).toBeUndefined();
  });
});

describe('evaluateHabitGoal', () => {
  const goal: GoalLike = {
    id: 'g2',
    kind: 'habit',
    title: '20 sessions',
    target: 20,
    createdAt: NOW.toISOString(),
  };
  it('counts session progress', () => {
    expect(evaluateHabitGoal(goal, 0)?.status).toBe('far');
    expect(evaluateHabitGoal(goal, 18)?.status).toBe('close');
    expect(evaluateHabitGoal(goal, 20)?.status).toBe('achieved');
  });
});

describe('evaluateRaceGoal', () => {
  it('delegates to nextRaceWindow for race-time goals', () => {
    const goal: GoalLike = {
      id: 'g3',
      kind: 'race-time',
      title: 'HM sub 2h',
      deadline: isoDaysFromNow(20),
      createdAt: NOW.toISOString(),
    };
    const r = evaluateRaceGoal(goal, NOW);
    expect(r?.daysOut).toBe(20);
    expect(r?.phase).toBe('peak');
  });
});

describe('evaluateStrengthTrend', () => {
  it('returns undefined with no samples', () => {
    expect(evaluateStrengthTrend([], NOW)).toBeUndefined();
  });
  it('returns undefined with a single sample (no trend)', () => {
    expect(
      evaluateStrengthTrend([{ performedAt: isoDaysFromNow(-2), lift: 'dl', e1rmKg: 200 }], NOW),
    ).toBeUndefined();
  });
  it('detects upward trend across multiple lifts', () => {
    const samples = [
      { performedAt: isoDaysFromNow(-49), lift: 'dl', e1rmKg: 180 },
      { performedAt: isoDaysFromNow(-21), lift: 'dl', e1rmKg: 185 },
      { performedAt: isoDaysFromNow(-3), lift: 'dl', e1rmKg: 195 },
      { performedAt: isoDaysFromNow(-49), lift: 'sq', e1rmKg: 140 },
      { performedAt: isoDaysFromNow(-21), lift: 'sq', e1rmKg: 145 },
      { performedAt: isoDaysFromNow(-3), lift: 'sq', e1rmKg: 150 },
    ];
    const t = evaluateStrengthTrend(samples, NOW);
    expect(t?.direction).toBe('up');
    expect(t!.deltaPct).toBeGreaterThan(0);
    expect(t!.sparkline.length).toBeGreaterThan(1);
  });
  it('detects flat trend', () => {
    const samples = [
      { performedAt: isoDaysFromNow(-49), lift: 'dl', e1rmKg: 180 },
      { performedAt: isoDaysFromNow(-3), lift: 'dl', e1rmKg: 180.5 },
    ];
    const t = evaluateStrengthTrend(samples, NOW);
    expect(t?.direction).toBe('flat');
  });
  it('detects downward trend', () => {
    const samples = [
      { performedAt: isoDaysFromNow(-49), lift: 'dl', e1rmKg: 200 },
      { performedAt: isoDaysFromNow(-3), lift: 'dl', e1rmKg: 180 },
    ];
    const t = evaluateStrengthTrend(samples, NOW);
    expect(t?.direction).toBe('down');
    expect(t!.deltaPct).toBeLessThan(0);
  });
});

describe('summarizeGoal', () => {
  it('hard strength-pr goal: includes progressPct + sublabel', () => {
    const goal: GoalLike = {
      id: 'g1',
      kind: 'strength-pr',
      title: 'Front squat 150',
      target: 150,
      targetUnit: 'kg',
      createdAt: NOW.toISOString(),
    };
    const s = summarizeGoal(goal, {
      latestE1rmByLift: new Map([['squat', 120]]),
      now: NOW,
    });
    expect(s.progressPct).toBeCloseTo(0.8, 2);
    expect(s.sublabel).toMatch(/120 \/ 150/);
  });
  it('qualitative goal with no signal: just label + notes', () => {
    const goal: GoalLike = {
      id: 'g2',
      kind: 'qualitative',
      title: 'Improved aesthetics',
      notes: 'Leaner, more visible abs by summer',
      createdAt: NOW.toISOString(),
    };
    const s = summarizeGoal(goal, { now: NOW });
    expect(s.label).toBe('Improved aesthetics');
    expect(s.sublabel).toMatch(/Leaner/);
    expect(s.progressPct).toBeUndefined();
    expect(s.trend).toBeUndefined();
  });
  it('qualitative goal with strength-trend signal: attaches trend', () => {
    const goal: GoalLike = {
      id: 'g3',
      kind: 'qualitative',
      title: 'Get stronger',
      signal: 'strength-trend',
      createdAt: NOW.toISOString(),
    };
    const s = summarizeGoal(goal, {
      e1rmSamples: [
        { performedAt: isoDaysFromNow(-49), lift: 'dl', e1rmKg: 180 },
        { performedAt: isoDaysFromNow(-3), lift: 'dl', e1rmKg: 195 },
      ],
      now: NOW,
    });
    expect(s.trend).toBeDefined();
    expect(s.trend?.direction).toBe('up');
  });
  it('strength-pr without movementId / liftByGoalId picks the highest lift e1RM (legacy fallback)', () => {
    const goal: GoalLike = {
      id: 'g-old',
      kind: 'strength-pr',
      title: 'Bench 120',
      target: 120,
      targetUnit: 'kg',
      createdAt: NOW.toISOString(),
    };
    const s = summarizeGoal(goal, {
      latestE1rmByLift: new Map([
        ['bench', 90],
        ['deadlift', 200],
      ]),
      now: NOW,
    });
    // Buggy fallback: compares against deadlift (200) → "achieved" rather
    // than bench (90). Encoded so any future change is intentional.
    expect(s.sublabel).toMatch(/200 \/ 120/);
  });
  it('strength-pr with liftByGoalId compares against the correct lift', () => {
    const goal: GoalLike = {
      id: 'g-bench',
      kind: 'strength-pr',
      title: 'Bench 120',
      target: 120,
      targetUnit: 'kg',
      movementId: 'movement-bench',
      createdAt: NOW.toISOString(),
    };
    const s = summarizeGoal(goal, {
      latestE1rmByLift: new Map([
        ['bench', 90],
        ['deadlift', 200],
      ]),
      liftByGoalId: new Map([['g-bench', 'bench']]),
      now: NOW,
    });
    expect(s.sublabel).toMatch(/90 \/ 120/);
    expect(s.progressPct).toBeCloseTo(0.75, 2);
  });
  it('race-time goal: deadline label rendered', () => {
    const goal: GoalLike = {
      id: 'g4',
      kind: 'race-time',
      title: 'Half-marathon sub 2h',
      deadline: isoDaysFromNow(45),
      createdAt: NOW.toISOString(),
    };
    const s = summarizeGoal(goal, { now: NOW });
    expect(s.sublabel).toMatch(/Race in/);
    expect(s.deadline?.daysOut).toBe(45);
  });
});
