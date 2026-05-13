import { describe, expect, it } from 'vitest';
import { isCardioLinkableToSlot, isRunCandidate, isoDayOfWeek, matchActivityToPlan, toLocalYmd } from './runPlan';
import type { RunPlanSlot } from './types';

const PLAN: RunPlanSlot[] = [
  { dayOfWeek: 0, kind: 'easy' }, // Mon
  { dayOfWeek: 1, kind: 'easy' }, // Tue
  { dayOfWeek: 2, kind: 'quality' }, // Wed
  { dayOfWeek: 4, kind: 'quality' }, // Fri
  { dayOfWeek: 5, kind: 'long' }, // Sat
  { dayOfWeek: 6, kind: 'rest' }, // Sun
];

// Mon 2026-05-04, Wed 2026-05-06, Sat 2026-05-09, Sun 2026-05-10
const MON = '2026-05-04T08:00:00Z';
const TUE = '2026-05-05T08:00:00Z';
const WED = '2026-05-06T08:00:00Z';
const SAT = '2026-05-09T08:00:00Z';
const SUN = '2026-05-10T08:00:00Z';

describe('isoDayOfWeek', () => {
  it('returns Mon=0, Sun=6', () => {
    expect(isoDayOfWeek(new Date(MON))).toBe(0);
    expect(isoDayOfWeek(new Date(WED))).toBe(2);
    expect(isoDayOfWeek(new Date(SAT))).toBe(5);
    expect(isoDayOfWeek(new Date(SUN))).toBe(6);
  });
});

describe('matchActivityToPlan', () => {
  it('returns the slot kind on a planned day', () => {
    expect(
      matchActivityToPlan({ performedAt: MON, modality: 'run' }, PLAN),
    ).toMatchObject({ kind: 'easy', confidence: 'exact' });
    expect(
      matchActivityToPlan({ performedAt: WED, modality: 'run' }, PLAN),
    ).toMatchObject({ kind: 'quality', confidence: 'exact' });
    expect(
      matchActivityToPlan({ performedAt: SAT, modality: 'run' }, PLAN),
    ).toMatchObject({ kind: 'long', confidence: 'exact' });
  });

  it('returns scheduledDate as performedAt local YMD on auto-match', () => {
    const m = matchActivityToPlan({ performedAt: MON, modality: 'run' }, PLAN);
    expect(m?.scheduledDate).toBe(toLocalYmd(new Date(MON)));
  });

  it('returns null on a rest day', () => {
    expect(matchActivityToPlan({ performedAt: SUN, modality: 'run' }, PLAN)).toBe(null);
  });

  it('returns null when the day has no slot at all', () => {
    // Thu = no slot in PLAN.
    expect(
      matchActivityToPlan({ performedAt: '2026-05-07T08:00:00Z', modality: 'run' }, PLAN),
    ).toBe(null);
  });

  it('treats undefined modality as run', () => {
    expect(matchActivityToPlan({ performedAt: TUE }, PLAN)).toMatchObject({
      kind: 'easy',
      confidence: 'exact',
    });
  });

  it('skips non-run modalities', () => {
    expect(
      matchActivityToPlan({ performedAt: MON, modality: 'bike' }, PLAN),
    ).toBe(null);
  });

  it('returns null with no plan', () => {
    expect(matchActivityToPlan({ performedAt: MON, modality: 'run' }, [])).toBe(null);
    expect(matchActivityToPlan({ performedAt: MON, modality: 'run' }, null)).toBe(null);
    expect(
      matchActivityToPlan({ performedAt: MON, modality: 'run' }, undefined),
    ).toBe(null);
  });
});

describe('isCardioLinkableToSlot', () => {
  it('accepts unmatched runs', () => {
    expect(isCardioLinkableToSlot({ modality: 'run', planMatch: 'none' })).toBe(true);
    expect(isCardioLinkableToSlot({ modality: 'run' })).toBe(true);
  });

  it('rejects already-linked runs (auto or manual)', () => {
    expect(isCardioLinkableToSlot({ modality: 'run', planMatch: 'exact' })).toBe(false);
    expect(isCardioLinkableToSlot({ modality: 'run', planMatch: 'manual' })).toBe(false);
  });

  it('rejects non-run modalities', () => {
    expect(isCardioLinkableToSlot({ modality: 'bike' })).toBe(false);
    expect(isCardioLinkableToSlot({ modality: 'walk' })).toBe(false);
    expect(isCardioLinkableToSlot({ modality: 'swim', planMatch: 'none' })).toBe(false);
  });

  it('treats undefined modality as run', () => {
    expect(isCardioLinkableToSlot({})).toBe(true);
  });
});

describe('isRunCandidate', () => {
  it('accepts any run regardless of link state', () => {
    expect(isRunCandidate({ modality: 'run' })).toBe(true);
    expect(isRunCandidate({})).toBe(true);
  });

  it('rejects non-run modalities', () => {
    expect(isRunCandidate({ modality: 'bike' })).toBe(false);
    expect(isRunCandidate({ modality: 'walk' })).toBe(false);
    expect(isRunCandidate({ modality: 'swim' })).toBe(false);
  });
});

describe('toLocalYmd', () => {
  it('formats a date as zero-padded YYYY-MM-DD in local time', () => {
    // 2026-01-05 in local time, regardless of TZ.
    const d = new Date(2026, 0, 5);
    expect(toLocalYmd(d)).toBe('2026-01-05');
  });
});
