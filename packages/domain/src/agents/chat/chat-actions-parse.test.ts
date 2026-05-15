import { describe, it, expect } from 'vitest';
import { parseChatActionsBlock } from './chat-actions-parse';

describe('parseChatActionsBlock', () => {
  const ids = (): (() => string) => {
    let n = 0;
    return () => `id-${++n}`;
  };

  it('returns the input unchanged when no actions block is present', () => {
    const raw = 'Just some prose.\n\nNo actions here.';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.prose).toBe(raw);
    expect(r.actions).toEqual([]);
  });

  it('strips a valid log_injury block and returns the parsed chip', () => {
    const raw =
      'Coach flagged a right-adductor strain.\n\n' +
      '<actions>\n' +
      '[{"kind":"log_injury","label":"Log right-adductor limitation","area":"right adductor","severity":3,"description":"Strain under load","movementIds":["seed:bulgarian-split-squat"]}]\n' +
      '</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.prose).toBe('Coach flagged a right-adductor strain.');
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({
      kind: 'log_injury',
      label: 'Log right-adductor limitation',
      area: 'right adductor',
      severity: 3,
      description: 'Strain under load',
      movementIds: ['seed:bulgarian-split-squat'],
      status: 'pending',
    });
  });

  it('rounds set_training_max kg to the nearest 0.5', () => {
    const raw =
      'Cut your bench.\n<actions>[{"kind":"set_training_max","label":"Cut bench TM","lift":"bench","newTrainingMaxKg":102.7,"reason":"AMRAPs missed targets"}]</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toHaveLength(1);
    expect((r.actions[0] as { newTrainingMaxKg: number }).newTrainingMaxKg).toBe(102.5);
  });

  it('drops invalid lifts on set_training_max', () => {
    const raw =
      'foo<actions>[{"kind":"set_training_max","label":"Bad","lift":"curl","newTrainingMaxKg":50,"reason":"x"}]</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toEqual([]);
  });

  it('drops set_training_max with non-finite or out-of-range kg', () => {
    const raw =
      'x<actions>[{"kind":"set_training_max","label":"Bad","lift":"squat","newTrainingMaxKg":0,"reason":"r"},{"kind":"set_training_max","label":"Bad2","lift":"squat","newTrainingMaxKg":1000,"reason":"r"}]</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toEqual([]);
  });

  it('validates set_block_volume_preset preset enum', () => {
    const raw =
      'x<actions>[{"kind":"set_block_volume_preset","label":"Bad","preset":"crushing","reason":"r"}]</actions>';
    expect(parseChatActionsBlock(raw, ids()).actions).toEqual([]);
    const raw2 =
      'x<actions>[{"kind":"set_block_volume_preset","label":"OK","preset":"minimal","reason":"deload coming"}]</actions>';
    const r = parseChatActionsBlock(raw2, ids());
    expect(r.actions).toHaveLength(1);
    expect((r.actions[0] as { preset: string }).preset).toBe('minimal');
  });

  it('caps the chip array at 4 entries', () => {
    const items = Array.from({ length: 7 }).map((_, i) => ({
      kind: 'log_injury',
      label: `chip-${i}`,
      area: 'knee',
    }));
    const raw = `pre<actions>${JSON.stringify(items)}</actions>`;
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toHaveLength(4);
  });

  it('returns prose-only and empty actions when JSON inside is malformed', () => {
    const raw = 'hi<actions>not json</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.prose).toBe('hi');
    expect(r.actions).toEqual([]);
  });

  it('strips an unclosed actions tag and returns empty actions', () => {
    const raw = 'prose body\n\n<actions>[{"kind":"log_injury","label":"x","area":"y"}';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.prose).toBe('prose body');
    expect(r.actions).toEqual([]);
  });

  it('rejects log_injury without area', () => {
    const raw = 'x<actions>[{"kind":"log_injury","label":"Bad"}]</actions>';
    expect(parseChatActionsBlock(raw, ids()).actions).toEqual([]);
  });

  it('ignores unknown kinds', () => {
    const raw = 'x<actions>[{"kind":"hyperdrive","label":"x"}]</actions>';
    expect(parseChatActionsBlock(raw, ids()).actions).toEqual([]);
  });

  describe('schedule_deload', () => {
    it('accepts a valid chip', () => {
      const raw =
        'x<actions>[{"kind":"schedule_deload","label":"Schedule deload","reason":"ACWR 1.47, weeks since deload 7"}]</actions>';
      const r = parseChatActionsBlock(raw, ids());
      expect(r.actions).toHaveLength(1);
      expect(r.actions[0]?.kind).toBe('schedule_deload');
    });

    it('rejects when reason is missing', () => {
      const raw = 'x<actions>[{"kind":"schedule_deload","label":"x"}]</actions>';
      expect(parseChatActionsBlock(raw, ids()).actions).toEqual([]);
    });
  });

  describe('substitute_movement', () => {
    const good = {
      kind: 'substitute_movement',
      label: 'Swap BSS for step-up',
      blockId: 'block-1',
      dayId: 'day-1',
      dayIndex: 0,
      currentMovementId: 'seed:bulgarian-split-squat',
      currentMovementName: 'Bulgarian Split Squat',
      newMovementId: 'seed:step-up',
      newMovementName: 'Step-up',
      reason: 'Quad-biased single-leg substitute that works around the right adductor',
    };

    it('accepts a valid chip with all fields', () => {
      const r = parseChatActionsBlock(`x<actions>${JSON.stringify([good])}</actions>`, ids());
      expect(r.actions).toHaveLength(1);
      expect(r.actions[0]).toMatchObject({
        kind: 'substitute_movement',
        blockId: 'block-1',
        dayId: 'day-1',
        dayIndex: 0,
        currentMovementId: 'seed:bulgarian-split-squat',
        newMovementId: 'seed:step-up',
      });
    });

    it('rejects when current and new movementId are identical', () => {
      const bad = { ...good, newMovementId: good.currentMovementId };
      const r = parseChatActionsBlock(`x<actions>${JSON.stringify([bad])}</actions>`, ids());
      expect(r.actions).toEqual([]);
    });

    it('rejects when a movementId field is missing or empty', () => {
      for (const field of [
        'currentMovementId',
        'currentMovementName',
        'newMovementId',
        'newMovementName',
        'reason',
      ]) {
        const bad = { ...good, [field]: '' };
        const r = parseChatActionsBlock(`x<actions>${JSON.stringify([bad])}</actions>`, ids());
        expect(r.actions, `expected reject when ${field} empty`).toEqual([]);
      }
    });

    it('drops invalid dayIndex but keeps the chip when other fields valid', () => {
      const r = parseChatActionsBlock(
        `x<actions>${JSON.stringify([{ ...good, dayIndex: -1 }])}</actions>`,
        ids(),
      );
      expect(r.actions).toHaveLength(1);
      expect((r.actions[0] as { dayIndex?: number }).dayIndex).toBeUndefined();
    });
  });

  it('rejects labels that are empty or too long', () => {
    const raw1 = 'x<actions>[{"kind":"log_injury","label":"","area":"knee"}]</actions>';
    expect(parseChatActionsBlock(raw1, ids()).actions).toEqual([]);
    const raw2 = `x<actions>[{"kind":"log_injury","label":"${'x'.repeat(80)}","area":"knee"}]</actions>`;
    expect(parseChatActionsBlock(raw2, ids()).actions).toEqual([]);
  });

  it('assigns the supplied id generator output to each chip', () => {
    const raw =
      'x<actions>[' +
      '{"kind":"log_injury","label":"A","area":"knee"},' +
      '{"kind":"log_injury","label":"B","area":"hip"}' +
      ']</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions[0]?.id).toBe('id-1');
    expect(r.actions[1]?.id).toBe('id-2');
  });
});
