import { describe, it, expect } from 'vitest';
import { buildAssistancePrompt } from './assistance-prompt';
import { DEFAULT_GOAL_FLAGS } from './goal-flags';
import type { MainLift, Movement } from './types';

const movements: Movement[] = [
  { id: 'bench', name: 'Bench Press', equipment: 'barbell', pattern: 'push-horizontal', primaryMuscles: ['chest'], secondaryMuscles: ['triceps'], isCompound: true, isMainLift: 'bench' },
  { id: 'dip', name: 'Dip', equipment: 'bodyweight', pattern: 'push-vertical', primaryMuscles: ['chest', 'triceps'], secondaryMuscles: [], isCompound: true },
  { id: 'curl', name: 'Dumbbell Curl', equipment: 'dumbbell', pattern: 'pull-horizontal', primaryMuscles: ['biceps'], secondaryMuscles: [] },
  { id: 'clamshell', name: 'Clamshell', equipment: 'bodyweight', pattern: 'core', primaryMuscles: ['glutes'], secondaryMuscles: [] },
  { id: 'kb-carry', name: 'Farmer Carry', equipment: 'kettlebell', pattern: 'carry', primaryMuscles: ['traps', 'forearms'], secondaryMuscles: [] },
];

const baseInput = {
  volume: { preset: 'custom' as const, mainDayReps: 120, accessoryReps: 300, accessoryMovements: 10 },
  days: [
    { id: 'd1', mainLifts: ['squat'] as MainLift[], label: 'Mon' },
    { id: 'd2', mainLifts: ['bench'] as MainLift[], label: 'Wed' },
    { id: 'd3', mainLifts: [] as MainLift[], label: 'Fri' },
  ],
  movements,
  goalFlags: DEFAULT_GOAL_FLAGS,
};

