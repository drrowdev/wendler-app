/**
 * Strava API client + token persistence (v1.1.0).
 *
 * Stores tokens in the same Cosmos container under id `${userId}::stravaAuth`,
 * kind `stravaAuth`. syncPull excludes this kind from the pull stream so
 * tokens never leave the API.
 */

import type { Container } from '@azure/cosmos';

export interface StravaAuthDoc {
  id: string; // `${userId}::stravaAuth`
  userId: string; // partition key
  kind: 'stravaAuth';
  athleteId: number;
  athleteName: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds when accessToken expires. */
  expiresAt: number;
  scope: string;
  /** HR zone upper bounds in bpm, length 5 (Z1..Z5). */
  hrZones?: number[];
  lastSyncAt?: string; // ISO
  connectedAt: string; // ISO
}

const STRAVA_BASE = 'https://www.strava.com';

export interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { id: number; firstname?: string; lastname?: string; username?: string };
  scope?: string;
}

export interface StravaActivity {
  id: number;
  name: string;
  description?: string;
  type: string;
  sport_type?: string;
  workout_type?: number | null;
  start_date: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  total_elevation_gain?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_speed?: number;
  max_speed?: number;
  suffer_score?: number;
  perceived_exertion?: number;
  has_heartrate?: boolean;
  map?: { summary_polyline?: string };
  best_efforts?: Array<{ name: string; distance: number; elapsed_time: number }>;
}

export interface StravaStream {
  type: string;
  data: number[];
}

export interface StravaZones {
  heart_rate?: {
    custom_zones: boolean;
    zones: Array<{ min: number; max: number }>;
  };
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<StravaTokenResponse> {
  const r = await fetch(`${STRAVA_BASE}/api/v3/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!r.ok) throw new Error(`strava exchange failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as StravaTokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<StravaTokenResponse> {
  const r = await fetch(`${STRAVA_BASE}/api/v3/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!r.ok) throw new Error(`strava refresh failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as StravaTokenResponse;
}

/** Returns a valid (refreshed if needed) auth doc, persisting any refresh. */
export async function getValidAuth(
  container: Container,
  userId: string,
  clientId: string,
  clientSecret: string,
): Promise<StravaAuthDoc | null> {
  const id = `${userId}::stravaAuth`;
  let doc: StravaAuthDoc;
  try {
    const res = await container.item(id, userId).read<StravaAuthDoc>();
    if (!res.resource) return null;
    doc = res.resource;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (doc.expiresAt - 60 > now) return doc;
  // Refresh
  const fresh = await refreshAccessToken(doc.refreshToken, clientId, clientSecret);
  doc.accessToken = fresh.access_token;
  doc.refreshToken = fresh.refresh_token;
  doc.expiresAt = fresh.expires_at;
  await container.items.upsert(doc);
  return doc;
}

export async function fetchActivities(
  accessToken: string,
  afterEpoch: number,
  perPage = 50,
): Promise<StravaActivity[]> {
  const out: StravaActivity[] = [];
  let page = 1;
  for (;;) {
    const url = `${STRAVA_BASE}/api/v3/athlete/activities?after=${afterEpoch}&per_page=${perPage}&page=${page}`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`strava activities ${r.status}: ${await r.text()}`);
    const batch = (await r.json()) as StravaActivity[];
    out.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
    if (page > 5) break; // safety: 250 activities per sync
  }
  return out;
}

export async function fetchActivityDetail(
  accessToken: string,
  id: number,
): Promise<StravaActivity> {
  const r = await fetch(`${STRAVA_BASE}/api/v3/activities/${id}?include_all_efforts=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`strava detail ${r.status}: ${await r.text()}`);
  return (await r.json()) as StravaActivity;
}

export async function fetchHrStream(
  accessToken: string,
  id: number,
): Promise<{ heartrate: number[]; time: number[] } | null> {
  const r = await fetch(
    `${STRAVA_BASE}/api/v3/activities/${id}/streams?keys=heartrate,time&key_by_type=true&resolution=medium`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) return null;
  const j = (await r.json()) as Record<string, StravaStream>;
  const hr = j.heartrate?.data;
  const tm = j.time?.data;
  if (!hr || !tm) return null;
  return { heartrate: hr, time: tm };
}

export async function fetchAthleteZones(accessToken: string): Promise<number[] | undefined> {
  const r = await fetch(`${STRAVA_BASE}/api/v3/athlete/zones`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return undefined;
  const j = (await r.json()) as StravaZones;
  const zones = j.heart_rate?.zones;
  if (!zones || zones.length === 0) return undefined;
  // Strava returns 5 zones; the upper bound of the last is usually -1 (open).
  return zones.map((z) => (z.max > 0 ? z.max : 999));
}

/**
 * Compute time-in-zone seconds from an HR stream and zone upper bounds.
 * Returns array length 5 (Z1..Z5).
 */
export function computeHrZoneSeconds(
  heartrate: number[],
  time: number[],
  zoneUpperBpm: number[],
): number[] {
  const out = [0, 0, 0, 0, 0];
  if (heartrate.length === 0 || time.length === 0) return out;
  const n = Math.min(heartrate.length, time.length);
  for (let i = 0; i < n; i += 1) {
    const dt = i === 0 ? 0 : time[i]! - time[i - 1]!;
    if (dt <= 0 || dt > 30) continue; // skip pauses
    const hr = heartrate[i]!;
    let z = 0;
    for (let zi = 0; zi < 5; zi += 1) {
      if (hr <= (zoneUpperBpm[zi] ?? 999)) {
        z = zi;
        break;
      }
      z = zi;
    }
    out[z] = (out[z] ?? 0) + dt;
  }
  return out;
}

/** Map Strava sport_type to our cardio modality. */
export function sportToModality(sport: string): 'run' | 'bike' | 'swim' | 'row' | 'walk' | 'padel' | 'other' {
  if (/run/i.test(sport)) return 'run';
  if (/ride|bike|cycl/i.test(sport)) return 'bike';
  if (/swim/i.test(sport)) return 'swim';
  if (/row/i.test(sport)) return 'row';
  if (/walk|hike/i.test(sport)) return 'walk';
  if (/padel/i.test(sport)) return 'padel';
  return 'other';
}
