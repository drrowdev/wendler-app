'use client';

// edit-proposal-undo.ts — rollback handler for an applied propose_edit
// ChatAction. Reads the persisted `ChatActionSnapshot` captured at
// apply time and restores every touched table to its before-state
// inside one Dexie transaction.
//
// Restore semantics per table key:
//   - Multi-row tables (blocks, movements, trainingMaxes):
//       * For each row in `rowsById`, `db.<table>.put(row)` with a
//         fresh `updatedAt` so LWW sync wins on peer devices.
//       * For any row currently present whose id is NOT in
//         `presentIds`, delete it AND write a tombstone — these were
//         created by the apply and must be propagated as deletes.
//   - Singleton tables (cardioPlan, schedule):
//       * If `singletonRow` is null, delete the singleton (it didn't
//         exist before apply).
//       * Else, put the captured row with fresh `updatedAt`.
//
// Action chip is marked `undoneAt: <now>` (`status` stays `applied`
// so the chip remains visible and re-openable). One notification is
// posted on the ai-action channel summarising the undo. The
// snapshot row is deleted after a successful undo — undoing twice
// makes no sense.

import type { Table } from 'dexie';
import type {
  ChatActionSnapshot,
  ChatActionSnapshotTableMulti,
  Notification,
} from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';
import { updateActionStatus } from './chat-actions';

export interface UndoResult {
  ok: boolean;
  error?: string;
  /** Counts surfaced for the toast / notification body. */
  restoredCounts?: {
    blocks: number;
    movements: number;
    trainingMaxes: number;
    cardioPlan: boolean;
    schedule: boolean;
    deletedBlockIds: string[];
    deletedMovementIds: string[];
    deletedTrainingMaxIds: string[];
  };
}

export async function undoChatAction(
  chatId: string,
  messageId: string,
  actionId: string,
): Promise<UndoResult> {
  const db = getDb();
  const snapshot = await db.chatActionSnapshots.get(actionId);
  if (!snapshot) {
    return {
      ok: false,
      error:
        'No undo snapshot found for this proposal (older than the undo log retention window).',
    };
  }
  const now = new Date().toISOString();
  const counts: UndoResult['restoredCounts'] = {
    blocks: 0,
    movements: 0,
    trainingMaxes: 0,
    cardioPlan: false,
    schedule: false,
    deletedBlockIds: [],
    deletedMovementIds: [],
    deletedTrainingMaxIds: [],
  };

  try {
    await db.transaction(
      'rw',
      [
        db.blocks,
        db.movements,
        db.trainingMaxes,
        db.cardioPlan,
        db.schedule,
        db.tombstones,
      ],
      async () => {
        const t = snapshot.tables;
        if (t.blocks) {
          const deleted = await restoreMulti(
            t.blocks,
            db.blocks as unknown as Table<Record<string, unknown>, string>,
            now,
            'block',
          );
          counts.blocks = Object.keys(t.blocks.rowsById).length;
          counts.deletedBlockIds = deleted;
        }
        if (t.movements) {
          const deleted = await restoreMulti(
            t.movements,
            db.movements as unknown as Table<Record<string, unknown>, string>,
            now,
            'movement',
          );
          counts.movements = Object.keys(t.movements.rowsById).length;
          counts.deletedMovementIds = deleted;
        }
        if (t.trainingMaxes) {
          const deleted = await restoreMulti(
            t.trainingMaxes,
            db.trainingMaxes as unknown as Table<Record<string, unknown>, string>,
            now,
            'trainingMax',
          );
          counts.trainingMaxes = Object.keys(t.trainingMaxes.rowsById).length;
          counts.deletedTrainingMaxIds = deleted;
        }
        if (t.cardioPlan) {
          if (t.cardioPlan.singletonRow === null) {
            await db.cardioPlan.delete('singleton');
            await db.tombstones.put({
              id: `cardioPlan:singleton`,
              kind: 'cardioPlan',
              recordId: 'singleton',
              deletedAt: now,
            });
          } else {
            const row = {
              ...(t.cardioPlan.singletonRow as object),
              updatedAt: now,
            };
            // Cast — Dexie singleton table is keyed by the literal 'singleton'.
            await db.cardioPlan.put(row as unknown as never);
          }
          counts.cardioPlan = true;
        }
        if (t.schedule) {
          if (t.schedule.singletonRow === null) {
            await db.schedule.delete('singleton');
            await db.tombstones.put({
              id: `schedule:singleton`,
              kind: 'schedule',
              recordId: 'singleton',
              deletedAt: now,
            });
          } else {
            const row = {
              ...(t.schedule.singletonRow as object),
              updatedAt: now,
            };
            await db.schedule.put(row as unknown as never);
          }
          counts.schedule = true;
        }
      },
    );
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  await updateActionStatus(chatId, messageId, actionId, {
    undoneAt: now,
  });
  await db.chatActionSnapshots.delete(actionId);
  await writeUndoNotification(chatId, actionId, counts);
  kickSync();
  return { ok: true, restoredCounts: counts };
}

/**
 * Restore a multi-row table to its captured state.
 * Returns the ids that were deleted (newly-created rows the apply
 * added that weren't in the before-state).
 */
async function restoreMulti(
  captured: ChatActionSnapshotTableMulti,
  table: Table<Record<string, unknown>, string>,
  now: string,
  tombstoneKind: string,
): Promise<string[]> {
  const beforeIds = new Set(captured.presentIds);
  const currentIds = (await table.toCollection().primaryKeys()) as string[];
  const deletedIds: string[] = [];

  // Delete rows that exist now but did not exist in the before-state.
  for (const id of currentIds) {
    if (!beforeIds.has(id)) {
      await table.delete(id);
      await getDb().tombstones.put({
        id: `${tombstoneKind}:${id}`,
        kind: tombstoneKind,
        recordId: id,
        deletedAt: now,
      });
      deletedIds.push(id);
    }
  }

  // Restore each before-state row (bumping updatedAt so LWW wins).
  for (const [id, row] of Object.entries(captured.rowsById)) {
    void id;
    await table.put({ ...(row as Record<string, unknown>), updatedAt: now });
  }

  return deletedIds;
}

async function writeUndoNotification(
  chatId: string,
  actionId: string,
  counts: UndoResult['restoredCounts'],
): Promise<void> {
  if (!counts) return;
  const now = new Date().toISOString();
  const parts: string[] = [];
  if (counts.blocks) parts.push(`${counts.blocks} block(s)`);
  if (counts.movements) parts.push(`${counts.movements} movement(s)`);
  if (counts.trainingMaxes) parts.push(`${counts.trainingMaxes} training max(es)`);
  if (counts.cardioPlan) parts.push(`cardio plan`);
  if (counts.schedule) parts.push(`schedule`);
  const summary = parts.length > 0 ? parts.join(', ') : 'no rows';
  const deletes =
    counts.deletedBlockIds.length +
    counts.deletedMovementIds.length +
    counts.deletedTrainingMaxIds.length;
  const notification: Notification = {
    // New id (not the chat-action:* of the original apply) so both
    // entries coexist in the notification history.
    id: `chat-action-undo:${actionId}`,
    createdAt: now,
    updatedAt: now,
    channel: 'ai-action',
    severity: 'info',
    title: `AI proposal undone`,
    body:
      `Restored ${summary}` +
      (deletes > 0 ? ` and removed ${deletes} newly-created row(s).` : '.'),
    context: {
      kind: 'chat-action',
      actionKind: 'propose_edit',
      chatId,
      messageId: actionId,
    },
  };
  try {
    await getDb().notifications.put(notification);
  } catch {
    // Best-effort.
  }
}
