'use client';

import Dexie, { type Table } from 'dexie';
import {
  SCHEMA_VERSION,
  SEED_MOVEMENTS,
  type AiGeneration,
  type CardioSession,
  type Chat,
  type Goal,
  type Movement,
  type Notification,
  type Program,
  type ProgramBlock,
  type ProgramSchedule,
  type PushSubscriptionRecord,
  type Race,
  type RecoveryEntry,
  type RunPlan,
  type SessionRecord,
  type SetRecord,
  type StrengthHrEnrichment,
  type Tombstone,
  type TrainingMaxRecord,
  type Injury,
  type UserProfile,
  type UserSettings,
  type WellnessFlag,
} from '@wendler/db-schema';
import { DEFAULT_DAY_ORDER } from '@wendler/domain';

/**
 * Singleton key/value rows persisted in Dexie for the sync engine.
 * Currently used keys: 'syncMeta' -> { lastPulledServerTime, lastPushedAt, deviceId }.
 */
export interface SyncMetaRecord {
  id: 'syncMeta';
  lastPulledServerTime: string; // ISO of last server cursor we pulled to
  lastPushedAt: string;         // ISO clock at last successful push
  deviceId: string;             // random per-install id
}

class WendlerDb extends Dexie {
  movements!: Table<Movement, string>;
  trainingMaxes!: Table<TrainingMaxRecord, string>;
  settings!: Table<UserSettings, 'singleton'>;
  sets!: Table<SetRecord, string>;
  sessions!: Table<SessionRecord, string>;
  blocks!: Table<ProgramBlock, string>;
  programs!: Table<Program, string>;
  schedule!: Table<ProgramSchedule, 'singleton'>;
  syncMeta!: Table<SyncMetaRecord, 'syncMeta'>;
  goals!: Table<Goal, string>;
  cardio!: Table<CardioSession, string>;
  recovery!: Table<RecoveryEntry, string>;
  pushSub!: Table<PushSubscriptionRecord, 'pushSub'>;
  tombstones!: Table<Tombstone, string>;
  runPlan!: Table<RunPlan, 'singleton'>;
  strengthHr!: Table<StrengthHrEnrichment, string>;
  races!: Table<Race, string>;
  wellness!: Table<WellnessFlag, string>;
  notifications!: Table<Notification, string>;
  aiGenerations!: Table<AiGeneration, string>;
  chats!: Table<Chat, string>;
  userProfile!: Table<UserProfile, 'singleton'>;
  injuries!: Table<Injury, string>;