describe('buildAssistancePrompt', () => {
  it('returns both system and user prompts as non-empty strings', () => {
    const { systemPrompt, userPrompt } = buildAssistancePrompt(baseInput);
    expect(systemPrompt.length).toBeGreaterThan(500);
    expect(userPrompt.length).toBeGreaterThan(100);
  });

  it('system prompt advertises strict JSON output and slot vocabulary', () => {
    const { systemPrompt } = buildAssistancePrompt(baseInput);
    for (const slot of ['push', 'pull', 'single-leg', 'core', 'prehab', 'isolation', 'carry']) {
      expect(systemPrompt).toContain(slot);
    }
    expect(systemPrompt).toContain('STRICT JSON');
    expect(systemPrompt).toContain('"perDay"');
    expect(systemPrompt).toContain('"blockRationale"');
  });

  it('user prompt renders block summary and movement library', () => {
    const { userPrompt } = buildAssistancePrompt(baseInput);
    expect(userPrompt).toContain('Day 0');
    expect(userPrompt).toContain('squat');
    expect(userPrompt).toContain('Day 2');
    expect(userPrompt).toContain('accessory day');
    expect(userPrompt).toContain('## Movement library');
    expect(userPrompt).toContain('bench');
    expect(userPrompt).toContain('clamshell');
  });

  it('default goal flags produce the "no specific training context flags set" line', () => {
    const { userPrompt } = buildAssistancePrompt(baseInput);
    expect(userPrompt).toContain('No specific training context flags set');
  });

  it('marathon flag surfaces mandates, prehab keywords, and muscle bias in the user prompt', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      goalFlags: { ...DEFAULT_GOAL_FLAGS, marathon: true },
    });
    expect(userPrompt).toContain('marathon prep');
    expect(userPrompt).toContain('Mandatory slots');
    expect(userPrompt).toContain('prehab');
    expect(userPrompt).toContain('clamshell');
    expect(userPrompt).toContain('calves');
  });

  it('deload flag surfaces volume multiplier and dropAmrapOverload directive', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      goalFlags: { ...DEFAULT_GOAL_FLAGS, deload: true },
    });
    expect(userPrompt).toContain('Volume multiplier');
    expect(userPrompt).toContain('dropAmrapOverload');
  });

  it('goalNotes appear verbatim in the user prompt', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      goalNotes: 'Right shoulder cranky on overhead pressing — avoid OHP variants for 2 weeks.',
    });
    expect(userPrompt).toContain('Right shoulder cranky on overhead pressing');
    expect(userPrompt).toContain('treat as authoritative');
  });

  it('longRunDayIndices alone (no marathon flag) produces the day-before veto line', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      longRunDayIndices: [2],
    });
    expect(userPrompt).toContain('day(s) 1');
    expect(userPrompt).toContain('Bulgarian split squats');
    expect(userPrompt).toContain('long run');
  });

  it('existing entries section lists movementIds that must not be re-suggested', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      existingPerDayEntries: [
        [{ id: 'e1', category: 'pull', movementId: 'curl', movementName: 'Dumbbell Curl', sets: 3, reps: 12 }],
        undefined,
        undefined,
      ],
    });
    expect(userPrompt).toContain('do NOT re-suggest');
    expect(userPrompt).toContain('Dumbbell Curl');
    expect(userPrompt).toContain('curl');
  });

  it('fill-the-gaps mode: emits explicit skip directive listing filled day indices', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      existingPerDayEntries: [
        [{ id: 'e1', category: 'pull', movementId: 'curl', movementName: 'Dumbbell Curl', sets: 3, reps: 12 }],
        undefined, // Day 1 empty
        [
          { id: 'e2', category: 'push', movementId: 'dip', movementName: 'Dip', sets: 4, reps: 8 },
          { id: 'e3', category: 'core', movementId: 'plank', movementName: 'Plank', sets: 3, reps: 30 },
        ],
      ],
    });
    expect(userPrompt).toContain('Fill-the-gaps mode is ACTIVE');
    expect(userPrompt).toContain('Days 0, 2');
    expect(userPrompt).toMatch(/Return `entries: \[\]` for those days/);
    // Mandate-coverage note for the skipped days.
    expect(userPrompt).toMatch(/already in the block.*for dedup and mandate-coverage/);
  });

  it('fill-the-gaps directive omitted when every day is empty', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      // No existingPerDayEntries → no filled days.
    });
    expect(userPrompt).not.toContain('Fill-the-gaps mode is ACTIVE');
    expect(userPrompt).toContain('None — no movements have been assigned');
  });

  it('fill-the-gaps directive uses singular phrasing when only one day is filled', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      existingPerDayEntries: [
        [{ id: 'e1', category: 'pull', movementId: 'curl', movementName: 'Dumbbell Curl', sets: 3, reps: 12 }],
        undefined,
        undefined,
      ],
    });
    expect(userPrompt).toMatch(/Day 0 is intentionally arranged/);
    expect(userPrompt).toMatch(/Return `entries: \[\]` for that day/);
  });

  it('availableEquipment filters the movement library and surfaces the constraint', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      availableEquipment: ['bodyweight', 'band'],
    });
    // Bench (barbell), curl (dumbbell), kb-carry (kettlebell) should NOT appear in the library section.
    const lib = userPrompt.split('## Movement library')[1] ?? '';
    expect(lib).not.toContain('bench |');
    expect(lib).not.toContain('curl |');
    expect(lib).not.toContain('kb-carry |');
    // Bodyweight is always allowed.
    expect(lib).toContain('dip |');
    expect(lib).toContain('clamshell |');
    expect(userPrompt).toContain('Available equipment');
  });

  it('warmupCoversPrehab and cardioPeakActive surface as environmental signals', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      warmupCoversPrehab: true,
      cardioPeakActive: true,
    });
    expect(userPrompt).toContain('Cardio peak active');
    expect(userPrompt).toContain('Warmup already covers prehab');
  });

  it('system prompt does NOT wrap the JSON example in a code fence', () => {
    const { systemPrompt } = buildAssistancePrompt(baseInput);
    expect(systemPrompt).not.toContain('```json');
    expect(systemPrompt).not.toContain('```\n');
  });

  it('JSON example uses the seed: prefix to match the catalog', () => {
    const { systemPrompt } = buildAssistancePrompt(baseInput);
    expect(systemPrompt).toContain('"movementId": "seed:dip"');
  });

  it('system prompt explains pair-awareness when two main lifts share a day', () => {
    const { systemPrompt } = buildAssistancePrompt(baseInput);
    expect(systemPrompt).toMatch(/two main lifts share a day/i);
    expect(systemPrompt).toMatch(/push slot follows the bench rule/i);
    expect(systemPrompt).toMatch(/pull slot follows the deadlift rule/i);
  });

  it('system prompt clarifies all slots are eligible on accessory days', () => {
    const { systemPrompt } = buildAssistancePrompt(baseInput);
    expect(systemPrompt).toMatch(/All slot types from the vocabulary are eligible on accessory days/);
  });

  it('blockKind renders in the block summary header when supplied', () => {
    const { userPrompt } = buildAssistancePrompt({ ...baseInput, blockKind: 'anchor' });
    expect(userPrompt).toContain('Block kind: anchor');
  });

  it('omits the Block kind line when blockKind is not supplied', () => {
    const { userPrompt } = buildAssistancePrompt(baseInput);
    expect(userPrompt).not.toContain('Block kind:');
  });

  it('renders Active phase line when phase is non-normal', () => {
    const { userPrompt } = buildAssistancePrompt({ ...baseInput, phase: 'deload' });
    expect(userPrompt).toContain('Active phase: deload');
  });

  it('omits Active phase line when phase is normal', () => {
    const { userPrompt } = buildAssistancePrompt({ ...baseInput, phase: 'normal' });
    expect(userPrompt).not.toContain('Active phase:');
  });

  it('surfaces the preset auto-shift suffix on the budget line', () => {
    const { userPrompt } = buildAssistancePrompt({
      ...baseInput,
      phasePresetShift: { from: 'standard', to: 'minimal' },
    });
    expect(userPrompt).toMatch(/phase-adjusted: `standard` preset auto-shifted to `minimal`/);
  });

  it('does not surface preset shift when none was applied', () => {
    const { userPrompt } = buildAssistancePrompt(baseInput);
    expect(userPrompt).not.toContain('phase-adjusted:');
  });

  it('user prompt always emits the Existing entries section, even when empty', () => {
    const { userPrompt } = buildAssistancePrompt(baseInput);
    expect(userPrompt).toContain('## Existing entries');
    expect(userPrompt).toMatch(/None — no movements have been assigned in this block yet/);
  });

  it('user prompt clarifies that the volume budget is assistance-only', () => {
    const { userPrompt } = buildAssistancePrompt(baseInput);
    expect(userPrompt).toMatch(/excludes main lifts.*supplemental.*warmups/i);
  });

  describe('cross-week context', () => {
    const otherWeeksContext = [
      {
        scopeLabel: 'Default plan',
        perDay: [
          [
            {
              id: 'e1',
              category: 'pull' as const,
              movementId: 'curl',
              movementName: 'Dumbbell Curl',
              sets: 3,
              reps: 10,
              unit: 'reps' as const,
            },
          ],
          undefined,
          [],
        ],
      },
      {
        scopeLabel: 'Week 1',
        perDay: [
          [],
          [
            {
              id: 'e2',
              category: 'push' as const,
              movementId: 'dip',
              movementName: 'Dip',
              sets: 3,
              reps: 8,
              unit: 'reps' as const,
            },
          ],
          undefined,
        ],
      },
    ];

    it('omits the section when otherWeeksContext is empty/undefined', () => {
      const { userPrompt } = buildAssistancePrompt(baseInput);
      expect(userPrompt).not.toContain('## Cross-week context');
    });

    it('emits the section with each scope and asks for fresh selections this week', () => {
      const { userPrompt } = buildAssistancePrompt({ ...baseInput, otherWeeksContext });
      expect(userPrompt).toContain('## Cross-week context (other weeks in this same block)');
      expect(userPrompt).toMatch(/Prefer fresh selections this week/i);
      expect(userPrompt).toContain('### Default plan');
      expect(userPrompt).toContain('### Week 1');
      expect(userPrompt).toContain('Dumbbell Curl (curl)');
      expect(userPrompt).toContain('Dip (dip)');
    });

    it('keeps family-dedup intra-week (not enforced across weeks)', () => {
      const { userPrompt } = buildAssistancePrompt({ ...baseInput, otherWeeksContext });
      expect(userPrompt).toMatch(/Family-dedup rules still apply WITHIN the week/i);
    });

    it('asks the model to rotate within the same family across weeks, not mirror', () => {
      const { userPrompt } = buildAssistancePrompt({ ...baseInput, otherWeeksContext });
      // No longer says "prefer to reuse the same movements" or treats mirroring as equally fine.
      expect(userPrompt).not.toMatch(/prefer to reuse the same movements/i);
      expect(userPrompt).not.toMatch(/canonical Wendler pattern is identical/i);
      expect(userPrompt).not.toMatch(/MAY mirror these picks/i);
      // Asks for a different specific movement per week from the same family.
      expect(userPrompt).toMatch(/different specific movement than the other weeks/i);
      expect(userPrompt).toMatch(/within the same movement family/i);
      // Allows repetition only when no equally-good same-family alternative exists.
      expect(userPrompt).toMatch(/only when.*no equally-good same-family alternative/i);
    });

    it('skips scopes that have no entries at all', () => {
      const { userPrompt } = buildAssistancePrompt({
        ...baseInput,
        otherWeeksContext: [
          { scopeLabel: 'Empty Week', perDay: [[], undefined, []] },
          otherWeeksContext[0]!,
        ],
      });
      expect(userPrompt).toContain('### Default plan');
      expect(userPrompt).not.toContain('### Empty Week');
    });

    it('renders day numbers parallel to the days array', () => {
      const { userPrompt } = buildAssistancePrompt({ ...baseInput, otherWeeksContext });
      expect(userPrompt).toMatch(/Day 0:.*Dumbbell Curl/);
      expect(userPrompt).toMatch(/Day 1:.*Dip/);
    });
  });

  describe('main work this week', () => {
    it('omits the section when weekScope is undefined', () => {
      const { userPrompt } = buildAssistancePrompt(baseInput);
      expect(userPrompt).not.toContain('## Main work this week');
    });

    it('emits Week 1 with 65/75/85% × 5 and AMRAP on top set (classic-531)', () => {
      const { userPrompt } = buildAssistancePrompt({ ...baseInput, weekScope: 1 });
      expect(userPrompt).toContain('## Main work this week (Week 1, classic 5/3/1+');
      expect(userPrompt).toMatch(/- 65% × 5(?!\+)/);
      expect(userPrompt).toMatch(/- 75% × 5(?!\+)/);
      expect(userPrompt).toMatch(/- 85% × 5\+ \(AMRAP\)/);
    });

    it('emits Week 2 with 70/80/90% × 3 (classic-531)', () => {
      const { userPrompt } = buildAssistancePrompt({ ...baseInput, weekScope: 2 });
      expect(userPrompt).toContain('## Main work this week (Week 2');
      expect(userPrompt).toMatch(/- 70% × 3(?!\+)/);
      expect(userPrompt).toMatch(/- 80% × 3(?!\+)/);
      expect(userPrompt).toMatch(/- 90% × 3\+ \(AMRAP\)/);
    });

    it('emits Week 3 with 75% × 5, 85% × 3, 95% × 1 + AMRAP and a "be conservative" cue', () => {
      const { userPrompt } = buildAssistancePrompt({ ...baseInput, weekScope: 3 });
      expect(userPrompt).toContain('## Main work this week (Week 3');
      expect(userPrompt).toMatch(/- 75% × 5(?!\+)/);
      expect(userPrompt).toMatch(/- 85% × 3(?!\+)/);
      expect(userPrompt).toMatch(/- 95% × 1\+ \(AMRAP\)/);
      expect(userPrompt).toMatch(/conservative on accessory volume/i);
    });

    it('emits Deload with 40/50/60% × 5, no AMRAP, and an explicit "cut volume" hint', () => {
      const { userPrompt } = buildAssistancePrompt({ ...baseInput, weekScope: 'deload' });
      expect(userPrompt).toContain('## Main work this week (Deload');
      expect(userPrompt).toMatch(/- 40% × 5(?!\+)/);
      expect(userPrompt).toMatch(/- 50% × 5(?!\+)/);
      expect(userPrompt).toMatch(/- 60% × 5(?!\+)/);
      // None of the set lines should be flagged AMRAP.
      expect(userPrompt).not.toMatch(/- \d+% × \d+\+ \(AMRAP\)/);
      expect(userPrompt).toMatch(/Cut accessory volume meaningfully/i);
    });

    it('5s PRO scheme uses 5 reps every set and no AMRAP on training weeks', () => {
      const { userPrompt } = buildAssistancePrompt({
        ...baseInput,
        weekScope: 2,
        mainScheme: '5s-pro',
      });
      expect(userPrompt).toMatch(/5s PRO/);
      expect(userPrompt).toMatch(/- 70% × 5(?!\+)/);
      expect(userPrompt).toMatch(/- 80% × 5(?!\+)/);
      expect(userPrompt).toMatch(/- 90% × 5(?!\+)/);
      // None of the set lines should be flagged AMRAP for 5s PRO training weeks.
      expect(userPrompt).not.toMatch(/- \d+% × \d+\+ \(AMRAP\)/);
    });

    it('3/5/1 scheme swaps Week 1 and Week 2 waves', () => {
      // Week 1 in 3/5/1 should run the 3s wave (70/80/90 × 3+)
      const { userPrompt: w1 } = buildAssistancePrompt({
        ...baseInput,
        weekScope: 1,
        mainScheme: '351',
      });
      expect(w1).toMatch(/3\/5\/1/);
      expect(w1).toMatch(/- 70% × 3(?!\+)/);
      expect(w1).toMatch(/- 90% × 3\+ \(AMRAP\)/);

      // Week 2 in 3/5/1 should run the 5s wave (65/75/85 × 5+)
      const { userPrompt: w2 } = buildAssistancePrompt({
        ...baseInput,
        weekScope: 2,
        mainScheme: '351',
      });
      expect(w2).toMatch(/- 65% × 5(?!\+)/);
      expect(w2).toMatch(/- 85% × 5\+ \(AMRAP\)/);
    });

    it('7th week (deload kind) renders with 7th-week-specific guidance', () => {
      const { userPrompt } = buildAssistancePrompt({
        ...baseInput,
        weekScope: '7w',
        seventhWeekKind: 'deload',
      });
      expect(userPrompt).toContain('## Main work this week (7th week — deload)');
      expect(userPrompt).toMatch(/Cut accessory volume by ~50%/i);
    });

    it('7th week (pr-test kind) tells the LLM to drop assistance to a recovery floor', () => {
      const { userPrompt } = buildAssistancePrompt({
        ...baseInput,
        weekScope: '7w',
        seventhWeekKind: 'pr-test',
      });
      expect(userPrompt).toContain('## Main work this week (7th week — pr-test)');
      expect(userPrompt).toMatch(/recovery floor/i);
    });
  });

  describe('prehab concentration rule', () => {
    it('system prompt tells the LLM to concentrate prehab on accessory days and cap main-day prehab at 1', () => {
      const { systemPrompt } = buildAssistancePrompt(baseInput);
      expect(systemPrompt).toMatch(/Prehab concentration/);
      expect(systemPrompt).toMatch(/Prefer the accessory day for prehab/i);
      expect(systemPrompt).toMatch(/Cap prehab on main-lift days at 1 slot per session/i);
      expect(systemPrompt).toMatch(/face pulls.*pull-aparts/i);
    });
  });

  describe('recent cardio load section', () => {
    it('is NOT emitted when cardioFatigueShift is 0 / omitted', () => {
      const { userPrompt } = buildAssistancePrompt(baseInput);
      expect(userPrompt).not.toMatch(/## Recent cardio load/);
    });

    it('is emitted with stats when cardioFatigueShift is -1', () => {
      const { userPrompt } = buildAssistancePrompt({
        ...baseInput,
        cardioFatigueShift: -1,
        cardioFatigue: { recentWeightedMin: 240, baselineWeightedMin: 180, deltaPct: 0.333 },
      });
      expect(userPrompt).toMatch(/## Recent cardio load/);
      expect(userPrompt).toContain('240');
      expect(userPrompt).toContain('180');
      expect(userPrompt).toContain('+33%');
      // Light cut wording.
      expect(userPrompt).toMatch(/~10.{0,3}15%/);
      expect(userPrompt).toMatch(/never more than 20%/);
      // Principle-based trim guidance (no "isolation FIRST" hardcode).
      expect(userPrompt).toMatch(/highest-recovery-cost movement/);
      expect(userPrompt).toMatch(/cardio-modality muscle overlap/);
      expect(userPrompt).toMatch(/Mandates and prehab stay at full reps/);
    });

    it('emits the modality mix line when present', () => {
      const { userPrompt } = buildAssistancePrompt({
        ...baseInput,
        cardioFatigueShift: -1,
        cardioFatigue: {
          recentWeightedMin: 240,
          baselineWeightedMin: 180,
          deltaPct: 0.333,
          recentModalityMix: [
            { modality: 'run', weightedMin: 200, sharePct: 83 },
            { modality: 'row', weightedMin: 40, sharePct: 17 },
          ],
        },
      });
      expect(userPrompt).toMatch(/Modality mix \(last 7d\)/);
      expect(userPrompt).toContain('run 83%');
      expect(userPrompt).toContain('row 17%');
    });

    it('omits modality lines below 10% share', () => {
      const { userPrompt } = buildAssistancePrompt({
        ...baseInput,
        cardioFatigueShift: -1,
        cardioFatigue: {
          recentWeightedMin: 100,
          baselineWeightedMin: 70,
          deltaPct: 0.43,
          recentModalityMix: [
            { modality: 'run', weightedMin: 95, sharePct: 95 },
            { modality: 'walk', weightedMin: 5, sharePct: 5 },
          ],
        },
      });
      expect(userPrompt).toContain('run 95%');
      expect(userPrompt).not.toContain('walk 5%');
    });

    it('uses the heavier trim wording when cardioFatigueShift is -2', () => {
      const { userPrompt } = buildAssistancePrompt({
        ...baseInput,
        cardioFatigueShift: -2,
        cardioFatigue: { recentWeightedMin: 300, baselineWeightedMin: 180, deltaPct: 0.667 },
      });
      expect(userPrompt).toMatch(/## Recent cardio load/);
      expect(userPrompt).toContain('+67%');
      expect(userPrompt).toMatch(/~15.{0,3}20%/);
    });

    it('system prompt rule 14 is principle-based — no "isolation first" hardcoded; references modality overlap', () => {
      const { systemPrompt } = buildAssistancePrompt(baseInput);
      expect(systemPrompt).toMatch(/Recent cardio load/);
      expect(systemPrompt).toMatch(/never more than 20%/i);
      expect(systemPrompt).toMatch(/Mandates and prehab remain inviolable/);
      expect(systemPrompt).toMatch(/automatically suppressed/);
      // Principle-based language: no "isolation slots FIRST" hardcode.
      expect(systemPrompt).not.toMatch(/isolation.*FIRST/);
      // Mentions the two-axis ranking.
      expect(systemPrompt).toMatch(/Intrinsic systemic cost/);
      expect(systemPrompt).toMatch(/Overlap with the dominant recent cardio/);
      // Names the muscle chains for the three main cardio modalities.
      expect(systemPrompt).toMatch(/running.*hamstrings.*glutes/i);
      expect(systemPrompt).toMatch(/cycling.*quads.*glutes/i);
      expect(systemPrompt).toMatch(/swim.*row.*lats/i);
    });
  });
});
