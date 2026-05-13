'use client';

// Full-screen /chat route — same ChatPanel as the drawer, but in a
// page-sized layout with a sidebar of conversations. Reachable via the
// "Expand" button in the FAB drawer, the /more list, and Quick-jump.
// `?id=…` deep-links a conversation; absent = new chat.

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { ChatConversationList, ChatPanel } from '@/components/ChatPanel';
import { useChatList } from '@/lib/useChat';

export default function ChatPage() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const conversations = useChatList();

  const select = useCallback(
    (nextId: string | null) => {
      router.replace(nextId ? `/chat?id=${nextId}` : '/chat', { scroll: false });
    },
    [router],
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
          onChatIdChange={(nid) => select(nid)}
        />
      </section>
    </div>
  );
}
