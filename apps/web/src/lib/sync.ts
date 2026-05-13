'use client';

import { authFetch, withAuth } from './auth';
import { getDb } from './db';
import type {
  AiGeneration,
  CardioSession,
  Goal,
  Movement,
  Notification,
  Program,
  ProgramBlock,
  ProgramSchedule,
  Race,
  RecoveryEntry,
  RunPlan,
  SessionRecord,
  SetRecord,
  StrengthHrEnrichment,
  TrainingMaxRecord,
  UserSettings,
  WellnessFlag,
} from '@wendler/db-schema';
import { SCHEMA_VERSION } from '@wendler/db-schema';

export type SyncKind =
  | 'set'
  | 'session'
  | 'movement'
  | 'block'
  | 'program'
  | 'trainingMax'
  | 'settings'
  | 'schedule'
  | 'goal'
  | 'cardio'
  | 'recovery'
  | 'runPlan'
  | 'race'
  | 'strengthHr'
  | 'wellness'
  | 'notification'
  | 'aiGeneration';

export interface OutboundDoc {
  kind: SyncKind;
  recordId: string;
  updatedAt: string;
  payload: unknown;
  deleted?: boolean;
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
  deleted?: boolean;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'disabled' | 'unauthenticated';
  lastSyncedAt?: string;
  // Only set when a sync cycle actually pushed or pulled at least one doc.
  // The UI pulses "Synced" off this — using lastSyncedAt would re-pulse on
  // every idle background tick (every 10s) and make the badge flicker.
  lastChangedAt?: string;
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
 * Detect a "seed-shaped" schedule singleton — a schedule with only the
 * factory-default fields set ({id, dayOrder, updatedAt}) and no user
 * configuration (dayGroups, liftsPerDay, cursor, activeBlockId, supplementalTemplate).
 * If such a row appears AND the user already has real data (programs/blocks/sessions),
 * something has wiped the singleton — refuse to push/apply it.
 */
/**
 * Pick the most-recent ISO-8601 timestamp from a variadic list of optional
 * values, falsy values dropped. Used throughout the sync engine to compose
 * a doc's `updatedAt` from the most recent of {createdAt, updatedAt,
 * performedAt, completedAt, …}. ISO-8601 UTC strings sort lexicographically,
 * which is why a string sort produces the right answer here — callers MUST
 * ensure inputs are UTC ISO strings (the convention everywhere else in the
 * app), otherwise this is unsound.
 *
 * Returns `undefined` only when every input is falsy — used in tests; runtime
 * call sites always pass at least one defined timestamp (e.g. createdAt).
 */
function latestTimestamp(...candidates: Array<string | undefined>): string | undefined {
  const defined = candidates.filter((t): t is string => !!t);
  if (defined.length === 0) return undefined;
  return defined.slice().sort()[defined.length - 1];
}

/**
 * Apply a doc to a Dexie table with a last-write-wins guard on `updatedAt`.
 *
 * Tie-breaking is uniformly "incoming wins ties" (`>=`) across every kind
 * that uses this helper. Rationale: when two devices write at the same
 * millisecond, both pull cycles converge to the same answer — whichever
 * doc arrives later wins, and both sides end up agreeing. The previous
 * mix of `>` (local-wins-ties for blocks/programs/goals/cardio/races) and
 * `>=` (incoming-wins-ties for singletons) was an unprincipled divergence
 * flagged in the v278 architecture review.
 *
 * Use this for records that are user-mutable (block, program, goal, cardio,
 * race, recovery, runPlan, strengthHr, wellness, movement). Append-only
 * records (set, session, trainingMax) don't need the guard — they're
 * effectively immutable from the sync engine's perspective and tombstones
 * already prevent resurrection.
 */
async function lwwPut<T extends { updatedAt?: string }>(
  table: { get(key: string): Promise<T | undefined>; put(record: T): Promise<unknown> },
  incoming: T,
  key: string,
): Promise<void> {
  const local = await table.get(key);
  // No local row, or no usable timestamps: always accept incoming.
  if (!local?.updatedAt || !incoming.updatedAt) {
    await table.put(incoming);
    return;
  }
  // Incoming wins ties (>=). Strict > would mean local keeps a row at
  // identical timestamps, which leaves the two sides disagreeing about
  // who "won" — undesirable for LWW convergence.
  if (incoming.updatedAt >= local.updatedAt) {
    await table.put(incoming);
  }
}

function isBareScheduleShape(s: ProgramSchedule | undefined | null): boolean {
  if (!s) return true;
  const hasUserConfig =
    (Array.isArray((s as { dayGroups?: unknown[] }).dayGroups) &&
      ((s as { dayGroups: unknown[] }).dayGroups.length > 0)) ||
    (s as { liftsPerDay?: number }).liftsPerDay != null ||
    !!(s as { cursor?: unknown }).cursor ||
    !!(s as { activeBlockId?: string }).activeBlockId ||
    !!(s as { supplementalTemplate?: string }).supplementalTemplate ||
    (s as { supplementalSetsOverride?: number }).supplementalSetsOverride != null;
  return !hasUserConfig;
}

function isBareSettingsShape(s: UserSettings | undefined | null): boolean {
  if (!s) return true;
  // The seed has small pair counts (≤ 2). The user's edited settings always
  // bumps every weight to 99 (see settings/page.tsx onSave). So if EVERY pair
  // is ≤ 5, this is the seed default.
  const pairs = (s as { pairsByWeight?: Record<string, number> }).pairsByWeight ?? {};
  const vals = Object.values(pairs);
  if (vals.length === 0) return true;
  return vals.every((v) => typeof v === 'number' && v <= 5);
}

async function userHasRealData(db: ReturnType<typeof getDb>): Promise<boolean> {
  const [p, b, s, t] = await Promise.all([
    db.programs.count(),
    db.blocks.count(),
    db.sessions.count(),
    db.trainingMaxes.count(),
  ]);
  return p + b + s + t > 0;
}

async function isSafeSingletonPush(
  kind: 'schedule' | 'settings',
  payload: ProgramSchedule | UserSettings,
  db: ReturnType<typeof getDb>,
): Promise<boolean> {
  const isBare =
    kind === 'schedule'
      ? isBareScheduleShape(payload as ProgramSchedule)
      : isBareSettingsShape(payload as UserSettings);
  if (!isBare) return true;
  // Bare-shaped singletons are only safe to push if (a) there's no real local
  // data AND (b) we've already pulled at least once from the server. Pulling
  // first guarantees we know the server doesn't have a richer version that
  // we'd be about to clobber. Without (b), a fresh PWA install would push the
  // freshly-seeded defaults to the server before its first pull and overwrite
  // the user's real data on every other device. See incident 2026-05-04.
  const hasReal = await userHasRealData(db);
  if (hasReal) {
    console.warn(
      `[sync] Refusing to push bare-shaped ${kind} singleton — user has real data`,
      { payload },
    );
    return false;
  }
  const meta = await db.syncMeta.get('syncMeta');
  const neverPulled =
    !meta?.lastPulledServerTime ||
    meta.lastPulledServerTime === '1970-01-01T00:00:00.000Z';
  if (neverPulled) {
    console.warn(
      `[sync] Refusing to push bare-shaped ${kind} singleton — no pull yet (would clobber server)`,
      { payload },
    );
    return false;
  }
  return true;
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
    // workoutCompletedAt is the timestamp stamped when "Complete workout" is
    // tapped on /day. It must be part of the doc updatedAt — otherwise the
    // session row never re-pushes after the user marks the workout complete,
    // and other devices keep showing the day as "in progress" while analytics
    // (which keys off completedAt set during set-logging) still ticks up. See
    // discrepancy reported 2026-05-03.
    const ts = latestTimestamp(s.workoutCompletedAt, s.completedAt, s.performedAt)!;
    if (ts > since) out.push({ kind: 'session', recordId: s.id, updatedAt: ts, payload: s });
  }

