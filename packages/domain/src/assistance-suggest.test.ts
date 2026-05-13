import { describe, it, expect } from 'vitest';
import { suggestAssistance, type AssistanceSuggestInput } from './assistance-suggest';
import type { Movement } from './types';

const movements: Movement[] = [
  { id: 'bench', name: 'Bench Press', equipment: 'barbell', pattern: 'push-horizontal', primaryMuscles: ['chest'], secondaryMuscles: ['triceps'], isCompound: true, isMainLift: 'bench' },
  { id: 'dip', name: 'Dip', equipment: 'bodyweight', pattern: 'push-vertical', primaryMuscles: ['chest', 'triceps'], secondaryMuscles: [], isCompound: true },
  { id: 'curl', name: 'Dumbbell Curl', equipment: 'dumbbell', pattern: 'pull-horizontal', primaryMuscles: ['biceps'], secondaryMuscles: [] },
  { id: 'chin', name: 'Chin Up', equipment: 'bodyweight', pattern: 'pull-vertical', primaryMuscles: ['lats', 'biceps'], secondaryMuscles: [], isCompound: true },
  { id: 'row', name: 'Barbell Row', equipment: 'barbell', pattern: 'pull-horizontal', primaryMuscles: ['back', 'lats'], secondaryMuscles: ['biceps'], isCompound: true },
  { id: 'lunge', name: 'Walking Lunge', equipment: 'dumbbell', pattern: 'squat', primaryMuscles: ['quads', 'glutes'], secondaryMuscles: [] },
  { id: 'splitsq', name: 'Bulgarian Split Squat', equipment: 'dumbbell', pattern: 'squat', primaryMuscles: ['quads', 'glutes'], secondaryMuscles: [] },
  { id: 'rdl-sl', name: 'Single-leg RDL', equipment: 'dumbbell', pattern: 'hinge', primaryMuscles: ['hamstrings', 'glutes'], secondaryMuscles: [] },
  { id: 'plank', name: 'Plank', equipment: 'bodyweight', pattern: 'core', primaryMuscles: ['core'], secondaryMuscles: [] },
  { id: 'abwheel', name: 'Ab Wheel Rollout', equipment: 'other', pattern: 'core', primaryMuscles: ['core'], secondaryMuscles: [] },
  { id: 'lat-raise', name: 'Lateral Raise', equipment: 'dumbbell', pattern: 'push-vertical', primaryMuscles: ['shoulders'], secondaryMuscles: [] },
  { id: 'face-pull', name: 'Face Pull', equipment: 'cable', pattern: 'pull-horizontal', primaryMuscles: ['shoulders'], secondaryMuscles: [] },
  { id: 'kb-carry', name: 'Farmer Carry', equipment: 'kettlebell', pattern: 'carry', primaryMuscles: ['traps', 'forearms'], secondaryMuscles: [] },
];

const standardVolume = {
  preset: 'custom' as const,
  mainDayReps: 120,
  accessoryReps: 300,
  accessoryMovements: 10,
};

function run(overrides: Partial<AssistanceSuggestInput> = {}) {
  return suggestAssistance({
    volume: standardVolume,
    days: [
      { id: 'd1', mainLifts: ['squat'] },
      { id: 'd2', mainLifts: ['bench'] },
      { id: 'd3', mainLifts: [] }, // accessory day
    ],
    activeGoalFlavors: [],
    movements,
    ...overrides,
  });
}

