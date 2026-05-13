/**
 * Race-calendar helpers. Pure functions over a structural Race shape so the
 * domain package doesn't pull in db-schema (which itself depends on domain).
 *
 * See packages/db-schema/src/types.ts for the canonical Race interface.
 */

export type RaceKindLike =
  | '5k'
  | '10k'
  | 'half-marathon'
  | 'marathon'
  | 'ultra'
  | 'trail'
  | 'triathlon'
  | 'other';

export type RacePriorityLike = 'A' | 'B' | 'C';

export interface RaceLike {
  id: string;
  name: string;
  date: string;
  kind: RaceKindLike;
  priority: RacePriorityLike;
  distanceKm?: number;
  targetTimeSec?: number;
  location?: string;
  notes?: string;
  result?: {
    finishTimeSec?: number;
    placeOverall?: number;
    placeAgeGroup?: number;
    notes?: string;
    stravaActivityId?: string;
    loggedAt: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /**
   * Per-race accept/dismiss state for the proposed taper actions panel.
   * See `proposedTaperActions` in taper.ts. Optional and structural —
   * domain code only reads the shape it cares about.
   */
  taperActions?: RaceTaperActionsLike;
}

export interface RaceTaperActionsLike {
  insertedDeload?:
    | { acceptedAt: string; blockId?: string }
    | { dismissedAt: string };
  competitionPeakingActivated?:
    | { acceptedAt: string }
    | { dismissedAt: string };
}

const STANDARD_DISTANCES: Record<RaceKindLike, number | undefined> = {
  '5k': 5,
  '10k': 10,
  'half-marathon': 21.0975,
  marathon: 42.195,
  ultra: undefined,
  trail: undefined,
  triathlon: undefined,
  other: undefined,
};

/** Returns the canonical distance (km) for a standard kind, or undefined. */
export function inferDistanceKm(kind: RaceKindLike): number | undefined {
  return STANDARD_DISTANCES[kind];
}

/** Format seconds as "M:SS" (<1h) or "H:MM:SS" (>=1h). */
export function formatRaceTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Days from `from` (start of day) to `to` (start of day). Negative = past. */
function dayDelta(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86400000);
}

export interface SeasonRow<R extends RaceLike = RaceLike> {
  race: R;
  daysOut: number;
}

export interface SeasonView<R extends RaceLike = RaceLike> {
  upcoming: SeasonRow<R>[];
  past: SeasonRow<R>[];
}

/**
 * Split races into upcoming / past by date. A race remains "upcoming" until
 * the day after its date (so race day itself stays at the top of the list).
 */
export function seasonView<R extends RaceLike>(
  races: readonly R[],
  now: Date = new Date(),
): SeasonView<R> {
  const upcoming: SeasonRow<R>[] = [];
  const past: SeasonRow<R>[] = [];
  for (const race of races) {
    const t = new Date(race.date);
    if (Number.isNaN(t.getTime())) continue;
    const daysOut = dayDelta(now, t);
    if (race.completedAt || daysOut < -1) past.push({ race, daysOut });
    else upcoming.push({ race, daysOut });
  }
  upcoming.sort((a, b) => a.daysOut - b.daysOut);
  past.sort((a, b) => b.daysOut - a.daysOut);
  return { upcoming, past };
}

/** Returns a short pill label like "A · marathon" suitable for list rows. */
export function raceLabel(race: Pick<RaceLike, 'priority' | 'kind'>): string {
  const k = race.kind === 'half-marathon' ? 'half'
    : race.kind === 'marathon' ? 'marathon'
    : race.kind;
  return `${race.priority} · ${k}`;
}
