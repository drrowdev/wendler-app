'use client';

// Client-side dispatch + state for chat action chips.
//
// Each kind of ChatAction has a handler here. Handlers either open an
// existing UI flow pre-filled (log_injury → InjurySheet) or write directly
// to Dexie after a small inline confirmation (set_training_max,
// set_block_volume_preset, schedule_deload, substitute_movement). Status
// mutations (`applied` / `dismissed`) are persisted on the parent assistant
// ChatMessage so chip state survives reload + sync.
//
// Audit logging: every successful apply captures `appliedDetails` (per-kind
// before/after summary) on the chip itself AND posts a `notification` row
// so the user has a centralised history of "what the AI did". Failures
// stash the error message in `applyError`; the chip stays `pending` so the
// user can retry.
//
// New action kinds plug in by adding a discriminated-union branch in
// db-schema/types.ts plus a `applyXxx` handler here.

import { nanoid } from 'nanoid';
import type {
  ChatAction,
  ChatActionApplyDetails,
  Notification,
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
  patch: Partial<Pick<
    ChatAction,
    'status' | 'appliedAt' | 'dismissedAt' | 'undoneAt' | 'appliedDetails' | 'applyError'
  >>,
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

/**
 * Mark a chip as applied AND post a "chat-action" notification capturing
 * the human-readable summary + the structured `appliedDetails`. Centralises
 * the success path so each handler doesn't repeat the audit boilerplate.
 */
async function markApplied(
  chatId: string,
  messageId: string,
  action: ChatAction,
  details: ChatActionApplyDetails,
  summary: string,
): Promise<void> {
  const now = new Date().toISOString();
  await updateActionStatus(chatId, messageId, action.id, {
    status: 'applied',
    appliedAt: now,
    appliedDetails: details,
    applyError: undefined,
  });
  // Audit notification — keyed by action id so reapplies don't duplicate.
  const notification: Notification = {
    id: `chat-action:${action.id}`,
    channel: 'ai-action',
    severity: 'success',
    title: action.label,
    body: `${summary}${action.rationale ? ` — ${action.rationale}` : ''}`,
    createdAt: now,
    updatedAt: now,
    context: {
      kind: 'chat-action',
      actionKind: action.kind,
      chatId,
      messageId,
      details,
    },
  };
  try {
    await getDb().notifications.put(notification);
    kickSync();
  } catch {
    // Notification write is best-effort — never fail an apply because
    // the audit row couldn't be written.
  }
}

/**
 * Mark a chip as failed-to-apply: stash the error message on the chip so
 * the UI can show it inline. Leave `status` as 'pending' so the user can
 * retry from the same button.
 */
async function markFailed(
  chatId: string,
  messageId: string,
  action: ChatAction,
  error: string,
): Promise<void> {
  await updateActionStatus(chatId, messageId, action.id, {
    status: 'pending',
    applyError: error,
  });
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
 * Audit-only wrapper for `log_injury` chips. The actual injury creation
 * happens inside the InjurySheet (Coach proposal flow) — this helper is
 * called from the chip UI after `onSaved` so the chip records which Injury
 * record was produced and writes the standard audit notification.
 *
 * Reads the final saved values from the Injury record (not the chip's
 * original suggested values) so the audit reflects what the user actually
 * saved after any in-form edits to severity / area / description.
 */
export async function applyLogInjuryAudit(
  chatId: string,
  messageId: string,
  action: ChatAction & { kind: 'log_injury' },
  injuryId: string,
): Promise<void> {
  const saved = await getDb().injuries.get(injuryId);
  const area = saved?.area ?? action.area;
  const severity = saved?.severity ?? action.severity;
  await markApplied(
    chatId,
    messageId,
    action,
    { kind: 'log_injury', injuryId },
    `Logged limitation: ${area}${severity ? ` (severity ${severity}/5)` : ''}`,
  );
}

