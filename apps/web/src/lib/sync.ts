'use client';

import { getDb } from './db';
import type {
  Movement,
  ProgramBlock,
  ProgramSchedule,
  SessionRecord,
  SetRecord,
  TrainingMaxRecord,
  UserSettings,
} from '@wendler/db-schema';
import { SCHEMA_VERSION } from '@wendler/db-schema';

export type SyncKind =
  | 'set'
  | 'session'
  | 'movement'
  | 'block'
  | 'trainingMax'
  | 'settings'
  | 'schedule';

export interface OutboundDoc {
  kind: SyncKind;
  recordId: string;
  updatedAt: string;
  payload: unknown;
}

export interface IncomingDoc {
  id: string;
  userId: string;
  kind: SyncKind;
  recordId: string;
  updatedAt: string;
  serverTime: string;
  payload: unknown;
  schemaVersion: number;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'disabled' | 'unauthenticated';
  lastSyncedAt?: string;
  pushed?: number;
  pulled?: number;
  message?: string;
}

const SYNC_META_ID = 'syncMeta';
const SLACK_MS = 60_000; // re-send anything within 60s slack to avoid clock-skew drops

function isoMinus(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() - ms).toISOString();
}

async function loadMeta() {
  const db = getDb();
  let meta = await db.syncMeta.get(SYNC_META_ID);
  if (!meta) {
    meta = {
      id: SYNC_META_ID,
      lastPulledServerTime: '1970-01-01T00:00:00.000Z',
      lastPushedAt: '1970-01-01T00:00:00.000Z',
      deviceId: crypto.randomUUID(),
    };
    await db.syncMeta.put(meta);
  }
  return meta;
}

async function saveMeta(patch: Partial<{ lastPulledServerTime: string; lastPushedAt: string }>) {
  const db = getDb();
  const existing = await loadMeta();
  await db.syncMeta.put({ ...existing, ...patch });
}

/**
 * Collect all local records that have been touched since lastPushedAt.
 * Records carry one of {performedAt, completedAt, createdAt, startedAt, updatedAt} —
 * we use the most recent timestamp as the doc's updatedAt.
 */
async function collectOutbound(sinceIso: string): Promise<OutboundDoc[]> {
  const db = getDb();
  const since = sinceIso;
  const out: OutboundDoc[] = [];

  const sets = await db.sets.toArray();
  for (const s of sets) {
    const ts = s.performedAt;
    if (ts > since) out.push({ kind: 'set', recordId: s.id, updatedAt: ts, payload: s });
  }

  const sessions = await db.sessions.toArray();
  for (const s of sessions) {
    const ts = [s.completedAt, s.performedAt].filter(Boolean).sort().pop()!;
    if (ts > since) out.push({ kind: 'session', recordId: s.id, updatedAt: ts, payload: s });
  }

  const tms = await db.trainingMaxes.toArray();
  for (const t of tms) {
    if (t.createdAt > since)
      out.push({ kind: 'trainingMax', recordId: t.id, updatedAt: t.createdAt, payload: t });
  }

  const blocks = await db.blocks.toArray();
  for (const b of blocks) {
    const ts = [b.completedAt, b.startedAt, b.createdAt].filter(Boolean).sort().pop()!;
    if (ts > since) out.push({ kind: 'block', recordId: b.id, updatedAt: ts, payload: b });
  }

  // Custom movements only — built-in seeds re-seed on each install.
  const moves = await db.movements.toArray();
  for (const m of moves) {
    if (m.isCustom) {
      // Movements have no timestamp; use a stable fake "1970" so we push them once,
      // and re-push only if the user's clock advances past the last sync (always true).
      out.push({ kind: 'movement', recordId: m.id, updatedAt: since, payload: m });
    }
  }

  const settings = await db.settings.get('singleton');
  if (settings && settings.updatedAt > since) {
    out.push({
      kind: 'settings',
      recordId: 'singleton',
      updatedAt: settings.updatedAt,
      payload: settings,
    });
  }

  const schedule = await db.schedule.get('singleton');
  if (schedule && schedule.updatedAt > since) {
    out.push({
      kind: 'schedule',
      recordId: 'singleton',
      updatedAt: schedule.updatedAt,
      payload: schedule,
    });
  }

  return out;
}

