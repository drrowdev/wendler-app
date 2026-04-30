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
 * POST /api/strava/disconnect
 * Removes the stored Strava token doc for this user. Strava-imported cardio
 * sessions are kept (they're real history); future syncs are disabled.
 */
export async function stravaDisconnect(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getClientPrincipal(req);
  if (!principal) return { status: 401, jsonBody: { error: 'unauthenticated' } };

  const container = await getSyncContainer();
  if (!container) return { status: 503, jsonBody: { error: 'no-cosmos' } };

  try {
    const id = `${principal.userId}::stravaAuth`;
    await container.item(id, principal.userId).delete<StravaAuthDoc>();
    return { status: 200, jsonBody: { ok: true } };
  } catch (e) {
    ctx.log('strava disconnect failed', e);
    return { status: 200, jsonBody: { ok: true } }; // already gone
  }
}

app.http('stravaDisconnect', {
  route: 'strava/disconnect',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: stravaDisconnect,
});
