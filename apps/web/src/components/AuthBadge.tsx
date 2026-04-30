'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth, loginUrl, logoutUrl } from '@/lib/auth';
import { syncNow, type SyncStatus } from '@/lib/sync';

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

export function AuthBadge() {
  const auth = useAuth();
  const [status, setStatus] = useState<SyncStatus>({ state: 'idle' });
  const [busy, setBusy] = useState(false);

  const runSync = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus({ state: 'syncing' });
    try {
      const result = await syncNow();
      setStatus(result);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Auto-sync on mount + when the tab becomes visible, but only when signed in.
  useEffect(() => {
    if (!auth.authenticated) return;
    void runSync();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void runSync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [auth.authenticated, runSync]);

  if (!auth.loaded) {
    return <span className="text-xs text-muted">…</span>;
  }

  if (!auth.authenticated) {
    return (
      <a
        href={loginUrl()}
        className="rounded-md border border-border px-2 py-1 text-xs text-fg hover:bg-card"
      >
        Sign in
      </a>
    );
  }

  let label: string;
  switch (status.state) {
    case 'syncing':
      label = 'Syncing…';
      break;
    case 'error':
      label = 'Sync error';
      break;
    case 'disabled':
      label = 'Sync off';
      break;
    case 'unauthenticated':
      label = 'Signed out';
      break;
    default:
      label = `Synced ${formatRelative(status.lastSyncedAt)}`;
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={runSync}
        disabled={busy}
        title={status.message ?? auth.userDetails ?? ''}
        className="rounded-md border border-border px-2 py-1 text-fg hover:bg-card disabled:opacity-60"
      >
        {label}
      </button>
      <a
        href={logoutUrl()}
        className="text-muted hover:text-fg"
        title={auth.userDetails ?? 'Sign out'}
      >
        Sign out
      </a>
    </div>
  );
}