  constructor() {
    super('wendler-app');
    // v1 schema (v0.1.0)
    this.version(1).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week',
    });
    // v2 schema (v0.2.0): add blocks, schedule; index blockId on sessions.
    this.version(2).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt',
      schedule: 'id',
    });
    // v3 schema (v0.5.0): add syncMeta singleton table for cloud sync cursors.
    this.version(3).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt',
      schedule: 'id',
      syncMeta: 'id',
    });
    // v4 schema (v0.6.0): goals, cardio sessions, daily recovery, push subscription.
    this.version(4).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality',
      recovery: 'id',
      pushSub: 'id',
    });
    // v5 schema (v1.1.0): index Strava externalId on cardio for de-dup.
    this.version(5).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
    });
    // v6 schema (v1.2.0): add programs table; index programId on blocks for sequence views.
    this.version(6).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
    });
    // v7 schema (v1.3.0): tombstones table for delete propagation across devices.
    this.version(7).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
    });
    // v8 schema: stamp updatedAt on every existing block + program so prior
    // local edits to plan/assistance (which previously had no timestamp the
    // sync engine could see) get re-pushed exactly once on next sync. Pure
    // data migration — no index changes.
    this.version(8).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
    }).upgrade(async (tx) => {
      const now = new Date().toISOString();
      await tx.table('blocks').toCollection().modify((b) => {
        b.updatedAt = now;
      });
      await tx.table('programs').toCollection().modify((p) => {
        p.updatedAt = now;
      });
    });
    // v9 schema: pure data migration. Reset syncMeta.lastPushedAt to epoch so
    // the next sync re-pushes every locally-touched record exactly once. This
    // recovers state that the v8-and-earlier sync engine silently dropped —
    // most notably session.workoutCompletedAt edits, which never bumped the
    // session's outbound timestamp and therefore never reached other devices.
    // No index changes.
    this.version(9)
      .stores({
        movements: 'id, name, equipment, pattern, isMainLift, isCustom',
        trainingMaxes: 'id, lift, createdAt',
        settings: 'id',
        sets: 'id, movementId, sessionId, performedAt, kind',
        sessions: 'id, performedAt, mainLift, week, blockId',
        blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
        programs: 'id, createdAt, completedAt',
        schedule: 'id',
        syncMeta: 'id',
        goals: 'id, kind, deadline, createdAt, completedAt',
        cardio: 'id, performedAt, modality, externalId',
        recovery: 'id',
        pushSub: 'id',
        tombstones: 'id, kind, recordId, deletedAt',
      })
      .upgrade(async (tx) => {
        await tx.table('syncMeta').toCollection().modify((m) => {
          m.lastPushedAt = '1970-01-01T00:00:00.000Z';
        });
      });
    // v10 schema: add `runPlan` singleton — the recurring weekly cardio
    // template (e.g. Mon=easy, Wed=tempo, Sat=long). No data migration; the
    // singleton is created lazily the first time the user opens the editor.
    this.version(10).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
      runPlan: 'id',
    });
    // v11 schema: add `strengthHr` table for Strava-imported HR enrichment
    // attached to in-app strength sessions. Cloud-synced as of v1.x —
    // see sync.ts. Indexed by performedAt for date-based matching to
    // strength sessions, externalId for per-device de-dup of re-imports.
    this.version(11).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
      runPlan: 'id',
      strengthHr: 'id, performedAt, externalId',
    });
    // v12 schema: add `races` table for the race calendar. A Race is a
    // scheduled event with a priority (A/B/C) that drives taper logic; see
    // packages/domain/src/taper.ts.
    this.version(12).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
      runPlan: 'id',
      strengthHr: 'id, performedAt, externalId',
      races: 'id, date, priority, completedAt, createdAt',
    });
    // v13 schema: add `wellness` table for illness episodes. The "Welcome
    // back" recommender (packages/domain/src/return-plan.ts) keys off these
    // rows on the first /day open after `recoveredAt` is set. Purely
    // additive — existing installs migrate without data touch.
    this.version(13).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
      runPlan: 'id',
      strengthHr: 'id, performedAt, externalId',
      races: 'id, date, priority, completedAt, createdAt',
      wellness: 'id, kind, startedAt, recoveredAt, updatedAt',
    });
    // v14 schema: add `notifications` table. Unified inbox for everything
    // the app surfaces (auto-derived phase shifts, AI applied events, sync
    // conflicts, migrations, auth recovery). Synced across devices via the
    // existing LWW pipeline; persistent by default. See
    // packages/db-schema/src/types.ts for the Notification interface and
    // apps/web/src/lib/notify.ts for the imperative API. Purely additive —
    // existing installs migrate without data touch.
    this.version(14).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
      runPlan: 'id',
      strengthHr: 'id, performedAt, externalId',
      races: 'id, date, priority, completedAt, createdAt',
      wellness: 'id, kind, startedAt, recoveredAt, updatedAt',
      notifications: 'id, createdAt, channel, severity, readAt, updatedAt',
    });
    // v15 schema: add `aiGenerations` table. Persistent log of every AI
    // suggester invocation: prompts, response, outcome, diagnostics. Drives
    // the prompt-history page and the "Copy as AI prompt" export. Indexes
    // on blockId + createdAt for per-block listings, on outcome for
    // filtering (applied vs undone vs error). Synced via LWW pipeline.
    this.version(15).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
      runPlan: 'id',
      strengthHr: 'id, performedAt, externalId',
      races: 'id, date, priority, completedAt, createdAt',
      wellness: 'id, kind, startedAt, recoveredAt, updatedAt',
      notifications: 'id, createdAt, channel, severity, readAt, updatedAt',
      aiGenerations: 'id, createdAt, blockId, weekScope, outcome, source, updatedAt',
    });
    // v16 schema: add `chats` table. User-AI chat conversations grounded
    // in the training-data snapshot built by buildChatContext. Indexes on
    // createdAt + updatedAt for the conversation list. Synced via LWW.
    this.version(16).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
      runPlan: 'id',
      strengthHr: 'id, performedAt, externalId',
      races: 'id, date, priority, completedAt, createdAt',
      wellness: 'id, kind, startedAt, recoveredAt, updatedAt',
      notifications: 'id, createdAt, channel, severity, readAt, updatedAt',
      aiGenerations: 'id, createdAt, blockId, weekScope, outcome, source, updatedAt',
      chats: 'id, createdAt, updatedAt',
    });
    // v17 schema: add `userProfile` singleton table. Demographics
    // (dateOfBirth, sex, heightCm) + training background. Feeds Coach +
    // Programmer + Periodizer + Summarizer agent prompts as dynamic context.
    // All fields optional. Synced via LWW.
    this.version(17).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
      runPlan: 'id',
      strengthHr: 'id, performedAt, externalId',
      races: 'id, date, priority, completedAt, createdAt',
      wellness: 'id, kind, startedAt, recoveredAt, updatedAt',
      notifications: 'id, createdAt, channel, severity, readAt, updatedAt',
      aiGenerations: 'id, createdAt, blockId, weekScope, outcome, source, updatedAt',
      chats: 'id, createdAt, updatedAt',
      userProfile: 'id',
    });
    // v18 schema: add `injuries` table. Tracks active + resolved
    // movement-limitation episodes; each row carries proposed/accepted/
    // declined per-movement adjustments produced by the Coach agent.
    // Indexed on resolvedAt so the active-limitations banner query is
    // O(active) rather than O(all). Synced via LWW.
    this.version(SCHEMA_VERSION).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week, blockId',
      blocks: 'id, kind, startedAt, completedAt, createdAt, programId',
      programs: 'id, createdAt, completedAt',
      schedule: 'id',
      syncMeta: 'id',
      goals: 'id, kind, deadline, createdAt, completedAt',
      cardio: 'id, performedAt, modality, externalId',
      recovery: 'id',
      pushSub: 'id',
      tombstones: 'id, kind, recordId, deletedAt',
      runPlan: 'id',
      strengthHr: 'id, performedAt, externalId',
      races: 'id, date, priority, completedAt, createdAt',
      wellness: 'id, kind, startedAt, recoveredAt, updatedAt',
      notifications: 'id, createdAt, channel, severity, readAt, updatedAt',
      aiGenerations: 'id, createdAt, blockId, weekScope, outcome, source, updatedAt',
      chats: 'id, createdAt, updatedAt',
      userProfile: 'id',
      injuries: 'id, area, startedAt, resolvedAt, updatedAt',
    });
  }
}

