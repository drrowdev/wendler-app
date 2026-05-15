'use client';

// Client-side dispatch + state for chat action chips.
//
// Each kind of ChatAction has a handler here. Handlers either open an
// existing UI flow pre-filled (log_injury → InjurySheet) or write directly
// to Dexie after a small inline confirmation (set_training_max,
// set_block_volume_preset). Status mutations (`applied` / `dismissed`)
// are persisted on the parent assistant ChatMessage so the chip state
// survives reload + sync.
//
// New action kinds plug in by adding a discriminated-union branch in
// db-schema/types.ts plus a `applyXxx` handler here.

import { nanoid } from 'nanoid';
import type {
  ChatAction,
  TrainingMaxRecord,
  ProgramBlock,
} from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';

/**
 * Update a single action chip's status inside a chat message and write
 * the change to Dexie. Returns the updated action for convenience.
 */
export async function updateActionStatus(
  chatId: string,
  messageId: string,
  actionId: string,
  patch: Pick<ChatAction, 'status' | 'appliedAt' | 'dismissedAt'>,
): Promise<ChatAction | undefined> {
  const db = getDb();
  const chat = await db.chats.get(chatId);
  if (!chat) return undefined;
  let updatedAction: ChatAction | undefined;
  const messages = chat.messages.map((m) => {
    if (m.id !== messageId || !m.actions) return m;
    const actions = m.actions.map((a) => {
      if (a.id !== actionId) return a;
      const merged = { ...a, ...patch } as ChatAction;
      updatedAction = merged;
      return merged;
    });
    return { ...m, actions };
  });
  await db.chats.put({ ...chat, messages, updatedAt: new Date().toISOString() });
  kickSync();
  return updatedAction;
}

export async function dismissAction(
  chatId: string,
  messageId: string,
  actionId: string,
): Promise<void> {
  await updateActionStatus(chatId, messageId, actionId, {
    status: 'dismissed',
    dismissedAt: new Date().toISOString(),
  });
}

/**
 * Apply a `set_training_max` action: write a new TrainingMaxRecord with
 * the proposed kg value. The previous record stays in the table (TMs are
 * historical), so the new row simply takes effect via the latest-by-lift
 * lookup the rest of the app uses.
 */
