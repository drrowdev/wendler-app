// Coarse 4-zone RPE picker UX (Easy / Moderate / Hard / Max). Storage is the
// usual numeric RPE — we record the midpoint of the zone the user tapped, so
// history, charts, and PR detection keep working unchanged. The inverse map
// (number → zone) lets us highlight the user's previously chosen zone if they
// re-open a logged set.

export type RpeZoneId = 'easy' | 'moderate' | 'hard' | 'max';

export interface RpeZone {
  id: RpeZoneId;
  label: string;
  /** Inclusive lower bound of the RPE range this zone represents. */
  min: number;
  /** Inclusive upper bound of the RPE range this zone represents. */
  max: number;
  /** Numeric RPE we persist when the user taps this zone (midpoint of min/max). */
  midpoint: number;
}

export const RPE_ZONES: readonly RpeZone[] = [
  { id: 'easy', label: 'Easy', min: 6, max: 6.5, midpoint: 6.25 },
  { id: 'moderate', label: 'Moderate', min: 7, max: 8, midpoint: 7.5 },
  { id: 'hard', label: 'Hard', min: 8.5, max: 9, midpoint: 8.75 },
  { id: 'max', label: 'Max effort', min: 9.5, max: 10, midpoint: 9.75 },
] as const;

/** Map a numeric RPE to the zone it falls in (for highlighting / display). */
export function zoneFromRpe(rpe: number | undefined): RpeZoneId | undefined {
  if (rpe === undefined || !isFinite(rpe)) return undefined;
  if (rpe < 7) return 'easy';
  if (rpe < 8.5) return 'moderate';
  if (rpe < 9.5) return 'hard';
  return 'max';
}

/** Numeric RPE we persist when the user taps a zone (its midpoint). */
export function rpeFromZone(zone: RpeZoneId): number {
  const z = RPE_ZONES.find((x) => x.id === zone);
  if (!z) throw new Error(`Unknown RPE zone: ${zone}`);
  return z.midpoint;
}