let _db: WendlerDb | null = null;
let _seedPromise: Promise<void> | null = null;

export function getDb(): WendlerDb {
  if (typeof window === 'undefined') {
    throw new Error('Dexie can only be used in the browser');
  }
  if (!_db) {
    _db = new WendlerDb();
    installSingletonWriteBreadcrumbs(_db);
  }
  return _db;
}

/**
 * Wrap singleton writes with a breadcrumb log AND a bare-over-rich
 * write guard. The previous version of this tap only logged; v323 makes
 * it active — if the incoming row is bare-shaped and the existing local
 * row is rich, the write is refused and a notification is filed in the
 * inbox so the user has a breadcrumb explaining why nothing changed.
 *
 * This is a belt to the sync layer's suspenders: sync.ts already refuses
 * to apply or push bare singletons, but it can't help if a UI bug writes
 * a bare row directly to Dexie. With this tap, that path is closed too.
 *
 * Captures stack trace + payload shape into a circular buffer in
 * localStorage either way. See incident 2026-05-04 (settings wiper) and
 * incident 2026-05-13 (schedule wiper — root cause unknown, defenses
 * upgraded to write-time as a result).
 */
function installSingletonWriteBreadcrumbs(db: WendlerDb) {
  // Definition of "bare" must match `isBareScheduleShape` in sync.ts.
  // Only the actual config fields count as evidence of user authorship —
  // activeBlockId/cursor/dayOrder are tiny pointers that downstream flows
  // set automatically and that don't carry program shape on their own.
  // See incident 2026-05-13.
  const isBareSchedule = (payload: Record<string, unknown>) => {
    const dayGroups = payload.dayGroups as unknown[] | undefined;
    const liftsPerDay = payload.liftsPerDay as number | undefined;
    const hasUserConfig =
      (Array.isArray(dayGroups) && dayGroups.length > 0) ||
      (liftsPerDay ?? 0) >= 2 ||
      !!payload.supplementalTemplate ||
      payload.supplementalSetsOverride != null;
    return !hasUserConfig;
  };
  const isBareSettings = (payload: Record<string, unknown>) => {
    const pairs = (payload.pairsByWeight as Record<string, number>) ?? {};
    const vals = Object.values(pairs);
    return vals.length > 0 && vals.every((x) => x <= 5);
  };
  const isBare = (table: 'schedule' | 'settings', payload: Record<string, unknown>) =>
    table === 'schedule' ? isBareSchedule(payload) : isBareSettings(payload);

  const tap = (table: 'schedule' | 'settings') => {
    const t = db[table] as unknown as {
      put: (v: unknown) => Promise<unknown>;
      get: (k: string) => Promise<unknown>;
    };
    const origPut = t.put.bind(t);
    const origGet = t.get.bind(t);
    t.put = async (v: unknown) => {
      const payload = (v as Record<string, unknown>) ?? {};
      const incomingBare = (() => {
        try { return isBare(table, payload); } catch { return false; }
      })();
      if (incomingBare) {
        const trace = new Error().stack ?? '(no stack)';
        // Read current row to decide whether to refuse.
        let localBare = true;
        try {
          const local = (await origGet('singleton')) as Record<string, unknown> | undefined;
          localBare = local ? isBare(table, local) : true;
        } catch {}
        // Always log the breadcrumb.
        console.warn(`[db] BARE ${table}.put detected`, { payload, trace, localBare });
        try {
          const KEY = '__wendler_wipe_breadcrumbs';
          const buf = JSON.parse(localStorage.getItem(KEY) || '[]') as unknown[];
          buf.push({
            at: new Date().toISOString(),
            table,
            payload,
            localBare,
            refused: !localBare,
            trace,
            url: location.href,
          });
          while (buf.length > 20) buf.shift();
          localStorage.setItem(KEY, JSON.stringify(buf));
        } catch {}
        // Refuse if local was rich.
        if (!localBare) {
          console.error(
            `[db] REFUSED bare ${table} write that would have overwritten a rich local row`,
          );
          // Lazy-import notify to avoid a circular module dep — db.ts is
          // imported by lots of code paths and notify.ts → sync.ts.
          void import('./notify').then(({ notify }) => {
            void notify.warn({
              channel: 'system',
              title:
                table === 'schedule'
                  ? 'Refused a write that would have wiped Program defaults'
                  : 'Refused a write that would have wiped Settings',
              body:
                table === 'schedule'
                  ? 'A bug tried to overwrite your Program defaults (lift groupings, supplemental template, day cadence) with default values. The write was blocked. If you see this repeatedly, please check the browser console for the stack trace tagged "[db] REFUSED bare schedule write".'
                  : 'A bug tried to overwrite your Settings (equipment, warm-up, rest timer) with defaults. The write was blocked.',
              deepLink:
                table === 'schedule'
                  ? { href: '/program/detail', label: 'Open Program defaults' }
                  : { href: '/settings', label: 'Open Settings' },
              context: { localBare, payload, trace },
            });
          }).catch(() => {});
          // Resolve with the existing local row's id so callers awaiting
          // a put-result keep working (Dexie's put returns the primary key).
          return 'singleton';
        }
      }
      return origPut(v);
    };
  };
  tap('schedule');
  tap('settings');
}

