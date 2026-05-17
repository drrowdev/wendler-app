'use client';

// ChatPanel — the reusable conversation widget. Same body renders both inside
// the FAB drawer and the full-screen /chat route. Owns the user-input box,
// message rendering (with markdown), suggested-prompt chips on empty state,
// the streaming/loading indicator, and inline title rename.
//
// Suggested prompts on the empty state are page-aware via
// `suggestedPromptsForPath(contextPath)` — opening the chat from
// /program/block surfaces block-specific starters, /calendar gets
// week-planning starters, etc.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Chat, ChatMessage } from '@wendler/db-schema';
import { suggestedPromptsForPath } from '@wendler/domain';
import { useChat, useChatSender, renameChat } from '@/lib/useChat';
import { getDb } from '@/lib/db';
import { ChatActionChips } from './ChatActionChips';

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
  // **Guard**: only fire while a send is in flight. After the user clicks
  // "+ New chat", chatId flips to null and useChatSender's sync effect
  // schedules setId(null) — but BOTH effects run in the same commit, so in
  // this render sender.id is still the previous conversation's id. Firing
  // here would bounce the URL right back. By requiring sender.sending the
  // effect only matches the intended case: a brand-new chat just minted
  // its id during the first turn's stream.
  useEffect(() => {
    if (sender.id && chatId === null && sender.sending) {
      onChatIdChangeRef.current?.(sender.id);
    }
  }, [sender.id, chatId, sender.sending]);

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

  // Proactive auto-send: when an external trigger (e.g. the injury
  // coach hook in InjurySheet) creates a chat with a primed user
  // message and `pendingAutoSend` set, fire the send automatically
  // the first time the chat is opened. Eliminates the "user has to
  // tap Send on a pre-filled prompt" step.
  //
  // Idempotency: the flag is cleared in Dexie BEFORE submit() is
  // called, so a re-render or remount won't refire. The per-id Set
  // is a belt-and-suspenders check against the same render firing
  // twice before the Dexie write settles.
  const autoSendFiredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!chat) return;
    if (!chat.pendingAutoSend) return;
    if (autoSendFiredRef.current.has(chat.id)) return;
    if (sender.sending) return;
    autoSendFiredRef.current.add(chat.id);
    const text = chat.pendingAutoSend;
    void (async () => {
      try {
        await getDb().chats.put({
          ...chat,
          pendingAutoSend: undefined,
          updatedAt: new Date().toISOString(),
        });
        await submit(text);
      } catch {
        // Best-effort. If the clear-then-submit fails, the user can
        // still see the primed prompt and send it manually.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id, chat?.pendingAutoSend, sender.sending]);

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

  // Page-aware suggested prompts on the empty state. Resolved from
  // `contextPath` (the route the user was on when opening the chat).
  // Falls back to the global set when the path doesn't match any
  // page rule.
  const suggestedPrompts = useMemo(
    () => suggestedPromptsForPath(contextPath),
    [contextPath],
  );

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
          <EmptyState onPick={(p) => void submit(p)} prompts={suggestedPrompts} />
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

function EmptyState({
  onPick,
  prompts,
}: {
  onPick: (prompt: string) => void;
  prompts: ReadonlyArray<{ title: string; body: string; icon: string }>;
}) {
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
        {prompts.map((p) => (
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
  // Auto-grow the textarea with content up to a cap, then scroll inside.
  // Plus user-resizable (drag the bottom edge) — handy for long prompts
  // where the auto-grow cap isn't enough.
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset to auto so shrink works when the user deletes content.
    el.style.height = 'auto';
    // Grow up to ~12 lines (~280px) before letting scroll take over.
    const next = Math.min(el.scrollHeight, 280);
    el.style.height = `${Math.max(next, 64)}px`;
  }, [value]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex items-end gap-2 border-t border-border bg-card/80 p-2"
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ask a question about your training… (⌘/Ctrl+Enter to send · drag bottom to resize)"
        rows={3}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="min-h-[4rem] max-h-[60vh] flex-1 resize-y rounded-md border border-border bg-bg px-2 py-1.5 text-sm leading-relaxed focus:border-accent focus:outline-none disabled:opacity-60"
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
