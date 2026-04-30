'use client';

import Dexie, { type Table } from 'dexie';
import {
  SCHEMA_VERSION,
  SEED_MOVEMENTS,
  type Movement,
  type SessionRecord,
  type SetRecord,
  type TrainingMaxRecord,
  type UserSettings,
} from '@wendler/db-schema';

class WendlerDb extends Dexie {
  movements!: Table<Movement, string>;
  trainingMaxes!: Table<TrainingMaxRecord, string>;
  settings!: Table<UserSettings, 'singleton'>;
  sets!: Table<SetRecord, string>;
  sessions!: Table<SessionRecord, string>;

  constructor() {
    super('wendler-app');
    this.version(SCHEMA_VERSION).stores({
      movements: 'id, name, equipment, pattern, isMainLift, isCustom',
      trainingMaxes: 'id, lift, createdAt',
      settings: 'id',
      sets: 'id, movementId, sessionId, performedAt, kind',
      sessions: 'id, performedAt, mainLift, week',
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
      updatedAt: new Date().toISOString(),
    });
  }
}
