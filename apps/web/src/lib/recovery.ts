'use client';

// Imperative API for writing RecoveryEntry rows. Centralised so the
// recovery page, pre-workout modal, and any future readiness surfaces all
// share the same upsert semantics + sync kick.
//
// One entry per `YYYY-MM-DD` calendar date — id IS the date. New writes
// merge with whatever's already there (a morning bodyweight log + an
// afternoon pre-workout readiness fill cohabit happily).

import type { RecoveryEntry } from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';

export function ymdLocal(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type RecoveryUpdate = Partial<Omit<RecoveryEntry, 'id' | 'updatedAt'>>;

/**
 * Upsert today's RecoveryEntry (or any specified date). Fields not in
 * `patch` are preserved from any existing row.
 */
export async function upsertRecoveryEntry(
  patch: RecoveryUpdate,
  date: string = ymdLocal(),
): Promise<void> {
  if (typeof window === 'undefined') return;
  const db = getDb();
  const now = new Date().toISOString();
  const existing = await db.recovery.get(date);
  const next: RecoveryEntry = {
    ...(existing ?? { id: date, updatedAt: now }),
    ...patch,
    id: date,
    updatedAt: now,
  };
  await db.recovery.put(next);
  kickSync();
}

/** Returns today's RecoveryEntry, or undefined if none logged yet. */
export async function getRecoveryEntry(
  date: string = ymdLocal(),
): Promise<RecoveryEntry | undefined> {
  if (typeof window === 'undefined') return undefined;
  return getDb().recovery.get(date);
}

/**
 * Return the most recent RecoveryEntry on or before `date` that carries a
 * `bodyweightKg`. Used by the effective-load helper so historical sets get
 * a meaningful bodyweight even if not logged that exact day.
 */
export async function getLatestBodyweightOnOrBefore(
  date: string = ymdLocal(),
): Promise<number | undefined> {
  if (typeof window === 'undefined') return undefined;
  const rows = await getDb()
    .recovery.where('id')
    .belowOrEqual(date)
    .reverse()
    .sortBy('id');
  for (const r of rows) {
    if (r.bodyweightKg && r.bodyweightKg > 0) return r.bodyweightKg;
  }
  return undefined;
}
