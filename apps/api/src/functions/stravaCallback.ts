import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyState } from '../auth';
import { getSyncContainer } from '../cosmos';
import {
  exchangeCode,
  fetchAthleteZones,
  type StravaAuthDoc,
} from '../strava';

/**
 * GET /api/strava/callback?code=...&state=...
 *
 * Strava redirects here without our session — we authenticate the request by
 * verifying the HMAC-signed state token (issued by /api/strava/connect).
 */
export async function stravaCallback(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const code = req.query.get('code');
  const state = req.query.get('state');
  const error = req.query.get('error');
  if (error) return redirect(`/settings?strava=error&reason=${encodeURIComponent(error)}`);
  if (!code || !state) return redirect('/settings?strava=error&reason=missing-code');

  const userId = verifyState(state);
  if (!userId) {
    return redirect('/settings?strava=error&reason=bad-state');
  }

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return redirect('/settings?strava=error&reason=not-configured');
  }

  const container = await getSyncContainer();
  if (!container) return redirect('/settings?strava=error&reason=no-cosmos');

  try {
    const tok = await exchangeCode(code, clientId, clientSecret);
    const zones = await fetchAthleteZones(tok.access_token);
    const athleteName =
      [tok.athlete?.firstname, tok.athlete?.lastname].filter(Boolean).join(' ') ||
      tok.athlete?.username ||
      `Athlete ${tok.athlete?.id ?? '?'}`;

    const doc: StravaAuthDoc = {
      id: `${userId}::stravaAuth`,
      userId,
      kind: 'stravaAuth',
      athleteId: tok.athlete?.id ?? 0,
      athleteName,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: tok.expires_at,
      scope: tok.scope ?? 'read,activity:read_all',
      hrZones: zones,
      connectedAt: new Date().toISOString(),
    };
    await container.items.upsert(doc);
    return redirect('/settings?strava=connected');
  } catch (e) {
    ctx.log('strava callback failed', e);
    return redirect('/settings?strava=error&reason=exchange-failed');
  }
}

function redirect(path: string): HttpResponseInit {
  return {
    status: 302,
    headers: { location: path },
  };
}

app.http('stravaCallback', {
  route: 'strava/callback',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: stravaCallback,
});
