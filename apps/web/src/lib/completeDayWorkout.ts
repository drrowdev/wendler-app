'use client';

import { nanoid } from 'nanoid';
import {
  advanceCursor,
  effectivePlan,
  effectiveScheduleDays,
  isDaySkipped,
  resolveDayAssistance,
  type AssistanceEntry,
  type ProgramBlock,
  type WendlerWeek,
} from '@wendler/domain';
import { getDb } from './db';

interface CompleteDayWorkoutOpts {
  blockId: string;
  week: WendlerWeek;
  dayIdx: number;
}

/**
 * Single "Complete workout" code path used by every workout type
 * (single-lift, multi-lift, accessory, 7th week).
 *
 * Stamps `workoutCompletedAt` on every session row for this day. If no row
 * exists (e.g. accessory day where the user logged nothing), materialises
 * an anchor row so dashboards / ThisWeekCard / strength-day count still
 * register the day as completed.
 *
 * **v282+**: also stamps `assistanceSnapshot` — a frozen copy of the
 * day's resolved assistance prescription at completion time. This makes
 * historical sessions render stably across future block-plan edits.
 * Generating new assistance for Wk2 after Day 1 of Wk1 is already
 * completed no longer rewrites the visual record of yesterday's session.
 * The snapshot is stamped on one row only (a single source of truth per
 * day-group); other rows in the same group resolve it via the shared
 * (blockId, week, dayIndex) key.
 *
 * Then advances the schedule cursor by one day group when the cursor is
 * currently parked on this exact (blockId, week, dayIdx). Mirrors the
 * existing `advanceScheduleAfterAccessoryDay` semantics but works for any
 * day kind — no "all main lifts logged" check, because the user's explicit
 * tap on Complete IS the signal.
 */
export async function completeDayWorkout({
  blockId,
  week,
  dayIdx,
}: CompleteDayWorkoutOpts): Promise<void> {
  if (!blockId) return;
  const db = getDb();
  const stamp = new Date().toISOString();

  // Compute the assistance snapshot from the current resolved plan.
  // Best-effort: if anything fails to resolve, we proceed without a
  // snapshot — the user's completion is more important than the snapshot.
  let snapshot: AssistanceEntry[] | undefined;
  // Stamp the block.updatedAt that produced this snapshot so /day can
  // detect cross-device staleness later (see SessionRecord field doc).
  let snapshotBlockUpdatedAt: string | undefined;
  try {
    const block = await db.blocks.get(blockId);
    const schedule = await db.schedule.get('singleton');
    if (block) {
      const dayOrder = schedule?.dayOrder ?? ['press', 'deadlift', 'bench', 'squat'];
      const liftsPerDay = schedule?.liftsPerDay ?? 1;
      const plan = schedule
        ? effectivePlan(block, schedule)
        : effectivePlan(block, dayOrder, liftsPerDay);
      const day = plan.days[dayIdx];
      if (day) {
        const entries = resolveDayAssistance(plan, week, day.id);
        // Deep-clone so a later mutation to the live plan can't surface
        // in the snapshot via shared object refs.
        snapshot = entries ? entries.map((e) => ({ ...e })) : undefined;
        snapshotBlockUpdatedAt = block.updatedAt;
      }
    }
  } catch {
    // Best-effort — leave snapshot undefined and proceed.
  }

  const allForBlock = await db.sessions.where('blockId').equals(blockId).toArray();
  const dayRows = allForBlock.filter((s) => s.week === week && s.dayIndex === dayIdx);

  if (dayRows.length > 0) {
    // Stamp `workoutCompletedAt` on every row. Stamp `assistanceSnapshot`
    // on the FIRST row only — it's a per-day-group field, not per-lift,
    // and fanning out the array adds storage with no benefit. The day
    // page reads the snapshot from whichever row carries it.
    let snapshotWritten = false;
    await Promise.all(
      dayRows.map((s) => {
        const patch: Partial<typeof s> = { workoutCompletedAt: stamp };
        if (snapshot && !snapshotWritten) {
          patch.assistanceSnapshot = snapshot;
          if (snapshotBlockUpdatedAt) {
            patch.assistanceSnapshotBlockUpdatedAt = snapshotBlockUpdatedAt;
          }
          snapshotWritten = true;
        }
        return db.sessions.update(s.id, patch);
      }),
    );
  } else {
    await db.sessions.put({
      id: nanoid(),
      performedAt: stamp,
      week,
      blockId,
      dayIndex: dayIdx,
      workoutCompletedAt: stamp,
      ...(snapshot ? { assistanceSnapshot: snapshot } : {}),
      ...(snapshotBlockUpdatedAt ? { assistanceSnapshotBlockUpdatedAt: snapshotBlockUpdatedAt } : {}),
    });
  }

  await advanceScheduleAfterDay(blockId, week, dayIdx);
}

/**
 * Advance the schedule cursor by one day group iff the cursor is parked
 * on (blockId, week, dayIdx). Idempotent. Generalises
 * `advanceScheduleAfterAccessoryDay` to any day kind — the per-lift
 * "are all main lifts logged" gate is intentionally dropped because
 * `completeDayWorkout` is only called from the explicit user tap.
 */
export async function advanceScheduleAfterDay(
  blockId: string,
  week: WendlerWeek,
  dayIdx: number,
): Promise<void> {
  const db = getDb();
  const schedule = await db.schedule.get('singleton');
  if (!schedule?.cursor) return;
  if (schedule.cursor.blockId !== blockId) return;
  if (schedule.cursor.week !== week) return;
  // Catch-up rule: advance the cursor past `dayIdx` whenever the cursor
  // sits at-or-before dayIdx in the same week. This handles mid-week
  // activation: cursor parked on Day 0 (Mon), user trains Thursday
  // first → cursor needs to jump past Thu, not stay on Mon. Strict
  // equality previously made the cursor stick on Mon and the Today
  // hero card couldn't tell what's actually next.
  if (schedule.cursor.groupIndex > dayIdx) return;

  const groups = effectiveScheduleDays(schedule);
  const block = await db.blocks.get(blockId);
  if (!block) return;

  // Skip-aware advance: after the basic cursor.groupIndex+1 / week+1 step,
  // keep advancing while the new slot points at a day flagged
  // `skipped: true` in plan.dayOverridesByWeek. Bounded by the same
  // advanceCursor walk that handles week boundaries — once the cursor
  // walks off the end of the block, we exit with null.
  let next = advanceCursor({ week, groupIndex: dayIdx }, block, groups.length);
  while (next && nextSlotIsSkipped(block, next.week, next.groupIndex)) {
    next = advanceCursor(next, block, groups.length);
  }
  const now = new Date().toISOString();
  if (next) {
    await db.schedule.put({
      ...schedule,
      cursor: { blockId, week: next.week, groupIndex: next.groupIndex },
      updatedAt: now,
    });
  } else {
    const { cursor: _drop, ...rest } = schedule;
    await db.schedule.put({ ...rest, updatedAt: now });
  }
}

/**
 * True iff the (week, groupIndex) slot points at a day flagged
 * `skipped: true` in the block plan's per-week overrides. The mapping
 * from groupIndex → plan.dayId assumes block.plan.days is ordered the
 * same as the schedule's day groups (which is how `derivePlan` builds
 * it — see packages/domain/src/blocks.ts).
 */
function nextSlotIsSkipped(
  block: ProgramBlock,
  week: WendlerWeek,
  groupIndex: number,
): boolean {
  const planDay = block.plan?.days?.[groupIndex];
  if (!planDay) return false;
  return isDaySkipped(block.plan, week, planDay.id);
}
