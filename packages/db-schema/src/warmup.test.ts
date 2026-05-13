import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRE_LIFTING_WARMUP_BLOCKS,
  estimateBlockDurationSec,
  formatDurationSec,
  liftSetKey,
  liftSetLabel,
  selectWarmupBlocks,
  type WarmupBlockDef,
} from './types';

const blocks: WarmupBlockDef[] = [
  { id: 'g', title: 'General', appliesTo: 'always', movements: [] },
  { id: 'p', title: 'Activation (upper)', appliesTo: 'press', movements: [] }, // legacy
  { id: 'l', title: 'Activation (lower)', appliesTo: 'lower', movements: [] }, // legacy
  { id: 'u', title: 'Mobility', movements: [] }, // appliesTo unset → always
  { id: 'bd', title: 'Bench+Deadlift only', appliesTo: 'bench+deadlift', movements: [] },
  { id: 'sp', title: 'Press+Squat only', appliesTo: 'press+squat', movements: [] },
];

describe('liftSetKey', () => {
  it('sorts lifts alphabetically and joins with +', () => {
    expect(liftSetKey(['squat', 'press'])).toBe('press+squat');
    expect(liftSetKey(['deadlift', 'bench'])).toBe('bench+deadlift');
  });
  it('handles single-lift days', () => {
    expect(liftSetKey(['bench'])).toBe('bench');
  });
  it('returns empty string for accessory days', () => {
    expect(liftSetKey([])).toBe('');
  });
});

describe('liftSetLabel', () => {
  it('builds a human-friendly label', () => {
    expect(liftSetLabel(['bench', 'deadlift'])).toBe('Bench + Deadlift');
    expect(liftSetLabel(['press'])).toBe('Press');
  });
  it('labels empty as Accessory', () => {
    expect(liftSetLabel([])).toBe('Accessory');
  });
});

describe('selectWarmupBlocks', () => {
  it('on a single bench day shows always + legacy press, no lower-only or other combos', () => {
    const out = selectWarmupBlocks(blocks, ['bench']);
    expect(out.map((b) => b.id)).toEqual(['g', 'p', 'u']);
  });

  it('on a single squat day shows always + legacy lower, not press', () => {
    const out = selectWarmupBlocks(blocks, ['squat']);
    expect(out.map((b) => b.id)).toEqual(['g', 'l', 'u']);
  });

  it('on a bench+deadlift superset day matches the bench+deadlift combo plus both legacies', () => {
    const out = selectWarmupBlocks(blocks, ['deadlift', 'bench']);
    expect(out.map((b) => b.id)).toEqual(['g', 'p', 'l', 'u', 'bd']);
  });

  it('on a press+squat superset day matches the press+squat combo plus both legacies', () => {
    const out = selectWarmupBlocks(blocks, ['squat', 'press']);
    expect(out.map((b) => b.id)).toEqual(['g', 'p', 'l', 'u', 'sp']);
  });

  it('on an accessory day (no main lifts) shows always + legacy lower', () => {
    const out = selectWarmupBlocks(blocks, []);
    expect(out.map((b) => b.id)).toEqual(['g', 'l', 'u']);
  });

  it('on a press+squat day a bench+deadlift block is hidden (and vice versa)', () => {
    const onPressSquat = selectWarmupBlocks(blocks, ['press', 'squat']);
    expect(onPressSquat.map((b) => b.id)).toContain('sp');
    expect(onPressSquat.map((b) => b.id)).not.toContain('bd');

    const onBenchDl = selectWarmupBlocks(blocks, ['bench', 'deadlift']);
    expect(onBenchDl.map((b) => b.id)).toContain('bd');
    expect(onBenchDl.map((b) => b.id)).not.toContain('sp');
  });

  it('preserves array order even after reordering', () => {
    const reordered: WarmupBlockDef[] = [];
    for (const id of ['u', 'l', 'g', 'p']) {
      const b = blocks.find((x) => x.id === id);
      if (b) reordered.push(b);
    }
    const out = selectWarmupBlocks(reordered, ['bench']);
    expect(out.map((b) => b.id)).toEqual(['u', 'g', 'p']);
  });
});