  const tms = await db.trainingMaxes.toArray();
  for (const t of tms) {
    if (t.createdAt > since)
      out.push({ kind: 'trainingMax', recordId: t.id, updatedAt: t.createdAt, payload: t });
  }

  const blocks = await db.blocks.toArray();
  for (const b of blocks) {
    const ts = latestTimestamp(b.updatedAt, b.completedAt, b.startedAt, b.createdAt)!;
    if (ts > since) out.push({ kind: 'block', recordId: b.id, updatedAt: ts, payload: b });
  }

  const programs = await db.programs.toArray();
  for (const p of programs) {
    const ts = latestTimestamp(p.updatedAt, p.completedAt, p.createdAt)!;
    if (ts > since) out.push({ kind: 'program', recordId: p.id, updatedAt: ts, payload: p });
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
    if (await isSafeSingletonPush('settings', settings, db)) {
      out.push({
        kind: 'settings',
        recordId: 'singleton',
        updatedAt: settings.updatedAt,
        payload: settings,
      });
    }
  }

  const schedule = await db.schedule.get('singleton');
  if (schedule && schedule.updatedAt > since) {
    if (await isSafeSingletonPush('schedule', schedule, db)) {
      out.push({
        kind: 'schedule',
        recordId: 'singleton',
        updatedAt: schedule.updatedAt,
        payload: schedule,
      });
    }
  }

