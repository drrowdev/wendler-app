'use client';

/**
 * Helpers for persisting the recurring weekly run plan and matching imported
 * Strava activities against it. Thin Dexie wrapper around the pure matching
 * logic in `@wendler/domain` (`runPlan.ts`).
 */

import { matchActivityToPlan, toLocalYmd } from '@wendler/domain';
import type { CardioSession, RunPlan } from '@wendler/db-schema';
import { getDb } from './db';

/**
 * Recompute `plannedKind` and `planMatch` for every cardio run in the local
 * Dexie store using the current RunPlan. Runs of modality !== 'run' are
 * skipped. Records that don't change are not written back. Returns the number
 * of updates performed.
 *
 * Use this both after the user edits the plan and after a Strava sync.
 */
export async function rematchAllCardioAgainstPlan(): Promise<number> {
  const db = getDb();
  const plan = await db.runPlan.get('singleton');
  const all = await db.cardio.toArray();
  const slots = plan?.slots ?? [];
  const updates: CardioSession[] = [];
  const now = new Date().toISOString();
  for (const c of all) {
    if (c.modality !== 'run') continue;
    // Manual user overrides are sticky — leave them alone (incl. planScheduledDate).
    if (c.planMatch === 'manual') continue;
    const m = matchActivityToPlan(c, slots);
    const newKind = m?.kind;
    const newMatch = m?.confidence ?? 'none';
    const newScheduled = m?.scheduledDate;
    if (
      c.plannedKind === newKind &&
      c.planMatch === newMatch &&
      c.planScheduledDate === newScheduled
    ) {
      continue;
    }
    updates.push({
      ...c,
      plannedKind: newKind,
      planMatch: newMatch,
      planScheduledDate: newScheduled,
      updatedAt: now,
    });
  }
  if (updates.length > 0) {
    await db.cardio.bulkPut(updates);
  }
  return updates.length;
}

/**
 * User-initiated re-tag of a single cardio activity. Setting `kind` to null
 * clears the manual override and the next rematch will re-derive from the
 * day-of-week slot. Persists with planMatch='manual' so the rematcher
 * leaves it alone.
 *
 * `slotDate` (YYYY-MM-DD) records which planned date this activity fulfills.
 * When omitted on a manual tag, defaults to the activity's own performedAt
 * date so the calendar continues to show the cardio glyph on the day it
 * happened. When clearing the tag, `planScheduledDate` is also cleared.
 */
export async function setManualPlanKind(
  cardioId: string,
  kind: import('@wendler/db-schema').RunPlannedKind | null,
  slotDate?: string,
): Promise<void> {
  const db = getDb();
  const c = await db.cardio.get(cardioId);
  if (!c) return;
  const performedYmd = toLocalYmd(new Date(c.performedAt));
  await db.cardio.put({
    ...c,
    plannedKind: kind ?? undefined,
    planMatch: kind ? 'manual' : 'none',
    planScheduledDate: kind ? slotDate ?? performedYmd : undefined,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Manually link a cardio activity to a planned slot on a specific date.
 *
 * Enforces "one activity per slot": if another cardio already claims this
 * slotDate, throws. Use `setManualPlanKind(id, null)` on the existing claim
 * first if you need to reassign.
 *
 * Marks the activity with planMatch='manual' so the auto-rematcher leaves it
 * alone, and records `planScheduledDate=slotDate` so the calendar's planned
 * pill on that date disappears (even when performedAt was a different day).
 */
export async function linkActivityToSlot(
  cardioId: string,
  slotDate: string,
  slotKind: import('@wendler/db-schema').RunPlannedKind,
): Promise<void> {
  const db = getDb();
  const conflict = await db.cardio
    .filter((c) => c.id !== cardioId && c.planScheduledDate === slotDate)
    .first();
  if (conflict) {
    throw new Error(
      `Another activity is already linked to ${slotDate}. Unlink it first.`,
    );
  }
  await setManualPlanKind(cardioId, slotKind, slotDate);
}

/**
 * Apply matching to a freshly imported batch of activities (in-memory) before
 * they are written to Dexie. Returns the patched array.
 *
 * The Strava import path uses this so a single sync cycle goes:
 *   1. Patch each new activity with plannedKind/planMatch
 *   2. Write them via cardio.put (existing flow)
 *   3. (Caller may also run rematchAllCardio in case the plan changed since
 *      the last sync — cheap and idempotent.)
 */
export async function applyPlanMatchToBatch(
  batch: CardioSession[],
): Promise<CardioSession[]> {
  const db = getDb();
  const plan = await db.runPlan.get('singleton');
  const slots = plan?.slots ?? [];
  if (slots.length === 0) return batch;
  return batch.map((c) => {
    if (c.modality !== 'run') return c;
    // Don't clobber a manual override that came back via sync.
    if (c.planMatch === 'manual') return c;
    const m = matchActivityToPlan(c, slots);
    return {
      ...c,
      plannedKind: m?.kind,
      planMatch: m?.confidence ?? 'none',
      planScheduledDate: m?.scheduledDate,
    };
  });
}

/** Persist the run plan singleton, bumping updatedAt for sync. */
export async function saveRunPlan(plan: Omit<RunPlan, 'id' | 'updatedAt'>): Promise<void> {
  const db = getDb();
  await db.runPlan.put({
    id: 'singleton',
    slots: plan.slots,
    updatedAt: new Date().toISOString(),
  });
}
