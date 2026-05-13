import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOAL_FLAGS,
  DEFAULT_USER_GOAL_SETTINGS,
  GOAL_FLAG_KEYS,
  GOAL_NOTES_MAX_LENGTH,
  evaluateGoalsForRules,
  goalsAreEmpty,
  goalsToPromptContext,
  type GoalFlags,
} from './goal-flags';

const allOff: GoalFlags = { ...DEFAULT_GOAL_FLAGS };

describe('GoalFlags constants', () => {
  it('exposes all six flags as keys', () => {
    expect(GOAL_FLAG_KEYS).toEqual([
      'marathon',
      'realLifeStrength',
      'bigArms',
      'deload',
      'competitionPeaking',
      'mobilityFocus',
    ]);
  });

  it('default flags are all false', () => {
    for (const k of GOAL_FLAG_KEYS) {
      expect(DEFAULT_GOAL_FLAGS[k]).toBe(false);
    }
  });

  it('default settings are empty', () => {
    expect(DEFAULT_USER_GOAL_SETTINGS.notes).toBe('');
    expect(goalsAreEmpty(DEFAULT_USER_GOAL_SETTINGS)).toBe(true);
  });
});

describe('evaluateGoalsForRules', () => {
  it('all-off returns no directives', () => {
    const r = evaluateGoalsForRules(allOff);
    expect(r.mandatorySlots).toEqual([]);
    expect(r.prehabKeywords).toEqual([]);
    expect(r.volumeMultiplier).toBe(1);
    expect(r.dropAmrapOverload).toBe(false);
    expect(r.preferProven).toBe(false);
    expect(Object.keys(r.muscleScoreDelta)).toHaveLength(0);
    expect(Object.keys(r.slotScoreDelta)).toHaveLength(0);
  });

  it('marathon mandates prehab + isolation + carry slots', () => {
    const r = evaluateGoalsForRules({ ...allOff, marathon: true });
    expect(r.mandatorySlots).toContain('prehab');
    expect(r.mandatorySlots).toContain('isolation');
    expect(r.mandatorySlots).toContain('carry');
    expect(r.muscleScoreDelta.calves).toBeGreaterThan(0);
    expect(r.muscleScoreDelta.glutes).toBeGreaterThan(0);
    expect(r.muscleScoreDelta.hamstrings).toBeGreaterThan(0);
    expect(r.muscleScoreDelta.quads).toBeLessThan(0);
    expect(r.prehabKeywords).toContain('clamshell');
    expect(r.prehabKeywords).toContain('hip abduction');
    expect(r.prehabKeywords).toContain('lateral band walk');
  });

  it('realLifeStrength mandates carry and bumps carry score', () => {
    const r = evaluateGoalsForRules({ ...allOff, realLifeStrength: true });
    expect(r.mandatorySlots).toEqual(['carry']);
    expect(r.slotScoreDelta.carry).toBeGreaterThan(0);
  });

  it('bigArms mandates isolation and bumps biceps/triceps', () => {
    const r = evaluateGoalsForRules({ ...allOff, bigArms: true });
    expect(r.mandatorySlots).toContain('isolation');
    expect(r.muscleScoreDelta.biceps).toBeGreaterThan(0);
    expect(r.muscleScoreDelta.triceps).toBeGreaterThan(0);
  });

  it('deload reduces volume, drops AMRAP, biases prehab/core', () => {
    const r = evaluateGoalsForRules({ ...allOff, deload: true });
    expect(r.volumeMultiplier).toBeLessThan(1);
    expect(r.dropAmrapOverload).toBe(true);
    expect(r.slotScoreDelta.prehab).toBeGreaterThan(0);
    expect(r.slotScoreDelta.isolation).toBeLessThan(0);
  });

  it('competitionPeaking is fatigue-conservative; legacy 2-arg call still sets preferProven', () => {
    const r = evaluateGoalsForRules({ ...allOff, competitionPeaking: true });
    expect(r.volumeMultiplier).toBeLessThan(1);
    expect(r.dropAmrapOverload).toBe(true);
    // back-compat: no phase supplied → legacy combined behavior fires preferProven
    expect(r.preferProven).toBe(true);
  });

  it('competitionPeaking + phase=taper: preferProven fires (≤14d, no novelty before race)', () => {
    const r = evaluateGoalsForRules({ ...allOff, competitionPeaking: true }, { phase: 'taper' });
    expect(r.dropAmrapOverload).toBe(true);
    expect(r.preferProven).toBe(true);
  });

  it('competitionPeaking + phase=peak: preferProven SUPPRESSED (still training; Wendler allows variation)', () => {
    const r = evaluateGoalsForRules({ ...allOff, competitionPeaking: true }, { phase: 'peak' });
    expect(r.dropAmrapOverload).toBe(true);
    expect(r.preferProven).toBe(false);
  });

  it('mobilityFocus mandates single-leg, demotes isolation, leaves carries to real-life-strength', () => {
    const r = evaluateGoalsForRules({ ...allOff, mobilityFocus: true });
    expect(r.mandatorySlots).not.toContain('carry');
    expect(r.mandatorySlots).toContain('single-leg');
    expect(r.slotScoreDelta['single-leg']).toBeGreaterThan(0);
    expect(r.slotScoreDelta.isolation).toBeLessThan(0);
  });

  it('flags compose: marathon + realLifeStrength stacks carries', () => {
    const r = evaluateGoalsForRules({ ...allOff, marathon: true, realLifeStrength: true });
    // carry mandated by both, deduplicated
    const carryCount = r.mandatorySlots.filter((s) => s === 'carry').length;
    expect(carryCount).toBe(1);
    // carry score delta sums (only realLifeStrength bumps slot score; marathon
    // bumps via mandatory only). So slotScoreDelta.carry should be from
    // realLifeStrength alone.
    expect(r.slotScoreDelta.carry).toBeGreaterThan(0);
  });

  it('deload + competitionPeaking multiplies volume reductions', () => {
    const r = evaluateGoalsForRules({
      ...allOff,
      deload: true,
      competitionPeaking: true,
    });
    // 0.6 * 0.75 = 0.45
    expect(r.volumeMultiplier).toBeCloseTo(0.45, 5);
  });

  it('marathon with no other flags does not set preferProven', () => {
    const r = evaluateGoalsForRules({ ...allOff, marathon: true });
    expect(r.preferProven).toBe(false);
  });

  it('returns deterministic output for same input', () => {
    const flags = { ...allOff, marathon: true, deload: true };
    const a = evaluateGoalsForRules(flags);
    const b = evaluateGoalsForRules(flags);
    expect(a).toEqual(b);
  });
});

