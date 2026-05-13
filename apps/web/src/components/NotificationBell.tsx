'use client';

// Bell icon + unread-count badge for the global nav. Live-queries the
// notifications table; the badge appears whenever any row has no `readAt`.
//
// Visible on every page on both PWA and desktop. Tap → /notifications.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useUnreadNotificationCount } from '@/lib/hooks';

export function NotificationBell({
  className = '',
  size = 'sm',
}: {
  className?: string;
  /** 'sm' = nav-header height (h-8 w-8); 'lg' = bottom-tab height with stacked label. */
  size?: 'sm' | 'lg';
}) {
  const path = usePathname();
  const unread = useUnreadNotificationCount();
  const active = path === '/notifications';
  const display = unread > 99 ? '99+' : String(unread);

  if (size === 'lg') {
    return (
      <Link
        href="/notifications"
        aria-current={active ? 'page' : undefined}
        aria-label={
          unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'
        }
        className={`relative flex flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-medium transition ${
          active ? 'text-accent' : 'text-muted hover:text-fg'
        } ${className}`}
      >
        <span className="relative">
          <BellIcon />
          {unread > 0 && (
            <span className="absolute -right-1.5 -top-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-tight text-white ring-1 ring-card">
              {display}
            </span>
          )}
        </span>
        <span className="leading-tight">Inbox</span>
      </Link>
    );
  }

  return (
    <Link
      href="/notifications"
      aria-current={active ? 'page' : undefined}
      aria-label={
        unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'
      }
      title={
        unread > 0 ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'
      }
      className={`relative flex h-8 w-8 items-center justify-center rounded-md transition ${
        active ? 'text-accent' : 'text-muted hover:bg-bg/60 hover:text-fg'
      } ${className}`}
    >
      <BellIcon />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-tight text-white ring-1 ring-card">
          {display}
        </span>
      )}
    </Link>
  );
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 1 1 12 0c0 3.5 1 5 2 6H4c1-1 2-2.5 2-6z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  );
}
