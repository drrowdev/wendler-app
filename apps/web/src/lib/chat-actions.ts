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
