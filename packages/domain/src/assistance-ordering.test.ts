import { describe, expect, it } from 'vitest';
import { sortAssistanceEntriesForDay } from './assistance-ordering';
import type { AssistanceCategory, AssistanceEntry } from './blocks';
import type { RuleSlot } from './goal-flags';

function e(id: string, category: AssistanceCategory): AssistanceEntry {
  return {
    id,
    category,
    movementName: id,
    sets: 3,
    reps: 8,
  };
}

describe('sortAssistanceEntriesForDay', () => {
  it('returns empty/single-entry arrays unchanged', () => {
    expect(sortAssistanceEntriesForDay([], ['bench'])).toEqual([]);
    const only = [e('dip', 'push')];
    expect(sortAssistanceEntriesForDay(only, ['bench'])).toEqual(only);
  });

  it('accessory day: orders by default flow push → pull → single-leg → core → accessory → other', () => {
    const input = [
      e('curl', 'accessory'),
      e('plank', 'core'),
      e('row', 'pull'),
      e('lunge', 'single-leg'),
      e('carry', 'other'),
      e('dip', 'push'),
    ];
    const out = sortAssistanceEntriesForDay(input, []);
    expect(out.map((x) => x.id)).toEqual(['dip', 'row', 'lunge', 'plank', 'curl', 'carry']);
  });

  it('bench day: push (matching) goes first', () => {
    const input = [
      e('curl', 'accessory'),
      e('row', 'pull'),
      e('dip', 'push'),
    ];
    expect(sortAssistanceEntriesForDay(input, ['bench']).map((x) => x.id)).toEqual([
      'dip',
      'row',
      'curl',
    ]);
  });

  it('press day: push (matching) goes first', () => {
    const input = [
      e('row', 'pull'),
      e('skull-crusher', 'push'),
      e('plank', 'core'),
    ];
    expect(sortAssistanceEntriesForDay(input, ['press']).map((x) => x.id)).toEqual([
      'skull-crusher',
      'row',
      'plank',
    ]);
  });

  it('deadlift day: pull (matching) goes first', () => {
    const input = [
      e('dip', 'push'),
      e('plank', 'core'),
      e('row', 'pull'),
      e('curl', 'accessory'),
    ];
    expect(sortAssistanceEntriesForDay(input, ['deadlift']).map((x) => x.id)).toEqual([
      'row',
      'dip',
      'plank',
      'curl',
    ]);
  });

  it('squat day: single-leg (matching) goes first', () => {
    const input = [
      e('row', 'pull'),
      e('dip', 'push'),
      e('lunge', 'single-leg'),
      e('plank', 'core'),
    ];
    expect(sortAssistanceEntriesForDay(input, ['squat']).map((x) => x.id)).toEqual([
      'lunge',
      'dip',
      'row',
      'plank',
    ]);
  });

  it('multi-main day uses the first lift to pick the matching category', () => {
    const input = [
      e('row', 'pull'),
      e('dip', 'push'),
      e('plank', 'core'),
    ];
    // bench listed first → push wins
    expect(
      sortAssistanceEntriesForDay(input, ['bench', 'deadlift']).map((x) => x.id),
    ).toEqual(['dip', 'row', 'plank']);
    // deadlift listed first → pull wins
    expect(
      sortAssistanceEntriesForDay(input, ['deadlift', 'bench']).map((x) => x.id),
    ).toEqual(['row', 'dip', 'plank']);
  });

  it('is stable within a category (preserves input order for same-category entries)', () => {
    const input = [
      e('curl', 'accessory'),
      e('lateral-raise', 'accessory'),
      e('face-pull', 'accessory'),
      e('dip', 'push'),
    ];
    expect(sortAssistanceEntriesForDay(input, ['bench']).map((x) => x.id)).toEqual([
      'dip',
      'curl',
      'lateral-raise',
      'face-pull',
    ]);
  });

  it('is idempotent — re-sorting an already-sorted array is a no-op', () => {
    const input = [
      e('curl', 'accessory'),
      e('row', 'pull'),
      e('dip', 'push'),
    ];
    const once = sortAssistanceEntriesForDay(input, ['bench']);
    const twice = sortAssistanceEntriesForDay(once, ['bench']);
    expect(twice).toEqual(once);
  });

  it('does not mutate the input array', () => {
    const input = [
      e('curl', 'accessory'),
      e('dip', 'push'),
    ];
    const snapshot = input.map((x) => x.id);
    sortAssistanceEntriesForDay(input, ['bench']);
    expect(input.map((x) => x.id)).toEqual(snapshot);
  });

  it("'other' (carries) lands last on every kind of day", () => {
    const input = [
      e('farmer-carry', 'other'),
      e('curl', 'accessory'),
      e('dip', 'push'),
    ];
    expect(sortAssistanceEntriesForDay(input, ['bench']).map((x) => x.id)).toEqual([
      'dip',
      'curl',
      'farmer-carry',
    ]);
    expect(sortAssistanceEntriesForDay(input, []).map((x) => x.id)).toEqual([
      'dip',
      'curl',
      'farmer-carry',
    ]);
  });

  describe('with slot map (LLM path — v286+)', () => {
    // When the LLM emits per-entry slot info, we trust its intra-day order
    // for everything except prehab, which gets pulled to the end. The
    // LLM is expected to do the heavy lifting (compound first, muscle
    // alternation) via the new system-prompt instruction.

    function slotMap(entries: ReadonlyArray<[string, RuleSlot]>): Map<string, RuleSlot> {
      return new Map(entries);
    }

    it("preserves the LLM's order when no prehab is present", () => {
      const input = [
        e('dip', 'push'),
        e('row', 'pull'),
        e('plank', 'core'),
        e('curl', 'accessory'),
      ];
      const slots = slotMap([
        ['dip', 'push'],
        ['row', 'pull'],
        ['plank', 'core'],
        ['curl', 'isolation'],
      ]);
      expect(
        sortAssistanceEntriesForDay(input, [], slots).map((x) => x.id),
      ).toEqual(['dip', 'row', 'plank', 'curl']);
    });

    it('pulls prehab entries to the end while preserving non-prehab order', () => {
      // This is the exact bug from the v286 user report — Day 3 had:
      // Nordic (pull), Glute Bridge (single-leg), Pallof (core),
      // Clamshell (prehab), Face Pull (prehab), Calf Raise (isolation),
      // Suitcase Carry (carry). The old category sort left
      // isolation/prehab in LLM-emitted order — prehab leaked ahead of
      // isolation. New behavior: prehab gets pulled to the end.
      const input = [
        e('nordic', 'pull'),
        e('glute-bridge', 'single-leg'),
        e('pallof', 'core'),
        e('clamshell', 'accessory'),
        e('face-pull', 'accessory'),
        e('calf-raise', 'accessory'),
        e('suitcase', 'other'),
      ];
      const slots = slotMap([
        ['nordic', 'pull'],
        ['glute-bridge', 'single-leg'],
        ['pallof', 'core'],
        ['clamshell', 'prehab'],
        ['face-pull', 'prehab'],
        ['calf-raise', 'isolation'],
        ['suitcase', 'carry'],
      ]);
      expect(
        sortAssistanceEntriesForDay(input, [], slots).map((x) => x.id),
      ).toEqual(['nordic', 'glute-bridge', 'pallof', 'calf-raise', 'suitcase', 'clamshell', 'face-pull']);
    });

    it('keeps prehab entries in their LLM-given order amongst themselves', () => {
      const input = [
        e('curl', 'accessory'),
        e('face-pull', 'accessory'),
        e('clamshell', 'accessory'),
      ];
      const slots = slotMap([
        ['curl', 'isolation'],
        ['face-pull', 'prehab'],
        ['clamshell', 'prehab'],
      ]);
      // curl stays first (non-prehab); face-pull before clamshell (LLM order).
      expect(
        sortAssistanceEntriesForDay(input, [], slots).map((x) => x.id),
      ).toEqual(['curl', 'face-pull', 'clamshell']);
    });

    it('is idempotent with the slot map', () => {
      const input = [
        e('clamshell', 'accessory'),
        e('dip', 'push'),
      ];
      const slots = slotMap([
        ['clamshell', 'prehab'],
        ['dip', 'push'],
      ]);
      const once = sortAssistanceEntriesForDay(input, ['bench'], slots);
      expect(once.map((x) => x.id)).toEqual(['dip', 'clamshell']);
      // Build a new slot map keyed on the (preserved) ids — the function
      // doesn't mutate ids, so the same map works.
      const twice = sortAssistanceEntriesForDay(once, ['bench'], slots);
      expect(twice.map((x) => x.id)).toEqual(['dip', 'clamshell']);
    });

    it('falls back to category sort when no slot map is supplied (back-compat)', () => {
      // Without slot info the legacy category-based sort kicks in.
      const input = [
        e('curl', 'accessory'),
        e('row', 'pull'),
        e('dip', 'push'),
      ];
      expect(sortAssistanceEntriesForDay(input, ['bench']).map((x) => x.id)).toEqual([
        'dip',
        'row',
        'curl',
      ]);
    });
  });
});