describe('suggestAssistance', () => {
  it('produces an entry per day, accessory day flagged', () => {
    const r = run();
    expect(r.perDay).toHaveLength(3);
    expect(r.perDay[0]!.isAccessoryDay).toBe(false);
    expect(r.perDay[2]!.isAccessoryDay).toBe(true);
    expect(r.perDay[2]!.entries.length).toBeGreaterThanOrEqual(3);
  });

  it('squat day gets single-leg, bench day gets pull', () => {
    const r = run();
    const squatSlots = r.perDay[0]!.entries.map((e) => e.category);
    const benchSlots = r.perDay[1]!.entries.map((e) => e.category);
    expect(squatSlots).toContain('single-leg');
    expect(benchSlots).toContain('pull');
  });

  it('hypertrophy flavor surfaces isolation movements on accessory day', () => {
    const r = run({ activeGoalFlavors: [['hypertrophy']] });
    const accNames = r.perDay[2]!.entries.map((e) => e.movementName);
    // Lateral raise / curl are pure isolation picks — expect at least one.
    expect(accNames.some((n) => /Lateral Raise|Curl/.test(n))).toBe(true);
    expect(r.rationale.some((s) => s.includes('hypertrophy'))).toBe(true);
  });

  it('functional flavor pulls in carries on accessory day', () => {
    const r = run({ activeGoalFlavors: [['functional']] });
    const accNames = r.perDay[2]!.entries.map((e) => e.movementName);
    expect(accNames).toContain('Farmer Carry');
  });

  it('cardio peak avoids quad-loaded single-leg on squat day', () => {
    const r = run({
      cardioPeakActive: true,
      activeGoalFlavors: [['functional']],
    });
    const squatEntry = r.perDay[0]!.entries.find((e) => e.category === 'single-leg');
    if (squatEntry) {
      expect(squatEntry.movementName).toBe('Single-leg RDL');
    }
    expect(r.rationale.some((s) => s.includes('Cardio peak'))).toBe(true);
  });

  it('warmup-covers-prehab drops the prehab slot', () => {
    const r = run({
      warmupCoversPrehab: true,
      activeGoalFlavors: [['prehab', 'prehab', 'prehab']],
    });
    const accNames = r.perDay[2]!.entries.map((e) => e.movementName);
    expect(accNames).not.toContain('Face Pull');
    expect(r.rationale.some((s) => s.includes('Warmup covers prehab'))).toBe(true);
  });

  it('history bias: prior block movement is reused when slot matches', () => {
    const r = run({
      activeGoalFlavors: [['strength']],
      prevPerDayEntries: [
        undefined,
        // Bench day previously used Barbell Row for the pull slot
        [{ id: 'p1', category: 'pull', movementId: 'row', movementName: 'Barbell Row', sets: 4, reps: 8 }],
        undefined,
      ],
    });
    const benchEntry = r.perDay[1]!.entries.find((e) => e.category === 'pull');
    expect(benchEntry?.movementId).toBe('row');
    expect((benchEntry as { rationale: string }).rationale).toContain('reused');
  });

  it('all suggested entries carry rationale strings', () => {
    const r = run({ activeGoalFlavors: [['strength', 'hypertrophy']] });
    for (const day of r.perDay) {
      for (const e of day.entries) {
        expect((e as { rationale: string }).rationale.length).toBeGreaterThan(0);
      }
    }
  });

  it('no accessory day: redistributes pool to main days and stacks 2nd slot', () => {
    const r = suggestAssistance({
      volume: standardVolume,
      days: [
        { id: 'd1', mainLifts: ['squat'] },
        { id: 'd2', mainLifts: ['bench'] },
      ],
      activeGoalFlavors: [['hypertrophy']],
      movements,
    });
    expect(r.perDay).toHaveLength(2);
    // budget should now include redistributed accessory pool, so each day stacks an extra slot
    expect(r.perDay[0]!.entries.length).toBeGreaterThanOrEqual(2);
    expect(r.perDay[1]!.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('respects movement budget — does not return absurd counts', () => {
    const r = run({ activeGoalFlavors: [['hypertrophy', 'hypertrophy']] });
    for (const day of r.perDay) {
      expect(day.entries.length).toBeLessThanOrEqual(6);
    }
  });

  it('does not duplicate movements across days within a block', () => {
    const r = run({ activeGoalFlavors: [['functional', 'hypertrophy']] });
    const ids = r.perDay.flatMap((d) => d.entries.map((e) => e.movementId));
    const dedup = new Set(ids);
    expect(dedup.size).toBe(ids.length);
  });

  it('availableEquipment filters out movements that need restricted equipment', () => {
    // Travel-style: bodyweight + band only. Should never pick barbell/DB/cable/KB.
    const r = run({
      availableEquipment: ['bodyweight', 'band'],
      activeGoalFlavors: [['functional', 'hypertrophy', 'prehab']],
    });
    const allEntries = r.perDay.flatMap((d) => d.entries);
    expect(allEntries.length).toBeGreaterThan(0);
    for (const e of allEntries) {
      const m = movements.find((x) => x.id === e.movementId);
      expect(m).toBeDefined();
      expect(['bodyweight', 'band']).toContain(m!.equipment);
    }
    // Lateral raise (DB) and Face Pull (cable) and Farmer Carry (KB) should NOT appear.
    const ids = new Set(allEntries.map((e) => e.movementId));
    expect(ids.has('lat-raise')).toBe(false);
    expect(ids.has('face-pull')).toBe(false);
    expect(ids.has('kb-carry')).toBe(false);
    expect(ids.has('curl')).toBe(false);
    // Block-level rationale should announce the restriction.
    expect(r.rationale.some((s) => s.includes('Equipment-restricted'))).toBe(true);
  });

  it('bodyweight is always allowed even if not in availableEquipment list', () => {
    // User accidentally omits bodyweight — we should still keep dips/chins/plank.
    const r = run({ availableEquipment: ['barbell'] });
    const allEntries = r.perDay.flatMap((d) => d.entries);
    const ids = new Set(allEntries.map((e) => e.movementId));
    // We expect at least one bodyweight movement to survive filtering.
    const bw = ['dip', 'chin', 'plank'];
    expect(bw.some((id) => ids.has(id))).toBe(true);
  });

  // -------- Phase 7: Forever-style 3-slot main day matrix --------

  it('main day always gets 3 categories: push + pull + (SL or core or iso)', () => {
    const r = run();
    // Each main day should produce 3 entries with rationale tagging slot intent.
    for (const dayIdx of [0, 1] as const) {
      const day = r.perDay[dayIdx]!;
      expect(day.entries.length).toBeGreaterThanOrEqual(3);
      const rationales = day.entries.map((e) => e.rationale ?? '');
      expect(rationales.some((r2) => r2.includes('push'))).toBe(true);
      expect(rationales.some((r2) => r2.includes('pull'))).toBe(true);
      // 3rd slot is one of single-leg / core / hypertrophy (slotLabel('isolation')) / carry
      expect(
        rationales.some((r2) =>
          /single-leg|core|hypertrophy|carry/.test(r2),
        ),
      ).toBe(true);
    }
  });

  it('paired bench+DL day gets push + pull + SL/core (Forever 3-cat rule)', () => {
    const r = suggestAssistance({
      volume: standardVolume,
      days: [{ id: 'd1', mainLifts: ['bench', 'deadlift'] }],
      activeGoalFlavors: [],
      movements,
    });
    const day = r.perDay[0]!;
    expect(day.entries.length).toBeGreaterThanOrEqual(3);
    const rationales = day.entries.map((e) => e.rationale ?? '');
    expect(rationales.some((r2) => r2.includes('push'))).toBe(true);
    expect(rationales.some((r2) => r2.includes('pull'))).toBe(true);
  });

  it('hypertrophy tag shifts the 3rd slot toward isolation on main day', () => {
    const r = run({ activeGoalFlavors: [['hypertrophy', 'hypertrophy']] });
    // Squat day's 3rd entry should land in the isolation slot (slotLabel = 'hypertrophy').
    const squatRats = r.perDay[0]!.entries.map((e) => e.rationale ?? '');
    expect(squatRats.some((r2) => r2.includes('hypertrophy'))).toBe(true);
  });

  it('functional tag promotes carry as the 3rd slot on a no-leg day', () => {
    const r = run({ activeGoalFlavors: [['functional', 'functional', 'functional']] });
    // With strong functional bias, carry rises to the top of 3rd-slot weighting
    // on at least one main day (squat day picks it first, which is correct —
    // bench day's slot then dedups).
    const allMainRats = [...r.perDay[0]!.entries, ...r.perDay[1]!.entries].map(
      (e) => e.rationale ?? '',
    );
    expect(allMainRats.some((r2) => r2.includes('carry'))).toBe(true);
  });

  it('squat day with squat-cov shifts SL slot toward posterior chain (RDL over more quad work)', () => {
    const r = suggestAssistance({
      volume: standardVolume,
      days: [
        { id: 'd1', mainLifts: ['squat'] },
        { id: 'd2', mainLifts: ['bench'] },
        { id: 'd3', mainLifts: [] },
      ],
      activeGoalFlavors: [['functional']],
      movements,
    });
    const squatEntries = r.perDay[0]!.entries;
    // Find the entry whose rationale tags it as the single-leg slot.
    const slEntry = squatEntries.find((e) => (e.rationale ?? '').includes('single-leg'));
    if (slEntry) {
      // Should prefer SL-RDL (posterior) over Bulgarian/Lunge (quad) on a squat day.
      expect(slEntry.movementId).toBe('rdl-sl');
    }
  });

  // Phase 7b: tag-driven rep ranges and slot count modifiers.

  it('strength tag shifts push/pull reps lower (5x5-8 instead of 4x8-12)', () => {
    const r = run({ activeGoalFlavors: [['strength']] });
    const allMain = [...r.perDay[0]!.entries, ...r.perDay[1]!.entries];
    const pushPull = allMain.filter((e) => e.category === 'push' || e.category === 'pull');
    expect(pushPull.length).toBeGreaterThan(0);
    // With strength bias, sets should be ≥5 and reps ≤8 for push/pull picks.
    for (const e of pushPull) {
      expect(e.sets).toBeGreaterThanOrEqual(5);
      expect(e.reps).toBeLessThanOrEqual(8);
    }
  });

  it('hypertrophy tag shifts push/pull reps higher (3x10-15)', () => {
    const r = run({ activeGoalFlavors: [['hypertrophy']] });
    const allMain = [...r.perDay[0]!.entries, ...r.perDay[1]!.entries];
    const pushPull = allMain.filter((e) => e.category === 'push' || e.category === 'pull');
    expect(pushPull.length).toBeGreaterThan(0);
    for (const e of pushPull) {
      expect(e.reps).toBeGreaterThanOrEqual(10);
    }
  });

  it('hypertrophy tag adds a 4th slot to main days', () => {
    const r = suggestAssistance({
      volume: { preset: 'custom', mainDayReps: 240, accessoryReps: 200, accessoryMovements: 6 },
      days: [{ id: 'd1', mainLifts: ['bench'] }],
      activeGoalFlavors: [['hypertrophy', 'hypertrophy']],
      movements,
    });
    expect(r.perDay[0]!.entries.length).toBeGreaterThanOrEqual(4);
  });

  it('conditioning tag drops a slot on main days (push + pull only)', () => {
    const r = suggestAssistance({
      volume: standardVolume,
      days: [{ id: 'd1', mainLifts: ['bench'] }],
      activeGoalFlavors: [['conditioning']],
      movements,
    });
    expect(r.perDay[0]!.entries).toHaveLength(2);
    const cats = r.perDay[0]!.entries.map((e) => e.category);
    expect(cats).toContain('push');
    expect(cats).toContain('pull');
  });

  it('hypertrophy + conditioning cancel out → default 3 slots', () => {
    const r = suggestAssistance({
      volume: standardVolume,
      days: [{ id: 'd1', mainLifts: ['bench'] }],
      activeGoalFlavors: [['hypertrophy', 'conditioning']],
      movements,
    });
    expect(r.perDay[0]!.entries).toHaveLength(3);
  });

  it('conditioning tag trims a set across all slots (floor at 2)', () => {
    const r = run({ activeGoalFlavors: [['conditioning']] });
    const allEntries = r.perDay.flatMap((d) => d.entries);
    expect(allEntries.length).toBeGreaterThan(0);
    for (const e of allEntries) {
      expect(e.sets).toBeGreaterThanOrEqual(2);
    }
  });
});

// -------- Phase 2: goal-directive integration --------

import { evaluateGoalsForRules, DEFAULT_GOAL_FLAGS } from './goal-flags';

// Extra movements covering marathon-prehab keywords + a heavy quad squat for veto tests.
const directiveMovements: Movement[] = [
  ...movements,
  { id: 'clamshell', name: 'Clamshell', equipment: 'bodyweight', pattern: 'core', primaryMuscles: ['glutes'], secondaryMuscles: [] },
  { id: 'band-walk', name: 'Lateral Band Walk', equipment: 'band', pattern: 'core', primaryMuscles: ['glutes'], secondaryMuscles: [] },
  { id: 'glute-bridge', name: 'Single-Leg Glute Bridge', equipment: 'bodyweight', pattern: 'hinge', primaryMuscles: ['glutes', 'hamstrings'], secondaryMuscles: [] },
  { id: 'calf-raise', name: 'Standing Calf Raise', equipment: 'dumbbell', pattern: 'core', primaryMuscles: ['calves'], secondaryMuscles: [] },
  { id: 'sled-drag', name: 'Backward Sled Drag', equipment: 'other', pattern: 'carry', primaryMuscles: ['quads', 'glutes'], secondaryMuscles: [] },
];

function runWithDirectives(
  flagOverrides: Partial<typeof DEFAULT_GOAL_FLAGS>,
  inputOverrides: Partial<AssistanceSuggestInput> = {},
) {
  const flags = { ...DEFAULT_GOAL_FLAGS, ...flagOverrides };
  return suggestAssistance({
    volume: standardVolume,
    days: [
      { id: 'd1', mainLifts: ['squat'] },
      { id: 'd2', mainLifts: ['bench'] },
      { id: 'd3', mainLifts: [] },
    ],
    activeGoalFlavors: [],
    movements: directiveMovements,
    goalDirectives: evaluateGoalsForRules(flags),
    ...inputOverrides,
  });
}

describe('suggestAssistance — goal directives', () => {
  it('no directives behaves identically to omitting goalDirectives', () => {
    const a = run();
    const b = run({ goalDirectives: evaluateGoalsForRules(DEFAULT_GOAL_FLAGS) });
    // Same per-day movement IDs, same set/rep prescription.
    const idsA = a.perDay.map((d) => d.entries.map((e) => e.movementId));
    const idsB = b.perDay.map((d) => d.entries.map((e) => e.movementId));
    expect(idsB).toEqual(idsA);
  });

  it('marathon flag mandates prehab + isolation + carry slots and surfaces calf', () => {
    const r = runWithDirectives({ marathon: true });
    const allEntries = r.perDay.flatMap((d) => d.entries);
    const ids = new Set(allEntries.map((e) => e.movementId));
    // Calf raise scores high via muscleScoreDelta.calves +3 → should appear.
    expect(ids.has('calf-raise')).toBe(true);
    // Carry mandate covered by Farmer Carry or Backward Sled Drag.
    expect(ids.has('kb-carry') || ids.has('sled-drag')).toBe(true);
    // Prehab mandate satisfied by either face-pull, clamshell, band-walk, or glute-bridge.
    const prehabHits = ['face-pull', 'clamshell', 'band-walk', 'glute-bridge'].filter((id) => ids.has(id));
    expect(prehabHits.length).toBeGreaterThan(0);
    expect(r.rationale.some((s) => s.includes('mandates'))).toBe(true);
  });

  it('marathon flag promotes clamshell-style movements into the prehab slot', () => {
    // Restrict equipment to bodyweight + band so face-pull (cable) is not available.
    const r = runWithDirectives(
      { marathon: true },
      { availableEquipment: ['bodyweight', 'band', 'barbell', 'dumbbell', 'other', 'kettlebell'] },
    );
    const allEntries = r.perDay.flatMap((d) => d.entries);
    const ids = new Set(allEntries.map((e) => e.movementId));
    // At least one of the prehab-keyword movements must be picked.
    const prehabKw = ['clamshell', 'band-walk', 'glute-bridge'];
    expect(prehabKw.some((id) => ids.has(id))).toBe(true);
  });

  it('deload flag scales sets down by ~40% and drops repsMax (no AMRAP overload)', () => {
    const baseline = runWithDirectives({});
    const deload = runWithDirectives({ deload: true });
    const baseSets = baseline.perDay.flatMap((d) => d.entries).reduce((s, e) => s + e.sets, 0);
    const deloadSets = deload.perDay.flatMap((d) => d.entries).reduce((s, e) => s + e.sets, 0);
    expect(deloadSets).toBeLessThan(baseSets);
    for (const e of deload.perDay.flatMap((d) => d.entries)) {
      expect(e.repsMax).toBeUndefined();
    }
    expect(deload.rationale.some((s) => /AMRAP/.test(s))).toBe(true);
    expect(deload.rationale.some((s) => /volume reduction/.test(s))).toBe(true);
  });

  it('competitionPeaking drops AMRAP and reduces volume', () => {
    const r = runWithDirectives({ competitionPeaking: true });
    for (const e of r.perDay.flatMap((d) => d.entries)) {
      expect(e.repsMax).toBeUndefined();
    }
    expect(r.rationale.some((s) => /volume reduction/.test(s))).toBe(true);
  });

  it('bigArms flag boosts curl onto the isolation slot via muscle score delta', () => {
    const r = runWithDirectives({ bigArms: true });
    const ids = new Set(r.perDay.flatMap((d) => d.entries).map((e) => e.movementId));
    expect(ids.has('curl')).toBe(true);
  });

  it('longRunDayIndices alone (no marathon flag) excludes squat-pattern compounds the day before a long run', () => {
    // longRunDayIndices = [1] → day 0 (squat day) gets vetoed for heavy lower,
    // even with no goal flags set. A scheduled long run is sufficient signal.
    const r = runWithDirectives({}, { longRunDayIndices: [1] });
    const day0 = r.perDay[0]!.entries;
    const ids = new Set(day0.map((e) => e.movementId));
    // splitsq and lunge are squat-pattern compounds with quads primary → must NOT appear on day 0.
    expect(ids.has('splitsq')).toBe(false);
    expect(ids.has('lunge')).toBe(false);
    expect(r.rationale.some((s) => /Heavy lower-body excluded/.test(s))).toBe(true);
  });

  it('mandatory slot is added to a day with budget headroom when not covered by main pass', () => {
    // realLifeStrength alone mandates 'carry'. Default suggester wouldn't pick a
    // carry without a functional flavor → the post-pass must add one.
    const r = runWithDirectives({ realLifeStrength: true });
    const allEntries = r.perDay.flatMap((d) => d.entries);
    const carryEntry = allEntries.find((e) => e.movementName === 'Farmer Carry');
    expect(carryEntry).toBeDefined();
    expect(carryEntry!.rationale).toContain('mandate');
  });

  it('mandatorySlots already covered by the main pass do not duplicate', () => {
    // bigArms mandates 'isolation'; isolation already comes through on accessory day.
    const r = runWithDirectives({ bigArms: true });
    const isoEntries = r.perDay
      .flatMap((d) => d.entries)
      .filter((e) => /isolation|hypertrophy|curl|raise|calf/i.test(e.rationale ?? ''));
    // No more than one "goal mandate" tagged isolation entry should appear
    // (extras would be the post-pass double-adding).
    const mandateIso = isoEntries.filter((e) => /goal mandate/.test(e.rationale ?? ''));
    expect(mandateIso.length).toBeLessThanOrEqual(1);
  });
});
