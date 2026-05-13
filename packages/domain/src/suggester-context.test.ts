import { describe, expect, it } from 'vitest';
import { buildSuggesterContext, isCardioPeakActive } from './suggester-context';
import { DEFAULT_TRAINING_PROFILE, type TrainingProfile } from './training-profile-types';
import type { Movement } from './types';
import type { BlockDay } from './blocks';
import type { RaceLike } from './races';

// Minimal stubs. These don't have to be Dexie-shaped; the context builder
// only reads the fields named in SuggesterBlock/SuggesterSettings/etc.
const defaultFlavorsForKind = () => [] as const;

function days(...mainsList: Array<string[]>): Pick<BlockDay, 'id' | 'mainLifts' | 'label'>[] {
  return mainsList.map((mains, i) => ({
    id: `d${i}`,
    mainLifts: mains as BlockDay['mainLifts'],
    label: `Day ${i}`,
  }));
}

const movements: Movement[] = [
  { id: 'dip', name: 'Dip', equipment: 'bodyweight', pattern: 'push-vertical', primaryMuscles: ['chest', 'triceps'], secondaryMuscles: [], isCompound: true },
];

function race(over: Partial<RaceLike> & Pick<RaceLike, 'date'>): RaceLike {
  return {
    id: 'r1',
    name: 'Test',
    priority: 'A',
    kind: 'half-marathon',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('isCardioPeakActive', () => {
  const now = new Date('2026-05-25T00:00:00Z');

  it('returns false when no races', () => {
    expect(isCardioPeakActive([], now)).toBe(false);
  });

  it('returns false for B/C-priority races even inside the window', () => {
    expect(
      isCardioPeakActive([race({ date: '2026-05-30', priority: 'B' })], now),
    ).toBe(false);
    expect(
      isCardioPeakActive([race({ date: '2026-05-30', priority: 'C' })], now),
    ).toBe(false);
  });

  it('uses per-kind windows: half-marathon=10d', () => {
    // 5 days out → in window
    expect(
      isCardioPeakActive([race({ date: '2026-05-30', kind: 'half-marathon' })], now),
    ).toBe(true);
    // 12 days out → outside the 10d half-marathon window
    expect(
      isCardioPeakActive([race({ date: '2026-06-06', kind: 'half-marathon' })], now),
    ).toBe(false);
  });

  it('marathon window is wider (21d)', () => {
    expect(
      isCardioPeakActive([race({ date: '2026-06-10', kind: 'marathon' })], now),
    ).toBe(true);
  });

  it('past races are excluded', () => {
    expect(
      isCardioPeakActive([race({ date: '2026-05-20', kind: 'half-marathon' })], now),
    ).toBe(false);
  });

  it('non-endurance race kinds are ignored', () => {
    // 'powerlifting' is not in the taper-days table — should fall through.
    expect(
      isCardioPeakActive(
        [race({ date: '2026-05-30', kind: 'powerlifting' as unknown as RaceLike['kind'] })],
        now,
      ),
    ).toBe(false);
  });
});

describe('buildSuggesterContext', () => {
  const now = new Date('2026-06-01T10:00:00Z');

  const baseInput = {
    block: {
      kind: 'anchor' as const,
      weeksBeforeDeload: 3,
      name: 'Anchor 1',
    },
    days: days(['squat'], ['bench'], []),
    movements,
    weekScope: 1 as const,
    defaultFlavorsForKind,
    now,
  };

  it('returns sane defaults when no profile / no goals / no races', () => {
    const ctx = buildSuggesterContext(baseInput);
    // Anchor default is 'high' → 150 reps main day.
    expect(ctx.volume.mainDayReps).toBe(150);
    expect(ctx.phase).toBe('normal');
    expect(ctx.phaseSource).toBe('manual');
    expect(ctx.cardioPeakActive).toBe(false);
    expect(ctx.trainingProfileContext).toBeUndefined();
    expect(ctx.activeGoalFlavors).toEqual([]);
    expect(ctx.suppressPhaseVolumeMultiplier).toBe(false);
    expect(ctx.phasePresetShift).toBeUndefined();
    expect(ctx.blockKind).toBe('anchor');
    expect(ctx.blockLabel).toBe('Anchor 1');
  });

  describe('recommendedVolume (v300)', () => {
    it('falls back to kind default when no recommendation is supplied', () => {
      const ctx = buildSuggesterContext(baseInput);
      // Anchor kind default is 'high'.
      expect(ctx.volume.mainDayReps).toBe(150);
    });

    it('uses the recommendation as the budget when no block.assistanceVolume is set', () => {
      const ctx = buildSuggesterContext({
        ...baseInput,
        recommendedVolume: 'minimal',
      });
      // minimal preset: 75 main-day reps (v278).
      expect(ctx.volume.mainDayReps).toBe(75);
    });

    it('block.assistanceVolume wins over the recommendation when both are set', () => {
      const ctx = buildSuggesterContext({
        ...baseInput,
        block: { ...baseInput.block, assistanceVolume: 'standard' },
        recommendedVolume: 'minimal',
      });
      // standard preset: 120 main-day reps (v278).
      expect(ctx.volume.mainDayReps).toBe(120);
    });
  });

  it('passes both AI and fallback paths the SAME phase/source/volume/directives object — drift seam closed', () => {
    // The whole point of the extraction: prompt builder + fallback both
    // read from the same SuggesterContext, so adding a new field can
    // never silently drift between the two paths.
    const profile: TrainingProfile = {
      ...DEFAULT_TRAINING_PROFILE,
      primaryGoal: 'marathon-prep',
      secondaryGoals: ['real-life-strength'],
      trainingPhase: 'normal',
      updatedAt: '2026-05-01T00:00:00Z',
    };
    const ctx = buildSuggesterContext({
      ...baseInput,
      settings: { trainingProfile: profile },
      races: [race({ date: '2026-06-10', priority: 'A', kind: 'half-marathon' })],
      blockFirstSessionDate: now, // anchor for per-week derivation
    });
    // Wk1 with race 9 days out → taper. (We're testing the seam, not the
    // race window math — but the integration matters here.)
    expect(ctx.phase).toBe('taper');
    expect(ctx.phaseSource).toBe('race');
    // Auto-derived phase → suppress volumeMultiplier to avoid compounding
    // with the preset auto-shift.
    expect(ctx.suppressPhaseVolumeMultiplier).toBe(true);
    // Anchor default is high → taper auto-shifts to minimal.
    expect(ctx.volume.mainDayReps).toBe(75);
    expect(ctx.phasePresetShift).toEqual({ from: 'high', to: 'minimal' });
  });

  it('manual phase override is reported as source=manual and does NOT suppress volumeMultiplier', () => {
    const profile: TrainingProfile = {
      ...DEFAULT_TRAINING_PROFILE,
      trainingPhase: 'deload',
      trainingPhaseManual: true,
      updatedAt: '2026-05-01T00:00:00Z',
    };
    const ctx = buildSuggesterContext({
      ...baseInput,
      settings: { trainingProfile: profile },
      blockFirstSessionDate: now,
    });
    expect(ctx.phase).toBe('deload');
    expect(ctx.phaseSource).toBe('manual');
    // Manual phase keeps the multiplier — both signals apply, by design.
    expect(ctx.suppressPhaseVolumeMultiplier).toBe(false);
  });

  it('block-derived deload (7th-week deload block) fires phaseSource=block', () => {
    const ctx = buildSuggesterContext({
      ...baseInput,
      block: {
        kind: 'seventh-week',
        seventhWeekKind: 'deload',
        weeksBeforeDeload: 1,
        name: '7w deload',
      },
      settings: { trainingProfile: DEFAULT_TRAINING_PROFILE },
      blockFirstSessionDate: now,
    });
    expect(ctx.phase).toBe('deload');
    expect(ctx.phaseSource).toBe('block');
    expect(ctx.suppressPhaseVolumeMultiplier).toBe(true);
  });

  it('inherits availableEquipment from the parent program when the block has none', () => {
    const ctx = buildSuggesterContext({
      ...baseInput,
      block: { ...baseInput.block, programId: 'p1' },
      programs: [{ id: 'p1', availableEquipment: ['barbell', 'dumbbell'] }],
    });
    expect(ctx.availableEquipment).toEqual(['barbell', 'dumbbell']);
  });

  it('block availableEquipment overrides program', () => {
    const ctx = buildSuggesterContext({
      ...baseInput,
      block: { ...baseInput.block, programId: 'p1', availableEquipment: ['bodyweight'] },
      programs: [{ id: 'p1', availableEquipment: ['barbell', 'dumbbell'] }],
    });
    expect(ctx.availableEquipment).toEqual(['bodyweight']);
  });

  it('collapses goal flavors to a single logical bucket', () => {
    const ctx = buildSuggesterContext({
      ...baseInput,
      goals: [
        { kind: 'strength-pr', flavors: ['strength', 'compound'] },
        { kind: 'strength-pr', flavors: ['strength'] }, // duplicate strength
        { kind: 'body-comp', flavors: ['hypertrophy'] },
      ],
    });
    expect(ctx.activeGoalFlavors).toHaveLength(1);
    expect(ctx.activeGoalFlavors[0]).toEqual(
      expect.arrayContaining(['strength', 'compound', 'hypertrophy']),
    );
    // Flat list also de-duplicated.
    expect(ctx.flatFlavors.sort()).toEqual(['compound', 'hypertrophy', 'strength']);
  });

  it('completed goals are ignored', () => {
    const ctx = buildSuggesterContext({
      ...baseInput,
      goals: [
        { kind: 'strength-pr', flavors: ['strength'], completedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    expect(ctx.activeGoalFlavors).toEqual([]);
  });

  describe('cardio fatigue shift', () => {
    // 12 baseline sessions (60 min each) over the 28-day window → 180 weighted-min/wk baseline.
    const baselineSessions = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        modality: 'run' as const,
        performedAt: new Date(now.getTime() - (9 + i * 2) * 86_400_000).toISOString(),
        durationSec: 60 * 60,
      }));
    const recentRun = (daysAgo: number) => ({
      modality: 'run' as const,
      performedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
      durationSec: 60 * 60,
    });

    it('no cardio → shift = 0', () => {
      const ctx = buildSuggesterContext({ ...baseInput, cardio: [] });
      expect(ctx.cardioFatigueShift).toBe(0);
      expect(ctx.cardioFatigue.suppressedByPhase).toBe(false);
    });

    it('+50% above baseline in NORMAL phase → shift = -1', () => {
      const recent = [recentRun(1), recentRun(3), recentRun(5), recentRun(6)];
      const ctx = buildSuggesterContext({
        ...baseInput,
        cardio: [...baselineSessions(12), ...recent],
      });
      expect(ctx.phase).toBe('normal');
      expect(ctx.cardioFatigueShift).toBe(-1);
      expect(ctx.cardioFatigue.suppressedByPhase).toBe(false);
      expect(ctx.cardioFatigue.recentModalityMix[0]?.modality).toBe('run');
    });

    it('+67% above baseline in NORMAL phase → shift = -2', () => {
      const recent = [recentRun(1), recentRun(2), recentRun(3), recentRun(5), recentRun(6)];
      const ctx = buildSuggesterContext({
        ...baseInput,
        cardio: [...baselineSessions(12), ...recent],
      });
      expect(ctx.cardioFatigueShift).toBe(-2);
    });

    it('SUPPRESSED in DELOAD phase even when delta is high', () => {
      const profile: TrainingProfile = {
        ...DEFAULT_TRAINING_PROFILE,
        trainingPhase: 'deload',
        trainingPhaseManual: true,
        updatedAt: '2026-05-01T00:00:00Z',
      };
      const recent = [recentRun(1), recentRun(2), recentRun(3), recentRun(5), recentRun(6)];
      const ctx = buildSuggesterContext({
        ...baseInput,
        settings: { trainingProfile: profile },
        cardio: [...baselineSessions(12), ...recent],
        blockFirstSessionDate: now,
      });
      expect(ctx.phase).toBe('deload');
      expect(ctx.cardioFatigueShift).toBe(0);
      expect(ctx.cardioFatigue.suppressedByPhase).toBe(true);
      expect(ctx.cardioFatigue.deltaPct!).toBeGreaterThanOrEqual(0.60);
    });

    it('SUPPRESSED in TAPER phase even when delta is high', () => {
      const ctx = buildSuggesterContext({
        ...baseInput,
        settings: {
          trainingProfile: {
            ...DEFAULT_TRAINING_PROFILE,
            primaryGoal: 'marathon-prep',
            updatedAt: '2026-05-01T00:00:00Z',
          },
        },
        races: [race({ date: '2026-06-10', priority: 'A', kind: 'half-marathon' })],
        cardio: [
          ...baselineSessions(12),
          recentRun(1),
          recentRun(2),
          recentRun(3),
          recentRun(5),
          recentRun(6),
        ],
        blockFirstSessionDate: now,
      });
      expect(ctx.phase).toBe('taper');
      expect(ctx.cardioFatigueShift).toBe(0);
      expect(ctx.cardioFatigue.suppressedByPhase).toBe(true);
    });

    it('FIRES in PEAK phase — peak is when cardio cuts are most needed', () => {
      const profile: TrainingProfile = {
        ...DEFAULT_TRAINING_PROFILE,
        trainingPhase: 'peak',
        trainingPhaseManual: true,
        updatedAt: '2026-05-01T00:00:00Z',
      };
      const ctx = buildSuggesterContext({
        ...baseInput,
        settings: { trainingProfile: profile },
        cardio: [
          ...baselineSessions(12),
          recentRun(1),
          recentRun(2),
          recentRun(3),
          recentRun(5),
          recentRun(6),
        ],
        blockFirstSessionDate: now,
      });
      expect(ctx.phase).toBe('peak');
      expect(ctx.cardioFatigueShift).toBe(-2);
      expect(ctx.cardioFatigue.suppressedByPhase).toBe(false);
    });
  });
});
