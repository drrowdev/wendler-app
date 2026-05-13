'use client';

import { getDb } from '@/lib/db';
import type { WendlerWeek } from '@wendler/domain';

/**
 * Information identifying a logged strength workout-day. The same
 * (blockId, week, dayIndex) tuple is used everywhere — sessions are
 * stamped with these fields when /day creates the row.
 */
export interface WorkoutDayKey {
  blockId: string;
  week: WendlerWeek;
  dayIndex: number;
}

/**
 * Pin a logged workout-day to a specific planned date. Stamps
 * `planScheduledDate` on every session row that shares the same
 * (blockId, week, dayIndex) so the day-group is treated atomically
 * (mirrors how `workoutCompletedAt` is fanned out by completeDayWorkout).
 *
 * Pass `null` for `plannedDate` to clear the link — the calendar will
 * fall back to the projected weekday.
 *
 * Throws if another day-group already claims `plannedDate`. Callers
 * should warn the user and resolve the conflict (clear the older claim
 * first) before retrying.
 */
export async function linkWorkoutDayToDate(
  key: WorkoutDayKey,
  plannedDate: string | null,
): Promise<void> {
  const db = getDb();
  if (plannedDate) {
    const conflict = await db.sessions
      .filter(
        (s) =>
          s.planScheduledDate === plannedDate &&
          !(
            s.blockId === key.blockId &&
            s.week === key.week &&
            s.dayIndex === key.dayIndex
          ),
      )
      .first();
    if (conflict) {
      throw new Error(
        `Another workout is already linked to ${plannedDate}. Unlink it first.`,
      );
    }
  }
  const rows = await db.sessions
    .where('blockId')
    .equals(key.blockId)
    .filter((s) => s.week === key.week && s.dayIndex === key.dayIndex)
    .toArray();
  await Promise.all(
    rows.map((s) =>
      db.sessions.put({
        ...s,
        planScheduledDate: plannedDate ?? undefined,
      }),
    ),
  );
}

/**
 * Look up which workout-day already claims a given planned date, if any.
 * Returns the (blockId, week, dayIndex) of the claimant for conflict
 * resolution UI.
 */
export async function findClaimantOfDate(
  plannedDate: string,
): Promise<WorkoutDayKey | null> {
  const db = getDb();
  const row = await db.sessions
    .filter((s) => s.planScheduledDate === plannedDate)
    .first();
  if (!row || !row.blockId || row.week == null || row.dayIndex == null) return null;
  return { blockId: row.blockId, week: row.week, dayIndex: row.dayIndex };
}
