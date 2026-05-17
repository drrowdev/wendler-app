'use client';

// Side-effects to run when a block transitions to `completedAt`. Kept
// in one place so future block-completion paths (auto-complete, sync-
// detected completion, etc.) can share the same hook list without
// every caller having to remember each rule.

import { getDb } from './db';
import { kickSync } from './sync';

/**
 * Remove any cardio plan slots that were tied to the just-completed
 * block via `linkedBlockId`. Pattern used by the chat AI's
 * `add_cardio_plan_slot` op when it pairs a cardio replacement with a
 * `skip_day_in_week` op: the bike ride scheduled to replace a strength
 * day during taper is auto-removed when the taper block ends, so the
 * user doesn't have to remember to clean it up.
 *
 * Idempotent: calling repeatedly with the same blockId is a no-op
 * after the first call.
 */
export async function pruneCardioSlotsLinkedToBlock(blockId: string): Promise<void> {
  const db = getDb();
  const plan = await db.cardioPlan.get('singleton');
  if (!plan?.slots || plan.slots.length === 0) return;
  const before = plan.slots.length;
  const next = plan.slots.filter((s) => s.linkedBlockId !== blockId);
  if (next.length === before) return; // no-op
  await db.cardioPlan.put({
    ...plan,
    slots: next,
    updatedAt: new Date().toISOString(),
  });
  kickSync();
}

/**
 * One-call entry for "block X just transitioned to completed". Runs
 * every side-effect that should follow. Today: prune linked cardio
 * slots. Future hooks (e.g. archive injuries scoped to the block,
 * record block-completion notification) can be added here.
 */
export async function onBlockCompleted(blockId: string): Promise<void> {
  await pruneCardioSlotsLinkedToBlock(blockId);
}
