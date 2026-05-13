import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { signState, verifyRequest } from '../auth';

/**
 * GET /api/strava/connect
 * Returns the Strava OAuth authorize URL for the current user.
 */
export async function stravaConnect(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user } = await verifyRequest(req);
  if (!user) return { status: 401, jsonBody: { error: 'unauthenticated' } };

  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectBase = process.env.STRAVA_REDIRECT_URI;
  if (!clientId || !redirectBase) {
    ctx.log('strava not configured');
    return { status: 503, jsonBody: { error: 'strava-not-configured' } };
  }

  // Signed state: callback verifies HMAC and extracts userId without a session.
  const stateB64 = signState(user.userId);

  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectBase);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope', 'read,activity:read_all,profile:read_all');
  url.searchParams.set('state', stateB64);

  return { status: 200, jsonBody: { authorizeUrl: url.toString() } };
}

app.http('stravaConnect', {
  route: 'strava/connect',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: stravaConnect,
});
