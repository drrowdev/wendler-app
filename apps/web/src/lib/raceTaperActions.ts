'use client';

import type { ProgramBlock, Race, RaceTaperActions } from '@wendler/db-schema';
import type { ProposedTaperAction } from '@wendler/domain';
import { getDb } from './db';
import { kickSync } from './sync';
import { insertSeventhWeekBlock } from './seventhWeek';

/**
 * Per-race accept/dismiss handlers for the Option-A taper actions panel.
 *
 * Both functions write `Race.taperActions` (last-write-wins synced via the
 * normal `updatedAt` pattern). `acceptAction` for `insert-deload` also
 * actually inserts the deload block via `insertSeventhWeekBlock` and
 * records the resulting blockId so we have a paper trail.
 *
 * `activate-competition-peaking` deliberately does NOT mutate
 * `settings.goalFlags`. The effective-flags helper (`computeEffectiveGoalFlags`
 * in @wendler/domain) ORs race-driven activations with the manual checkbox
 * at read time, so the suggester sees the right value without a duplicated
 * source of truth and without a "flag mysteriously turned on" UX smell.
 */

interface AcceptOpts {
  race: Race;
  action: ProposedTaperAction;
  /** Required for `insert-deload` so we know which program to slot into. */
  programId?: string;
  /** Required for `insert-deload`; pre-fetched program block list. */
  programBlocks?: readonly ProgramBlock[];
}

export interface AcceptResult {
  /** For `insert-deload`: the new block id so the caller can navigate. */
  blockId?: string;
}

export async function acceptAction(opts: AcceptOpts): Promise<AcceptResult> {
  const { race, action, programId, programBlocks } = opts;
  const dbi = getDb();
  const now = new Date().toISOString();
  const result: AcceptResult = {};

  let nextActions: RaceTaperActions = { ...(race.taperActions ?? {}) };

  if (action.kind === 'insert-deload') {
    if (!programId || !programBlocks) {
      throw new Error('insert-deload requires programId + programBlocks');
    }
    const { blockId } = await insertSeventhWeekBlock({
      programId,
      kind: 'deload',
      programBlocks,
    });
    nextActions = {
      ...nextActions,
      insertedDeload: { acceptedAt: now, blockId },
    };
    result.blockId = blockId;
  } else if (action.kind === 'activate-competition-peaking') {
    nextActions = {
      ...nextActions,
      competitionPeakingActivated: { acceptedAt: now },
    };
  }

  await dbi.races.put({
    ...race,
    taperActions: nextActions,
    updatedAt: now,
  });
  kickSync();
  return result;
}

export async function dismissAction(race: Race, action: ProposedTaperAction): Promise<void> {
  const dbi = getDb();
  const now = new Date().toISOString();
  let nextActions: RaceTaperActions = { ...(race.taperActions ?? {}) };

  if (action.kind === 'insert-deload') {
    nextActions = { ...nextActions, insertedDeload: { dismissedAt: now } };
  } else if (action.kind === 'activate-competition-peaking') {
    nextActions = {
      ...nextActions,
      competitionPeakingActivated: { dismissedAt: now },
    };
  }

  await dbi.races.put({
    ...race,
    taperActions: nextActions,
    updatedAt: now,
  });
  kickSync();
}
