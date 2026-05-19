'use client';

// ChatDrawer — slide-up panel on mobile, right-anchored drawer on desktop.
// Hosts a `ChatPanel`. Owns its own ephemeral conversation-id state so the
// user can chat without leaving the page; "Expand" opens the full-screen
// /chat route preserving the conversation id via query string.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChatConversationList, ChatPanel } from './ChatPanel';
import { useChatList } from '@/lib/useChat';

export function ChatDrawer({
  pathname,
  onClose,
  chatId,
  setChatId,
  setUserTouched,
}: {
  pathname: string;
  onClose: () => void;
  chatId: string | null;
  setChatId: (id: string | null) => void;
  /** Retained for ChatFab→drawer prop contract; no longer read here. */
  userTouched: boolean;
  setUserTouched: (v: boolean) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const conversations = useChatList();

  // First-open behavior: land on a fresh blank composer, NOT on the most-
  // recently-updated conversation. Auto-selecting most-recent kept dropping
  // the user into the auto-created Daily Brief thread (whose prompt was
  // surfacing visibly before the assistant reply rendered). Fresh-state-
  // first lets the user start a new question without seeing implementation
  // details, and the history list + notification deep-links remain the
  // explicit ways to resume a specific past thread.
  //
  // `chatId` is hoisted from ChatFab so a user's explicit selection still
  // survives drawer close → reopen and route changes — only the *initial*
  // null state is preserved here.

  const selectChat = (id: string | null) => {
    setUserTouched(true);
    setChatId(id);
  };

  // Escape closes drawer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Lock body scroll while the drawer is open so touch-drags inside the
  // chat list scroll the LIST instead of bubbling up to the page beneath
  // (iOS Safari + WKWebView are particularly aggressive about this).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-end bg-black/40 md:items-stretch"
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-label="AI chat"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full flex-col rounded-t-2xl border border-border bg-card shadow-2xl md:h-full md:w-[480px] md:rounded-l-2xl md:rounded-tr-none"
        style={{ maxHeight: '92dvh' }}
      >
        {historyOpen ? (
          <ChatConversationList
            selectedId={chatId}
            conversations={conversations}
            onSelect={(id) => {
              selectChat(id);
              setHistoryOpen(false);
            }}
            onNew={() => {
              selectChat(null);
              setHistoryOpen(false);
            }}
          />
        ) : (
          <ChatPanel
            chatId={chatId}
            contextPath={pathname}
            onChatIdChange={(id) => {
              setUserTouched(true);
              setChatId(id);
            }}
            headerSlot={
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => selectChat(null)}
                  aria-label="New chat"
                  title="New chat"
                  className="rounded-md p-1.5 text-muted hover:bg-bg/50 hover:text-fg"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(true)}
                  aria-label="Chat history"
                  title="History"
                  className="rounded-md p-1.5 text-muted hover:bg-bg/50 hover:text-fg"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
                  </svg>
                </button>
                <Link
                  href={chatId ? `/chat?id=${chatId}` : '/chat'}
                  onClick={onClose}
                  aria-label="Open full screen"
                  title="Open full screen"
                  className="rounded-md p-1.5 text-muted hover:bg-bg/50 hover:text-fg"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <path d="M3 10V3h7M21 14v7h-7M3 21l8-8M21 3l-8 8" strokeLinecap="round" />
                  </svg>
                </Link>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close chat"
                  className="rounded-md p-1.5 text-muted hover:bg-bg/50 hover:text-fg"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            }
          />
        )}
      </aside>
    </div>
  );
}
