'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Today' },
  { href: '/program', label: 'Program' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/analytics', label: 'Stats' },
  { href: '/movements', label: 'Moves' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="sticky bottom-0 z-30 border-t border-border bg-card/90 backdrop-blur md:top-0 md:bottom-auto md:border-b md:border-t-0">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-2 py-2 md:px-6 md:py-3">
        <Link href="/" className="hidden text-lg font-semibold tracking-tight md:block">
          5 / 3 / 1
        </Link>
        <div className="flex flex-1 justify-around md:flex-none md:gap-2">
          {TABS.map((t) => {
            const active = path === t.href || (t.href !== '/' && path.startsWith(t.href));
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`rounded-lg px-3 py-2 text-sm transition ${
                  active ? 'bg-accent text-bg font-semibold' : 'text-muted hover:text-fg'
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
