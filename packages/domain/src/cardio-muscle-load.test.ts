import { describe, expect, it } from 'vitest';
import { cardioMuscleImpact } from './cardio-muscle-load';

// Helper to build HR zone arrays that produce a given classifier tag.
const HARD_ZONES = [60, 60, 120, 600, 360]; // ~50% Z4+Z5
const THRESHOLD_ZONES = [120, 240, 600, 60, 0]; // ~50% Z3
const EASY_ZONES = [400, 800, 0, 0, 0];
const RECOVERY_ZONES = [1500, 100, 0, 0, 0];

describe('cardioMuscleImpact — runs', () => {
  it('hard run loads the whole posterior chain + quads + calves as primary', () => {
    const r = cardioMuscleImpact({
      modality: 'run',
      durationSec: 45 * 60,
      distanceKm: 9,
      hrZoneSeconds: HARD_ZONES,
    });
    expect(r.primary).toEqual(
      expect.arrayContaining(['quads', 'hamstrings', 'glutes', 'calves']),
    );
  });

  it('threshold run keeps glutes secondary', () => {
    const r = cardioMuscleImpact({
      modality: 'run',
      durationSec: 40 * 60,
      hrZoneSeconds: THRESHOLD_ZONES,
    });
    expect(r.primary).toContain('quads');
    expect(r.primary).not.toContain('glutes');
    expect(r.secondary).toContain('glutes');
  });

  it('long easy run (45+ min) loads the whole leg as secondary', () => {
    const r = cardioMuscleImpact({
      modality: 'run',
      durationSec: 60 * 60,
      distanceKm: 10,
      hrZoneSeconds: EASY_ZONES,
    });
    expect(r.primary).toContain('calves');
    expect(r.secondary).toEqual(
      expect.arrayContaining(['quads', 'hamstrings', 'glutes']),
    );
  });

  it('short easy shakeout only touches calves + quads as secondary', () => {
    const r = cardioMuscleImpact({
      modality: 'run',
      durationSec: 20 * 60,
      distanceKm: 4,
      hrZoneSeconds: EASY_ZONES,
    });
    expect(r.primary).toEqual([]);
    expect(r.secondary).toEqual(expect.arrayContaining(['calves', 'quads']));
    expect(r.secondary).not.toContain('hamstrings');
  });

  it('recovery jog still counts as an easy touch', () => {
    const r = cardioMuscleImpact({
      modality: 'run',
      durationSec: 30 * 60,
      distanceKm: 5,
      hrZoneSeconds: RECOVERY_ZONES,
    });
    expect(r.secondary.length).toBeGreaterThan(0);
  });

  it('unclassified (no HR) short run is dropped', () => {
    const r = cardioMuscleImpact({
      modality: 'run',
      durationSec: 15 * 60,
      distanceKm: 3,
    });
    expect(r.primary).toEqual([]);
    expect(r.secondary).toEqual([]);
  });

  it('unclassified longer run falls back to easy', () => {
    const r = cardioMuscleImpact({
      modality: 'run',
      durationSec: 30 * 60,
      distanceKm: 6,
    });
    expect(r.secondary.length).toBeGreaterThan(0);
  });
});

describe('cardioMuscleImpact — other modalities', () => {
  it('hard bike puts quads + glutes primary', () => {
    const r = cardioMuscleImpact({
      modality: 'bike',
      durationSec: 60 * 60,
      hrZoneSeconds: HARD_ZONES,
    });
    expect(r.primary).toEqual(expect.arrayContaining(['quads', 'glutes']));
  });

  it('hard row hits the full pull chain', () => {
    const r = cardioMuscleImpact({
      modality: 'row',
      durationSec: 30 * 60,
      hrZoneSeconds: HARD_ZONES,
    });
    expect(r.primary).toEqual(
      expect.arrayContaining(['hamstrings', 'glutes', 'back', 'lats']),
    );
  });

  it('hard swim emphasises lats + shoulders + back', () => {
    const r = cardioMuscleImpact({
      modality: 'swim',
      durationSec: 45 * 60,
      hrZoneSeconds: HARD_ZONES,
    });
    expect(r.primary).toEqual(
      expect.arrayContaining(['lats', 'shoulders', 'back']),
    );
  });

  it('30-min walk does not reset leg freshness', () => {
    const r = cardioMuscleImpact({
      modality: 'walk',
      durationSec: 30 * 60,
      distanceKm: 2.5,
    });
    expect(r.primary).toEqual([]);
    expect(r.secondary).toEqual([]);
  });

  it('long hike (90+ min OR 8+ km) loads calves + quads + glutes', () => {
    const r = cardioMuscleImpact({
      modality: 'walk',
      durationSec: 100 * 60,
      distanceKm: 10,
    });
    expect(r.secondary).toEqual(
      expect.arrayContaining(['calves', 'quads', 'glutes']),
    );
  });

  it('walk between the two thresholds (60-89 min, <8km) is light', () => {
    const r = cardioMuscleImpact({
      modality: 'walk',
      durationSec: 70 * 60,
      distanceKm: 5,
    });
    expect(r.secondary).toEqual(['calves']);
  });

  it('hard padel hits legs primary, shoulders/core secondary', () => {
    const r = cardioMuscleImpact({
      modality: 'padel',
      durationSec: 60 * 60,
      hrZoneSeconds: HARD_ZONES,
    });
    expect(r.primary).toEqual(expect.arrayContaining(['quads', 'calves']));
    expect(r.secondary).toEqual(
      expect.arrayContaining(['shoulders', 'core', 'obliques']),
    );
  });

  it('"other" modality never resets freshness', () => {
    const r = cardioMuscleImpact({
      modality: 'other',
      durationSec: 60 * 60,
      hrZoneSeconds: HARD_ZONES,
    });
    expect(r.primary).toEqual([]);
    expect(r.secondary).toEqual([]);
  });
});