/** Apply an incoming sync doc to the local Dexie store, idempotently. */
async function applyIncoming(doc: IncomingDoc) {
  const db = getDb();
  switch (doc.kind) {
    case 'set':
      await db.sets.put(doc.payload as SetRecord);
      break;
    case 'session':
      await db.sessions.put(doc.payload as SessionRecord);
      break;
    case 'trainingMax':
      await db.trainingMaxes.put(doc.payload as TrainingMaxRecord);
      break;
    case 'block':
      await db.blocks.put(doc.payload as ProgramBlock);
      break;
    case 'movement':
      await db.movements.put(doc.payload as Movement);
      break;
    case 'settings': {
      const incoming = doc.payload as UserSettings;
      const local = await db.settings.get('singleton');
      // Last-write-wins on updatedAt for the settings singleton.
      if (!local || incoming.updatedAt >= local.updatedAt) {
        await db.settings.put(incoming);
      }
      break;
    }
    case 'schedule': {
      const incoming = doc.payload as ProgramSchedule;
      const local = await db.schedule.get('singleton');
      if (!local || incoming.updatedAt >= local.updatedAt) {
        await db.schedule.put(incoming);
      }
      break;
    }
  }
}

async function pushOnce(): Promise<{ pushed: number; conflicts: number }> {
  const meta = await loadMeta();
  const since = isoMinus(meta.lastPushedAt, SLACK_MS);
  const docs = await collectOutbound(since);
  if (docs.length === 0) {
    return { pushed: 0, conflicts: 0 };
  }
  // Chunk to stay under server batch limit.
  const CHUNK = 200;
  let pushed = 0;
  let conflicts = 0;
  const startedAt = new Date().toISOString();
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    const res = await fetch('/api/sync/push', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: meta.deviceId,
        schemaVersion: SCHEMA_VERSION,
        docs: chunk,
      }),
    });
    if (!res.ok) {
      throw new Error(`push failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    const body = (await res.json()) as { accepted: number; conflicts: number };
    pushed += body.accepted;
    conflicts += body.conflicts;
  }
  await saveMeta({ lastPushedAt: startedAt });
  return { pushed, conflicts };
}

async function pullOnce(): Promise<{ pulled: number }> {
  const meta = await loadMeta();
  let cursor = meta.lastPulledServerTime;
  let pulled = 0;
  let lastServerTime = cursor;
  for (let page = 0; page < 50; page += 1) {
    const url = `/api/sync/pull?since=${encodeURIComponent(cursor)}`;
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`pull failed: ${res.status}`);
    }
    const body = (await res.json()) as {
      docs: IncomingDoc[];
      serverTime: string;
      hasMore: boolean;
      cursor: string | null;
    };
    for (const doc of body.docs) {
      await applyIncoming(doc);
      pulled += 1;
    }
    lastServerTime = body.serverTime;
    if (!body.hasMore || !body.cursor) break;
    cursor = body.cursor;
  }
  await saveMeta({ lastPulledServerTime: lastServerTime });
  return { pulled };
}

let inflight: Promise<SyncStatus> | null = null;

export async function syncNow(): Promise<SyncStatus> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const auth = await fetch('/api/me', { credentials: 'include', cache: 'no-store' });
      if (!auth.ok) {
        return { state: 'error', message: `auth check failed: ${auth.status}` } as SyncStatus;
      }
      const me = await auth.json();
      if (!me.authenticated) {
        return { state: 'unauthenticated' } as SyncStatus;
      }
      const push = await pushOnce();
      const pull = await pullOnce();
      return {
        state: 'idle',
        lastSyncedAt: new Date().toISOString(),
        pushed: push.pushed,
        pulled: pull.pulled,
      } as SyncStatus;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('503')) return { state: 'disabled', message } as SyncStatus;
      return { state: 'error', message } as SyncStatus;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
