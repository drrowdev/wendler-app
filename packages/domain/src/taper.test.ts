import { describe, it, expect } from 'vitest';
import { nextRaceWindow, taperRecommendation, type RaceGoal } from './taper';
import type { RaceLike } from './races';

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

function R(daysOut: number, over: Partial<RaceLike> = {}): RaceLike {
  const d = new Date(now.getTime() + daysOut * 86400000);
  return {
    id: over.id ?? 'r1',
    name: over.name ?? `${daysOut}d race`,
    date: d.toISOString(),
    kind: 'half-marathon',
    priority: 'A',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
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

describe('taperRecommendation (race-driven)', () => {
  it('priority C is always normal', () => {
    expect(taperRecommendation(R(3, { priority: 'C' }), now).phase).toBe('normal');
    expect(taperRecommendation(R(60, { priority: 'C' }), now).phase).toBe('normal');
  });

  it('completed race is always normal', () => {
    expect(
      taperRecommendation(
        R(2, { priority: 'A', completedAt: '2026-04-30T10:00:00Z' }),
        now,
      ).phase,
    ).toBe('normal');
  });

  it('past race (>1d ago) is normal', () => {
    expect(taperRecommendation(R(-3, { priority: 'A' }), now).phase).toBe('normal');
  });

  describe('priority A (marathon-style)', () => {
    it('> 21d: normal', () => {
      expect(taperRecommendation(R(30, { priority: 'A' }), now).phase).toBe('normal');
    });
    it('14–21d: deload-prompt', () => {
      expect(taperRecommendation(R(20, { priority: 'A' }), now).phase).toBe('deload-prompt');
      expect(taperRecommendation(R(15, { priority: 'A' }), now).phase).toBe('deload-prompt');
    });
    it('5–14d: maintenance', () => {
      expect(taperRecommendation(R(10, { priority: 'A' }), now).phase).toBe('maintenance');
      expect(taperRecommendation(R(6, { priority: 'A' }), now).phase).toBe('maintenance');
    });
    it('0–5d: cutoff', () => {
      expect(taperRecommendation(R(5, { priority: 'A' }), now).phase).toBe('cutoff');
      expect(taperRecommendation(R(0, { priority: 'A' }), now).phase).toBe('cutoff');
    });
  });

  describe('priority B (half-marathon-style)', () => {
    it('> 14d: normal', () => {
      expect(taperRecommendation(R(20, { priority: 'B' }), now).phase).toBe('normal');
    });
    it('10–14d: deload-prompt', () => {
      expect(taperRecommendation(R(13, { priority: 'B' }), now).phase).toBe('deload-prompt');
      expect(taperRecommendation(R(11, { priority: 'B' }), now).phase).toBe('deload-prompt');
    });
    it('5–10d: maintenance', () => {
      expect(taperRecommendation(R(9, { priority: 'B' }), now).phase).toBe('maintenance');
      expect(taperRecommendation(R(6, { priority: 'B' }), now).phase).toBe('maintenance');
    });
    it('0–5d: cutoff', () => {
      expect(taperRecommendation(R(5, { priority: 'B' }), now).phase).toBe('cutoff');
      expect(taperRecommendation(R(2, { priority: 'B' }), now).phase).toBe('cutoff');
    });
  });

  it('reason string is non-empty for any non-normal phase', () => {
    for (const days of [3, 8, 18]) {
      const rec = taperRecommendation(R(days, { priority: 'A' }), now);
      expect(rec.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('nextRaceWindow with races[] (race-driven path)', () => {
  it('returns undefined when no upcoming A/B races', () => {
    expect(nextRaceWindow({ goals: [], races: [], now })).toBeUndefined();
    expect(
      nextRaceWindow({ goals: [], races: [R(10, { priority: 'C' })], now }),
    ).toBeUndefined();
  });

  it('picks the soonest A/B race', () => {
    const w = nextRaceWindow({
      goals: [],
      races: [
        R(60, { id: 'far', priority: 'A' }),
        R(12, { id: 'near', priority: 'B' }),
        R(30, { id: 'mid', priority: 'A' }),
      ],
      now,
    })!;
    expect(w.raceId).toBe('near');
    expect(w.raceTaperPhase).toBe('deload-prompt');
    expect(w.racePriority).toBe('B');
  });

  it('falls back to goals when races[] is empty', () => {
    const w = nextRaceWindow({
      goals: [race(10, 'gOnly')],
      races: [],
      now,
    })!;
    expect(w.goalId).toBe('gOnly');
    expect(w.raceTaperPhase).toBeUndefined();
    expect(w.phase).toBe('taper');
  });

  it('race-driven cutoff produces race-week / race-day legacy phase', () => {
    const w = nextRaceWindow({
      goals: [],
      races: [R(2, { priority: 'A' })],
      now,
    })!;
    expect(w.phase).toBe('race-week');
    const wDay = nextRaceWindow({
      goals: [],
      races: [R(0, { priority: 'A' })],
      now,
    })!;
    expect(wDay.phase).toBe('race-day');
  });

  it('skips C races even if soonest, prefers next A/B', () => {
    const w = nextRaceWindow({
      goals: [],
      races: [
        R(3, { id: 'tuneup', priority: 'C' }),
        R(20, { id: 'goal', priority: 'A' }),
      ],
      now,
    })!;
    expect(w.raceId).toBe('goal');
  });
});

import {
  proposedTaperActions,
  proposedTaperActionsByRace,
  computeEffectiveGoalFlags,
  type GoalFlagsLike,
} from './taper';

const manualOff: GoalFlagsLike = {
  marathon: false,
  realLifeStrength: false,
  bigArms: false,
  deload: false,
  competitionPeaking: false,
  mobilityFocus: false,
};

describe('proposedTaperActions', () => {
  it('returns empty for normal phase (>21d, A)', () => {
    expect(proposedTaperActions(R(30, { priority: 'A' }), now)).toEqual([]);
  });

  it('returns empty for cutoff phase (<=5d)', () => {
    expect(proposedTaperActions(R(3, { priority: 'A' }), now)).toEqual([]);
  });

  it('returns empty for priority C regardless of distance', () => {
    expect(proposedTaperActions(R(15, { priority: 'C' }), now)).toEqual([]);
  });

  it('returns empty for completed race', () => {
    expect(
      proposedTaperActions(
        R(15, { priority: 'A', completedAt: '2026-04-30T00:00:00Z' }),
        now,
      ),
    ).toEqual([]);
  });

  it('at deload-prompt (A, 18d): proposes both insert-deload and activate-peaking', () => {
    const acts = proposedTaperActions(R(18, { priority: 'A', id: 'rA' }), now);
    expect(acts.map((a) => a.kind).sort()).toEqual([
      'activate-competition-peaking',
      'insert-deload',
    ]);
    for (const a of acts) {
      expect(a.raceId).toBe('rA');
      expect(a.daysOut).toBe(18);
      expect(a.phase).toBe('deload-prompt');
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.why.length).toBeGreaterThan(20);
    }
  });

  it('at maintenance (A, 8d): proposes activate-peaking only (deload window passed)', () => {
    const acts = proposedTaperActions(R(8, { priority: 'A' }), now);
    expect(acts.map((a) => a.kind)).toEqual(['activate-competition-peaking']);
  });

  it('excludes already-accepted insert-deload', () => {
    const acts = proposedTaperActions(
      R(18, {
        priority: 'A',
        taperActions: {
          insertedDeload: { acceptedAt: '2026-04-29T00:00:00Z', blockId: 'b1' },
        },
      }),
      now,
    );
    expect(acts.map((a) => a.kind)).toEqual(['activate-competition-peaking']);
  });

  it('excludes dismissed insert-deload', () => {
    const acts = proposedTaperActions(
      R(18, {
        priority: 'A',
        taperActions: { insertedDeload: { dismissedAt: '2026-04-29T00:00:00Z' } },
      }),
      now,
    );
    expect(acts.map((a) => a.kind)).toEqual(['activate-competition-peaking']);
  });

  it('returns empty when both decisions made', () => {
    const acts = proposedTaperActions(
      R(18, {
        priority: 'A',
        taperActions: {
          insertedDeload: { dismissedAt: '2026-04-29T00:00:00Z' },
          competitionPeakingActivated: { acceptedAt: '2026-04-29T00:00:00Z' },
        },
      }),
      now,
    );
    expect(acts).toEqual([]);
  });
});

describe('proposedTaperActionsByRace', () => {
  it('groups by race and skips races with no proposals', () => {
    const grouped = proposedTaperActionsByRace(
      [
        R(50, { id: 'far', priority: 'A' }),
        R(18, { id: 'near', priority: 'A' }),
        R(8, { id: 'soon', priority: 'A' }),
      ],
      now,
    );
    expect(grouped.map((g) => g.race.id)).toEqual(['near', 'soon']);
    expect(grouped[0]!.actions.length).toBe(2);
    expect(grouped[1]!.actions.length).toBe(1);
  });
});

describe('computeEffectiveGoalFlags', () => {
  it('echoes manual flags when no races', () => {
    const r = computeEffectiveGoalFlags({ ...manualOff, mobilityFocus: true }, [], now);
    expect(r.effective.mobilityFocus).toBe(true);
    expect(r.effective.competitionPeaking).toBe(false);
    expect(r.autoSources).toEqual({});
  });

  it('activates competitionPeaking when an A race has accepted action', () => {
    const r = computeEffectiveGoalFlags(
      manualOff,
      [
        R(12, {
          id: 'race-1',
          name: 'Berlin',
          priority: 'A',
          taperActions: { competitionPeakingActivated: { acceptedAt: '2026-04-29T00:00:00Z' } },
        }),
      ],
      now,
    );
    expect(r.effective.competitionPeaking).toBe(true);
    expect(r.autoSources.competitionPeaking?.raceId).toBe('race-1');
    expect(r.autoSources.competitionPeaking?.daysOut).toBe(12);
  });

  it('does NOT report autoSource when manual is already on', () => {
    const r = computeEffectiveGoalFlags(
      { ...manualOff, competitionPeaking: true },
      [
        R(12, {
          priority: 'A',
          taperActions: { competitionPeakingActivated: { acceptedAt: '2026-04-29T00:00:00Z' } },
        }),
      ],
      now,
    );
    expect(r.effective.competitionPeaking).toBe(true);
    expect(r.autoSources.competitionPeaking).toBeUndefined();
  });

  it('ignores past races (auto-cleanup)', () => {
    const r = computeEffectiveGoalFlags(
      manualOff,
      [
        R(-5, {
          priority: 'A',
          taperActions: { competitionPeakingActivated: { acceptedAt: '2026-04-29T00:00:00Z' } },
        }),
      ],
      now,
    );
    expect(r.effective.competitionPeaking).toBe(false);
  });

  it('ignores completed races', () => {
    const r = computeEffectiveGoalFlags(
      manualOff,
      [
        R(5, {
          priority: 'A',
          completedAt: '2026-04-30T00:00:00Z',
          taperActions: { competitionPeakingActivated: { acceptedAt: '2026-04-29T00:00:00Z' } },
        }),
      ],
      now,
    );
    expect(r.effective.competitionPeaking).toBe(false);
  });

  it('ignores priority C even with accepted action', () => {
    const r = computeEffectiveGoalFlags(
      manualOff,
      [
        R(8, {
          priority: 'C',
          taperActions: { competitionPeakingActivated: { acceptedAt: '2026-04-29T00:00:00Z' } },
        }),
      ],
      now,
    );
    expect(r.effective.competitionPeaking).toBe(false);
  });

  it('ignores dismissed actions', () => {
    const r = computeEffectiveGoalFlags(
      manualOff,
      [
        R(10, {
          priority: 'A',
          taperActions: { competitionPeakingActivated: { dismissedAt: '2026-04-29T00:00:00Z' } },
        }),
      ],
      now,
    );
    expect(r.effective.competitionPeaking).toBe(false);
  });

  it('picks the soonest of multiple accepted races for autoSource', () => {
    const r = computeEffectiveGoalFlags(
      manualOff,
      [
        R(30, {
          id: 'far',
          name: 'Far',
          priority: 'A',
          taperActions: { competitionPeakingActivated: { acceptedAt: '2026-04-29T00:00:00Z' } },
        }),
        R(7, {
          id: 'near',
          name: 'Near',
          priority: 'B',
          taperActions: { competitionPeakingActivated: { acceptedAt: '2026-04-29T00:00:00Z' } },
        }),
      ],
      now,
    );
    expect(r.effective.competitionPeaking).toBe(true);
    expect(r.autoSources.competitionPeaking?.raceId).toBe('near');
  });
});
