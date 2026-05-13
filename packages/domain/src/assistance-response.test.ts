import { describe, it, expect } from 'vitest';
import { parseAssistanceResponse } from './assistance-response';

const VALID_RESPONSE = {
  perDay: [
    {
      dayIndex: 0,
      isAccessoryDay: false,
      entries: [
        {
          slot: 'push',
          movementId: 'seed:dip',
          movementName: 'Dip',
          sets: 4,
          reps: 8,
          repsMax: 12,
          unit: 'reps',
          rationale: 'shoulder/tri bias for bench day',
        },
      ],
    },
  ],
  blockRationale: ['marathon flag added prehab mandate'],
};

const allowedIds = new Set(['seed:dip', 'seed:curl', 'seed:plank']);

describe('parseAssistanceResponse', () => {
  it('accepts a well-formed response', () => {
    const r = parseAssistanceResponse(JSON.stringify(VALID_RESPONSE), {
      allowedMovementIds: allowedIds,
      maxDayIndex: 2,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.perDay).toHaveLength(1);
      expect(r.data.perDay[0]?.entries[0]?.movementId).toBe('seed:dip');
      expect(r.data.blockRationale).toEqual(['marathon flag added prehab mandate']);
    }
  });

  it('strips ```json code fences when the LLM ignores the no-fence rule', () => {
    const fenced = '```json\n' + JSON.stringify(VALID_RESPONSE) + '\n```';
    const r = parseAssistanceResponse(fenced, { allowedMovementIds: allowedIds });
    expect(r.ok).toBe(true);
  });

  it('strips bare ``` fences too', () => {
    const fenced = '```\n' + JSON.stringify(VALID_RESPONSE) + '\n```\n';
    const r = parseAssistanceResponse(fenced);
    expect(r.ok).toBe(true);
  });

  it('rejects non-JSON', () => {
    const r = parseAssistanceResponse('not json at all');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Invalid JSON/);
  });

  it('rejects missing perDay', () => {
    const r = parseAssistanceResponse(JSON.stringify({ blockRationale: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/perDay/);
  });

  it('rejects an unknown slot', () => {
    const bad = JSON.parse(JSON.stringify(VALID_RESPONSE));
    bad.perDay[0].entries[0].slot = 'cardio';
    const r = parseAssistanceResponse(JSON.stringify(bad), {
      allowedMovementIds: allowedIds,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /slot/.test(e))).toBe(true);
  });

  it('rejects movementIds not in the supplied library', () => {
    const bad = JSON.parse(JSON.stringify(VALID_RESPONSE));
    bad.perDay[0].entries[0].movementId = 'dip'; // missing seed: prefix
    const r = parseAssistanceResponse(JSON.stringify(bad), {
      allowedMovementIds: allowedIds,
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(
        r.errors.some((e) => /movementId.*not in the supplied movement library/.test(e)),
      ).toBe(true);
  });

  it('skips library check when allowedMovementIds is omitted', () => {
    const bad = JSON.parse(JSON.stringify(VALID_RESPONSE));
    bad.perDay[0].entries[0].movementId = 'made-up:xyz';
    const r = parseAssistanceResponse(JSON.stringify(bad));
    expect(r.ok).toBe(true);
  });

  describe('newMovement (LLM proposes novel movements)', () => {
    const NOVEL_RESPONSE = {
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            {
              slot: 'core',
              newMovement: {
                name: 'Pallof Iso-Hold',
                equipment: 'cable',
                pattern: 'core',
                primaryMuscles: ['core', 'obliques'],
              },
              movementName: 'Pallof Iso-Hold',
              sets: 3,
              reps: 30,
              unit: 'sec',
              rationale: 'anti-rotation gap',
            },
          ],
        },
      ],
      blockRationale: [],
    };

    it('accepts a valid newMovement when equipment is in availableEquipment', () => {
      const r = parseAssistanceResponse(JSON.stringify(NOVEL_RESPONSE), {
        allowedMovementIds: allowedIds,
        availableEquipment: new Set(['cable', 'barbell']),
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const e = r.data.perDay[0]?.entries[0];
        expect(e?.movementId).toBeUndefined();
        expect(e?.newMovement?.name).toBe('Pallof Iso-Hold');
        expect(e?.newMovement?.equipment).toBe('cable');
      }
    });

    it('always allows bodyweight even when not in availableEquipment', () => {
      const bw = JSON.parse(JSON.stringify(NOVEL_RESPONSE));
      bw.perDay[0].entries[0].newMovement.equipment = 'bodyweight';
      const r = parseAssistanceResponse(JSON.stringify(bw), {
        availableEquipment: new Set(['barbell']),
      });
      expect(r.ok).toBe(true);
    });

    it('rejects newMovement when equipment is not in availableEquipment', () => {
      const r = parseAssistanceResponse(JSON.stringify(NOVEL_RESPONSE), {
        availableEquipment: new Set(['barbell', 'dumbbell']),
      });
      expect(r.ok).toBe(false);
      if (!r.ok)
        expect(r.errors.some((e) => /not in the available equipment/.test(e))).toBe(true);
    });

    it('skips equipment check when availableEquipment is omitted', () => {
      const r = parseAssistanceResponse(JSON.stringify(NOVEL_RESPONSE));
      expect(r.ok).toBe(true);
    });

    it('rejects entries with both movementId and newMovement', () => {
      const bad = JSON.parse(JSON.stringify(NOVEL_RESPONSE));
      bad.perDay[0].entries[0].movementId = 'seed:dip';
      const r = parseAssistanceResponse(JSON.stringify(bad), {
        allowedMovementIds: allowedIds,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /exactly one.*both/.test(e))).toBe(true);
    });

    it('rejects entries with neither movementId nor newMovement', () => {
      const bad = {
        perDay: [
          {
            dayIndex: 0,
            isAccessoryDay: false,
            entries: [
              {
                slot: 'push',
                movementName: 'Floating',
                sets: 3,
                reps: 8,
                unit: 'reps',
                rationale: 'no movement at all',
              },
            ],
          },
        ],
      };
      const r = parseAssistanceResponse(JSON.stringify(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /exactly one.*neither/.test(e))).toBe(true);
    });

    it('rejects newMovement with invalid equipment', () => {
      const bad = JSON.parse(JSON.stringify(NOVEL_RESPONSE));
      bad.perDay[0].entries[0].newMovement.equipment = 'rocket-launcher';
      const r = parseAssistanceResponse(JSON.stringify(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /equipment/.test(e))).toBe(true);
    });

    it('rejects newMovement with invalid pattern', () => {
      const bad = JSON.parse(JSON.stringify(NOVEL_RESPONSE));
      bad.perDay[0].entries[0].newMovement.pattern = 'flapping';
      const r = parseAssistanceResponse(JSON.stringify(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /pattern/.test(e))).toBe(true);
    });

    it('rejects newMovement with empty primaryMuscles', () => {
      const bad = JSON.parse(JSON.stringify(NOVEL_RESPONSE));
      bad.perDay[0].entries[0].newMovement.primaryMuscles = [];
      const r = parseAssistanceResponse(JSON.stringify(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /primaryMuscles/.test(e))).toBe(true);
    });

    it('rejects newMovement with invalid muscle in primaryMuscles', () => {
      const bad = JSON.parse(JSON.stringify(NOVEL_RESPONSE));
      bad.perDay[0].entries[0].newMovement.primaryMuscles = ['heart'];
      const r = parseAssistanceResponse(JSON.stringify(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /invalid muscle/.test(e))).toBe(true);
    });

    it('rejects newMovement with name exceeding 80 chars', () => {
      const bad = JSON.parse(JSON.stringify(NOVEL_RESPONSE));
      bad.perDay[0].entries[0].newMovement.name = 'x'.repeat(81);
      const r = parseAssistanceResponse(JSON.stringify(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /80 chars/.test(e))).toBe(true);
    });

    it('rejects newMovement with empty name', () => {
      const bad = JSON.parse(JSON.stringify(NOVEL_RESPONSE));
      bad.perDay[0].entries[0].newMovement.name = '   ';
      const r = parseAssistanceResponse(JSON.stringify(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /name.*non-empty/.test(e))).toBe(true);
    });

    it('accepts optional secondaryMuscles and isBodyweight', () => {
      const ok = JSON.parse(JSON.stringify(NOVEL_RESPONSE));
      ok.perDay[0].entries[0].newMovement.secondaryMuscles = ['shoulders'];
      ok.perDay[0].entries[0].newMovement.isBodyweight = false;
      const r = parseAssistanceResponse(JSON.stringify(ok));
      expect(r.ok).toBe(true);
      if (r.ok) {
        const nm = r.data.perDay[0]?.entries[0]?.newMovement;
        expect(nm?.secondaryMuscles).toEqual(['shoulders']);
        expect(nm?.isBodyweight).toBe(false);
      }
    });
  });

  it('rejects out-of-range dayIndex when maxDayIndex is set', () => {
    const bad = JSON.parse(JSON.stringify(VALID_RESPONSE));
    bad.perDay[0].dayIndex = 5;
    const r = parseAssistanceResponse(JSON.stringify(bad), {
      allowedMovementIds: allowedIds,
      maxDayIndex: 2,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /exceeds block size/.test(e))).toBe(true);
  });

  it('rejects sets out of [1,20] and reps out of [1,200]', () => {
    const bad = JSON.parse(JSON.stringify(VALID_RESPONSE));
    bad.perDay[0].entries[0].sets = 0;
    bad.perDay[0].entries[0].reps = 999;
    const r = parseAssistanceResponse(JSON.stringify(bad), {
      allowedMovementIds: allowedIds,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /sets/.test(e))).toBe(true);
      expect(r.errors.some((e) => /reps/.test(e))).toBe(true);
    }
  });

  it('rejects repsMax below reps', () => {
    const bad = JSON.parse(JSON.stringify(VALID_RESPONSE));
    bad.perDay[0].entries[0].reps = 10;
    bad.perDay[0].entries[0].repsMax = 5;
    const r = parseAssistanceResponse(JSON.stringify(bad), {
      allowedMovementIds: allowedIds,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /repsMax.*>= reps/.test(e))).toBe(true);
  });

  it('accepts repsMax === null (dropAmrapOverload signal)', () => {
    const ok = JSON.parse(JSON.stringify(VALID_RESPONSE));
    ok.perDay[0].entries[0].repsMax = null;
    const r = parseAssistanceResponse(JSON.stringify(ok), {
      allowedMovementIds: allowedIds,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.perDay[0]?.entries[0]?.repsMax).toBeUndefined();
  });

  it('rejects unit other than reps/sec', () => {
    const bad = JSON.parse(JSON.stringify(VALID_RESPONSE));
    bad.perDay[0].entries[0].unit = 'minutes';
    const r = parseAssistanceResponse(JSON.stringify(bad), {
      allowedMovementIds: allowedIds,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /unit/.test(e))).toBe(true);
  });

  it('aggregates multiple errors instead of bailing on the first', () => {
    const bad = {
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { slot: 'invalid', movementId: '', movementName: '', sets: 0, reps: -1, unit: 'x', rationale: 5 },
            { slot: 'push', movementId: 'unknown', movementName: 'X', sets: 3, reps: 10, unit: 'reps', rationale: 'r' },
          ],
        },
      ],
      blockRationale: 'should-be-array',
    };
    const r = parseAssistanceResponse(JSON.stringify(bad), {
      allowedMovementIds: allowedIds,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(3);
  });

  it('truncates rationales over 120 chars instead of failing validation', () => {
    const longRationale = 'a'.repeat(200);
    const payload = {
      ...VALID_RESPONSE,
      perDay: [
        {
          ...VALID_RESPONSE.perDay[0],
          entries: [
            {
              ...VALID_RESPONSE.perDay[0]!.entries[0],
              rationale: longRationale,
            },
          ],
        },
      ],
    };
    const r = parseAssistanceResponse(JSON.stringify(payload), {
      allowedMovementIds: allowedIds,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.data.perDay[0]?.entries[0]?.rationale ?? '';
      expect(out.length).toBe(120);
      expect(out.endsWith('…')).toBe(true);
    }
  });

  it('keeps rationales at the 120-char boundary unchanged', () => {
    const exact = 'x'.repeat(120);
    const payload = {
      ...VALID_RESPONSE,
      perDay: [
        {
          ...VALID_RESPONSE.perDay[0],
          entries: [
            {
              ...VALID_RESPONSE.perDay[0]!.entries[0],
              rationale: exact,
            },
          ],
        },
      ],
    };
    const r = parseAssistanceResponse(JSON.stringify(payload), {
      allowedMovementIds: allowedIds,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.perDay[0]?.entries[0]?.rationale).toBe(exact);
    }
  });
});
