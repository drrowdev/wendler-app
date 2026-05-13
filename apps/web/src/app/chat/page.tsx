'use client';

// Full-screen /chat route — same ChatPanel as the drawer, but in a
// page-sized layout with a sidebar of conversations. Reachable via the
// "Expand" button in the FAB drawer, the /more list, and Quick-jump.
// `?id=…` deep-links a conversation; absent = new chat.

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ChatConversationList, ChatPanel } from '@/components/ChatPanel';
import { useChatList } from '@/lib/useChat';

export default function ChatPage() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const conversations = useChatList();
  const [mobileListOpen, setMobileListOpen] = useState(false);

  const select = useCallback(
    (nextId: string | null) => {
      router.replace(nextId ? `/chat?id=${nextId}` : '/chat', { scroll: false });
    },
    [router],
  );

  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push('/');
    }
  };

  const headerSlot = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setMobileListOpen((v) => !v)}
        aria-label="Show conversations"
        title="Conversations"
        className="rounded-md p-1.5 text-muted hover:bg-bg/50 hover:text-fg md:hidden"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
          <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        onClick={goBack}
        aria-label="Back"
        title="Back"
        className="rounded-md p-1.5 text-muted hover:bg-bg/50 hover:text-fg"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
          <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Link
        href="/"
        aria-label="Close"
        title="Close"
        className="rounded-md p-1.5 text-muted hover:bg-bg/50 hover:text-fg"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </Link>
    </div>
  );

  return (
    <div className="grid h-[calc(100dvh-9rem)] gap-3 md:grid-cols-[16rem_1fr]">
      <aside className="hidden overflow-hidden rounded-lg border border-border bg-card md:block">
        <ChatConversationList
          selectedId={id}
          conversations={conversations}
          onSelect={(nid) => select(nid)}
          onNew={() => select(null)}
        />
      </aside>
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <ChatPanel
          chatId={id}
          contextPath="/chat"
          headerSlot={headerSlot}
          onChatIdChange={(nid) => select(nid)}
        />
      </section>
      {mobileListOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/40 md:hidden"
          onClick={() => setMobileListOpen(false)}
        >
          <aside
            role="dialog"
            aria-label="Chat conversations"
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded-t-2xl border border-border bg-card shadow-2xl"
            style={{ maxHeight: '80dvh' }}
          >
            <ChatConversationList
              selectedId={id}
              conversations={conversations}
              onSelect={(nid) => {
                select(nid);
                setMobileListOpen(false);
              }}
              onNew={() => {
                select(null);
                setMobileListOpen(false);
              }}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
