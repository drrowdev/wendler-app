'use client';

// useChat — Dexie-backed hook that owns a single conversation thread, sends
// new user messages to /api/chat (SSE-streaming), and persists the result.
// The drawer + the full-screen route both consume this hook. State lives in
// Dexie so the conversation survives reloads and syncs across devices via
// the LWW pipeline (see sync.ts → chat kind).

import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import type { Chat, ChatAction, ChatMessage } from '@wendler/db-schema';
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

export interface SendOptions {
  /** Path the user was on when invoking the chat (for context). */
  contextPath?: string;
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

export interface ToolCallStatus {
  /** Anthropic tool_use id — stable for the duration of the turn. */
  id: string;
  /** Tool name as registered (e.g. "consult_coach"). */
  name: string;
  /** When the dispatch started (perf.now-style ms timestamp). */
  startedAtMs: number;
  /** When the dispatch finished. Undefined while still in flight. */
  endedAtMs?: number;
  /** Tokens consumed by the specialist call. Undefined while in flight. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * High-level phase of the current send. Useful for picking the right
 * "what is the assistant doing right now?" loading message in the UI.
 *
 *   - `idle`        : nothing in flight
 *   - `thinking`    : Claude is generating its first response chunk
 *                     (before any tool use or final text)
 *   - `consulting`  : at least one tool dispatch is in flight
 *   - `composing`   : tools have completed; waiting for Claude's final
 *                     iteration to start streaming text
 *   - `streaming`   : final text deltas are arriving
 */
export type ChatTurnPhase =
  | 'idle'
  | 'thinking'
  | 'consulting'
  | 'composing'
  | 'streaming';

export interface UseChatSender {
  send: (content: string, opts?: SendOptions) => Promise<string>;
  /** Conversation id (existing or newly minted on first send). */
  id: string | null;
  sending: boolean;
  /** In-progress streaming text (assistant turn being received). */
  streaming: string;
  /** Tool calls dispatched during the current turn (most-recent last). Cleared between turns. */
  toolCalls: ToolCallStatus[];
  /** High-level phase of the current turn for UI loading messages. */
  phase: ChatTurnPhase;
  error: string | null;
}

/**
 * useChatSender — handles new-message submission with SSE streaming. Splits
 * from `useChat` so the drawer can render the live conversation while a
 * response streams in. The pre-final assistant text is exposed as
 * `streaming` and rendered as a pending bubble by the panel.
 */
export function useChatSender(externalId: string | null): UseChatSender {
  const [id, setId] = useState<string | null>(externalId);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCallStatus[]>([]);
  const [phase, setPhase] = useState<ChatTurnPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  // Keep internal id in sync when the parent switches conversations
  // (e.g. user clicks "New chat" → externalId becomes null). Without this,
  // the sender would keep appending to the previous conversation. We skip
  // mid-send to avoid clobbering an in-flight request.
  useEffect(() => {
    if (!sending) setId(externalId);
  }, [externalId, sending]);

  const send = useCallback(
    async (content: string, opts: SendOptions = {}): Promise<string> => {
      if (sending) throw new Error('Already sending');
      const trimmed = content.trim();
      if (!trimmed) throw new Error('Empty message');
      setError(null);
      setSending(true);
      setStreaming('');
      setToolCalls([]);
      setPhase('thinking');
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

        const contextBlob = await buildContextBlob();

        // Today's date in the user's local timezone (YYYY-MM-DD). The API
        // injects this verbatim into the system prompt so the model can
        // reason about "race in N weeks" without guessing.
        const todayLocal = (() => {
          const d = new Date();
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return `${y}-${m}-${day}`;
        })();

        const resp = await authFetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            context: contextBlob,
            contextPath: opts.contextPath,
            todayLocal,
            messages: messagesSoFar.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        if (!resp.ok || !resp.body) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string; detail?: string };
          throw new Error(body.detail ?? body.error ?? `HTTP ${resp.status}`);
        }

        // Parse the SSE stream. Each event is `data: {json}\n\n`. We
        // accumulate `delta` events into `accumulated`, mirror to local
        // `streaming` for live render, and finalize on `done`.
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let accumulatedActions: ChatAction[] = [];
        let streamErr: string | null = null;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Split on the SSE event delimiter; keep partial trailing data
          // in the buffer for the next iteration.
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const eventBlock = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = eventBlock
              .split('\n')
              .find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json) continue;
            try {
              const evt = JSON.parse(json) as
                | { type: 'delta'; text: string }
                | { type: 'done'; modelInfo: unknown }
                | { type: 'error'; detail: string }
                | { type: 'tool_use_start'; id: string; name: string }
                | {
                    type: 'tool_use_end';
                    id: string;
                    name: string;
                    durationMs: number;
                    inputTokens: number;
                    outputTokens: number;
                  }
                | { type: 'composing_start' }
                | { type: 'action_chips'; actions: ChatAction[] };
              if (evt.type === 'delta') {
                accumulated += evt.text;
                setStreaming(accumulated);
                setPhase('streaming');
              } else if (evt.type === 'error') {
                streamErr = evt.detail;
              } else if (evt.type === 'action_chips') {
                accumulatedActions = evt.actions;
              } else if (evt.type === 'tool_use_start') {
                setToolCalls((prev) => [
                  ...prev,
                  {
                    id: evt.id,
                    name: evt.name,
                    startedAtMs: Date.now(),
                  },
                ]);
                setPhase('consulting');
              } else if (evt.type === 'tool_use_end') {
                setToolCalls((prev) =>
                  prev.map((tc) =>
                    tc.id === evt.id
                      ? {
                          ...tc,
                          endedAtMs: Date.now(),
                          inputTokens: evt.inputTokens,
                          outputTokens: evt.outputTokens,
                        }
                      : tc,
                  ),
                );
              } else if (evt.type === 'composing_start') {
                setPhase('composing');
              }
            } catch {
              // Tolerate keep-alives or malformed lines without aborting.
            }
          }
        }
        if (streamErr) throw new Error(streamErr);
        if (!accumulated.trim()) throw new Error('Empty response from model');

        const replyTs = new Date().toISOString();
        const assistantMsg: ChatMessage = {
          id: nanoid(),
          role: 'assistant',
          content: accumulated,
          createdAt: replyTs,
          ...(accumulatedActions.length > 0 ? { actions: accumulatedActions } : {}),
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
        setStreaming('');
        setPhase('idle');
      }
    },
    [id, sending],
  );

  return { send, id, sending, streaming, toolCalls, phase, error };
}

/** Rename a chat conversation. */
export async function renameChat(id: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  const db = getDb();
  const row = await db.chats.get(id);
  if (!row) return;
  await db.chats.put({
    ...row,
    title: trimmed.length <= 80 ? trimmed : trimmed.slice(0, 77) + '…',
    updatedAt: new Date().toISOString(),
  });
  kickSync();
}

/** Delete a chat conversation. */
export async function deleteChat(id: string): Promise<void> {
  const { deleteWithTombstones } = await import('./delete');
  await deleteWithTombstones('chat', [id]);
}
