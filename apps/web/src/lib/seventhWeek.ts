'use client';

import { nanoid } from 'nanoid';
import {
  type ProgramBlock,
} from '@wendler/db-schema';
import {
  SEVENTH_WEEK_VARIANTS,
  effectivePlan,
  initialCursorWeek,
  type SeventhWeekKind,
} from '@wendler/domain';
import { getDb } from './db';
import { kickSync } from './sync';

export interface InsertSeventhWeekResult {
  blockId: string;
}

/**
 * Insert a 7th-week block (deload / TM-test / PR-test) into a program at the
 * "right now" position — i.e. immediately after the last completed normal
 * block, shifting any later blocks back by one. Activates the new block in
 * the schedule cursor when applicable.
 *
 * This is the same flow used by the cadence-based 7th-week prompt on
 * /program/detail, extracted so race-driven taper can call it from
 * TaperBanner / /races without code duplication.
 *
 * Returns the new block's id so the caller can navigate to it.
 */
export async function insertSeventhWeekBlock(opts: {
  programId: string;
  kind: SeventhWeekKind;
  /** All blocks belonging to the program (any order). */
  programBlocks: readonly ProgramBlock[];
}): Promise<InsertSeventhWeekResult> {
  const { programId, kind, programBlocks } = opts;
  const dbi = getDb();
  const now = new Date().toISOString();

  const lastNormal = [...programBlocks]
    .reverse()
    .find((b) => b.kind !== 'seventh-week');
  const sched = await dbi.schedule.get('singleton');
  let plan;
  if (lastNormal) {
    plan = sched
      ? effectivePlan(lastNormal, sched)
      : effectivePlan(lastNormal, ['squat', 'bench', 'deadlift', 'press']);
    plan = {
      ...plan,
      days: plan.days.map((d) => ({ ...d, assistance: [] })),
      assistanceOverrides: undefined,
    };
  }

  const variant = SEVENTH_WEEK_VARIANTS[kind];
  const sorted = [...programBlocks].sort(
    (a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0),
  );
  const lastCompleted = [...sorted].reverse().find((b) => !!b.completedAt);
  const insertSeq = lastCompleted ? (lastCompleted.sequenceIndex ?? 0) + 1 : 0;
  const toShift = sorted.filter((b) => (b.sequenceIndex ?? 0) >= insertSeq);

  const newBlock: ProgramBlock = {
    id: nanoid(),
    name: variant.title,
    kind: 'seventh-week',
    seventhWeekKind: kind,
    weeksBeforeDeload: 1,
    includesDeload: false,
    supplementalTemplate: 'none',
    mainScheme: lastNormal?.mainScheme ?? '5s-pro',
    createdAt: now,
    // Stamp startedAt now so cardio-scope resolution + timeline have
    // a concrete anchor for the new active block.
    startedAt: now,
    programId,
    sequenceIndex: insertSeq,
    ...(plan ? { plan } : {}),
  };

  await dbi.transaction('rw', dbi.blocks, async () => {
    for (const b of [...toShift].sort(
      (a, b) => (b.sequenceIndex ?? 0) - (a.sequenceIndex ?? 0),
    )) {
      await dbi.blocks.update(b.id, {
        sequenceIndex: (b.sequenceIndex ?? 0) + 1,
        updatedAt: now,
      });
    }
    await dbi.blocks.add(newBlock);
  });

  if (sched) {
    await dbi.schedule.put({
      ...sched,
      activeBlockId: newBlock.id,
      cursor: { blockId: newBlock.id, week: initialCursorWeek(newBlock), groupIndex: 0 },
      updatedAt: now,
    });
  }

  kickSync();
  return { blockId: newBlock.id };
}
