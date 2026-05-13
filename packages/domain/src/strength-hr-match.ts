// Match imported Strava strength HR enrichments against logged Wendler
// strength sessions. A strength HR row is "matched" if there is at least
// one Wendler session whose `performedAt` falls on the same calendar day
// (UTC date prefix — close enough for daily training rhythm).
//
// Orphan rows (e.g. a Wednesday gymnastics session logged to Garmin as
// Strength but with no matching Wendler workout) still contribute to the
// weekly load score and Banister daily series, but they're worth
// surfacing in Settings so the user knows the app saw them.

export interface StrengthHrLike {
  id: string;
  performedAt: string;
  durationSec: number;
  avgHrBpm?: number;
  hrZoneSeconds?: number[];
  sport?: string;
  notes?: string;
}

export interface StrengthSessionLike {
  performedAt: string;
}

function dayKey(iso: string): string {
  // First 10 chars of an ISO timestamp = YYYY-MM-DD (UTC). Strava
  // activity start times are stored as ISO with a Z suffix, and Wendler
  // sessions stamp `performedAt` server-side as ISO; treating both in
  // UTC keeps the matcher symmetric without pulling in a tz library.
  return iso.slice(0, 10);
}

/**
 * Human-friendly label for a Strava strength `sport_type`. Falls back to
 * "Strength" when the type is unknown or missing — a sensible umbrella.
 */
export function importedStrengthLabel(sport?: string | null): string {
  switch (sport) {
    case 'WeightTraining':
      return 'Weight training';
    case 'Crossfit':
      return 'CrossFit';
    case 'HighIntensityIntervalTraining':
      return 'HIIT';
    case 'Workout':
      return 'Workout';
    default:
      return 'Strength';
  }
}

/**
 * Returns the subset of `strengthHr` rows that have NO Wendler strength
 * session logged on the same calendar day. Sorted newest-first.
 */
export function orphanStrengthHr<T extends StrengthHrLike>(
  strengthHr: readonly T[],
  sessions: readonly StrengthSessionLike[],
): T[] {
  const sessionDays = new Set<string>();
  for (const s of sessions) sessionDays.add(dayKey(s.performedAt));
  const orphans = strengthHr.filter((h) => !sessionDays.has(dayKey(h.performedAt)));
  orphans.sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1));
  return orphans;
}

/**
 * Splits imported strength HR rows into:
 *   - `matchedByDay`: Map<dayKey, row> — rows that line up with a logged
 *     Wendler strength session on the same calendar day. Used to enrich
 *     the in-app strength session view with HR + duration from Strava
 *     instead of rendering a separate "Imported" line item (which would
 *     read as double-counting the same workout).
 *   - `orphans`: rows with no matching Wendler session — surface these as
 *     standalone items (e.g. Wednesday gymnastics logged to Garmin as
 *     Strength) so they aren't lost.
 *
 * When multiple HR rows hit the same day, the longest by `durationSec`
 * wins — that's the most likely candidate for the "real" strength block.
 */
export function partitionStrengthHr<T extends StrengthHrLike>(
  strengthHr: readonly T[],
  sessions: readonly StrengthSessionLike[],
): { matchedByDay: Map<string, T>; orphans: T[] } {
  const sessionDays = new Set<string>();
  for (const s of sessions) sessionDays.add(dayKey(s.performedAt));
  const matchedByDay = new Map<string, T>();
  const orphans: T[] = [];
  for (const h of strengthHr) {
    const k = dayKey(h.performedAt);
    if (!sessionDays.has(k)) {
      orphans.push(h);
      continue;
    }
    const existing = matchedByDay.get(k);
    if (!existing || (h.durationSec ?? 0) > (existing.durationSec ?? 0)) {
      matchedByDay.set(k, h);
    }
  }
  orphans.sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1));
  return { matchedByDay, orphans };
}

/** Day key (YYYY-MM-DD UTC) used by the strength HR matcher. */
export function strengthHrDayKey(iso: string): string {
  return dayKey(iso);
}
