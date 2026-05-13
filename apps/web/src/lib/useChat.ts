'use client';

// useChat — Dexie-backed hook that owns a single conversation thread, sends
// new user messages to /api/chat, and persists the result. The drawer + the
// full-screen route both consume this hook. State lives in Dexie so the
// conversation survives reloads and syncs across devices via the LWW
// pipeline (see sync.ts → chat kind).

import { useCallback, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import type { Chat, ChatMessage } from '@wendler/db-schema';
import {
  buildChatContext,
  renderChatContextAsText,
  type MinimalChatCardio,
  type MinimalChatRace,
  type MinimalChatRecovery,
  type MinimalChatSet,
  type MinimalChatTrainingMax,
} from '@wendler/domain';
import { getDb } from './db';
import { kickSync } from './sync';
import { authFetch } from './auth';

export interface UseChatOptions {
  /** Existing conversation id, or null to create on first send. */
  id: string | null;
}

export interface SendOptions {
  /** Path the user was on when invoking the chat (for context). */
  contextPath?: string;
}

interface ChatApiOk {
  ok: true;
  content: string;
  modelInfo: { model: string; elapsedMs: number; inputTokens?: number; outputTokens?: number };
}

interface ChatApiErr {
  error: string;
  detail?: string;
}

/** Live conversation read straight from Dexie (or null when not yet created). */
export function useChat(id: string | null): Chat | null | undefined {
  return useLiveQuery(async () => {
    if (!id) return null;
    return (await getDb().chats.get(id)) ?? null;
  }, [id]);
}

/** Listing of all conversations, newest first, for the drawer history view. */
export function useChatList(): Chat[] | undefined {
  return useLiveQuery(async () => {
    const all = await getDb().chats.toArray();
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
}

async function buildContextBlob(): Promise<string> {
  const db = getDb();
  const [sets, cardio, recovery, races, tms, settings, movements] = await Promise.all([
    db.sets.toArray(),
    db.cardio.toArray(),
    db.recovery.toArray(),
    db.races.toArray(),
    db.trainingMaxes.toArray(),
    db.settings.get('singleton'),
    db.movements.toArray(),
  ]);
  const movementName = new Map(movements.map((m) => [m.id, m.name]));
  const summary = buildChatContext({
    now: new Date(),
    sets: sets as MinimalChatSet[],
    cardio: cardio as MinimalChatCardio[],
    recovery: recovery as MinimalChatRecovery[],
    races: races as MinimalChatRace[],
    trainingMaxes: tms as MinimalChatTrainingMax[],
    profile: settings?.trainingProfile,
    movementName,
  });
  return renderChatContextAsText(summary);
}

function titleFromFirstMessage(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? 'New chat';
  return firstLine.length <= 80 ? firstLine : firstLine.slice(0, 77) + '…';
}

export interface UseChatSender {
  send: (content: string, opts?: SendOptions) => Promise<string>;
  /** Conversation id (existing or newly minted on first send). */
  id: string | null;
  sending: boolean;
  error: string | null;
}

/**
 * useChatSender — handles new-message submission. Splits from `useChat` so the
 * drawer can render the live conversation while sending in parallel.
 *
 * On first `send`, mints a new Chat row and returns its id (so the caller can
 * pin it to URL state). On subsequent sends, appends to the same row.
 */
export function useChatSender(initialId: string | null): UseChatSender {
  const [id, setId] = useState<string | null>(initialId);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (content: string, opts: SendOptions = {}): Promise<string> => {
      if (sending) throw new Error('Already sending');
      const trimmed = content.trim();
      if (!trimmed) throw new Error('Empty message');
      setError(null);
      setSending(true);
      try {
        const db = getDb();
        const now = new Date().toISOString();
        const userMsg: ChatMessage = {
          id: nanoid(),
          role: 'user',
          content: trimmed,
          createdAt: now,
          ...(opts.contextPath ? { contextPath: opts.contextPath } : {}),
        };
        let chatId = id;
        let existing: Chat | undefined;
        if (chatId) {
          existing = await db.chats.get(chatId);
        }
        const messagesSoFar: ChatMessage[] = existing
          ? [...existing.messages, userMsg]
          : [userMsg];
        const chatRow: Chat = existing
          ? { ...existing, messages: messagesSoFar, updatedAt: now }
          : {
              id: chatId ?? nanoid(),
              createdAt: now,
              updatedAt: now,
              title: titleFromFirstMessage(trimmed),
              messages: messagesSoFar,
            };
        chatId = chatRow.id;
        if (!id) setId(chatId);
        await db.chats.put(chatRow);
        kickSync();

        // Build context fresh per turn so newly logged data is always seen.
        const contextBlob = await buildContextBlob();

        const resp = await authFetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            context: contextBlob,
            contextPath: opts.contextPath,
            messages: messagesSoFar.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as ChatApiErr;
          throw new Error(body.detail ?? body.error ?? `HTTP ${resp.status}`);
        }
        const body = (await resp.json()) as ChatApiOk;
        const replyTs = new Date().toISOString();
        const assistantMsg: ChatMessage = {
          id: nanoid(),
          role: 'assistant',
          content: body.content,
          createdAt: replyTs,
        };
        const finalMessages = [...messagesSoFar, assistantMsg];
        await db.chats.put({
          ...chatRow,
          messages: finalMessages,
          updatedAt: replyTs,
        });
        kickSync();
        return chatId;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setSending(false);
      }
    },
    [id, sending],
  );

  return { send, id, sending, error };
}

/** Delete a chat conversation. */
export async function deleteChat(id: string): Promise<void> {
  const { deleteWithTombstones } = await import('./delete');
  await deleteWithTombstones('chat', [id]);
}
