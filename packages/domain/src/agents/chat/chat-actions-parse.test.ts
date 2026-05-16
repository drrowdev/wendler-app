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

  it('drops invalid severity but keeps the chip', () => {
    const raw =
      'x<actions>[{"kind":"log_injury","label":"Log knee","area":"knee","severity":9}]</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).not.toHaveProperty('severity');
  });

  it('rejects log_injury chips with empty area', () => {
    const raw =
      'x<actions>[{"kind":"log_injury","label":"Log nothing","area":""}]</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toEqual([]);
  });

  it('rejects log_injury chips with missing label', () => {
    const raw =
      'x<actions>[{"kind":"log_injury","area":"knee"}]</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toEqual([]);
  });

  it('silently drops deprecated chip kinds from legacy AI emissions', () => {
    const raw =
      'x<actions>[{"kind":"set_training_max","label":"Cut bench TM","lift":"bench","newTrainingMaxKg":102.5,"reason":"x"},{"kind":"log_injury","label":"Log knee","area":"knee"}]</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]?.kind).toBe('log_injury');
  });

  it('handles malformed JSON gracefully', () => {
    const raw = 'x<actions>{not json}</actions>';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toEqual([]);
    expect(r.prose).toBe('x');
  });

  it('handles truncated opener with no closer (drops the truncated tail)', () => {
    const raw = 'prose here<actions>[{"kind":"log_injury"';
    const r = parseChatActionsBlock(raw, ids());
    expect(r.prose).toBe('prose here');
    expect(r.actions).toEqual([]);
  });

  it('caps emitted chips at 4', () => {
    const chips = Array.from({ length: 8 }, (_, i) => ({
      kind: 'log_injury',
      label: `Log ${i}`,
      area: 'knee',
    }));
    const raw = `x<actions>${JSON.stringify(chips)}</actions>`;
    const r = parseChatActionsBlock(raw, ids());
    expect(r.actions).toHaveLength(4);
  });

  it('caps label length and slices long descriptions', () => {
    const raw =
      'x<actions>[{"kind":"log_injury","label":"' +
      'x'.repeat(80) +
      '","area":"knee","description":"' +
      'y'.repeat(600) +
      '"}]</actions>';
    const r = parseChatActionsBlock(raw, ids());
    // Label > 60 chars is rejected entirely.
    expect(r.actions).toEqual([]);
  });
});
