'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { ProfileMenu } from './ProfileMenu';
import { BuildVersion } from './BuildVersion';
import { SaveStatusBadge } from './SaveStatusBadge';
import { NotificationBell } from './NotificationBell';
import { openQuickJump } from './QuickJumpPalette';

type Tab = { href: string; label: string; icon: ReactNode };

const I = {
  today: (
    <path d="M12 3l9 7v11h-6v-7H9v7H3V10l9-7z" strokeLinejoin="round" />
  ),
  program: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10v4M17 10v4M3 12h2M19 12h2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  stats: (
    <path d="M4 19V5M4 19h16M8 15v-4M12 15V8M16 15v-6" strokeLinecap="round" />
  ),
  load: (
    <path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" strokeLinejoin="round" />
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
};

const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    aria-hidden="true"
    className="h-5 w-5"
  >
    {children}
  </svg>
);

const PRIMARY_TABS: Tab[] = [
  { href: '/', label: 'Today', icon: <Icon>{I.today}</Icon> },
  { href: '/program', label: 'Program', icon: <Icon>{I.program}</Icon> },
  { href: '/calendar', label: 'Calendar', icon: <Icon>{I.calendar}</Icon> },
  { href: '/analytics', label: 'Stats', icon: <Icon>{I.stats}</Icon> },
  { href: '/load', label: 'Load', icon: <Icon>{I.load}</Icon> },
];

// On mobile only: surface a "More" tab so the auxiliary tools (Goals, Cardio,
// Recovery, Movements, Settings) remain reachable without forcing users to
// open the avatar menu on small screens.
const MOBILE_MORE_TAB: Tab = {
  href: '/more',
  label: 'More',
  icon: <Icon>{I.more}</Icon>,
};

export function Nav() {
  const path = usePathname();

  const isActive = (href: string) =>
    path === href || (href !== '/' && path.startsWith(href));

  const mobileTabs = [...PRIMARY_TABS, MOBILE_MORE_TAB];

  return (
    <>
      {/* Mobile top header: brand, build SHA (testing), profile menu. */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-border bg-card/90 px-3 py-2 backdrop-blur md:hidden">
        <Link href="/" className="text-base font-semibold tracking-tight">
          5 / 3 / 1
        </Link>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openQuickJump}
            aria-label="Quick jump"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-bg/60 hover:text-fg"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
            </svg>
          </button>
          <SaveStatusBadge />
          <NotificationBell size="sm" />
          <BuildVersion />
          <ProfileMenu />
        </div>
      </header>

      {/* Primary nav: bottom tab bar on mobile, top bar on desktop. */}
      <nav
        aria-label="Primary"
        className="sticky bottom-0 z-30 border-t border-border bg-card/95 backdrop-blur pb-[env(safe-area-inset-bottom)] md:fixed md:inset-x-0 md:top-0 md:bottom-auto md:border-b md:border-t-0 md:pb-0"
      >
        <div className="mx-auto flex max-w-6xl items-center md:justify-between md:gap-2 md:px-6 md:py-3">
          <Link
            href="/"
            className="hidden text-lg font-semibold tracking-tight md:block"
          >
            5 / 3 / 1
          </Link>
          {/* Mobile: 6 tabs incl. More. Desktop: 5 primary tabs only. */}
          <div className="grid w-full grid-cols-6 md:hidden">
            {mobileTabs.map((t) => {
              const active = isActive(t.href);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-medium transition ${
                    active ? 'text-accent' : 'text-muted hover:text-fg'
                  }`}
                >
                  <span>{t.icon}</span>
                  <span className="leading-tight">{t.label}</span>
                </Link>
              );
            })}
          </div>
          <div className="hidden md:flex md:flex-none md:gap-1">
            {PRIMARY_TABS.map((t) => {
              const active = isActive(t.href);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    active
                      ? 'bg-accent/15 text-accent'
                      : 'text-muted hover:text-fg'
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
          </div>
          <div className="hidden md:flex md:items-center md:gap-3">
            <button
              type="button"
              onClick={openQuickJump}
              aria-label="Quick jump (Ctrl/Cmd-K)"
              title="Quick jump (Ctrl/Cmd-K)"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-bg/60 hover:text-fg"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
              </svg>
            </button>
            <SaveStatusBadge />
            <NotificationBell size="sm" />
            <BuildVersion />
            <ProfileMenu />
          </div>
        </div>
      </nav>
    </>
  );
}
