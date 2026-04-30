/**
 * Pace PR detection (v1.1.0).
 *
 * Mirrors `pr-detection.ts` for cardio: given a list of cardio sessions with
 * Strava best_efforts records, find the all-time best for each common race
 * distance and surface improvements.
 */

export interface PaceCardio {
  id: string;
  performedAt: string;
  modality: string;
  /** distance metres → time seconds */
  bestEffortsSec?: Record<number, number>;
}

export interface PaceRecord {
  /** distance in metres */
  distanceM: number;
  /** time in seconds */
  timeSec: number;
  /** ISO timestamp of the activity */
  performedAt: string;
  /** activity id */
  cardioId: string;
}

/** Common race distances (m). */
export const RACE_DISTANCES_M = [1000, 1609, 5000, 10000, 21097, 42195];

export function pacePRs(cardios: PaceCardio[]): PaceRecord[] {
  const best = new Map<number, PaceRecord>();
  for (const c of cardios) {
    if (!c.bestEffortsSec) continue;
    for (const dStr of Object.keys(c.bestEffortsSec)) {
      const d = Number(dStr);
      const t = c.bestEffortsSec[d];
      if (!Number.isFinite(t) || t === undefined || t <= 0) continue;
      const cur = best.get(d);
      if (!cur || t < cur.timeSec) {
        best.set(d, { distanceM: d, timeSec: t, performedAt: c.performedAt, cardioId: c.id });
      }
    }
  }
  return Array.from(best.values()).sort((a, b) => a.distanceM - b.distanceM);
}

/** Format seconds as mm:ss or h:mm:ss. */
export function formatPaceTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format a race distance label. */
export function formatDistance(m: number): string {
  if (m === 1609) return '1 mi';
  if (m === 21097) return 'Half';
  if (m === 42195) return 'Marathon';
  if (m >= 1000) return `${(m / 1000).toFixed(0)} km`;
  return `${m} m`;
}
