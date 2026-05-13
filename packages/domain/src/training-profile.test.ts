import { describe, it, expect } from 'vitest';
import {
  compatibilityWarnings,
  secondaryEffect,
  effectiveSecondaryGoals,
  phaseDirective,
  effectiveTrainingPhase,
  effectiveTrainingPhaseInfo,
  deriveGoalFlags,
  toggleSecondaryGoal,
  migrateLegacyToTrainingProfile,
  normalizeTrainingProfile,
  customConstraint,
  type ActivePhaseBlockLike,
} from './training-profile';
import {
  MAX_SECONDARY_GOALS,
  DEFAULT_TRAINING_PROFILE,
  type TrainingProfile,
  type SecondaryGoal,
  type Constraint,
} from './training-profile-types';
import type { RaceLike } from './races';

const NOW = new Date('2026-06-01T10:00:00Z');

function profile(overrides: Partial<TrainingProfile> = {}): TrainingProfile {
  return { ...DEFAULT_TRAINING_PROFILE, ...overrides };
}

describe('compatibilityWarnings', () => {
  it('flags marathon-prep + isolation-emphasis as expensive', () => {
    const w = compatibilityWarnings({
      primaryGoal: 'marathon-prep',
      secondaryGoals: ['isolation-emphasis'],
    });
    expect(w).toHaveLength(1);
    expect(w[0]!.level).toBe('expensive');
    expect(w[0]!.message).toMatch(/running recovery/i);
  });

  it('flags hypertrophy + isolation-emphasis as redundant', () => {
    const w = compatibilityWarnings({
      primaryGoal: 'hypertrophy',
      secondaryGoals: ['isolation-emphasis'],
    });
    expect(w).toHaveLength(1);
    expect(w[0]!.level).toBe('redundant');
  });

  it('emits no warnings for compatible/recommended pairings', () => {
    expect(
      compatibilityWarnings({
        primaryGoal: 'marathon-prep',
        secondaryGoals: ['functional-movement', 'real-life-strength'],
      }),
    ).toEqual([]);
  });
});

describe('phase × tier 2 matrix', () => {
  it('suppresses isolation-emphasis during peak', () => {
    expect(secondaryEffect('isolation-emphasis', 'peak')).toBe('suppressed');
  });

  it('suppresses every Tier 2 secondary during peak (injury-prevention is Tier 3 now)', () => {
    expect(secondaryEffect('real-life-strength', 'peak')).toBe('suppressed');
    expect(secondaryEffect('functional-movement', 'peak')).toBe('suppressed');
    expect(secondaryEffect('isolation-emphasis', 'peak')).toBe('suppressed');
  });

  it('keeps functional-movement light during deload and taper', () => {
    expect(secondaryEffect('functional-movement', 'deload')).toBe('light');
    expect(secondaryEffect('functional-movement', 'taper')).toBe('light');
  });

  it('keeps everything active in normal phase', () => {
    const all: SecondaryGoal[] = [
      'real-life-strength',
      'functional-movement',
      'isolation-emphasis',
    ];
    for (const g of all) expect(secondaryEffect(g, 'normal')).toBe('active');
  });

  it('effectiveSecondaryGoals removes suppressed entries', () => {
    const out = effectiveSecondaryGoals(
      ['real-life-strength', 'isolation-emphasis', 'functional-movement'],
      'peak',
    );
    expect(out).toEqual([]);
  });

  it('phaseDirective returns prompt strings only for non-active cells', () => {
    expect(phaseDirective('functional-movement', 'normal')).toBeUndefined();
    expect(phaseDirective('functional-movement', 'taper')).toMatch(/light/i);
    expect(phaseDirective('isolation-emphasis', 'peak')).toBeUndefined();
  });
});

