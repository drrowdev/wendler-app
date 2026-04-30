import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { getClientPrincipal } from '../auth';
import { getSyncContainer } from '../cosmos';
import type { StravaAuthDoc } from '../strava';

/**
 * GET /api/strava/status
 * Returns whether Strava is connected for this user, athlete name, hrZones, lastSync.
 */
export async function stravaStatus(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getClientPrincipal(req);
  if (!principal) return { status: 401, jsonBody: { error: 'unauthenticated' } };

  const configured = !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);
  if (!configured) {
    return { status: 200, jsonBody: { configured: false, connected: false } };
  }

  const container = await getSyncContainer();
  if (!container) return { status: 503, jsonBody: { error: 'no-cosmos' } };

  try {
    const id = `${principal.userId}::stravaAuth`;
    const res = await container.item(id, principal.userId).read<StravaAuthDoc>();
    if (!res.resource) {
      return { status: 200, jsonBody: { configured: true, connected: false } };
    }
    return {
      status: 200,
      jsonBody: {
        configured: true,
        connected: true,
        athleteId: res.resource.athleteId,
        athleteName: res.resource.athleteName,
        hrZones: res.resource.hrZones ?? null,
        lastSyncAt: res.resource.lastSyncAt ?? null,
        connectedAt: res.resource.connectedAt,
      },
    };
  } catch (e) {
    ctx.log('strava status read failed', e);
    return { status: 200, jsonBody: { configured: true, connected: false } };
  }
}

app.http('stravaStatus', {
  route: 'strava/status',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: stravaStatus,
});
