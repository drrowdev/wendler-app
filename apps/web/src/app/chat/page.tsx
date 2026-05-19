'use client';

// Full-screen /chat route — same ChatPanel as the drawer, but in a
// page-sized layout with a sidebar of conversations. Reachable via the
// "Expand" button in the FAB drawer, the /more list, and Quick-jump.
// `?id=…` deep-links a conversation; absent = new chat.
// `?followup=…` (when paired with id) primes the chat with a follow-up
// prompt the AI proposed earlier — used by scheduled check-in
// notifications.

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChatConversationList, ChatPanel } from '@/components/ChatPanel';
import { SnapshotInspector } from '@/components/SnapshotInspector';
import { useChatList } from '@/lib/useChat';
import { getDb } from '@/lib/db';

export default function ChatPage() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const followupActionId = params.get('followup');
  const debugSnapshot = params.get('debug') === 'snapshot';
  const conversations = useChatList();
  const [mobileListOpen, setMobileListOpen] = useState(false);

  // When the URL carries a `followup=<actionId>`, read the matching
  // notification's `context.followupPrompt` and APPEND IT AS THE NEXT
  // ASSISTANT MESSAGE in the chat. The user then sees the AI's check-in
  // question rendered as a normal coach turn and replies via the composer.
  //
  // v476+ change: previously this stashed the prompt as `pendingAutoSend`,
  // which auto-fired it as a USER message — the user saw themselves
  // "asking" the AI a question phrased from the AI's perspective ("How
  // did today's bench session go? Any adductor pain?"), and the AI then
  // tried to answer its own question. Re-anchoring it as an assistant
  // message restores the intended UX: the coach proactively asks, the
  // user replies.
  useEffect(() => {
    if (!id || !followupActionId) return;
    let cancelled = false;
    (async () => {
      try {
        const db = getDb();
        const notificationId = `chat-followup:${followupActionId}`;
        const note = await db.notifications.get(notificationId);
        const prompt =
          note && typeof (note.context as Record<string, unknown>)?.followupPrompt === 'string'
            ? ((note.context as Record<string, unknown>).followupPrompt as string)
            : undefined;
        if (!prompt) return;
        const chat = await db.chats.get(id);
        if (!chat || cancelled) return;

        // Idempotent: if the last message is already this exact prompt
        // from the assistant, don't double-append on a refresh / re-open.
        const last = chat.messages[chat.messages.length - 1];
        const alreadyAppended =
          last && last.role === 'assistant' && last.content === prompt;

        if (!alreadyAppended) {
          const { nanoid } = await import('nanoid');
          const nowIso = new Date().toISOString();
          await db.chats.put({
            ...chat,
            messages: [
              ...chat.messages,
              {
                id: nanoid(),
                role: 'assistant',
                content: prompt,
                createdAt: nowIso,
              },
            ],
            // Clear any leftover pendingAutoSend from older versions of
            // the follow-up flow so we don't double up.
            pendingAutoSend: undefined,
            updatedAt: nowIso,
          });
        }

        // Mark the notification read so it stops showing as "new".
        if (note && !note.readAt) {
          await db.notifications.put({
            ...note,
            readAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch {
        // Best-effort. Worst case: user lands on chat without the prompt.
      } finally {
        if (!cancelled) {
          router.replace(`/chat?id=${id}`, { scroll: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, followupActionId, router]);

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
        onClick={() => select(null)}
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
    <div className="flex h-[calc(100dvh-9rem)] flex-col gap-3">
      {debugSnapshot && <SnapshotInspector />}
      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[16rem_1fr]">
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
      </div>
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
