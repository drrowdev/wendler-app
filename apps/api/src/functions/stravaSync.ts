import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../auth';
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
 * HR-only enrichment for strength activities (Garmin → Strava). Returned
 * separately from `imported` so the client writes them to the dedicated
 * `strengthHr` table instead of polluting the cardio history.
 */
interface ImportedStrengthHr {
  id: string;
  externalId: string;
  performedAt: string;
  durationSec: number;
  avgHrBpm?: number;
  maxHrBpm?: number;
  hrZoneSeconds?: number[];
  sport?: string;
  notes?: string;
  source: 'strava';
  updatedAt: string;
}

/**
 * Strava sport_types we treat as strength training. The HR signal is
 * captured but the activity is NOT imported as cardio — the user logs
 * the strength session in-app and we attach this enrichment by date.
 */
const STRENGTH_SPORT_TYPES = new Set([
  'WeightTraining',
  'Workout',
  'Crossfit',
  'HighIntensityIntervalTraining',
]);

function isStrengthActivity(a: StravaActivity): boolean {
  return STRENGTH_SPORT_TYPES.has(a.sport_type ?? a.type);
}

/**
 * POST /api/strava/sync
 * Pulls activities since lastSyncAt (or last 60 days on first sync), enriches
 * with HR-zone breakdown and best efforts where available, and returns them
 * to the client to write to Dexie. Updates lastSyncAt server-side.
 */
export async function stravaSync(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user } = await verifyRequest(req);
  if (!user) return { status: 401, jsonBody: { error: 'unauthenticated' } };

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { status: 503, jsonBody: { error: 'strava-not-configured' } };
  }

  const container = await getSyncContainer();
  if (!container) return { status: 503, jsonBody: { error: 'no-cosmos' } };

  const auth = await getValidAuth(container, user.userId, clientId, clientSecret);
  if (!auth) return { status: 400, jsonBody: { error: 'not-connected' } };

  // First sync backfills the last 60 days so newly-connected users get a
  // couple of months of history (analytics windows like 30d/90d become
  // immediately useful). Subsequent syncs are incremental from lastSyncAt.
  // Pass ?backfillDays=N to force a full re-fetch (e.g. to refresh notes /
  // descriptions after a code change).
  const FIRST_SYNC_BACKFILL_DAYS = 60;
  const url = new URL(req.url);
  const backfillDaysParam = url.searchParams.get('backfillDays');
  const backfillDays = backfillDaysParam ? Math.max(1, Math.min(365, Number(backfillDaysParam))) : null;
  // Client toggles whether to fetch HR for strength activities. Defaults to
  // true; explicit ?includeStrengthHr=false suppresses the extra stream calls
  // when the user has disabled enrichment in Settings.
  const includeStrengthHr = url.searchParams.get('includeStrengthHr') !== 'false';
  const sinceIso = backfillDays
    ? new Date(Date.now() - backfillDays * 86400000).toISOString()
    : auth.lastSyncAt ??
      new Date(Date.now() - FIRST_SYNC_BACKFILL_DAYS * 86400000).toISOString();
  const afterEpoch = Math.floor(new Date(sinceIso).getTime() / 1000);

  let activities: StravaActivity[] = [];
  try {
    activities = await fetchActivities(auth.accessToken, afterEpoch);
  } catch (e) {
    ctx.log('strava activities fetch failed', e);
    return { status: 502, jsonBody: { error: 'strava-fetch-failed' } };
  }

  const imported: ImportedCardio[] = [];
  const strengthHr: ImportedStrengthHr[] = [];
  let skipped = 0;
  for (const a of activities) {
    // Strength activities (Garmin → Strava): pull HR-only enrichment when the
    // user has zones configured. NOT imported as cardio — the strength session
    // itself is planned + logged in-app; we just decorate it with HR.
    if (isStrengthActivity(a)) {
      if (!includeStrengthHr || !a.has_heartrate || !auth.hrZones || auth.hrZones.length !== 5) {
        skipped++;
        continue;
      }
      try {
        const stream = await fetchHrStream(auth.accessToken, a.id);
        if (!stream) {
          skipped++;
          continue;
        }
        strengthHr.push({
          id: crypto.randomUUID(),
          externalId: `strava:${a.id}`,
          performedAt: a.start_date,
          durationSec: a.moving_time ?? a.elapsed_time,
          avgHrBpm: a.average_heartrate,
          maxHrBpm: a.max_heartrate,
          hrZoneSeconds: computeHrZoneSeconds(stream.heartrate, stream.time, auth.hrZones),
          sport: a.sport_type ?? a.type,
          notes: a.name,
          source: 'strava',
          updatedAt: new Date().toISOString(),
        });
      } catch (e) {
        ctx.log(`strava strength stream fetch failed for ${a.id}`, e);
        skipped++;
      }
      continue;
    }

    const modality = sportToModality(a.sport_type ?? a.type);
    // Only import endurance activities. Anything that maps to 'other' AND
    // wasn't caught as a strength activity above (yoga, etc.) is skipped.
    if (modality === 'other') {
      skipped++;
      continue;
    }
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

    // For runs, fetch detail to get best_efforts (race-distance PRs).
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
      strengthHr,
      count: imported.length,
      strengthHrCount: strengthHr.length,
      skipped,
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
