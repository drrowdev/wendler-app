'use client';

// ChatPanel — the reusable conversation widget. Same body renders both inside
// the FAB drawer and the full-screen /chat route. Owns the user-input box,
// message rendering (with markdown), suggested-prompt chips on empty state,
// the streaming/loading indicator, and inline title rename.

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Chat, ChatMessage } from '@wendler/db-schema';
import { useChat, useChatSender, renameChat } from '@/lib/useChat';
import { ChatActionChips } from './ChatActionChips';

const SUGGESTED_PROMPTS = [
  {
    title: 'Half-marathon readiness',
    body: 'Analyze my running history. Can I run my upcoming half-marathon under 2 hours, or do I need to increase my volume — and what kind of running given my overall load?',
    icon: '🏃',
  },
  {
    title: 'Race target check',
    body: 'Given my upcoming A-race, am I on track for the target time? What should I change in the next 4 weeks?',
    icon: '🎯',
  },
  {
    title: 'Where am I stalling?',
    body: 'Where are my strength gains stalling on the four main lifts? What should I change?',
    icon: '🪨',
  },
  {
    title: 'Plan next block',
    body: 'Plan my next training block given my current TMs, recent fatigue, race calendar, and Training Profile.',
    icon: '🧭',
  },
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const onChatIdChangeRef = useRef(onChatIdChange);
  useEffect(() => {
    onChatIdChangeRef.current = onChatIdChange;
  }, [onChatIdChange]);

  // Auto-scroll on new messages or streaming chunks.
  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [chat?.messages.length, sender.sending, sender.streaming, sender.toolCalls.length]);

  // Bubble up the chatId the moment the sender allocates it — NOT after
  // send() resolves. With tool-use turns running 20-30s, waiting for the
  // resolve meant the URL (and the panel's `chatId` prop) stayed null for
  // the whole turn, so the user saw an empty pane until everything landed
  // in one shot. By watching `sender.id`, the parent route updates the URL
  // the moment the user submits and the conversation is visible immediately.
  //
  // **Guard**: only fire when the parent is currently at `null` (= a brand-
  // new chat just got an id). If the parent flipped chatId to null via the
  // "+ New chat" button, sender.id still holds the previous conversation's
  // id in THIS render (the sync setId(null) inside useChatSender is queued
  // for the next render). Without this guard the bubble fires with the
  // stale id and bounces the URL right back to the old chat. With it, the
  // sync effect lands first on the next render and sender.id matches null.
  useEffect(() => {
    if (sender.id && chatId === null) {
      onChatIdChangeRef.current?.(sender.id);
    }
  }, [sender.id, chatId]);

  const submit = async (text: string) => {
    if (!text.trim() || sender.sending) return;
    setDraft('');
    try {
      const newId = await sender.send(text, { contextPath });
      // Bubble up the (possibly newly-minted) id once per send. Direct call
      // — not a useEffect — so we don't accidentally re-emit a stale id
      // when the parent flips chatId to null (e.g. "+ New").
      if (newId && newId !== chatId) onChatIdChangeRef.current?.(newId);
    } catch {
      // Surfaced via sender.error.
    }
  };

  const startRename = () => {
    if (!chat) return;
    setTitleDraft(chat.title);
    setEditingTitle(true);
  };
  const commitRename = async () => {
    if (chat && titleDraft.trim()) {
      await renameChat(chat.id, titleDraft);
    }
    setEditingTitle(false);
  };

  const isEmpty = !chat || chat.messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border bg-card/80 px-3 py-2 backdrop-blur">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitRename();
                } else if (e.key === 'Escape') {
                  setEditingTitle(false);
                }
              }}
              className="w-full rounded-md border border-border bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={chat ? startRename : undefined}
              disabled={!chat}
              title={chat ? 'Click to rename' : undefined}
              className="block w-full truncate text-left text-sm font-semibold hover:text-accent disabled:cursor-default disabled:hover:text-fg"
            >
              {chat?.title ?? 'New chat'}
            </button>
          )}
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
              <MessageBubble key={m.id} chatId={chat!.id} message={m} />
            ))}
            {sender.sending && (
              <StreamingBubble
                text={sender.streaming}
                toolCalls={sender.toolCalls}
                phase={sender.phase}
              />
            )}
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
    <div className="mx-auto max-w-md space-y-4 px-1 py-2 text-sm">
      <div className="space-y-1 text-center">
        <div className="text-2xl">💬</div>
        <h3 className="text-base font-semibold">Ask your training coach</h3>
        <p className="text-xs text-muted">
          Grounded in your strength, cardio, recovery, race, and profile data.
        </p>
      </div>
      <ul className="space-y-2">
        {SUGGESTED_PROMPTS.map((p) => (
          <li key={p.title}>
            <button
              type="button"
              onClick={() => onPick(p.body)}
              className="group flex w-full items-start gap-3 rounded-xl border border-border bg-bg/40 px-3 py-2.5 text-left transition hover:border-accent hover:bg-accent/5"
            >
              <span aria-hidden className="mt-0.5 text-base">{p.icon}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-fg group-hover:text-accent">
                  {p.title}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted">
                  {p.body}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="pt-1 text-center text-[10px] text-muted">
        Your data stays private — sent to Claude per turn, never stored server-side.
      </p>
    </div>
  );
}

function MessageBubble({ chatId, message }: { chatId: string; message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <li className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? 'whitespace-pre-wrap bg-accent/15 text-fg'
            : 'border border-border bg-card text-fg'
        }`}
      >
        {isUser ? message.content : <MarkdownBody content={message.content} />}
        {!isUser && message.actions && message.actions.length > 0 && (
          <ChatActionChips
            chatId={chatId}
            messageId={message.id}
            actions={message.actions}
          />
        )}
      </div>
    </li>
  );
}

function StreamingBubble({
  text,
  toolCalls,
  phase,
}: {
  text: string;
  toolCalls: import('@/lib/useChat').ToolCallStatus[];
  phase: import('@/lib/useChat').ChatTurnPhase;
}) {
  // Loading-state copy. Even when text has started streaming we keep
  // showing the spinner so the user has something to look at if the model
  // pauses mid-paragraph.
  const loadingText =
    phase === 'consulting'
      ? 'Consulting specialists…'
      : phase === 'composing'
        ? 'Composing reply…'
        : 'Thinking…';
  return (
    <li className="flex justify-start">
      <div className="max-w-[90%] rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg">
        {toolCalls.length > 0 && (
          <ul className="mb-2 space-y-0.5 text-[11px]">
            {toolCalls.map((tc) => (
              <li key={tc.id} className="flex items-center gap-1.5 text-muted">
                <span aria-hidden className={tc.endedAtMs ? '' : 'inline-block animate-spin'}>
                  {tc.endedAtMs ? '✓' : '↻'}
                </span>
                <span className="font-semibold text-fg/80">{specialistLabel(tc.name)}</span>
                {tc.endedAtMs && (
                  <span className="text-muted">
                    ({Math.round((tc.endedAtMs - tc.startedAtMs) / 100) / 10}s
                    {tc.outputTokens != null && tc.outputTokens > 0
                      ? ` · ${tc.outputTokens} tok`
                      : ''}
                    )
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {text ? (
          <>
            <MarkdownBody content={text} />
            <span className="ml-0.5 inline-block h-3 w-2 animate-pulse bg-accent align-middle" aria-hidden />
          </>
        ) : (
          <span className="text-muted">
            <span className="inline-flex gap-0.5">
              <span className="animate-pulse">•</span>
              <span className="animate-pulse [animation-delay:120ms]">•</span>
              <span className="animate-pulse [animation-delay:240ms]">•</span>
            </span>
            <span className="ml-2">{loadingText}</span>
          </span>
        )}
      </div>
    </li>
  );
}

function specialistLabel(toolName: string): string {
  switch (toolName) {
    case 'consult_coach':
      return 'Coach';
    case 'consult_programmer':
      return 'Programmer';
    case 'consult_periodizer':
      return 'Periodizer';
    case 'summarize_week':
      return 'Weekly summary';
    default:
      return toolName;
  }
}

function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h1 className="mt-3 mb-1 text-base font-semibold" {...props} />,
          h2: (props) => <h2 className="mt-3 mb-1 text-sm font-semibold" {...props} />,
          h3: (props) => <h3 className="mt-2 mb-1 text-sm font-semibold" {...props} />,
          p: (props) => <p className="my-1.5 leading-relaxed" {...props} />,
          ul: (props) => <ul className="my-1.5 list-disc space-y-0.5 pl-5" {...props} />,
          ol: (props) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5" {...props} />,
          li: (props) => <li className="leading-relaxed" {...props} />,
          strong: (props) => <strong className="font-semibold text-fg" {...props} />,
          em: (props) => <em className="italic" {...props} />,
          code: ({ className, children, ...props }) => {
            const isBlock = className?.includes('language-');
            if (isBlock) {
              return (
                <code className="block whitespace-pre-wrap rounded-md bg-bg/80 p-2 text-[12px] font-mono" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-bg/70 px-1 py-0.5 text-[12px] font-mono" {...props}>
                {children}
              </code>
            );
          },
          pre: (props) => <pre className="my-2 overflow-x-auto" {...props} />,
          blockquote: (props) => (
            <blockquote className="my-2 border-l-2 border-accent/50 pl-3 text-muted" {...props} />
          ),
          table: (props) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]" {...props} />
            </div>
          ),
          th: (props) => (
            <th className="border-b border-border px-2 py-1 text-left font-semibold" {...props} />
          ),
          td: (props) => <td className="border-b border-border/40 px-2 py-1 align-top" {...props} />,
          a: (props) => (
            <a className="text-accent underline-offset-2 hover:underline" target="_blank" rel="noreferrer" {...props} />
          ),
          hr: () => <hr className="my-3 border-border" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
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
 * Conversation list — used on the full-screen route's sidebar and the
 * drawer's history affordance.
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
                  if (confirm('Delete this conversation?')) {
                    void import('@/lib/useChat').then((m) => m.deleteChat(c.id));
                  }
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
    </div>
  );
}