  const goals = await db.goals.toArray();
  for (const g of goals) {
    const ts = latestTimestamp(g.completedAt, g.updatedAt, g.createdAt)!;
    if (ts > since) out.push({ kind: 'goal', recordId: g.id, updatedAt: ts, payload: g });
  }

  const cardio = await db.cardio.toArray();
  for (const c of cardio) {
    const ts = latestTimestamp(c.updatedAt, c.performedAt)!;
    if (ts > since) out.push({ kind: 'cardio', recordId: c.id, updatedAt: ts, payload: c });
  }

  const recovery = await db.recovery.toArray();
  for (const r of recovery) {
    if (r.updatedAt > since)
      out.push({ kind: 'recovery', recordId: r.id, updatedAt: r.updatedAt, payload: r });
  }

  // RunPlan singleton: only one row, plain LWW on updatedAt — no bare-shape
  // hardening needed because the seedless lazy-create means there's no risk
  // of a "factory defaults" overwrite scenario like settings/schedule had.
  const runPlan = await db.runPlan.get('singleton');
  if (runPlan && runPlan.updatedAt > since) {
    out.push({
      kind: 'runPlan',
      recordId: 'singleton',
      updatedAt: runPlan.updatedAt,
      payload: runPlan,
    });
  }

  const races = await db.races.toArray();
  for (const r of races) {
    const ts = latestTimestamp(r.completedAt, r.updatedAt, r.createdAt)!;
    if (ts > since) out.push({ kind: 'race', recordId: r.id, updatedAt: ts, payload: r });
  }

  // Strength HR enrichments — Strava-imported HR overlays for in-app strength
  // sessions. Cloud-synced (LWW on updatedAt) so a Strava sync run on one
  // device propagates to others; otherwise the mobile PWA would never see
  // imports that the desktop pulled. Each row's externalId still de-dupes
  // re-imports of the same Strava activity within a single device.
  const strengthHr = await db.strengthHr.toArray();
  for (const h of strengthHr) {
    const ts = latestTimestamp(h.updatedAt, h.performedAt)!;
    if (ts > since)
      out.push({ kind: 'strengthHr', recordId: h.id, updatedAt: ts, payload: h });
  }

  // Wellness flags — illness episodes. LWW on updatedAt; field-level merges
  // aren't needed because the row is small and edits are user-driven (mark
  // recovered, dismiss recommendation).
  const wellness = await db.wellness.toArray();
  for (const w of wellness) {
    const ts = latestTimestamp(w.updatedAt, w.recoveredAt, w.startedAt, w.createdAt)!;
    if (ts > since) {
      out.push({ kind: 'wellness', recordId: w.id, updatedAt: ts, payload: w });
    }
  }

  // Notifications (v14) — unified inbox events. LWW on updatedAt; the row is
  // small and state changes are user-driven (mark read, dismiss).
  const notifications = await db.notifications.toArray();
  for (const n of notifications) {
    const ts = latestTimestamp(n.updatedAt, n.createdAt)!;
    if (ts > since) {
      out.push({ kind: 'notification', recordId: n.id, updatedAt: ts, payload: n });
    }
  }

  // AI generations (v15) — append-mostly log of every suggester invocation.
  // LWW on updatedAt; row state transitions when outcome moves applied→undone
  // or when the user adds an annotation. Rows can be large (5-15KB each for
  // the system prompt) but volume is bounded (~50/month for active use).
  const aiGenerations = await db.aiGenerations.toArray();
  for (const g of aiGenerations) {
    const ts = latestTimestamp(g.updatedAt, g.outcomeAt, g.createdAt)!;
    if (ts > since) {
      out.push({ kind: 'aiGeneration', recordId: g.id, updatedAt: ts, payload: g });
    }
  }

