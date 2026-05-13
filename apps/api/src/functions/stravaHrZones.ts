import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../auth';
import { getSyncContainer } from '../cosmos';
import { fetchAthleteZones, type StravaAuthDoc } from '../strava';

interface PutBody {
  hrZones: number[];
}

/**
 * GET  /api/strava/hr-zones        — returns current zones
 * PUT  /api/strava/hr-zones        — body { hrZones: [z1Upper..z5Upper] }
 *                                    overrides zones with user-provided values
 * POST /api/strava/hr-zones/refresh — re-fetches zones from Strava (athlete/zones)
 *
 * Zones are upper-bound bpm for Z1..Z5. Z5 should be open-ended; we accept
 * any number and clamp to >= prev zone. Used by the time-in-zone calculator
 * in stravaSync; existing imports are not retroactively recomputed (the user
 * can hit "Refresh last 60 days" if they want that).
 */
export async function stravaHrZones(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user } = await verifyRequest(req);
  if (!user) return { status: 401, jsonBody: { error: 'unauthenticated' } };

  const container = await getSyncContainer();
  if (!container) return { status: 503, jsonBody: { error: 'no-cosmos' } };

  const id = `${user.userId}::stravaAuth`;
  const res = await container.item(id, user.userId).read<StravaAuthDoc>();
  if (!res.resource) return { status: 404, jsonBody: { error: 'not-connected' } };
  const doc = res.resource;

  if (req.method === 'GET') {
    return { status: 200, jsonBody: { hrZones: doc.hrZones ?? null } };
  }

  if (req.method === 'POST') {
    // Refresh from Strava
    try {
      const zones = await fetchAthleteZones(doc.accessToken);
      if (!zones || zones.length !== 5) {
        return {
          status: 502,
          jsonBody: { error: 'strava-zones-unavailable' },
        };
      }
      doc.hrZones = zones;
      await container.items.upsert(doc);
      return { status: 200, jsonBody: { hrZones: zones, source: 'strava' } };
    } catch (e) {
      ctx.log('strava zones refresh failed', e);
      return { status: 502, jsonBody: { error: 'strava-zones-fetch-failed' } };
    }
  }

  // PUT
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return { status: 400, jsonBody: { error: 'invalid-json' } };
  }
  const zones = Array.isArray(body?.hrZones) ? body.hrZones.map((n) => Number(n)) : null;
  if (!zones || zones.length !== 5 || zones.some((n) => !isFinite(n) || n <= 0)) {
    return {
      status: 400,
      jsonBody: { error: 'invalid-zones', expected: 'array of 5 positive numbers' },
    };
  }
  // Sanity: enforce non-decreasing.
  for (let i = 1; i < 5; i += 1) {
    if (zones[i]! < zones[i - 1]!) {
      return {
        status: 400,
        jsonBody: { error: 'non-monotonic', detail: 'zones must be non-decreasing' },
      };
    }
  }
  doc.hrZones = zones;
  await container.items.upsert(doc);
  return { status: 200, jsonBody: { hrZones: zones, source: 'manual' } };
}

app.http('stravaHrZones', {
  route: 'strava/hr-zones',
  methods: ['GET', 'PUT', 'POST'],
  authLevel: 'anonymous',
  handler: stravaHrZones,
});
