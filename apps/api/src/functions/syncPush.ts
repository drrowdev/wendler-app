import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { getClientPrincipal } from '../auth';
import { getSyncContainer, type SyncDoc } from '../cosmos';

interface PushBody {
  deviceId?: string;
  schemaVersion: number;
  docs: Omit<SyncDoc, 'userId' | 'serverTime' | 'id'>[];
}

interface PushResult {
  accepted: number;
  conflicts: number;
  serverTime: string;
}

/**
 * POST /api/sync/push — append a batch of mutations from the client to the user's partition.
 *
 * Append-only semantics: the same (kind, recordId, updatedAt) is idempotent — repeated
 * pushes of the same mutation are safely deduplicated by the deterministic doc id.
 * The server never overwrites existing documents.
 */
export async function syncPush(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getClientPrincipal(req);
  if (!principal) return { status: 401, jsonBody: { error: 'unauthenticated' } };

  const container = await getSyncContainer();
  if (!container) {
    return { status: 503, jsonBody: { error: 'sync-not-configured' } };
  }

  let body: PushBody;
  try {
    body = (await req.json()) as PushBody;
  } catch {
    return { status: 400, jsonBody: { error: 'invalid-json' } };
  }
  if (!body || !Array.isArray(body.docs)) {
    return { status: 400, jsonBody: { error: 'invalid-body' } };
  }
  if (body.docs.length > 500) {
    return { status: 413, jsonBody: { error: 'batch-too-large', max: 500 } };
  }

  const now = new Date().toISOString();
  const userId = principal.userId;
  let accepted = 0;
  let conflicts = 0;

  for (const incoming of body.docs) {
    const id = `${userId}::${incoming.kind}::${incoming.recordId}::${incoming.updatedAt}`;
    const doc: SyncDoc = {
      id,
      userId,
      kind: incoming.kind,
      recordId: incoming.recordId,
      updatedAt: incoming.updatedAt,
      serverTime: now,
      payload: incoming.payload,
      deviceId: body.deviceId,
      schemaVersion: body.schemaVersion ?? 1,
    };
    try {
      await container.items.create(doc, { disableAutomaticIdGeneration: true });
      accepted += 1;
    } catch (err: unknown) {
      // 409 Conflict means we've already received this exact mutation — that's fine.
      if ((err as { code?: number }).code === 409) {
        conflicts += 1;
      } else {
        ctx.log('push insert failed', err);
        return {
          status: 500,
          jsonBody: { error: 'cosmos-write-failed', accepted, conflicts },
        };
      }
    }
  }

  const result: PushResult = { accepted, conflicts, serverTime: now };
  return { status: 200, jsonBody: result };
}

app.http('syncPush', {
  route: 'sync/push',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: syncPush,
});