describe('toggleSecondaryGoal', () => {
  it('adds a goal when capacity allows', () => {
    expect(toggleSecondaryGoal([], 'real-life-strength', MAX_SECONDARY_GOALS)).toEqual([
      'real-life-strength',
    ]);
  });

  it('removes a goal that is already present', () => {
    expect(
      toggleSecondaryGoal(
        ['real-life-strength', 'functional-movement'],
        'real-life-strength',
        MAX_SECONDARY_GOALS,
      ),
    ).toEqual(['functional-movement']);
  });

  it('refuses to add beyond max', () => {
    const at = ['real-life-strength', 'functional-movement'] as SecondaryGoal[];
    expect(toggleSecondaryGoal(at, 'isolation-emphasis', MAX_SECONDARY_GOALS)).toEqual(at);
  });
});

describe('effectiveTrainingPhase', () => {
  it('returns manual phase verbatim when override is set', () => {
    const p = profile({ trainingPhase: 'taper', trainingPhaseManual: true });
    expect(effectiveTrainingPhase(p, [], NOW)).toBe('taper');
  });

  it('falls back to profile.trainingPhase when no race influence', () => {
    expect(effectiveTrainingPhase(profile({ trainingPhase: 'normal' }), [], NOW)).toBe('normal');
  });

  describe('per-week race-proximity auto-derivation', () => {
    function race(
      overrides: Partial<RaceLike> & Pick<RaceLike, 'date'>,
    ): RaceLike {
      return {
        id: overrides.id ?? 'r-test',
        name: overrides.name ?? 'Test Race',
        priority: overrides.priority ?? 'A',
        kind: overrides.kind ?? 'half-marathon',
        createdAt: overrides.createdAt ?? '2026-01-01T00:00:00Z',
        updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00Z',
        ...overrides,
      };
    }

    const baseProfile = profile({ trainingPhase: 'normal' });

    it('auto-derives "taper" when an A/B race is within 14 days of the target date', () => {
      const target = new Date('2026-05-25T00:00:00Z'); // 7 days before race
      const r = race({ date: '2026-06-01', priority: 'A' });
      expect(effectiveTrainingPhase(baseProfile, [r], target)).toBe('taper');
      expect(effectiveTrainingPhase(baseProfile, [{ ...r, priority: 'B' }], target)).toBe('taper');
    });

    it('auto-derives "peak" for A-priority races 15–28 days out', () => {
      const target = new Date('2026-05-10T00:00:00Z'); // 22 days before race
      const r = race({ date: '2026-06-01', priority: 'A' });
      expect(effectiveTrainingPhase(baseProfile, [r], target)).toBe('peak');
    });

    it('auto-derives "peak" for B-priority races 15–21 days out only', () => {
      const r = race({ date: '2026-06-01', priority: 'B' });
      // 18 days out → peak
      expect(effectiveTrainingPhase(baseProfile, [r], new Date('2026-05-14T00:00:00Z'))).toBe('peak');
      // 25 days out → no auto trigger (B window is 15–21 only)
      expect(effectiveTrainingPhase(baseProfile, [r], new Date('2026-05-07T00:00:00Z'))).toBe('normal');
    });

    it('does not auto-trigger for C-priority races', () => {
      const r = race({ date: '2026-06-01', priority: 'C' });
      expect(effectiveTrainingPhase(baseProfile, [r], new Date('2026-05-25T00:00:00Z'))).toBe('normal');
    });

    it('does not auto-trigger for races more than 28 days out', () => {
      const r = race({ date: '2026-08-01', priority: 'A' });
      expect(effectiveTrainingPhase(baseProfile, [r], NOW)).toBe('normal');
    });

    it('does not auto-trigger when the user has dismissed the peaking banner', () => {
      const r = race({
        date: '2026-06-01',
        priority: 'A',
        taperActions: { competitionPeakingActivated: { dismissedAt: '2026-05-10T00:00:00Z' } },
      });
      expect(effectiveTrainingPhase(baseProfile, [r], new Date('2026-05-25T00:00:00Z'))).toBe('normal');
    });

    it('manual override still wins over auto-derived race proximity', () => {
      const r = race({ date: '2026-06-01', priority: 'A' });
      const manual = profile({ trainingPhase: 'normal', trainingPhaseManual: true });
      expect(effectiveTrainingPhase(manual, [r], new Date('2026-05-25T00:00:00Z'))).toBe('normal');
    });

    it('picks the soonest qualifying A/B race when multiple are scheduled', () => {
      const close = race({ id: 'r-near', date: '2026-06-01', priority: 'A' }); // 7d → taper
      const far = race({ id: 'r-far', date: '2026-06-15', priority: 'A' });    // 21d → peak
      // The taper-window race wins because it is sooner.
      expect(effectiveTrainingPhase(baseProfile, [far, close], new Date('2026-05-25T00:00:00Z'))).toBe('taper');
    });
  });

  describe('block-derived deload', () => {
    const baseProfile = profile({ trainingPhase: 'normal' });
    const deloadBlock: ActivePhaseBlockLike = {
      kind: 'seventh-week',
      seventhWeekKind: 'deload',
    };

    it('auto-derives deload when the active block is a 7th-week deload', () => {
      const info = effectiveTrainingPhaseInfo(baseProfile, [], NOW, deloadBlock);
      expect(info.phase).toBe('deload');
      expect(info.source).toBe('block');
    });

    it('back-compat: bare effectiveTrainingPhase returns the same phase', () => {
      expect(effectiveTrainingPhase(baseProfile, [], NOW, deloadBlock)).toBe('deload');
    });

    it('does NOT auto-derive for 7th-week TM-test blocks', () => {
      const info = effectiveTrainingPhaseInfo(baseProfile, [], NOW, {
        kind: 'seventh-week',
        seventhWeekKind: 'tm-test',
      });
      expect(info.phase).toBe('normal');
      expect(info.source).toBe('manual');
    });

    it('does NOT auto-derive for 7th-week PR-test blocks', () => {
      const info = effectiveTrainingPhaseInfo(baseProfile, [], NOW, {
        kind: 'seventh-week',
        seventhWeekKind: 'pr-test',
      });
      expect(info.phase).toBe('normal');
      expect(info.source).toBe('manual');
    });

    it('does NOT auto-derive for leader/anchor/standalone blocks', () => {
      for (const kind of ['leader', 'anchor', 'standalone'] as const) {
        const info = effectiveTrainingPhaseInfo(baseProfile, [], NOW, { kind });
        expect(info.phase).toBe('normal');
        expect(info.source).toBe('manual');
      }
    });

    it('race-driven taper wins over block-derived deload', () => {
      function race(date: string): RaceLike {
        return {
          id: 'r-test',
          name: 'Test Race',
          priority: 'A',
          kind: 'half-marathon',
          date,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        };
      }
      const target = new Date('2026-05-25T00:00:00Z'); // 7d before race
      const info = effectiveTrainingPhaseInfo(
        baseProfile,
        [race('2026-06-01')],
        target,
        deloadBlock,
      );
      expect(info.phase).toBe('taper');
      expect(info.source).toBe('race');
    });

    it('race-driven peak wins over block-derived deload', () => {
      function race(date: string): RaceLike {
        return {
          id: 'r-test',
          name: 'Test Race',
          priority: 'A',
          kind: 'half-marathon',
          date,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        };
      }
      const target = new Date('2026-05-10T00:00:00Z'); // 22d before race
      const info = effectiveTrainingPhaseInfo(
        baseProfile,
        [race('2026-06-01')],
        target,
        deloadBlock,
      );
      expect(info.phase).toBe('peak');
      expect(info.source).toBe('race');
    });

    it('manual override wins over block-derived deload', () => {
      const manual = profile({ trainingPhase: 'normal', trainingPhaseManual: true });
      const info = effectiveTrainingPhaseInfo(manual, [], NOW, deloadBlock);
      expect(info.phase).toBe('normal');
      expect(info.source).toBe('manual');
    });

    it('deriveGoalFlags surfaces phaseSource and flags.deload when block-derived', () => {
      const r = deriveGoalFlags(
        profile({ primaryGoal: 'strength', secondaryGoals: ['real-life-strength'] }),
        [],
        NOW,
        deloadBlock,
      );
      expect(r.phase).toBe('deload');
      expect(r.phaseSource).toBe('block');
      expect(r.flags.deload).toBe(true);
      // deload phase suppresses real-life-strength
      expect(r.flags.realLifeStrength).toBe(false);
    });

    it('phaseSource is "manual" when no auto signal fires', () => {
      const info = effectiveTrainingPhaseInfo(baseProfile, [], NOW);
      expect(info.phase).toBe('normal');
      expect(info.source).toBe('manual');
    });
  });
});