describe('DEFAULT_PRE_LIFTING_WARMUP_BLOCKS', () => {
  it('every default block has a unique id', () => {
    const ids = DEFAULT_PRE_LIFTING_WARMUP_BLOCKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every default movement has a unique id within its block', () => {
    for (const b of DEFAULT_PRE_LIFTING_WARMUP_BLOCKS) {
      const mIds = b.movements.map((m) => m.id);
      expect(new Set(mIds).size).toBe(mIds.length);
    }
  });

  it('all default blocks are appliesTo=always (the user opts into combos via the editor)', () => {
    for (const b of DEFAULT_PRE_LIFTING_WARMUP_BLOCKS) {
      expect(b.appliesTo).toBe('always');
    }
  });

  it('a single bench day surfaces every default block', () => {
    const out = selectWarmupBlocks(DEFAULT_PRE_LIFTING_WARMUP_BLOCKS, ['bench']);
    expect(out).toHaveLength(DEFAULT_PRE_LIFTING_WARMUP_BLOCKS.length);
  });
});

describe('estimateBlockDurationSec', () => {
  it('returns 0 for an empty block', () => {
    expect(estimateBlockDurationSec({ id: 'x', title: 't', movements: [] })).toBe(0);
  });

  it('uses an explicit time dose directly (minutes)', () => {
    const sec = estimateBlockDurationSec({
      id: 'x',
      title: 't',
      movements: [{ id: 'm', name: 'cardio', dose: '~3 min' }],
    });
    expect(sec).toBe(3 * 60);
  });

  it('uses an explicit time dose directly (seconds)', () => {
    const sec = estimateBlockDurationSec({
      id: 'x',
      title: 't',
      movements: [{ id: 'm', name: 'plank', dose: '30 s' }],
    });
    expect(sec).toBe(30);
  });

  it('doubles a time-based dose when /side is present (e.g. 40 s / side → 80 s)', () => {
    const sec = estimateBlockDurationSec({
      id: 'x',
      title: 't',
      movements: [{ id: 'm', name: 'side plank', dose: '40 s / side' }],
    });
    expect(sec).toBe(80);
  });

  it('doubles a minute-based dose when /side is present (1 min / side → 120 s)', () => {
    const sec = estimateBlockDurationSec({
      id: 'x',
      title: 't',
      movements: [{ id: 'm', name: 'couch stretch', dose: '1 min / side' }],
    });
    expect(sec).toBe(120);
  });

  it('computes sets×reps with REP_SECONDS + between-sets rest', () => {
    // 2×10: 2 sets × 10 reps × 4 s = 80 s, plus 1 between-set rest of 30 s = 110 s
    const sec = estimateBlockDurationSec({
      id: 'x',
      title: 't',
      movements: [{ id: 'm', name: 'pull-aparts', dose: '2 × 10' }],
    });
    expect(sec).toBe(110);
  });

  it('doubles the rep count when the dose says /side', () => {
    // 2×8 /side → 16 effective reps per set: 2 × 16 × 4 = 128 s + 30 s rest = 158 s
    const sec = estimateBlockDurationSec({
      id: 'x',
      title: 't',
      movements: [{ id: 'm', name: 'birddog', dose: '2 × 8 / side' }],
    });
    expect(sec).toBe(158);
  });

  it('falls back to per-movement default when the dose has no parseable shape', () => {
    const sec = estimateBlockDurationSec({
      id: 'x',
      title: 't',
      movements: [{ id: 'm', name: 'foam roll' }],
    });
    expect(sec).toBe(30);
  });

  it('adds a between-movement transition for each extra movement', () => {
    // two movements of "30 s" each: 30 + 30 + 1 transition × 15 = 75 s
    const sec = estimateBlockDurationSec({
      id: 'x',
      title: 't',
      movements: [
        { id: 'a', name: 'a', dose: '30 s' },
        { id: 'b', name: 'b', dose: '30 s' },
      ],
    });
    expect(sec).toBe(75);
  });
});

describe('formatDurationSec', () => {
  it('formats sub-minute values in 15 s steps', () => {
    expect(formatDurationSec(45)).toBe('≈ 45 s');
    expect(formatDurationSec(20)).toBe('≈ 15 s');
  });

  it('formats sub-5-minute values in half-minute steps', () => {
    expect(formatDurationSec(60)).toBe('≈ 1 min');
    expect(formatDurationSec(150)).toBe('≈ 2.5 min');
  });

  it('formats values >= 5 min in whole minutes', () => {
    expect(formatDurationSec(360)).toBe('≈ 6 min');
  });

  it('shows an em-dash for non-positive or non-finite inputs', () => {
    expect(formatDurationSec(0)).toBe('—');
    expect(formatDurationSec(-1)).toBe('—');
    expect(formatDurationSec(NaN)).toBe('—');
  });
});
