'use client';

import {
  advanceCursor,
  effectiveScheduleDays,
  type MainLift,
  type WendlerWeek,
} from '@wendler/domain';
import { getDb } from './db';

/**
 * After a session is completed, advance the schedule cursor to the next day
 * group iff (a) the session matches the cursor's expected (blockId, week),
 * (b) the logged lift belongs to the current group's main lifts, AND (c) all
 * other main lifts in the current group have already been logged for this
 * (blockId, week). Out-of-order sessions and partial-group completions leave
 * the cursor alone so "Up next" still suggests what's planned.
 *
 * If the cursor would advance past the block's last session and the block
 * has no deload (or is on its last deload day), the cursor is cleared
 * (block effectively complete from a scheduling standpoint).
 */
export async function advanceScheduleIfMatches(
  sessionBlockId: string | undefined,
  lift: MainLift,
  week: WendlerWeek,
): Promise<void> {
  if (!sessionBlockId) return;
  const db = getDb();
  const schedule = await db.schedule.get('singleton');
  if (!schedule?.cursor) return;
  if (schedule.cursor.blockId !== sessionBlockId) return;
  if (schedule.cursor.week !== week) return;

  const groups = effectiveScheduleDays(schedule);
  const currentGroup = groups[schedule.cursor.groupIndex];
  if (!currentGroup || !currentGroup.mainLifts.includes(lift)) return;

  // Check that every other main lift in the current group has a logged
  // session for (blockId, week). The just-logged `lift` is included
  // optimistically — its session row is materialized in the same flow that
  // calls us, but may not be visible to this query yet depending on Dexie
  // write ordering.
  const sessions = await db.sessions.where('blockId').equals(sessionBlockId).toArray();
  const liftsLogged = new Set<MainLift>([lift]);
  for (const s of sessions) {
    if (s.week === week && s.mainLift) liftsLogged.add(s.mainLift);
  }
  const groupComplete = currentGroup.mainLifts.every((l) => liftsLogged.has(l));
  if (!groupComplete) return;

  const block = await db.blocks.get(sessionBlockId);
  if (!block) return;

  const next = advanceCursor(
    { week: schedule.cursor.week, groupIndex: schedule.cursor.groupIndex },
    block,
    groups.length,
  );
  const now = new Date().toISOString();
  if (next) {
    await db.schedule.put({
      ...schedule,
      cursor: { blockId: sessionBlockId, week: next.week, groupIndex: next.groupIndex },
      updatedAt: now,
    });
  } else {
    // Block is done — clear cursor (caller may also flip activeBlockId).
    const { cursor: _drop, ...rest } = schedule;
    await db.schedule.put({ ...rest, updatedAt: now });
  }
}

/**
 * Mark an accessory day complete and advance the schedule cursor by one
 * group. No session-completion check (an accessory day has no main lifts to
 * verify); the user explicitly requests advancement via the day card.
 *
 * Idempotent at the cursor level: if the cursor isn't currently at this
 * (blockId, week, accessory group), nothing changes.
 */
export async function advanceScheduleAfterAccessoryDay(
  sessionBlockId: string | undefined,
  week: WendlerWeek,
  groupIndex: number,
): Promise<void> {
  if (!sessionBlockId) return;
  const db = getDb();
  const schedule = await db.schedule.get('singleton');
  if (!schedule?.cursor) return;
  if (schedule.cursor.blockId !== sessionBlockId) return;
  if (schedule.cursor.week !== week) return;
  if (schedule.cursor.groupIndex !== groupIndex) return;

  const groups = effectiveScheduleDays(schedule);
  const currentGroup = groups[groupIndex];
  if (!currentGroup || currentGroup.mainLifts.length > 0) return; // not an accessory group

  const block = await db.blocks.get(sessionBlockId);
  if (!block) return;

  const next = advanceCursor({ week, groupIndex }, block, groups.length);
  const now = new Date().toISOString();
  if (next) {
    await db.schedule.put({
      ...schedule,
      cursor: { blockId: sessionBlockId, week: next.week, groupIndex: next.groupIndex },
      updatedAt: now,
    });
  } else {
    const { cursor: _drop, ...rest } = schedule;
    await db.schedule.put({ ...rest, updatedAt: now });
  }
}
