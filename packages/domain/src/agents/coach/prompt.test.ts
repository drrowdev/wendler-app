import { describe, expect, it } from 'vitest';
import type { Movement } from '../../types';
import { buildCoachPrompt, COACH_SYSTEM_PROMPT } from './prompt';
import { parseCoachResponse } from './response';

const LIBRARY: Movement[] = [
  {
    id: 'seed:bulgarian-split-squat',
    name: 'Bulgarian Split Squat',
    equipment: 'dumbbell',
    pattern: 'squat',
    primaryMuscles: ['quads', 'glutes'],
    secondaryMuscles: ['hamstrings', 'core', 'adductors'],
  },
  {
    id: 'seed:dead-bug',
    name: 'Dead Bug',
    equipment: 'bodyweight',
    pattern: 'core',
    primaryMuscles: ['core'],
    secondaryMuscles: ['obliques', 'adductors'],
  },
  {
    id: 'seed:cossack-squat',
    name: 'Cossack Squat',
    equipment: 'bodyweight',
    pattern: 'squat',
    primaryMuscles: ['quads', 'glutes'],
    secondaryMuscles: ['hamstrings', 'core', 'adductors'],
    externallyLoadable: true,
  },
];

describe('buildCoachPrompt', () => {
  it('returns the static system prompt verbatim', () => {
    const { systemPrompt } = buildCoachPrompt({
      injury: { area: 'right adductor', severity: 3, description: 'pain on load' },
      movements: LIBRARY,
    });
    expect(systemPrompt).toBe(COACH_SYSTEM_PROMPT);
    // Spot-check key phrases that anchor the agent's identity / boundaries.
    expect(systemPrompt).toContain('movement-modification coach');
    expect(systemPrompt).toContain('NOT a medical diagnostic tool');
    expect(systemPrompt).toContain('Runna');
    expect(systemPrompt).toContain('proposedAdjustments');
  });

  it('emits the injury section with area + severity + description', () => {
    const { userPrompt } = buildCoachPrompt({
      injury: {
        area: 'right adductor',
        severity: 3,
        description: 'Pain on weighted Bulgarian split squat. Bodyweight is fine.',
      },
      movements: LIBRARY,
    });
    expect(userPrompt).toContain('## Injury being analysed');
    expect(userPrompt).toContain('Area: right adductor');
    expect(userPrompt).toContain('Severity: 3 of 5');
    expect(userPrompt).toContain('Pain on weighted Bulgarian split squat');
  });

  it('lists user-tagged movements as the floor for proposals', () => {
    const { userPrompt } = buildCoachPrompt({
      injury: {
        area: 'right adductor',
        severity: 3,
        description: 'pain on load',
        initialMovementIds: ['seed:bulgarian-split-squat', 'seed:dead-bug'],
      },
      movements: LIBRARY,
    });
    expect(userPrompt).toMatch(/explicitly tagged/i);
    expect(userPrompt).toContain('seed:bulgarian-split-squat');
    expect(userPrompt).toContain('seed:dead-bug');
  });

  it('emits the About-the-user section when profile data is provided', () => {
    const { userPrompt } = buildCoachPrompt({
      injury: { area: 'right adductor', severity: 3, description: 'pain on load' },
      movements: LIBRARY,
      userProfile: {
        ageYears: 40,
        sex: 'male',
        heightCm: 178,
        trainingExperience: 'advanced',
        yearsLifting: 10,
        backgroundNotes: 'Former rugby player. Left ACL reconstruction 2018.',
      },
    });
    expect(userPrompt).toContain('## About the user');
    expect(userPrompt).toContain('Age: 40');
    expect(userPrompt).toContain('Sex: male');
    expect(userPrompt).toContain('Training experience: advanced');
    expect(userPrompt).toContain('Background notes: Former rugby player');
  });

  it('omits the About section entirely when no profile data is provided', () => {
    const { userPrompt } = buildCoachPrompt({
      injury: { area: 'shoulder', severity: 2, description: 'twinge' },
      movements: LIBRARY,
    });
    expect(userPrompt).not.toContain('## About the user');
  });

  it('renders the movement library with primary + secondary muscles + tags', () => {
    const { userPrompt } = buildCoachPrompt({
      injury: { area: 'right adductor', severity: 3, description: 'pain on load' },
      movements: LIBRARY,
    });
    expect(userPrompt).toContain('## Movement library');
    expect(userPrompt).toContain('seed:bulgarian-split-squat');
    expect(userPrompt).toContain('primary=quads/glutes');
    expect(userPrompt).toContain('secondary=hamstrings/core/adductors');
    expect(userPrompt).toContain('seed:cossack-squat');
    expect(userPrompt).toContain('[loadable]');
  });

  it('filters movement library by available equipment when supplied', () => {
    const { userPrompt } = buildCoachPrompt({
      injury: { area: 'right adductor', severity: 3, description: 'pain on load' },
      movements: LIBRARY,
      // Only bodyweight allowed → dumbbell BSS should disappear, but bodyweight
      // movements (Dead Bug, Cossack) stay.
      availableEquipment: ['bodyweight'],
    });
    expect(userPrompt).not.toContain('seed:bulgarian-split-squat');
    expect(userPrompt).toContain('seed:dead-bug');
    expect(userPrompt).toContain('seed:cossack-squat');
  });

  it('surfaces other active injuries for interaction reasoning', () => {
    const { userPrompt } = buildCoachPrompt({
      injury: { area: 'right adductor', severity: 3, description: 'pain on load' },
      movements: LIBRARY,
      otherActiveInjuries: [
        { area: 'left shoulder', severity: 2, description: 'mild AC joint twinge' },
      ],
    });
    expect(userPrompt).toContain('## Other active injuries');
    expect(userPrompt).toContain('left shoulder');
  });

  it('flags recently-resolved injuries as a recurrence trigger', () => {
    const { userPrompt } = buildCoachPrompt({
      injury: { area: 'right adductor', severity: 3, description: 'pain on load' },
      movements: LIBRARY,
      recentResolvedInjuries: [
        { area: 'right adductor', resolvedAt: '2026-04-01' },
      ],
    });
    expect(userPrompt).toContain('## Recently resolved injuries');
    expect(userPrompt).toContain('right adductor (resolved 2026-04-01)');
    expect(userPrompt).toMatch(/PT-consult trigger/i);
  });
});