/**
 * Idempotent, safe-to-call-many-times seed bootstrap.
 * MUST be invoked outside any Dexie liveQuery zone (otherwise the writes throw
 * ReadOnlyError because liveQuery queriers run in a read-only transaction).
 * The app layout calls this once on mount.
 */
export function ensureSeeded(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (!_seedPromise) {
    _seedPromise = seedIfEmpty(getDb()).catch((err) => {
      // Allow retry on next call if it failed.
      _seedPromise = null;
      throw err;
    });
  }
  return _seedPromise;
}

/**
 * True only if this looks like a brand-new install (no user data, never
 * synced). Used as a guard before re-seeding singleton rows like
 * schedule/settings — re-seeding them on a non-fresh install would silently
 * overwrite the cloud copy on the next sync push and propagate the wipe to
 * every other device. See incident 2026-05-04.
 */
async function isFreshInstall(db: WendlerDb): Promise<boolean> {
  const meta = await db.syncMeta.get('syncMeta');
  if (meta && meta.lastPulledServerTime && meta.lastPulledServerTime !== '1970-01-01T00:00:00.000Z') {
    return false;
  }
  if (meta && meta.lastPushedAt && meta.lastPushedAt !== '1970-01-01T00:00:00.000Z') {
    return false;
  }
  // Any user-authored content disqualifies this from being treated as fresh.
  const counts = await Promise.all([
    db.programs.count(),
    db.blocks.count(),
    db.sessions.count(),
    db.sets.count(),
    db.trainingMaxes.count(),
    db.goals.count(),
    db.cardio.count(),
    db.recovery.count(),
    db.wellness.count(),
  ]);
  return counts.every((c) => c === 0);
}

