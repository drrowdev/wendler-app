import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { getClientPrincipal } from '../auth';
import { getSyncContainer } from '../cosmos';
import {
  computeHrZoneSeconds,
  fetchActivities,
  fetchActivityDetail,
  fetchHrStream,
  getValidAuth,
  sportToModality,
  type StravaActivity,
} from '../strava';

interface ImportedCardio {
  id: string;
  externalId: string;
  performedAt: string;
  modality: ReturnType<typeof sportToModality>;
  durationSec: number;
  distanceKm?: number;
  avgHrBpm?: number;
  maxHrBpm?: number;
  elevGainM?: number;
  perceivedExertion?: number;
  sufferScore?: number;
  hrZoneSeconds?: number[];
  bestEffortsSec?: Record<number, number>;
  polyline?: string;
  sport?: string;
  notes?: string;
  source: 'strava';
  updatedAt: string;
}

/**
 * POST /api/strava/sync
 * Pulls activities since lastSyncAt (or last 30 days on first sync), enriches
 * with HR-zone breakdown and best efforts where available, and returns them
 * to the client to write to Dexie. Updates lastSyncAt server-side.
 */
export async function stravaSync(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getClientPrincipal(req);
  if (!principal) return { status: 401, jsonBody: { error: 'unauthenticated' } };

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { status: 503, jsonBody: { error: 'strava-not-configured' } };
  }

  const container = await getSyncContainer();
  if (!container) return { status: 503, jsonBody: { error: 'no-cosmos' } };

  const auth = await getValidAuth(container, principal.userId, clientId, clientSecret);
  if (!auth) return { status: 400, jsonBody: { error: 'not-connected' } };

  const sinceIso = auth.lastSyncAt ?? new Date(Date.now() - 30 * 86400000).toISOString();
  const afterEpoch = Math.floor(new Date(sinceIso).getTime() / 1000);

  let activities: StravaActivity[] = [];
  try {
    activities = await fetchActivities(auth.accessToken, afterEpoch);
  } catch (e) {
    ctx.log('strava activities fetch failed', e);
    return { status: 502, jsonBody: { error: 'strava-fetch-failed' } };
  }

  const imported: ImportedCardio[] = [];
  for (const a of activities) {
    const modality = sportToModality(a.sport_type ?? a.type);
    const cardio: ImportedCardio = {
      id: crypto.randomUUID(),
      externalId: `strava:${a.id}`,
      performedAt: a.start_date,
      modality,
      durationSec: a.moving_time ?? a.elapsed_time,
      distanceKm: a.distance ? a.distance / 1000 : undefined,
      avgHrBpm: a.average_heartrate,
      maxHrBpm: a.max_heartrate,
      elevGainM: a.total_elevation_gain,
      perceivedExertion: a.perceived_exertion,
      sufferScore: a.suffer_score,
      polyline: a.map?.summary_polyline,
      sport: a.sport_type ?? a.type,
      notes: a.name,
      source: 'strava',
      updatedAt: new Date().toISOString(),
    };

    // Enrich with HR zones from streams (only if HR data + zones known)
    if (a.has_heartrate && auth.hrZones && auth.hrZones.length === 5) {
      try {
        const stream = await fetchHrStream(auth.accessToken, a.id);
        if (stream) {
          cardio.hrZoneSeconds = computeHrZoneSeconds(
            stream.heartrate,
            stream.time,
            auth.hrZones,
          );
        }
      } catch (e) {
        ctx.log(`strava stream fetch failed for ${a.id}`, e);
      }
    }

    // For runs, fetch detail to get best_efforts (race-distance PRs)
    if (modality === 'run') {
      try {
        const detail = await fetchActivityDetail(auth.accessToken, a.id);
        if (detail.best_efforts && detail.best_efforts.length > 0) {
          const eff: Record<number, number> = {};
          for (const e of detail.best_efforts) {
            if ([1000, 1609, 5000, 10000, 21097, 42195].includes(e.distance)) {
              eff[e.distance] = e.elapsed_time;
            }
          }
          if (Object.keys(eff).length) cardio.bestEffortsSec = eff;
        }
      } catch (e) {
        ctx.log(`strava detail fetch failed for ${a.id}`, e);
      }
    }

    imported.push(cardio);
  }

  // Update lastSyncAt
  try {
    auth.lastSyncAt = new Date().toISOString();
    await container.items.upsert(auth);
  } catch (e) {
    ctx.log('strava lastSyncAt update failed', e);
  }

  return {
    status: 200,
    jsonBody: {
      imported,
      count: imported.length,
      since: sinceIso,
      lastSyncAt: auth.lastSyncAt,
    },
  };
}

app.http('stravaSync', {
  route: 'strava/sync',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: stravaSync,
});