describe('parseCoachResponse', () => {
  function valid(): string {
    return JSON.stringify({
      summary: 'Likely right adductor strain.',
      proposedAdjustments: [
        {
          movementId: 'seed:bulgarian-split-squat',
          action: 'reduce-load',
          modification: 'Switch to bodyweight Bulgarian Split Squat.',
          reasoning: 'User says bodyweight is pain-free; load is the trigger.',
        },
      ],
      monitoringAdvice: 'Retest at 5 kg in 1-2 weeks.',
      consultRecommended: false,
    });
  }

  it('parses a valid response', () => {
    const r = parseCoachResponse(valid(), {
      allowedMovementIds: new Set(['seed:bulgarian-split-squat']),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrowing');
    expect(r.data.summary).toContain('adductor');
    expect(r.data.proposedAdjustments).toHaveLength(1);
    expect(r.data.proposedAdjustments[0]!.action).toBe('reduce-load');
    expect(r.data.consultRecommended).toBe(false);
  });

  it('strips a code-fence wrapper if Claude adds one', () => {
    const wrapped = '```json\n' + valid() + '\n```';
    const r = parseCoachResponse(wrapped, {
      allowedMovementIds: new Set(['seed:bulgarian-split-squat']),
    });
    expect(r.ok).toBe(true);
  });

  it('rejects empty input', () => {
    const r = parseCoachResponse('   ');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrowing');
    expect(r.errors[0]).toMatch(/empty/i);
  });

  it('rejects non-JSON input', () => {
    const r = parseCoachResponse('not json at all');
    expect(r.ok).toBe(false);
  });

  it('rejects responses missing required summary', () => {
    const raw = JSON.stringify({ proposedAdjustments: [] });
    const r = parseCoachResponse(raw);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrowing');
    expect(r.errors.some((e) => e.includes('summary'))).toBe(true);
  });

  it('accepts an empty proposedAdjustments array', () => {
    const raw = JSON.stringify({
      summary: 'Probably nothing to do.',
      proposedAdjustments: [],
    });
    const r = parseCoachResponse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrowing');
    expect(r.data.proposedAdjustments).toHaveLength(0);
  });

  it('rejects an invalid action value', () => {
    const raw = JSON.stringify({
      summary: 'fine',
      proposedAdjustments: [
        {
          movementId: 'seed:bulgarian-split-squat',
          action: 'banish',
          modification: 'x',
          reasoning: 'x',
        },
      ],
    });
    const r = parseCoachResponse(raw, {
      allowedMovementIds: new Set(['seed:bulgarian-split-squat']),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrowing');
    expect(r.errors.some((e) => e.includes('action'))).toBe(true);
  });

  it('rejects movementIds not in the user library', () => {
    const raw = JSON.stringify({
      summary: 'fine',
      proposedAdjustments: [
        {
          movementId: 'seed:not-real',
          action: 'skip',
          modification: 'x',
          reasoning: 'x',
        },
      ],
    });
    const r = parseCoachResponse(raw, {
      allowedMovementIds: new Set(['seed:bulgarian-split-squat']),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrowing');
    expect(r.errors.some((e) => e.includes('not in the user'))).toBe(true);
  });

  it('rejects the same movementId proposed twice', () => {
    const raw = JSON.stringify({
      summary: 'fine',
      proposedAdjustments: [
        {
          movementId: 'seed:bulgarian-split-squat',
          action: 'skip',
          modification: 'a',
          reasoning: 'a',
        },
        {
          movementId: 'seed:bulgarian-split-squat',
          action: 'monitor',
          modification: 'b',
          reasoning: 'b',
        },
      ],
    });
    const r = parseCoachResponse(raw, {
      allowedMovementIds: new Set(['seed:bulgarian-split-squat']),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrowing');
    expect(r.errors.some((e) => e.includes('multiple times'))).toBe(true);
  });

  it('requires consultReason when consultRecommended is true', () => {
    const raw = JSON.stringify({
      summary: 'fine',
      proposedAdjustments: [],
      consultRecommended: true,
    });
    const r = parseCoachResponse(raw);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrowing');
    expect(r.errors.some((e) => e.includes('consultReason'))).toBe(true);
  });

  it('accepts consultRecommended true with reason', () => {
    const raw = JSON.stringify({
      summary: 'fine',
      proposedAdjustments: [],
      consultRecommended: true,
      consultReason: 'Severity 5 with daily-life impairment.',
    });
    const r = parseCoachResponse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrowing');
    expect(r.data.consultRecommended).toBe(true);
    expect(r.data.consultReason).toContain('Severity 5');
  });
});