describe('deriveGoalFlags', () => {
  it('maps primary marathon-prep → flags.marathon = true', () => {
    const r = deriveGoalFlags(profile({ primaryGoal: 'marathon-prep' }), [], NOW);
    expect(r.flags.marathon).toBe(true);
  });

  it('suppresses isolation-emphasis flag during peak', () => {
    const r = deriveGoalFlags(
      profile({
        primaryGoal: 'strength',
        trainingPhase: 'peak',
        secondaryGoals: ['isolation-emphasis', 'functional-movement'],
      }),
      [],
      NOW,
    );
    expect(r.flags.bigArms).toBe(false);
    expect(r.phase).toBe('peak');
    expect(r.effectiveSecondaries).toEqual([]);
  });

  it('keeps functional-movement flag during taper but emits the light directive', () => {
    const r = deriveGoalFlags(
      profile({
        primaryGoal: 'marathon-prep',
        trainingPhase: 'taper',
        secondaryGoals: ['functional-movement'],
      }),
      [],
      NOW,
    );
    expect(r.flags.mobilityFocus).toBe(true);
    expect(r.phaseDirectives.some((d) => d.directive.match(/light/i))).toBe(true);
  });
});

describe('migrateLegacyToTrainingProfile', () => {
  const race: RaceLike = {
    id: 'r1',
    name: 'Helsinki Marathon',
    date: '2026-08-30',
    priority: 'A',
    kind: 'marathon',
  } as RaceLike;

  it('auto-sets marathon-prep when an active A-priority race exists', () => {
    const out = migrateLegacyToTrainingProfile({ races: [race], now: NOW });
    expect(out.profile.primaryGoal).toBe('marathon-prep');
    expect(out.autoSetPrimary).toBe(true);
    expect(out.reason).toMatch(/Helsinki/);
  });

  it('flags ambiguity when multiple recent active goals across kinds', () => {
    const out = migrateLegacyToTrainingProfile({
      legacyGoals: [
        { id: 'g1', kind: 'race-time', updatedAt: '2026-05-30T00:00:00Z' },
        { id: 'g2', kind: 'body-comp', updatedAt: '2026-05-29T00:00:00Z' },
      ],
      now: NOW,
    });
    expect(out.profile.primaryGoalAmbiguous).toBe(true);
    expect(out.profile.primaryGoal).toBe('balanced-development');
    expect(out.autoSetPrimary).toBe(false);
  });

  it('maps single body-comp goal to hypertrophy', () => {
    const out = migrateLegacyToTrainingProfile({
      legacyGoals: [{ id: 'g1', kind: 'body-comp', updatedAt: '2026-05-30T00:00:00Z' }],
      now: NOW,
    });
    expect(out.profile.primaryGoal).toBe('hypertrophy');
    expect(out.autoSetPrimary).toBe(true);
  });

  it('maps legacy GoalFlags to secondaries respecting the cap of 2', () => {
    const out = migrateLegacyToTrainingProfile({
      legacyFlags: {
        marathon: false,
        realLifeStrength: true,
        bigArms: true,
        deload: false,
        competitionPeaking: false,
        mobilityFocus: true,
      },
      legacyGoals: [
        { id: 'g1', kind: 'qualitative', updatedAt: '2026-05-30T00:00:00Z', flavors: ['prehab'] },
      ],
      now: NOW,
    });
    expect(out.profile.secondaryGoals.length).toBeLessThanOrEqual(MAX_SECONDARY_GOALS);
    // Prehab flavor no longer auto-seeds a constraint — Tier 3 vocabulary
    // is fully user-authored. The legacy flavor signal is dropped silently.
    expect(out.profile.secondaryGoals).not.toContain('injury-prevention' as never);
    expect(out.profile.constraints).toEqual([]);
  });

  it('maps competitionPeaking flag → trainingPhase peak', () => {
    const out = migrateLegacyToTrainingProfile({
      legacyFlags: {
        marathon: false,
        realLifeStrength: false,
        bigArms: false,
        deload: false,
        competitionPeaking: true,
        mobilityFocus: false,
      },
      now: NOW,
    });
    expect(out.profile.trainingPhase).toBe('peak');
  });

  it('defaults to balanced-development when no signal', () => {
    const out = migrateLegacyToTrainingProfile({ now: NOW });
    expect(out.profile.primaryGoal).toBe('balanced-development');
    expect(out.autoSetPrimary).toBe(false);
    expect(out.profile.primaryGoalAmbiguous).toBeUndefined();
  });
});

