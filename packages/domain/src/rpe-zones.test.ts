import { describe, expect, it } from 'vitest';
import { rpeFromZone, RPE_ZONES, zoneFromRpe } from './rpe-zones';

describe('rpe-zones', () => {
  it('exposes all four zones in order', () => {
    expect(RPE_ZONES.map((z) => z.id)).toEqual(['easy', 'moderate', 'hard', 'max']);
  });

  it('persists the zone midpoint as the numeric RPE', () => {
    expect(rpeFromZone('easy')).toBe(6.25);
    expect(rpeFromZone('moderate')).toBe(7.5);
    expect(rpeFromZone('hard')).toBe(8.75);
    expect(rpeFromZone('max')).toBe(9.75);
  });

  it('maps numeric RPE back to a zone for highlighting', () => {
    expect(zoneFromRpe(6)).toBe('easy');
    expect(zoneFromRpe(6.5)).toBe('easy');
    expect(zoneFromRpe(6.99)).toBe('easy');
    expect(zoneFromRpe(7)).toBe('moderate');
    expect(zoneFromRpe(8)).toBe('moderate');
    expect(zoneFromRpe(8.49)).toBe('moderate');
    expect(zoneFromRpe(8.5)).toBe('hard');
    expect(zoneFromRpe(9)).toBe('hard');
    expect(zoneFromRpe(9.49)).toBe('hard');
    expect(zoneFromRpe(9.5)).toBe('max');
    expect(zoneFromRpe(10)).toBe('max');
  });

  it('round-trips: each zone midpoint maps back to its own zone', () => {
    for (const z of RPE_ZONES) {
      expect(zoneFromRpe(z.midpoint)).toBe(z.id);
    }
  });

  it('returns undefined for missing/invalid RPE', () => {
    expect(zoneFromRpe(undefined)).toBeUndefined();
    expect(zoneFromRpe(NaN)).toBeUndefined();
  });
});