export async function applySetTrainingMax(
  chatId: string,
  messageId: string,
  action: ChatAction & { kind: 'set_training_max' },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  // Inherit the user's configured TM% (defaults to 0.85). Stored as a
  // fraction in settings; TrainingMaxRecord.tmPercent uses the same
  // 0-1 fraction convention.
  const settings = await db.settings.get('singleton');
  const tmPercent = settings?.defaultTmPercent ?? 0.85;
  const record: TrainingMaxRecord = {
    id: nanoid(),
    lift: action.lift,
    trainingMaxKg: action.newTrainingMaxKg,
    tmPercent,
    createdAt: now,
    source: 'manual',
    note: `Chat: ${action.reason}`,
  };
  try {
    await db.trainingMaxes.put(record);
    await updateActionStatus(chatId, messageId, action.id, {
      status: 'applied',
      appliedAt: now,
    });
    kickSync();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Apply a `set_block_volume_preset` action: update the targeted block's
 * `assistanceVolume` field. Defaults to the currently active block when
 * the chip didn't specify one.
 */
export async function applySetBlockVolumePreset(
  chatId: string,
  messageId: string,
  action: ChatAction & { kind: 'set_block_volume_preset' },
): Promise<{ ok: true; block: ProgramBlock } | { ok: false; error: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  let block: ProgramBlock | undefined;
  if (action.blockId) {
    block = await db.blocks.get(action.blockId);
  }
  if (!block) {
    // Fall back to the currently active block (no completedAt).
    const all = await db.blocks.toArray();
    block = all.find((b) => !b.completedAt);
  }
  if (!block) {
    return { ok: false, error: 'No active block found to update.' };
  }
  try {
    await db.blocks.put({
      ...block,
      assistanceVolume: action.preset,
      updatedAt: now,
    } as ProgramBlock);
    await updateActionStatus(chatId, messageId, action.id, {
      status: 'applied',
      appliedAt: now,
    });
    kickSync();
    return { ok: true, block };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Apply a `schedule_deload` action: create a 7th-week deload block in the
 * active program, sequenced right after the currently-active block. Does
 * NOT truncate the active block — the user finishes their current week as
 * planned, then the deload block becomes active. Mirrors the most
 * conservative interpretation of "deload next" Wendler is built around.
 */
export async function applyScheduleDeload(
  chatId: string,
  messageId: string,
  action: ChatAction & { kind: 'schedule_deload' },
): Promise<{ ok: true; block: ProgramBlock } | { ok: false; error: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  const all = await db.blocks.toArray();
  const activeBlock = all.find((b) => !b.completedAt);
  if (!activeBlock) {
    return { ok: false, error: 'No active block found.' };
  }
  // Find the highest sequenceIndex inside the same program so we can slot
  // the new block right after. When the active block has no programId
  // (free-standing), the new deload block is also free-standing.
  const programId = activeBlock.programId;
  const peers = programId
    ? all.filter((b) => b.programId === programId)
    : [activeBlock];
  const maxSeq = peers.reduce(
    (acc, b) => Math.max(acc, b.sequenceIndex ?? 0),
    0,
  );
  const deloadBlock: ProgramBlock = {
    id: nanoid(),
    name: 'Deload week',
    kind: 'seventh-week',
    seventhWeekKind: 'deload',
    weeksBeforeDeload: 1,
    includesDeload: true,
    supplementalTemplate: activeBlock.supplementalTemplate,
    mainScheme: activeBlock.mainScheme,
    createdAt: now,
    updatedAt: now,
    ...(programId ? { programId } : {}),
    sequenceIndex: maxSeq + 1,
  };
  try {
    await db.blocks.put(deloadBlock);
    await updateActionStatus(chatId, messageId, action.id, {
      status: 'applied',
      appliedAt: now,
    });
    kickSync();
    return { ok: true, block: deloadBlock };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Apply a `substitute_movement` action: swap one assistance entry's
 * movement on a specific day of a block. Matches the target entry by
 * movementId, scoped to a specific day via `dayId` (preferred) or
 * `dayIndex`, falling back to the first matching entry in the block
 * when neither is set.
 *
 * Validation hard-fails (rather than silently doing nothing) when:
 *   - the target block can't be found
 *   - the replacement movementId isn't in the user's library
 *   - no entry matches the currentMovementId on the resolved day
 *
 * On success, the entry's movementId + movementName are updated. Other
 * fields (sets, reps, category, etc.) are preserved.
 */
export async function applySubstituteMovement(
  chatId: string,
  messageId: string,
  action: ChatAction & { kind: 'substitute_movement' },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  let block: ProgramBlock | undefined;
  if (action.blockId) {
    block = await db.blocks.get(action.blockId);
  }
  if (!block) {
    const all = await db.blocks.toArray();
    block = all.find((b) => !b.completedAt);
  }
  if (!block) return { ok: false, error: 'No active block found.' };
  if (!block.plan || block.plan.days.length === 0) {
    return { ok: false, error: 'Active block has no assistance plan yet.' };
  }

  const newMovement = await db.movements.get(action.newMovementId);
  if (!newMovement) {
    return {
      ok: false,
      error: `Replacement movement \`${action.newMovementId}\` is not in your library.`,
    };
  }

  // Resolve target day. dayId wins; then dayIndex; then "the first day
  // that has a matching entry".
  let targetDayIdxs: number[] = [];
  if (action.dayId) {
    const idx = block.plan.days.findIndex((d) => d.id === action.dayId);
    if (idx < 0) {
      return { ok: false, error: `Day id \`${action.dayId}\` not found in block.` };
    }
    targetDayIdxs = [idx];
  } else if (typeof action.dayIndex === 'number') {
    if (action.dayIndex < 0 || action.dayIndex >= block.plan.days.length) {
      return { ok: false, error: `dayIndex ${action.dayIndex} is out of range.` };
    }
    targetDayIdxs = [action.dayIndex];
  } else {
    targetDayIdxs = block.plan.days.map((_, i) => i);
  }

  let swapped = false;
  const newDays = block.plan.days.map((d, di) => {
    if (!targetDayIdxs.includes(di)) return d;
    if (swapped) return d; // only swap on the first matching day
    const newAssistance = d.assistance.map((e) => {
      if (swapped) return e;
      if (e.movementId !== action.currentMovementId) return e;
      swapped = true;
      return {
        ...e,
        movementId: action.newMovementId,
        movementName: action.newMovementName || newMovement.name,
        // Clear the auto-generated suggester rationale — it described the
        // old pick.
        suggestionRationale: undefined,
      };
    });
    return { ...d, assistance: newAssistance };
  });
  if (!swapped) {
    return {
      ok: false,
      error: `No assistance entry with movementId \`${action.currentMovementId}\` found on the target day(s).`,
    };
  }

  const updated: ProgramBlock = {
    ...block,
    plan: { ...block.plan, days: newDays },
    updatedAt: now,
  };
  try {
    await db.blocks.put(updated);
    await updateActionStatus(chatId, messageId, action.id, {
      status: 'applied',
      appliedAt: now,
    });
    kickSync();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
