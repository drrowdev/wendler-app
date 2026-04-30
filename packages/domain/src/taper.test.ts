import { describe, it, expect } from 'vitest';
import { nextRaceWindow, type RaceGoal } from './taper';

const now = new Date('2026-05-01T12:00:00Z');

function race(daysOut: number, id = 'g1', completed = false): RaceGoal {
  const d = new Date(now.getTime() + daysOut * 86400000);
  return {
    id,
    title: `${daysOut}d race`,
    kind: 'race-time',
    deadline: d.toISOString(),
    completedAt: completed ? d.toISOString() : undefined,
  };
}

describe('nextRaceWindow', () => {
  it('returns undefined when no race goals', () => {
    expect(nextRaceWindow({ goals: [], now })).toBeUndefined();
  });

  it('ignores non-race goals', () => {
    expect(
      nextRaceWindow({
        goals: [{ id: 'g', title: 'PR', kind: 'strength-pr', deadline: now.toISOString() }],
        now,
      }),
    ).toBeUndefined();
  });

  it('ignores completed races', () => {
    expect(nextRaceWindow({ goals: [race(5, 'g', true)], now })).toBeUndefined();
  });

  it('classifies race day', () => {
    const w = nextRaceWindow({ goals: [race(0)], now })!;
    expect(w.phase).toBe('race-day');
    expect(w.strengthVolumeMultiplier).toBe(0);
  });

  it('classifies race week (1-6 days)', () => {
    const w = nextRaceWindow({ goals: [race(3)], now })!;
    expect(w.phase).toBe('race-week');
    expect(w.daysOut).toBe(3);
  });

  it('classifies taper (7-14 days)', () => {
    expect(nextRaceWindow({ goals: [race(10)], now })!.phase).toBe('taper');
  });

  it('classifies peak (15-28 days)', () => {
    expect(nextRaceWindow({ goals: [race(20)], now })!.phase).toBe('peak');
  });

  it('classifies build (29-84 days)', () => {
    expect(nextRaceWindow({ goals: [race(60)], now })!.phase).toBe('build');
  });

  it('classifies off-season (>84 days)', () => {
    expect(nextRaceWindow({ goals: [race(120)], now })!.phase).toBe('off-season');
  });

  it('picks the soonest race when multiple present', () => {
    const w = nextRaceWindow({
      goals: [race(60, 'far'), race(8, 'near'), race(30, 'mid')],
      now,
    })!;
    expect(w.goalId).toBe('near');
    expect(w.phase).toBe('taper');
  });
});
