import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../auth';
import { getSyncContainer } from '../cosmos';
import { fetchActivities, fetchActivityDetail, getValidAuth } from '../strava';

/**
 * GET /api/strava/inspect?count=5
 *
 * Diagnostic endpoint that returns the raw fields the Strava API actually
 * populates for the user's most recent N runs. Used to debug why the
 * run-plan matcher isn't picking up Runna workouts — the user can see at a
 * glance whether `name`, `description`, `workout_type`, `private_note` etc.
 * carry the workout intent, or whether everything is a generic "Evening Run".
 *
 * Not consumed by the regular UI flow; this is a one-off troubleshooting
 * tool. The response intentionally projects only the fields relevant to
 * matching (no GPS streams, no HR data) so it stays cheap to call.
 */
export async function stravaInspect(
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

  const url = new URL(req.url);
  const count = Math.max(1, Math.min(20, Number(url.searchParams.get('count')) || 5));

  // Pull the last 30 days, then trim to the requested count.
  const afterEpoch = Math.floor((Date.now() - 30 * 86400000) / 1000);
  let activities;
  try {
    activities = await fetchActivities(auth.accessToken, afterEpoch);
  } catch (e) {
    ctx.log('strava inspect activities fetch failed', e);
    return { status: 502, jsonBody: { error: 'strava-fetch-failed' } };
  }

  const recent = activities
    .filter((a) => /run/i.test(a.sport_type ?? a.type))
    .slice(0, count);

  const out: Record<string, unknown>[] = [];
  for (const a of recent) {
    let detail;
    try {
      detail = await fetchActivityDetail(auth.accessToken, a.id);
    } catch (e) {
      ctx.log(`strava inspect detail failed for ${a.id}`, e);
      detail = null;
    }
    out.push({
      id: a.id,
      start_date: a.start_date,
      sport_type: a.sport_type ?? a.type,
      // Fields relevant to plan matching:
      name_from_list: a.name,
      name_from_detail: detail?.name ?? null,
      description: detail?.description ?? null,
      workout_type: a.workout_type ?? null,
      workout_type_meaning: workoutTypeLabel(a.workout_type),
    });
  }

  return {
    status: 200,
    jsonBody: {
      checked: out.length,
      since: new Date(afterEpoch * 1000).toISOString(),
      activities: out,
    },
  };
}

function workoutTypeLabel(wt: number | null | undefined): string {
  switch (wt) {
    case 0:
      return 'default run';
    case 1:
      return 'race';
    case 2:
      return 'long run';
    case 3:
      return 'workout (tempo / intervals)';
    default:
      return 'unset';
  }
}

app.http('stravaInspect', {
  route: 'strava/inspect',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: stravaInspect,
});
