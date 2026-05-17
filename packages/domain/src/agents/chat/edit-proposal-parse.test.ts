import { describe, expect, it } from 'vitest';
import { applyDecisionToOp, parseEditProposal } from './edit-proposal-parse';

function idGen() {
  let n = 0;
  return () => `id-${++n}`;
}

const VALID_TRIM_OP = {
  kind: 'trim_assistance_entry',
  label: 'Trim Pull-up Wk2 Day 1',
  dayId: 'day-abc',
  entryId: 'entry-xyz',
  movementName: 'Pull-up',
  newSets: 3,
  newReps: 8,
  newRepsMax: 12,
};

describe('parseEditProposal', () => {
  it('accepts a well-formed multi-op proposal', () => {
    const r = parseEditProposal(
      {
        label: 'Trim taper',
        headline: "Trim next week's accessory volume for race taper",
        reason: 'Helsinki Half is in 14 days. Reduce accessory fatigue.',
        confidence: 'high',
        operations: [
          {
            kind: 'set_block_volume_preset',
            label: 'Preset high → standard',
            preset: 'standard',
          },
          VALID_TRIM_OP,
        ],
      },
      { idGen: idGen() },
    );
    expect(r.errors).toEqual([]);
    expect(r.proposal).toBeDefined();
    expect(r.proposal!.operations).toHaveLength(2);
    expect(r.proposal!.confidence).toBe('high');
    expect(r.proposal!.id).toMatch(/id-/);
    expect(r.proposal!.operations[0]!.id).toMatch(/id-/);
  });

  it('rejects the whole proposal when ANY op is malformed', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          VALID_TRIM_OP,
          {
            kind: 'set_training_max',
            label: 'TM bench',
            lift: 'bench',
            // missing newTrainingMaxKg
          },
        ],
      },
      { idGen: idGen() },
    );
    expect(r.proposal).toBeUndefined();
    expect(r.errors.some((e) => e.includes('newTrainingMaxKg'))).toBe(true);
  });

  it('rejects unknown op kinds with a useful message', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [{ kind: 'frobnicate_the_thing', label: 'x' }],
      },
      { idGen: idGen() },
    );
    expect(r.proposal).toBeUndefined();
    expect(r.errors.some((e) => e.includes('kind must be one of'))).toBe(true);
  });

  it('rounds set_training_max kg to nearest 0.5', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          {
            kind: 'set_training_max',
            label: 'TM bench',
            lift: 'bench',
            newTrainingMaxKg: 102.7,
          },
        ],
      },
      { idGen: idGen() },
    );
    expect(r.proposal).toBeDefined();
    const op = r.proposal!.operations[0] as { newTrainingMaxKg: number };
    expect(op.newTrainingMaxKg).toBe(102.5);
  });

  it('rejects when operations is empty', () => {
    const r = parseEditProposal(
      { label: 'x', headline: 'h', reason: 'r', operations: [] },
      { idGen: idGen() },
    );
    expect(r.proposal).toBeUndefined();
    expect(r.errors.some((e) => e.includes('non-empty'))).toBe(true);
  });

  it('rejects when operations exceeds the cap', () => {
    const ops = Array.from({ length: 11 }, () => VALID_TRIM_OP);
    const r = parseEditProposal(
      { label: 'x', headline: 'h', reason: 'r', operations: ops },
      { idGen: idGen() },
    );
    expect(r.errors.some((e) => e.includes('Too many'))).toBe(true);
  });

  it('rejects when newRepsMax < newReps in trim op', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [{ ...VALID_TRIM_OP, newReps: 10, newRepsMax: 8 }],
      },
      { idGen: idGen() },
    );
    expect(r.errors.some((e) => e.includes('newRepsMax'))).toBe(true);
  });

  it('rejects duplicate op ids within the proposal', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          { ...VALID_TRIM_OP, id: 'dup' },
          { ...VALID_TRIM_OP, id: 'dup', dayId: 'day-2' },
        ],
      },
      { idGen: idGen() },
    );
    expect(r.errors.some((e) => e.includes('duplicated'))).toBe(true);
  });

  it('accepts schedule_deload with just kind + label', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [{ kind: 'schedule_deload', label: 'Insert deload' }],
      },
      { idGen: idGen() },
    );
    expect(r.proposal).toBeDefined();
    expect(r.proposal!.operations[0]!.kind).toBe('schedule_deload');
  });

  it('validates add_assistance_entry category against the controlled list', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          {
            kind: 'add_assistance_entry',
            label: 'Add hip thrust',
            dayId: 'day-1',
            movementId: 'seed:hip-thrust',
            movementName: 'Hip Thrust',
            category: 'glutes',
            sets: 3,
            reps: 10,
          },
        ],
      },
      { idGen: idGen() },
    );
    expect(r.errors.some((e) => e.includes('category must be one of'))).toBe(true);
  });

  it('accepts a well-formed add_movement_to_library op', () => {
    const r = parseEditProposal(
      {
        label: 'Add Banded Clamshell',
        headline: 'Add Banded Clamshell to library',
        reason: 'Prehab work for hip stability before half-marathon.',
        operations: [
          {
            kind: 'add_movement_to_library',
            label: 'Add Banded Clamshell',
            tempMovementId: 'tmp:banded-clamshell',
            name: 'Banded Clamshell',
            category: 'prehab',
            primaryMuscles: ['glutes'],
            secondaryMuscles: ['adductors'],
            equipment: 'band',
            pattern: 'core',
          },
        ],
      },
      { idGen: idGen() },
    );
    expect(r.errors).toEqual([]);
    expect(r.proposal).toBeDefined();
    const op = r.proposal!.operations[0]!;
    expect(op.kind).toBe('add_movement_to_library');
    if (op.kind !== 'add_movement_to_library') throw new Error('kind mismatch');
    expect(op.tempMovementId).toBe('tmp:banded-clamshell');
    expect(op.primaryMuscles).toEqual(['glutes']);
    expect(op.equipment).toBe('band');
  });

  it('rejects add_movement_to_library when tempMovementId is missing tmp: prefix', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          {
            kind: 'add_movement_to_library',
            label: 'bad',
            tempMovementId: 'banded-clamshell',
            name: 'Banded Clamshell',
            category: 'prehab',
            primaryMuscles: ['glutes'],
            pattern: 'core',
          },
        ],
      },
      { idGen: idGen() },
    );
    expect(r.errors.some((e) => e.includes('tempMovementId'))).toBe(true);
  });

  it('rejects add_movement_to_library when primaryMuscles is empty', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          {
            kind: 'add_movement_to_library',
            label: 'bad',
            tempMovementId: 'tmp:weird-thing',
            name: 'Weird Thing',
            category: 'prehab',
            primaryMuscles: [],
            pattern: 'core',
          },
        ],
      },
      { idGen: idGen() },
    );
    expect(r.errors.some((e) => e.includes('primaryMuscles'))).toBe(true);
  });

  it('rejects add_movement_to_library when a primary muscle is not in the enum', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          {
            kind: 'add_movement_to_library',
            label: 'bad',
            tempMovementId: 'tmp:weird-thing',
            name: 'Weird Thing',
            category: 'prehab',
            primaryMuscles: ['glutes', 'spleen'],
            pattern: 'core',
          },
        ],
      },
      { idGen: idGen() },
    );
    expect(r.errors.some((e) => e.includes('invalid muscle "spleen"'))).toBe(true);
  });

  it('rejects ops introducing a movement matching an active user exclusion', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          {
            kind: 'add_assistance_entry',
            label: 'Add skull crusher',
            dayId: 'day-1',
            movementId: 'seed:skull-crusher',
            movementName: 'EZ-Bar Skull Crushers',
            category: 'isolation',
            sets: 3,
            reps: 10,
          },
        ],
      },
      { idGen: idGen(), activeExclusions: ['no skull crushers'] },
    );
    expect(r.proposal).toBeUndefined();
    expect(r.errors.some((e) => e.includes('no skull crushers'))).toBe(true);
  });

  it('accepts ops on movements NOT in the exclusion list', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          {
            kind: 'add_assistance_entry',
            label: 'Add hip thrust',
            dayId: 'day-1',
            movementId: 'seed:hip-thrust',
            movementName: 'Hip Thrust',
            category: 'push',
            sets: 3,
            reps: 10,
          },
        ],
      },
      { idGen: idGen(), activeExclusions: ['no skull crushers', 'no close-grip bench press'] },
    );
    expect(r.errors).toEqual([]);
    expect(r.proposal).toBeDefined();
  });

  it('exclusion matching is case-insensitive and substring-based', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          {
            kind: 'swap_assistance_movement',
            label: 'Swap to close-grip',
            dayId: 'day-1',
            entryId: 'entry-1',
            currentMovementId: 'seed:incline-db-press',
            currentMovementName: 'Incline Dumbbell Press',
            newMovementId: 'seed:cgbp',
            newMovementName: 'Close-Grip Bench Press',
          },
        ],
      },
      { idGen: idGen(), activeExclusions: ['no close-grip bench'] },
    );
    expect(r.proposal).toBeUndefined();
    expect(r.errors.some((e) => e.includes('close-grip bench'))).toBe(true);
  });

  it('does not flag swap currentMovementName matching an exclusion — user is moving AWAY from it', () => {
    const r = parseEditProposal(
      {
        label: 'x',
        headline: 'h',
        reason: 'r',
        operations: [
          {
            kind: 'swap_assistance_movement',
            label: 'Swap skull crusher → tricep pushdown',
            dayId: 'day-1',
            entryId: 'entry-1',
            currentMovementId: 'seed:skull-crusher',
            currentMovementName: 'Skull Crushers',
            newMovementId: 'seed:tricep-pushdown',
            newMovementName: 'Tricep Pushdown',
          },
        ],
      },
      { idGen: idGen(), activeExclusions: ['no skull crushers'] },
    );
    expect(r.errors).toEqual([]);
    expect(r.proposal).toBeDefined();
  });
});

describe('applyDecisionToOp', () => {
  it('returns the op unchanged when no modification', () => {
    const op = { ...VALID_TRIM_OP, id: 'x' } as never;
    expect(applyDecisionToOp(op, undefined)).toBe(op);
  });

  it('overlays user modifications onto the op', () => {
    const op = { ...VALID_TRIM_OP, id: 'x' } as never;
    const merged = applyDecisionToOp(op, { newSets: 2 });
    expect((merged as { newSets: number }).newSets).toBe(2);
    expect((merged as { newReps: number }).newReps).toBe(8);
  });
});
