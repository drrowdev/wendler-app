'use client';

import Dexie, { type Table } from 'dexie';
import {
  SCHEMA_VERSION,
  SEED_MOVEMENTS,
  type CardioSession,
  type Goal,
  type Movement,
  type ProgramBlock,
  type ProgramSchedule,
  type PushSubscriptionRecord,
  type RecoveryEntry,
  type SessionRecord,
  type SetRecord,
  type TrainingMaxRecord,
  type UserSettings,
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
  schedule!: Table<ProgramSchedule, 'singleton'>;
  syncMeta!: Table<SyncMetaRecord, 'syncMeta'>;
  goals!: Table<Goal, string>;
  cardio!: Table<CardioSession, string>;
  recovery!: Table<RecoveryEntry, string>;
  pushSub!: Table<PushSubscriptionRecord, 'pushSub'>;

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
    this.version(SCHEMA_VERSION).stores({
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
  }
}

let _db: WendlerDb | null = null;

export function getDb(): WendlerDb {
  if (typeof window === 'undefined') {
    throw new Error('Dexie can only be used in the browser');
  }
  if (!_db) {
    _db = new WendlerDb();
    void seedIfEmpty(_db);
  }
  return _db;
}

async function seedIfEmpty(db: WendlerDb) {
  const count = await db.movements.count();
  if (count === 0) {
    await db.movements.bulkAdd(SEED_MOVEMENTS);
  }
  const settings = await db.settings.get('singleton');
  if (!settings) {
    await db.settings.put({
      id: 'singleton',
      barWeightKg: 20,
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
        joker: 240,
      },
      autoStartRestTimer: true,
      jokerRpeThreshold: 8,
      updatedAt: new Date().toISOString(),
    });
  }
  const schedule = await db.schedule.get('singleton');
  if (!schedule) {
    await db.schedule.put({
      id: 'singleton',
      dayOrder: [...DEFAULT_DAY_ORDER],
      updatedAt: new Date().toISOString(),
    });
  }
}
