import { describe, expect, it } from 'vitest';
import {
  importedStrengthLabel,
  orphanStrengthHr,
  partitionStrengthHr,
} from './strength-hr-match';

describe('orphanStrengthHr', () => {
  it('returns rows with no matching session day', () => {
    const orphans = orphanStrengthHr(
      [
        { id: 'a', performedAt: '2026-04-29T18:00:00Z', durationSec: 3600 },
        { id: 'b', performedAt: '2026-04-30T18:00:00Z', durationSec: 1800 },
      ],
      [{ performedAt: '2026-04-29T17:30:00Z' }],
    );
    expect(orphans.map((o) => o.id)).toEqual(['b']);
  });

  it('is empty when every row matches a session day', () => {
    const orphans = orphanStrengthHr(
      [{ id: 'a', performedAt: '2026-04-29T18:00:00Z', durationSec: 3600 }],
      [{ performedAt: '2026-04-29T08:00:00Z' }, { performedAt: '2026-04-30T08:00:00Z' }],
    );
    expect(orphans).toEqual([]);
  });

  it('returns everything when there are no sessions', () => {
    const orphans = orphanStrengthHr(
      [
        { id: 'a', performedAt: '2026-04-29T18:00:00Z', durationSec: 3600 },
        { id: 'b', performedAt: '2026-04-30T18:00:00Z', durationSec: 1800 },
      ],
      [],
    );
    expect(orphans.map((o) => o.id).sort()).toEqual(['a', 'b']);
  });

  it('sorts newest first', () => {
    const orphans = orphanStrengthHr(
      [
        { id: 'old', performedAt: '2026-04-01T18:00:00Z', durationSec: 1800 },
        { id: 'new', performedAt: '2026-04-30T18:00:00Z', durationSec: 1800 },
        { id: 'mid', performedAt: '2026-04-15T18:00:00Z', durationSec: 1800 },
      ],
      [],
    );
    expect(orphans.map((o) => o.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('partitionStrengthHr', () => {
  it('puts each row into matched-by-day or orphans', () => {
    const { matchedByDay, orphans } = partitionStrengthHr(
      [
        { id: 'a', performedAt: '2026-04-29T18:00:00Z', durationSec: 3600 },
        { id: 'b', performedAt: '2026-04-30T18:00:00Z', durationSec: 1800 },
      ],
      [{ performedAt: '2026-04-29T17:30:00Z' }],
    );
    expect(matchedByDay.get('2026-04-29')?.id).toBe('a');
    expect(orphans.map((o) => o.id)).toEqual(['b']);
  });

  it('keeps the longest row when multiple HR rows share a matched day', () => {
    const { matchedByDay } = partitionStrengthHr(
      [
        { id: 'short', performedAt: '2026-04-29T08:00:00Z', durationSec: 900 },
        { id: 'long', performedAt: '2026-04-29T18:00:00Z', durationSec: 3600 },
        { id: 'mid', performedAt: '2026-04-29T12:00:00Z', durationSec: 1800 },
      ],
      [{ performedAt: '2026-04-29T17:30:00Z' }],
    );
    expect(matchedByDay.size).toBe(1);
    expect(matchedByDay.get('2026-04-29')?.id).toBe('long');
  });

  it('returns no matches when there are no sessions', () => {
    const { matchedByDay, orphans } = partitionStrengthHr(
      [{ id: 'a', performedAt: '2026-04-29T18:00:00Z', durationSec: 3600 }],
      [],
    );
    expect(matchedByDay.size).toBe(0);
    expect(orphans.map((o) => o.id)).toEqual(['a']);
  });
});

describe('importedStrengthLabel', () => {
  it('maps known Strava sport types to human labels', () => {
    expect(importedStrengthLabel('WeightTraining')).toBe('Weight training');
    expect(importedStrengthLabel('Crossfit')).toBe('CrossFit');
    expect(importedStrengthLabel('HighIntensityIntervalTraining')).toBe('HIIT');
    expect(importedStrengthLabel('Workout')).toBe('Workout');
  });

  it('falls back to "Strength" for unknown / missing sport', () => {
    expect(importedStrengthLabel(undefined)).toBe('Strength');
    expect(importedStrengthLabel(null)).toBe('Strength');
    expect(importedStrengthLabel('SomethingNew')).toBe('Strength');
  });
});
