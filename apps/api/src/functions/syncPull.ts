import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../auth';
import { getSyncContainer, type SyncDoc } from '../cosmos';

interface PullResult {
  docs: SyncDoc[];
  serverTime: string;
  hasMore: boolean;
  /** Continuation cursor: next call should pass since=cursor to resume. */
  cursor: string | null;
}

const PAGE_SIZE = 500;

/**
 * GET /api/sync/pull?since=<ISO> — fetch all sync docs for the current user
 * with serverTime > since, ordered ascending by serverTime.
 *
 * since=0 (or omitted) returns all docs from the beginning.
 */
export async function syncPull(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user } = await verifyRequest(req);
  if (!user) return { status: 401, jsonBody: { error: 'unauthenticated' } };

  const container = await getSyncContainer();
  if (!container) {
    return { status: 503, jsonBody: { error: 'sync-not-configured' } };
  }

  const since = req.query.get('since') ?? '1970-01-01T00:00:00.000Z';
  const userId = user.userId;

  try {
    const { resources } = await container.items
      .query<SyncDoc>(
        {
          query:
            "SELECT TOP @max c.id, c.userId, c.kind, c.recordId, c.updatedAt, c.serverTime, c.payload, c.deviceId, c.schemaVersion, c.deleted FROM c WHERE c.userId = @uid AND c.serverTime > @since AND c.kind != 'stravaAuth' ORDER BY c.serverTime ASC",
          parameters: [
            { name: '@uid', value: userId },
            { name: '@since', value: since },
            { name: '@max', value: PAGE_SIZE },
          ],
        },
        { partitionKey: userId },
      )
      .fetchAll();

    const hasMore = resources.length === PAGE_SIZE;
    const cursor = hasMore ? resources[resources.length - 1]!.serverTime : null;
    const result: PullResult = {
      docs: resources,
      serverTime: new Date().toISOString(),
      hasMore,
      cursor,
    };
    return { status: 200, jsonBody: result };
  } catch (err) {
    ctx.log('pull failed', err);
    return { status: 500, jsonBody: { error: 'cosmos-read-failed' } };
  }
}

app.http('syncPull', {
  route: 'sync/pull',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: syncPull,
});
