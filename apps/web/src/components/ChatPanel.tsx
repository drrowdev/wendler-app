'use client';

// ChatPanel — the reusable conversation widget. Same body renders both inside
// the FAB drawer and the full-screen /chat route. Owns the user-input box,
// message rendering, suggested-prompt chips on empty state, and the loading
// indicator. Conversation persistence lives in `useChat` / `useChatSender`.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Chat, ChatMessage } from '@wendler/db-schema';
import { useChat, useChatSender, deleteChat } from '@/lib/useChat';

const SUGGESTED_PROMPTS = [
  'Analyze my running history and tell me what you see.',
  'Given my upcoming A-race, am I on track for my target time?',
  'Where are my strength gains stalling? What should I change?',
  'Plan my next training block given everything you know.',
  'How does my last 4 weeks compare to the same period last year?',
];

interface ChatPanelProps {
  chatId: string | null;
  /** Pathname the user was on when invoking the chat (for "this block/run" context). */
  contextPath?: string;
  /** Header slot for variant-specific buttons (close / expand / new). */
  headerSlot?: React.ReactNode;
  /** Called when the sender mints a new conversation id (so URL can be synced). */
  onChatIdChange?: (id: string) => void;
}

export function ChatPanel({ chatId, contextPath, headerSlot, onChatIdChange }: ChatPanelProps) {
  const chat = useChat(chatId);
  const sender = useChatSender(chatId);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const onChatIdChangeRef = useRef(onChatIdChange);
  useEffect(() => {
    onChatIdChangeRef.current = onChatIdChange;
  }, [onChatIdChange]);

  // Bubble the new id back to the URL once after first send.
  useEffect(() => {
    if (sender.id && sender.id !== chatId) {
      onChatIdChangeRef.current?.(sender.id);
    }
  }, [sender.id, chatId]);

  // Auto-scroll on new messages.
  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [chat?.messages.length, sender.sending]);

  const submit = async (text: string) => {
    if (!text.trim() || sender.sending) return;
    setDraft('');
    try {
      await sender.send(text, { contextPath });
    } catch {
      // Error is surfaced via sender.error; leave the draft empty so the
      // user can retype if they want.
    }
  };

  const isEmpty = !chat || chat.messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border bg-card/80 px-3 py-2 backdrop-blur">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{chat?.title ?? 'New chat'}</h2>
          <p className="text-[10px] text-muted">
            Grounded in your training snapshot · Sonnet 4.6
          </p>
        </div>
        {headerSlot}
      </header>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {isEmpty ? (
          <EmptyState onPick={(p) => void submit(p)} />
        ) : (
          <ul className="space-y-3">
            {chat!.messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {sender.sending && <PendingBubble />}
          </ul>
        )}
        {sender.error && (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
            {sender.error}
          </div>
        )}
      </div>

      <Composer
        value={draft}
        disabled={sender.sending}
        onChange={setDraft}
        onSubmit={() => void submit(draft)}
      />
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">
        Ask anything about your training. Some ideas:
      </p>
      <ul className="space-y-1.5">
        {SUGGESTED_PROMPTS.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => onPick(p)}
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-left text-sm text-fg hover:border-accent hover:bg-accent/10"
            >
              {p}
            </button>
          </li>
        ))}
      </ul>
      <p className="pt-1 text-[11px] text-muted">
        Your data stays private. Each turn sends a fresh snapshot to Claude
        and the response is logged on your devices via the existing sync.
      </p>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <li className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? 'bg-accent/15 text-fg'
            : 'border border-border bg-card text-fg'
        }`}
      >
        {message.content}
      </div>
    </li>
  );
}

function PendingBubble() {
  return (
    <li className="flex justify-start">
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted">
        <span className="inline-flex gap-0.5">
          <span className="animate-pulse">•</span>
          <span className="animate-pulse [animation-delay:120ms]">•</span>
          <span className="animate-pulse [animation-delay:240ms]">•</span>
        </span>
        <span className="ml-2">Thinking…</span>
      </div>
    </li>
  );
}

function Composer({
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex items-end gap-2 border-t border-border bg-card/80 p-2"
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ask a question about your training…"
        rows={2}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="flex-1 resize-none rounded-md border border-border bg-bg px-2 py-1.5 text-sm focus:border-accent focus:outline-none disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}

/**
 * Conversation list — used on the full-screen route's sidebar. The drawer
 * exposes a "history" affordance that pops this in place.
 */
export function ChatConversationList({
  selectedId,
  conversations,
  onSelect,
  onNew,
}: {
  selectedId: string | null;
  conversations: Chat[] | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">Chats</span>
        <button
          type="button"
          onClick={onNew}
          className="rounded-md border border-accent/60 bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent"
        >
          + New
        </button>
      </header>
      <ul className="flex-1 overflow-y-auto py-1 text-sm">
        {(conversations ?? []).map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-bg/40 ${
                c.id === selectedId ? 'bg-accent/10 text-fg' : 'text-muted'
              }`}
            >
              <span className="flex-1 truncate">{c.title}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm('Delete this conversation?')) void deleteChat(c.id);
                }}
                className="ml-2 text-[10px] text-muted/70 hover:text-rose-300"
                aria-label="Delete"
              >
                ×
              </button>
            </button>
          </li>
        ))}
        {(!conversations || conversations.length === 0) && (
          <li className="px-3 py-3 text-xs text-muted">No conversations yet.</li>
        )}
      </ul>
      <footer className="border-t border-border px-3 py-2 text-[10px] text-muted">
        <Link href="/chat" className="hover:text-fg">
          Open full screen →
        </Link>
      </footer>
    </div>
  );
}
