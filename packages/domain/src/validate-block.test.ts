import { describe, it, expect } from 'vitest';
import { validateBlock } from './validate-block';
import type { AssistanceVolumeCustom } from './blocks';

const STANDARD: AssistanceVolumeCustom = {
  preset: 'custom',
  mainDayReps: 120,
  accessoryReps: 300,
  accessoryMovements: 10,
};

describe('validateBlock', () => {
  it('passes a clean block', () => {
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:dip', sets: 4, reps: 8, unit: 'reps' },
            { movementId: 'seed:row', sets: 3, reps: 10, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('warns on duplicate movementId across days (does not fail)', () => {
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [{ movementId: 'seed:dip', sets: 4, reps: 8, unit: 'reps' }],
        },
        {
          dayIndex: 1,
          isAccessoryDay: false,
          entries: [{ movementId: 'seed:dip', sets: 4, reps: 8, unit: 'reps' }],
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('seed:dip');
    expect(r.warnings[0]).toContain('0, 1');
  });

  it('errors on per-day budget overflow beyond 20% slack', () => {
    // 120 main * 1.2 = 144 cap. 5*30 = 150.
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [{ movementId: 'seed:dip', sets: 5, reps: 30, unit: 'reps' }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('Day 0');
    expect(r.errors[0]).toContain('120');
  });

  it('uses repsMax when present for budget math', () => {
    // 5 * 12 = 60 ≤ 144 ok.
    const ok = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [{ movementId: 'seed:dip', sets: 5, reps: 8, repsMax: 12, unit: 'reps' }],
        },
      ],
    });
    expect(ok.ok).toBe(true);

    // 5 * 30 = 150 > 144 error.
    const bad = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [{ movementId: 'seed:dip', sets: 5, reps: 8, repsMax: 30, unit: 'reps' }],
        },
      ],
    });
    expect(bad.ok).toBe(false);
  });

  it('excludes seconds-based holds from the rep budget', () => {
    // Plank for 60s would obviously bust a rep budget if counted.
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [{ movementId: 'seed:plank', sets: 5, reps: 60, unit: 'sec' }],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('uses accessoryReps budget on accessory days', () => {
    // 300 * 1.2 = 360 cap.
    const ok = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 2,
          isAccessoryDay: true,
          entries: Array.from({ length: 5 }, () => ({
            movementId: `seed:m${Math.random()}`,
            sets: 3,
            reps: 15,
            unit: 'reps' as const,
          })),
        },
      ],
    });
    expect(ok.ok).toBe(true);

    const bad = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 2,
          isAccessoryDay: true,
          entries: Array.from({ length: 8 }, (_, i) => ({
            movementId: `seed:m${i}`,
            sets: 5,
            reps: 12,
            unit: 'reps' as const,
          })),
        },
      ],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toContain('accessory');
  });

  it('errors on unknown movementId when catalog supplied', () => {
    const r = validateBlock({
      volume: STANDARD,
      allowedMovementIds: new Set(['seed:dip', 'seed:row']),
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [{ movementId: 'fictional', sets: 3, reps: 10, unit: 'reps' }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('fictional');
  });

  it('skips the catalog check when allowedMovementIds is omitted', () => {
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [{ movementId: 'literally-anything', sets: 3, reps: 10, unit: 'reps' }],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('honors a custom budgetSlack', () => {
    // 120 * 1.0 = exact budget; 121 reps fails.
    const r = validateBlock({
      volume: STANDARD,
      budgetSlack: 1.0,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [{ movementId: 'seed:dip', sets: 11, reps: 11, unit: 'reps' }],
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('skips budget enforcement when budget is zero (no accessory day defined)', () => {
    const r = validateBlock({
      volume: { preset: 'custom', mainDayReps: 0, accessoryReps: 0, accessoryMovements: 0 },
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [{ movementId: 'seed:dip', sets: 100, reps: 100, unit: 'reps' }],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  // ---- Movement-family dedup --------------------------------------------
  it('warns when two deadlift-family variants appear in the same block', () => {
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:trap-bar-deadlift', movementName: 'Trap Bar Deadlift', sets: 3, reps: 5, unit: 'reps' },
          ],
        },
        {
          dayIndex: 4,
          isAccessoryDay: true,
          entries: [
            { movementId: 'seed:deadlift', movementName: 'Deadlift', sets: 3, reps: 12, repsMax: 20, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.includes('deadlift-family'))).toBe(true);
  });

  it('warns when bar muscle-up + ring muscle-up both appear', () => {
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'custom:bar-mu', movementName: 'Bar Muscle-up', sets: 4, reps: 3, unit: 'reps' },
          ],
        },
        {
          dayIndex: 4,
          isAccessoryDay: true,
          entries: [
            { movementId: 'custom:ring-mu', movementName: 'Ring Muscle-up', sets: 4, reps: 3, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.includes('muscle-up-family'))).toBe(true);
  });

  it('does NOT warn for two single-leg variants (single-leg family is exempt)', () => {
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:bss', movementName: 'Bulgarian Split Squat', sets: 3, reps: 8, unit: 'reps' },
          ],
        },
        {
          dayIndex: 4,
          isAccessoryDay: true,
          entries: [
            { movementId: 'seed:sl-rdl', movementName: 'Single-Leg RDL', sets: 3, reps: 10, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.includes('family'))).toBe(false);
  });

  // ---- Main-lift family conflict ----------------------------------------
  it('warns when deadlift assistance is scheduled alongside a deadlift main lift', () => {
    const r = validateBlock({
      volume: STANDARD,
      scheduledMainLifts: ['deadlift', 'bench'],
      perDay: [
        {
          dayIndex: 4,
          isAccessoryDay: true,
          entries: [
            { movementId: 'seed:rdl', movementName: 'Romanian Deadlift', sets: 3, reps: 12, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.toLowerCase().includes('deadlift main lift'))).toBe(true);
  });

  it('does not warn for non-deadlift assistance when deadlift main is scheduled', () => {
    const r = validateBlock({
      volume: STANDARD,
      scheduledMainLifts: ['deadlift', 'bench'],
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:row', movementName: 'Barbell Row', sets: 3, reps: 10, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings).toHaveLength(0);
  });

  // ---- High-skill rep ceiling -------------------------------------------
  it('warns when a high-skill movement is prescribed at hypertrophy reps', () => {
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'custom:rmu', movementName: 'Ring Muscle-up', sets: 4, reps: 8, repsMax: 12, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.includes('Ring Muscle-up') && w.includes('high-skill'))).toBe(true);
  });

  it('does not warn when high-skill movement is prescribed at 3-5 reps', () => {
    const r = validateBlock({
      volume: STANDARD,
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'custom:mu', movementName: 'Bar Muscle-up', sets: 4, reps: 3, repsMax: 5, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.includes('high-skill'))).toBe(false);
  });

  // ---- Marathon mandate -------------------------------------------------
  it('warns when marathon flag is on but no calf raise variant is scheduled', () => {
    const r = validateBlock({
      volume: STANDARD,
      goalFlags: { marathon: true, realLifeStrength: false, bigArms: false, deload: false, competitionPeaking: false, mobilityFocus: false },
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:dip', movementName: 'Dip', sets: 4, reps: 10, unit: 'reps' },
            { movementId: 'seed:bicep-curl', movementName: 'Bicep Curl', sets: 3, reps: 12, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.toLowerCase().includes('calf'))).toBe(true);
  });

  it('does not warn when a calf raise variant is present and marathon is on', () => {
    const r = validateBlock({
      volume: STANDARD,
      goalFlags: { marathon: true, realLifeStrength: false, bigArms: false, deload: false, competitionPeaking: false, mobilityFocus: false },
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:calf', movementName: 'Standing Calf Raise', sets: 4, reps: 15, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.toLowerCase().includes('calf'))).toBe(false);
  });

  // ---- bigArms mandate --------------------------------------------------
  it('warns when bigArms is on but no curl variant is scheduled', () => {
    const r = validateBlock({
      volume: STANDARD,
      goalFlags: { marathon: false, realLifeStrength: false, bigArms: true, deload: false, competitionPeaking: false, mobilityFocus: false },
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:cgbp', movementName: 'Close-Grip Bench Press', sets: 4, reps: 10, unit: 'reps' },
            { movementId: 'seed:chinup', movementName: 'Chin-up', sets: 4, reps: 8, unit: 'reps' },
            { movementId: 'seed:tri-pd', movementName: 'Tricep Push-down', sets: 3, reps: 12, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.toLowerCase().includes('bicep isolation'))).toBe(true);
    expect(r.warnings.some((w) => w.toLowerCase().includes('tricep isolation'))).toBe(false);
  });

  it('warns when bigArms is on but no tricep iso (compound dips/CGBP do not satisfy)', () => {
    const r = validateBlock({
      volume: STANDARD,
      goalFlags: { marathon: false, realLifeStrength: false, bigArms: true, deload: false, competitionPeaking: false, mobilityFocus: false },
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:dip', movementName: 'Dip', sets: 4, reps: 10, unit: 'reps' },
            { movementId: 'seed:curl', movementName: 'Hammer Curl', sets: 3, reps: 12, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.toLowerCase().includes('tricep isolation'))).toBe(true);
  });

  // ---- Press balance ----------------------------------------------------
  it('warns when 3+ pressing movements with no rear-delt prehab', () => {
    const r = validateBlock({
      volume: STANDARD,
      scheduledMainLifts: ['bench', 'press'],
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:cgbp', movementName: 'Close-Grip Bench Press', sets: 4, reps: 10, unit: 'reps' },
            { movementId: 'seed:dip', movementName: 'Dip', sets: 4, reps: 10, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.toLowerCase().includes('rear-delt') || w.toLowerCase().includes('face-pull'))).toBe(true);
  });

  it('does not warn for press balance when rear-delt prehab is present', () => {
    const r = validateBlock({
      volume: STANDARD,
      scheduledMainLifts: ['bench', 'press'],
      perDay: [
        {
          dayIndex: 0,
          isAccessoryDay: false,
          entries: [
            { movementId: 'seed:dip', movementName: 'Dip', sets: 4, reps: 10, unit: 'reps' },
            { movementId: 'seed:fp', movementName: 'Face Pull', sets: 3, reps: 15, unit: 'reps' },
          ],
        },
      ],
    });
    expect(r.warnings.some((w) => w.toLowerCase().includes('rear-delt'))).toBe(false);
  });
});
