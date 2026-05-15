'use client';

import { getDb } from './db';
import { kickSync } from './sync';
import type { SyncKind } from './sync';

/**
 * Delete records of a given sync kind from the local DB and write tombstones,
 * so the deletes are pushed to the server and propagated to other devices.
 * Tombstones are kept locally; receiving them back from the server is a no-op.
 */
export async function deleteWithTombstones(kind: SyncKind, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();

  const table =
    kind === 'set'
      ? db.sets
      : kind === 'session'
        ? db.sessions
        : kind === 'block'
          ? db.blocks
          : kind === 'program'
            ? db.programs
            : kind === 'trainingMax'
              ? db.trainingMaxes
              : kind === 'movement'
                ? db.movements
                : kind === 'goal'
                  ? db.goals
                  : kind === 'cardio'
                    ? db.cardio
                    : kind === 'recovery'
                      ? db.recovery
                      : kind === 'race'
                        ? db.races
                        : kind === 'wellness'
                          ? db.wellness
                          : kind === 'notification'
                            ? db.notifications
                            : kind === 'aiGeneration'
                              ? db.aiGenerations
                              : kind === 'chat'
                                ? db.chats
                                : kind === 'injury'
                                  ? db.injuries
                                  : kind === 'weeklyReview'
                                    ? db.weeklyReviews
                                    : null;
  if (!table) throw new Error(`deleteWithTombstones: kind '${kind}' is not deletable`);

  await db.transaction('rw', table, db.tombstones, async () => {
    await table.bulkDelete(ids);
    await db.tombstones.bulkPut(
      ids.map((recordId) => ({ id: `${kind}:${recordId}`, kind, recordId, deletedAt: now })),
    );
  });
  kickSync();
}

/** Mark already-deleted-locally rows as tombstoned (used when applying incoming deletes). */
export async function recordIncomingDelete(kind: SyncKind, recordId: string): Promise<void> {
  // No-op for incoming: applyIncoming already removes the local row;
  // we don't need a local tombstone since the server already has one.
}
