'use client';

import { useEffect, useState } from 'react';
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

export function AuthBadge() {
  const auth = useAuth();
  const [status, setStatus] = useState<SyncStatus>({ state: 'idle' });

  // Subscribe to global sync status (driven by background loop + manual triggers).
  useEffect(() => subscribeSyncStatus(setStatus), []);

  // Start background polling once we're signed in.
  useEffect(() => {
    if (!auth.authenticated) return;
    void syncNow();
    const stop = startBackgroundSync(10_000);
    return stop;
  }, [auth.authenticated]);

  if (!auth.loaded) {
    return <span className="text-xs text-muted">…</span>;
  }

  if (!auth.authenticated) {
    return (
      <button
        type="button"
        onClick={auth.signIn}
        className="rounded-md border border-border px-2 py-1 text-xs text-fg hover:bg-card"
      >
        Sign in
      </button>
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
      label = 'Auth error';
      break;
    default:
      label = `Synced ${formatRelative(status.lastSyncedAt)}`;
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={() => void syncNow()}
        disabled={status.state === 'syncing'}
        title={status.message ?? auth.userDetails ?? ''}
        className="min-w-[110px] rounded-md border border-border px-2 py-1 text-center font-mono tabular-nums text-fg hover:bg-card disabled:opacity-60"
      >
        {label}
      </button>
      <button
        type="button"
        onClick={auth.signOut}
        className="text-muted hover:text-fg"
        title={auth.userDetails ?? 'Sign out'}
      >
        Sign out
      </button>
    </div>
  );
}