async function seedIfEmpty(db: WendlerDb) {
  // Upsert seed movements by id so new seeds (e.g. Trap Bar Deadlift) appear
  // on existing installs without wiping user-customized rows.
  const existing = await db.movements.bulkGet(SEED_MOVEMENTS.map((m) => m.id));
  const missing = SEED_MOVEMENTS.filter((_, i) => !existing[i]);
  if (missing.length > 0) {
    await db.movements.bulkAdd(missing);
  }
  // Backfill new fields onto existing seed rows without overwriting any user
  // edits (we only patch fields that are still undefined in storage). Today
  // this keeps `isCompound` in sync with the seed library so the per-slot
  // movement picker can filter to compound lifts on installs that were seeded
  // before the flag existed.
  const patches: Array<{ id: string; isCompound: boolean }> = [];
  // One-shot equipment backfills — when a seed movement's equipment is
  // intentionally retyped (e.g. Face Pull moved to band), nudge existing
  // local rows that still match the previous default. Conservative: only
  // overwrite when the stored value matches the old default, so user
  // re-classifications are preserved.
  const equipmentBackfills: Array<{ id: string; from: Movement['equipment']; to: Movement['equipment'] }> = [
    { id: 'seed:face-pull', from: 'cable', to: 'band' },
    { id: 'seed:pallof-press', from: 'cable', to: 'band' },
  ];
  for (const bf of equipmentBackfills) {
    const stored = await db.movements.get(bf.id);
    if (stored && stored.equipment === bf.from) {
      await db.movements.update(bf.id, { equipment: bf.to });
    }
  }
  for (let i = 0; i < SEED_MOVEMENTS.length; i++) {
    const stored = existing[i];
    const seed = SEED_MOVEMENTS[i];
    if (!stored || !seed) continue;
    if (stored.isCompound === undefined && seed.isCompound !== undefined) {
      patches.push({ id: stored.id, isCompound: seed.isCompound });
    }
  }
  if (patches.length > 0) {
    await Promise.all(patches.map((p) => db.movements.update(p.id, { isCompound: p.isCompound })));
  }
  const settings = await db.settings.get('singleton');
  if (!settings) {
    // Guard against catastrophic data loss: if the user has *any* prior
    // history (sessions, blocks, programs, etc.) or has ever pulled from the
    // cloud, then a missing settings row is corruption — not a fresh install.
    // Writing defaults here (which will then get pushed by the next sync)
    // would overwrite the good copy on the server and propagate the wipe to
    // every other device. Instead, leave it absent and let the next pull
    // restore from the server. See incident 2026-05-04.
    if (await isFreshInstall(db)) {
      await db.settings.put({
        id: 'singleton',
        barWeightKg: 20,
        trapBarWeightKg: 25,
        keepScreenOn: false,
        pairsByWeight: { 25: 2, 20: 2, 15: 1, 10: 2, 5: 2, 2.5: 2, 1.25: 2 },
        roundingKg: 2.5,
        warmupPercents: [0.4, 0.6, 0.8],
        warmupReps: [5, 5, 3],
        defaultTmPercent: 0.85,
        units: 'kg',
        restSecondsByKind: {
          warmup: 60,
          main: 180,
          amrap: 240,
          supplemental: 90,
          assistance: 60,
        },
        autoStartRestTimer: true,
        updatedAt: new Date().toISOString(),
      });
    } else {
      console.warn(
        '[seed] settings singleton missing on a non-fresh install; ' +
          'leaving absent to let the next sync pull restore it from the server',
      );
    }
  }
  const schedule = await db.schedule.get('singleton');
  if (!schedule) {
    if (await isFreshInstall(db)) {
      await db.schedule.put({
        id: 'singleton',
        dayOrder: [...DEFAULT_DAY_ORDER],
        updatedAt: new Date().toISOString(),
      });
    } else {
      console.warn(
        '[seed] schedule singleton missing on a non-fresh install; ' +
          'leaving absent to let the next sync pull restore it from the server',
      );
    }
  } else if (schedule.cursor && 'dayIndex' in schedule.cursor && !('groupIndex' in schedule.cursor)) {
    // One-shot cursor migration: legacy `dayIndex` (per main lift) → new
    // `groupIndex` (per training day). Idempotent: once written with
    // groupIndex, this branch never fires again.
    const legacy = schedule.cursor as unknown as {
      blockId: string;
      week: import('@wendler/domain').WendlerWeek;
      dayIndex: number;
    };
    const liftsPerDay = Math.max(1, schedule.liftsPerDay ?? 1);
    const groupIndex = Math.floor(legacy.dayIndex / liftsPerDay);
    await db.schedule.put({
      ...schedule,
      cursor: { blockId: legacy.blockId, week: legacy.week, groupIndex },
      updatedAt: new Date().toISOString(),
    });
  }
}
