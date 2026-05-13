'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { startBackgroundSync, subscribeSyncStatus, syncNow, type SyncStatus } from '@/lib/sync';

function formatRelative(iso?: string) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 30_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function syncTone(state: SyncStatus['state']): { dot: string; label: string } {
  switch (state) {
    case 'syncing':
      return { dot: 'bg-amber-400 animate-pulse', label: 'Syncing…' };
    case 'error':
      return { dot: 'bg-red-500', label: 'Sync error' };
    case 'disabled':
      return { dot: 'bg-muted/60', label: 'Sync off' };
    case 'unauthenticated':
      return { dot: 'bg-red-500', label: 'Auth error' };
    default:
      return { dot: 'bg-emerald-500', label: 'Synced' };
  }
}

function initialsFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '·';
  const at = trimmed.indexOf('@');
  const base = at > 0 ? trimmed.slice(0, at) : trimmed;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return base.charAt(0).toUpperCase();
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

/**
 * Compact profile control for the top nav: a colored sync dot + an avatar
 * button. Clicking the avatar opens a small menu with profile info, settings,
 * "More" (Goals / Cardio / Recovery / Movements), and Sign out — keeping the
 * primary nav free of those concerns.
 */
export function ProfileMenu() {
  const auth = useAuth();
  const [status, setStatus] = useState<SyncStatus>({ state: 'idle' });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeSyncStatus(setStatus), []);
  useEffect(() => {
    if (!auth.authenticated) return;
    void syncNow();
    const stop = startBackgroundSync(10_000);
    return stop;
  }, [auth.authenticated]);

  // Close on outside click + Escape
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!auth.loaded) {
    return <span className="text-xs text-muted">…</span>;
  }
  if (!auth.authenticated) {
    return (
      <button
        type="button"
        onClick={auth.signIn}
        className="rounded-md border border-border px-2.5 py-1 text-xs text-fg hover:bg-card"
      >
        Sign in
      </button>
    );
  }

  const tone = syncTone(status.state);
  const name = auth.userDetails ?? 'Account';
  const initials = initialsFor(name);
  const isProblem =
    status.state === 'error' ||
    status.state === 'unauthenticated' ||
    status.state === 'disabled';

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent ring-1 ring-accent/30 hover:bg-accent/25"
        title={name}
      >
        {initials}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-2 w-60 overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        >
          <div className="border-b border-border px-3 py-3">
            <div className="truncate text-sm font-medium">{name}</div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} />
              {status.state === 'idle' && status.lastSyncedAt
                ? `Synced ${formatRelative(status.lastSyncedAt)}`
                : tone.label}
            </div>
            {isProblem && status.message && (
              <div className="mt-2 break-words rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] leading-snug text-red-200">
                {status.message}
              </div>
            )}
          </div>
          <nav className="flex flex-col py-1 text-sm">
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="px-3 py-2 hover:bg-bg/50"
            >
              Settings
            </Link>
            <Link
              href="/more"
              onClick={() => setOpen(false)}
              className="px-3 py-2 hover:bg-bg/50"
            >
              More tools
            </Link>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void syncNow();
              }}
              className="px-3 py-2 text-left hover:bg-bg/50"
            >
              Sync now
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                auth.signOut();
              }}
              className="px-3 py-2 text-left text-red-300 hover:bg-red-500/10"
            >
              Sign out
            </button>
          </nav>
        </div>
      )}
    </div>
  );
}
