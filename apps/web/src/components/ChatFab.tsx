'use client';

// ChatFab — global floating action button. Mounted in layout.tsx so it
// appears on every page (with a hide list for routes where it would
// interfere). Tap opens the slide-up ChatDrawer.
//
// Also the host for the welcome-back trigger: on mount, idempotently
// check whether the user is returning after a multi-day gap and spawn
// a single catch-up coach chat if so.

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ChatDrawer } from './ChatDrawer';
import { maybeTriggerWelcomeBack } from '@/lib/returning-user-trigger';

// Routes where the FAB is hidden because:
// - /day, /session: active workout, don't distract mid-set
// - /chat: full-screen chat is already open
const HIDE_PATHS: (string | RegExp)[] = ['/chat', /^\/day(\?|$|\/)/, /^\/session(\?|$|\/)/];

function shouldHide(pathname: string): boolean {
  return HIDE_PATHS.some((p) => (typeof p === 'string' ? pathname === p : p.test(pathname)));
}

export function ChatFab() {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  // Hoisted from ChatDrawer so the user's explicit choice survives a
  // drawer close → reopen and across route changes. Without this,
  // hitting "+ New chat" then navigating away made the next drawer
  // open auto-select the most-recent conversation again, wiping the
  // user's fresh-state intent.
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatUserTouched, setChatUserTouched] = useState(false);

  // Close drawer on route change so it doesn't linger covering a new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Idempotently maybe-fire the welcome-back trigger on mount. The
  // helper is safe to call on every mount — gap-based gating prevents
  // duplicates. Fire-and-forget.
  useEffect(() => {
    void maybeTriggerWelcomeBack();
  }, []);

  if (shouldHide(pathname)) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Open AI chat"
        title="Ask the AI coach"
        onClick={() => setOpen(true)}
        className="fixed right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-bg shadow-lg ring-2 ring-bg transition hover:scale-105 active:scale-95"
        style={{
          // Above the mobile bottom nav (~56px tall + safe-area) on mobile;
          // 24px from the bottom edge on desktop.
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 76px)',
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
          className="h-6 w-6"
        >
          <path d="M12 3l2.39 4.84L19.5 9l-3.55 3.46.84 5.05L12 15.77l-4.79 1.74.84-5.05L4.5 9l5.11-1.16L12 3z" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ChatDrawer
          pathname={pathname}
          onClose={() => setOpen(false)}
          chatId={chatId}
          setChatId={setChatId}
          userTouched={chatUserTouched}
          setUserTouched={setChatUserTouched}
        />
      )}
    </>
  );
}