  // Tombstones — propagate deletes. Push every tombstone touched since lastPushedAt.
  const tombstones = await db.tombstones.toArray();
  for (const t of tombstones) {
    if (t.deletedAt > since) {
      out.push({
        kind: t.kind as SyncKind,
        recordId: t.recordId,
        updatedAt: t.deletedAt,
        payload: null,
        deleted: true,
      });
    }
  }

  return out;
}

/** Apply an incoming sync doc to the local Dexie store, idempotently. */
async function applyIncoming(doc: IncomingDoc) {
  const db = getDb();
  if (doc.deleted) {
    // Server says this record was deleted on another device — remove locally.
    // Also persist a local tombstone so any older `put` we receive in the same
    // pull batch (or in a future fresh-install pull) can't resurrect the row.
    // The local tombstone id is `${kind}:${recordId}` — same shape used by
    // deleteWithTombstones — so we won't ever push it again (unchanged
    // deletedAt < lastPushedAt).
    switch (doc.kind) {
      case 'set': await db.sets.delete(doc.recordId); break;
      case 'session': await db.sessions.delete(doc.recordId); break;
      case 'block': await db.blocks.delete(doc.recordId); break;
      case 'program': await db.programs.delete(doc.recordId); break;
      case 'trainingMax': await db.trainingMaxes.delete(doc.recordId); break;
      case 'movement': await db.movements.delete(doc.recordId); break;
      case 'goal': await db.goals.delete(doc.recordId); break;
      case 'cardio': await db.cardio.delete(doc.recordId); break;
      case 'recovery': await db.recovery.delete(doc.recordId); break;
      case 'race': await db.races.delete(doc.recordId); break;
      case 'strengthHr': await db.strengthHr.delete(doc.recordId); break;
      case 'wellness': await db.wellness.delete(doc.recordId); break;
      case 'notification': await db.notifications.delete(doc.recordId); break;
      case 'aiGeneration': await db.aiGenerations.delete(doc.recordId); break;
      // settings/schedule are singletons — never deleted.
    }
    if (
      doc.kind !== 'settings' &&
      doc.kind !== 'schedule'
    ) {
      const id = `${doc.kind}:${doc.recordId}`;
      const existing = await db.tombstones.get(id);
      if (!existing || existing.deletedAt < doc.updatedAt) {
        await db.tombstones.put({
          id,
          kind: doc.kind,
          recordId: doc.recordId,
          deletedAt: doc.updatedAt,
        });
      }
    }
    return;
  }
  // Tombstone guard: if we have a local tombstone for this record that is at
  // least as new as the incoming doc, skip the put. This prevents an old
  // server-side put from resurrecting a record the user has since deleted.
  // Particularly useful because the server is append-only and never compacts.
  if (
    doc.kind === 'set' || doc.kind === 'session' || doc.kind === 'block' ||
    doc.kind === 'program' || doc.kind === 'trainingMax' || doc.kind === 'movement' ||
    doc.kind === 'goal' || doc.kind === 'cardio' || doc.kind === 'recovery' ||
    doc.kind === 'race' || doc.kind === 'strengthHr' || doc.kind === 'wellness'
  ) {
    const tomb = await db.tombstones.get(`${doc.kind}:${doc.recordId}`);
    if (tomb && tomb.deletedAt >= doc.updatedAt) {
      return;
    }
  }
  switch (doc.kind) {
    case 'set':
      // Append-only — sets are never edited after creation. No LWW guard
      // needed; tombstones prevent resurrection if the user deletes a set.
      await db.sets.put(doc.payload as SetRecord);
      break;
    case 'session':
      // Append-only at sync level — session-level edits (workoutCompletedAt,
      // notes) all advance the composite `updatedAt` in collectOutbound, so
      // each push carries the latest version. Blind put is safe because the
      // tombstone guard above already prevents deleted-row resurrection.
      await db.sessions.put(doc.payload as SessionRecord);
      break;
    case 'trainingMax':
      // Append-only — a new TM row is written each time the user updates;
      // older rows are historical and never overwritten. Blind put.
      await db.trainingMaxes.put(doc.payload as TrainingMaxRecord);
      break;
    case 'block': {
      // LWW guard via the shared helper. Without this, the user's own
      // recently-pushed block can be echoed back via pull and clobber a
      // fresher local mutation — e.g. deleting assistance entries from
      // block.plan, then a sync cycle resurrects the older plan because
      // pull runs before push and the echo arrives with stale
      // block.updatedAt. See incident 2026-05-11.
      const incoming = doc.payload as ProgramBlock;
      await lwwPut(db.blocks, incoming, incoming.id);
      break;
    }
    case 'program': {
      const incoming = doc.payload as Program;
      await lwwPut(db.programs, incoming, incoming.id);
      break;
    }
    case 'movement':
      // Movements have no `updatedAt` field (see types.ts:Movement) — they
      // use a fake timestamp in `collectOutbound` purely to satisfy the
      // OutboundDoc shape. Without a real timestamp there's nothing to
      // LWW against. Blind put is acceptable because: (a) movement edits
      // are rare in practice, (b) seed movements re-write at install
      // time and (c) the tombstone guard above already prevents
      // resurrection of deleted entries. If we ever need versioned
      // movement edits, add `updatedAt` to the schema first.
      await db.movements.put(doc.payload as Movement);
      break;
    case 'settings': {
      const incoming = doc.payload as UserSettings;
      const local = await db.settings.get('singleton');
      // Belt-and-suspenders: never let an incoming bare-shaped settings clobber
      // a richer local one, even if its updatedAt is newer. A bare push is
      // almost always the data-wipe bug recurring from another device.
      if (local && !isBareSettingsShape(local) && isBareSettingsShape(incoming)) {
        console.warn('[sync] Refusing to apply bare settings over rich local', {
          incomingUpdatedAt: incoming.updatedAt,
          localUpdatedAt: local.updatedAt,
        });
        break;
      }
      // Symmetric rule: ALWAYS prefer rich-shaped server payload over a local
      // bare-shaped row, regardless of timestamp. This handles the iOS
      // "Add to Home Screen" fresh-install case where seedIfEmpty writes a
      // bare singleton with `now`, then the pull arrives with the user's real
      // settings at an older timestamp — without this rule, LWW would discard
      // the real payload and leave the user with factory defaults.
      if (local && isBareSettingsShape(local) && !isBareSettingsShape(incoming)) {
        await db.settings.put(incoming);
        break;
      }
      // Last-write-wins on updatedAt for the settings singleton.
      await lwwPut(db.settings, incoming, 'singleton');
      break;
    }
    case 'schedule': {
      const incoming = doc.payload as ProgramSchedule;
      const local = await db.schedule.get('singleton');
      if (local && !isBareScheduleShape(local) && isBareScheduleShape(incoming)) {
        console.warn('[sync] Refusing to apply bare schedule over rich local', {
          incomingUpdatedAt: incoming.updatedAt,
          localUpdatedAt: local.updatedAt,
        });
        break;
      }
      if (local && isBareScheduleShape(local) && !isBareScheduleShape(incoming)) {
        await db.schedule.put(incoming);
        break;
      }
      await lwwPut(db.schedule, incoming, 'singleton');
      break;
    }
    case 'goal': {
      const incoming = doc.payload as Goal;
      await lwwPut(db.goals, incoming, incoming.id);
      break;
    }
    case 'cardio': {
      const incoming = doc.payload as CardioSession;
      await lwwPut(db.cardio, incoming, incoming.id);
      break;
    }
    case 'recovery': {
      const incoming = doc.payload as RecoveryEntry;
      // Recovery is idempotent per-day — last write wins.
      await lwwPut(db.recovery, incoming, incoming.id);
      break;
    }
    case 'runPlan': {
      const incoming = doc.payload as RunPlan;
      await lwwPut(db.runPlan, incoming, 'singleton');
      break;
    }
    case 'race': {
      const incoming = doc.payload as Race;
      await lwwPut(db.races, incoming, incoming.id);
      break;
    }
    case 'strengthHr': {
      const incoming = doc.payload as StrengthHrEnrichment;
      await lwwPut(db.strengthHr, incoming, incoming.id);
      break;
    }
    case 'wellness': {
      const incoming = doc.payload as WellnessFlag;
      await lwwPut(db.wellness, incoming, incoming.id);
      break;
    }
    case 'notification': {
      const incoming = doc.payload as Notification;
      await lwwPut(db.notifications, incoming, incoming.id);
      break;
    }
    case 'aiGeneration': {
      const incoming = doc.payload as AiGeneration;
      await lwwPut(db.aiGenerations, incoming, incoming.id);
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
    const res = await fetch('/api/sync/push', await withAuth({
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: meta.deviceId,
        schemaVersion: SCHEMA_VERSION,
        docs: chunk.map((d) => ({
          kind: d.kind,
          recordId: d.recordId,
          updatedAt: d.updatedAt,
          payload: d.payload,
          ...(d.deleted ? { deleted: true } : {}),
        })),
      }),
    }));
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
    const res = await authFetch(url, { credentials: 'include', cache: 'no-store' });
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
let lastStatus: SyncStatus = { state: 'idle' };
const listeners = new Set<(s: SyncStatus) => void>();
let kickTimer: ReturnType<typeof setTimeout> | null = null;

/** Subscribe to sync status changes. Returns an unsubscribe function. */
export function subscribeSyncStatus(fn: (s: SyncStatus) => void): () => void {
  listeners.add(fn);
  fn(lastStatus);
  return () => listeners.delete(fn);
}

function emit(s: SyncStatus) {
  lastStatus = s;
  for (const fn of listeners) fn(s);
}

/**
 * Trigger a sync soon. Debounced ~400ms so a burst of mutations only kicks one cycle.
 * Use this from any code that mutates Dexie and wants the change pushed immediately.
 */
export function kickSync(): void {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void syncNow();
  }, 400);
}