describe('goalsToPromptContext', () => {
  it('all-off + no notes produces explicit "no flags" message', () => {
    const out = goalsToPromptContext(allOff, '');
    expect(out).toContain('No specific training context flags');
    expect(out).not.toContain('free-text notes');
  });

  it('marathon emits long-run guard and mandatory work', () => {
    const out = goalsToPromptContext({ ...allOff, marathon: true }, '');
    expect(out).toContain('marathon');
    expect(out).toContain('long run');
    expect(out).toContain('calf');
    expect(out).toContain('hip-stability');
  });

  it('includes notes when present', () => {
    const out = goalsToPromptContext(allOff, 'bad left shoulder above 90°');
    expect(out).toContain('User-supplied free-text notes');
    expect(out).toContain('bad left shoulder');
  });

  it('truncates notes longer than max length', () => {
    const long = 'x'.repeat(GOAL_NOTES_MAX_LENGTH + 100);
    const out = goalsToPromptContext(allOff, long);
    // The notes section in the output contains exactly MAX chars of x's.
    const notesSection = out.split('User-supplied free-text notes (treat as authoritative):\n')[1];
    expect(notesSection).toBeDefined();
    expect(notesSection!.length).toBe(GOAL_NOTES_MAX_LENGTH);
  });

  it('trims whitespace-only notes', () => {
    const out = goalsToPromptContext(allOff, '   \n\t  ');
    expect(out).not.toContain('free-text notes');
  });

  it('emits multiple flag lines when stacked', () => {
    const out = goalsToPromptContext(
      { ...allOff, marathon: true, deload: true, mobilityFocus: true },
      '',
    );
    expect(out).toContain('marathon');
    expect(out).toContain('deload');
    expect(out).toContain('functional movement');
  });

  it('distinguishes peak vs taper when phase is supplied', () => {
    const peakOut = goalsToPromptContext({ ...allOff, competitionPeaking: true }, '', 'peak');
    expect(peakOut).toContain('peak phase');
    expect(peakOut).toContain('sharpening');
    expect(peakOut).not.toContain('recovery, not training');

    const taperOut = goalsToPromptContext({ ...allOff, competitionPeaking: true }, '', 'taper');
    expect(taperOut).toContain('taper phase');
    expect(taperOut).toContain('recovery');
    expect(taperOut).toContain('Do NOT introduce novel');
    expect(taperOut).not.toContain('sharpening');
  });

  it('falls back to combined peak/taper wording when no phase is supplied', () => {
    const out = goalsToPromptContext({ ...allOff, competitionPeaking: true }, '');
    expect(out).toContain('competition peaking');
    expect(out).not.toContain('peak phase');
    expect(out).not.toContain('taper phase');
  });
});

describe('goalsAreEmpty', () => {
  it('default is empty', () => {
    expect(goalsAreEmpty(DEFAULT_USER_GOAL_SETTINGS)).toBe(true);
  });
  it('any flag on makes it non-empty', () => {
    expect(
      goalsAreEmpty({
        flags: { ...DEFAULT_GOAL_FLAGS, marathon: true },
        notes: '',
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(false);
  });
  it('non-blank notes makes it non-empty even with all flags off', () => {
    expect(
      goalsAreEmpty({
        flags: DEFAULT_GOAL_FLAGS,
        notes: 'foo',
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(false);
  });
  it('whitespace notes are still empty', () => {
    expect(
      goalsAreEmpty({
        flags: DEFAULT_GOAL_FLAGS,
        notes: '   \n  ',
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(true);
  });
});