describe('normalizeTrainingProfile', () => {
  it('returns null when profile already conforms', () => {
    const p = profile({ secondaryGoals: ['real-life-strength'] });
    expect(normalizeTrainingProfile(p, NOW)).toBeNull();
  });

  it('strips legacy injury-prevention from secondaryGoals', () => {
    const stored = profile({
      secondaryGoals: ['real-life-strength', 'injury-prevention'] as unknown as SecondaryGoal[],
    });
    const out = normalizeTrainingProfile(stored, NOW);
    expect(out).not.toBeNull();
    expect(out!.secondaryGoals).toEqual(['real-life-strength']);
  });

  it('rewrites any non-custom constraint kind to "custom" while preserving label', () => {
    const stale = {
      id: 'c-old',
      kind: 'injury-prevention',
      label: 'Injury prevention',
      createdAt: '2026-01-01T00:00:00Z',
    } as unknown as Constraint;
    const stored = profile({ constraints: [stale] });
    const out = normalizeTrainingProfile(stored, NOW);
    expect(out).not.toBeNull();
    expect(out!.constraints).toHaveLength(1);
    expect(out!.constraints[0]!.kind).toBe('custom');
    expect(out!.constraints[0]!.label).toBe('Injury prevention');
    expect(out!.constraints[0]!.id).toBe('c-old');
  });

  it('handles a mix of custom and stale-kind constraints', () => {
    const custom = customConstraint('c-keep', 'Tennis elbow flare', NOW);
    const stale = {
      id: 'c-stale',
      kind: 'no-machines',
      label: 'No machines',
      createdAt: '2026-01-01T00:00:00Z',
    } as unknown as Constraint;
    const stored = profile({ constraints: [custom, stale] });
    const out = normalizeTrainingProfile(stored, NOW);
    expect(out).not.toBeNull();
    expect(out!.constraints.every((c) => c.kind === 'custom')).toBe(true);
    expect(out!.constraints.map((c) => c.label)).toEqual([
      'Tennis elbow flare',
      'No machines',
    ]);
  });
});

describe('constraint helpers', () => {
  it('builds custom constraints with literal "custom" kind', () => {
    const c = customConstraint('c1', 'Tennis elbow flare', NOW);
    expect(c.kind).toBe('custom');
    expect(c.label).toBe('Tennis elbow flare');
  });
});