export async function syncNow(): Promise<SyncStatus> {
  if (inflight) return inflight;
  emit({ state: 'syncing' });
  inflight = (async () => {
    try {
      const auth = await authFetch('/api/me', { credentials: 'include', cache: 'no-store' });
      if (!auth.ok) {
        const s: SyncStatus = { state: 'error', message: `auth check failed: ${auth.status}` };
        emit(s);
        return s;
      }
      const me = await auth.json();
      if (!me.authenticated) {
        const s: SyncStatus = { state: 'unauthenticated' };
        emit(s);
        return s;
      }
      // Order matters: on a fresh install (lastPulledServerTime at epoch)
      // we MUST pull before push. Otherwise the just-seeded bare schedule/
      // settings singletons get pushed to the server with `now` timestamps,
      // clobbering the rich versions there and propagating defaults to every
      // other device. Pull-first is also strictly better in the steady
      // state — local LWW guards already protect us from accepting stale
      // pulls. See incident 2026-05-04 (iOS PWA wiper).
      const pull = await pullOnce();
      const push = await pushOnce();
      const now = new Date().toISOString();
      const moved = push.pushed > 0 || pull.pulled > 0;
      // Note: `push.conflicts` is NOT cross-device write contention. It
      // counts 409 responses from container.items.create, where the doc id
      // is `userId::kind::recordId::updatedAt` — a deterministic dedupe key.
      // Combined with the 60s SLACK_MS rebroadcast and the 10s background
      // sync cadence, every push that catches the previous push's slack
      // window will report a "conflict" for every record touched in that
      // window. It's a benign idempotent-resend confirmation, not a problem.
      // No notification fires here — v297 mis-emitted on this signal and
      // v298 retired the emitter (see SyncConflictFloodCleanup).
      const s: SyncStatus = {
        state: 'idle',
        lastSyncedAt: now,
        // Carry the previous lastChangedAt forward so an idle tick doesn't
        // wipe a still-fresh "Synced" pulse from a recent real sync.
        lastChangedAt: moved ? now : lastStatus.lastChangedAt,
        pushed: push.pushed,
        pulled: pull.pulled,
      };
      emit(s);
      return s;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const s: SyncStatus = message.includes('503')
        ? { state: 'disabled', message }
        : { state: 'error', message };
      emit(s);
      return s;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Start a background loop that periodically syncs while the page is visible
 * and on focus / network reconnect. Idempotent — subsequent calls are no-ops.
 */
let backgroundStarted = false;
export function startBackgroundSync(intervalMs = 10_000): () => void {
  if (typeof window === 'undefined') return () => {};
  if (backgroundStarted) return () => {};
  backgroundStarted = true;
  const tick = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      void syncNow();
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void syncNow();
  };
  const onOnline = () => void syncNow();
  const interval = setInterval(tick, intervalMs);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onOnline);
  return () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', onOnline);
    backgroundStarted = false;
  };
}
