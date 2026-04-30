'use client';

import { useEffect, useState } from 'react';
import { getDb } from '@/lib/db';
import type { CardioSession } from '@wendler/db-schema';

interface StravaStatus {
  configured: boolean;
  connected: boolean;
  athleteName?: string;
  hrZones?: number[] | null;
  lastSyncAt?: string | null;
  connectedAt?: string;
}

interface SyncResponse {
  imported: CardioSession[];
  count: number;
  since: string;
  lastSyncAt: string;
}

function fmtDateTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function StravaPanel() {
  const [status, setStatus] = useState<StravaStatus | null>(null);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch('/api/strava/status', { credentials: 'include' });
      if (r.status === 401) {
        setStatus({ configured: false, connected: false });
        setMsg('Sign in with Microsoft first to enable Strava sync.');
        return;
      }
      const j = (await r.json()) as StravaStatus;
      setStatus(j);
    } catch {
      setStatus({ configured: false, connected: false });
    }
  }

  useEffect(() => {
    void load();
    // Reflect ?strava=connected from callback
    const url = new URL(window.location.href);
    const flag = url.searchParams.get('strava');
    if (flag === 'connected') setMsg('✅ Strava connected.');
    else if (flag === 'error') {
      setMsg(`Strava error: ${url.searchParams.get('reason') ?? 'unknown'}`);
    }
    if (flag) {
      url.searchParams.delete('strava');
      url.searchParams.delete('reason');
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

  async function onConnect() {
    setBusy('connect');
    setMsg(null);
    try {
      const r = await fetch('/api/strava/connect', { credentials: 'include' });
      if (!r.ok) {
        setMsg(`Connect failed (${r.status}). Check STRAVA_CLIENT_ID app setting.`);
        return;
      }
      const { authorizeUrl } = (await r.json()) as { authorizeUrl: string };
      window.location.href = authorizeUrl;
    } finally {
      setBusy(null);
    }
  }

  async function onSync() {
    setBusy('sync');
    setMsg(null);
    try {
      const r = await fetch('/api/strava/sync', {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) {
        setMsg(`Sync failed (${r.status}).`);
        return;
      }
      const j = (await r.json()) as SyncResponse;
      // De-dup against existing externalId, then write to Dexie
      const db = getDb();
      let added = 0;
      for (const c of j.imported) {
        const existing = await db.cardio.where('externalId').equals(c.externalId!).first();
        if (existing) {
          await db.cardio.put({ ...existing, ...c, id: existing.id });
        } else {
          await db.cardio.put(c);
          added += 1;
        }
      }
      setMsg(`Imported ${j.count} activities (${added} new) since ${fmtDateTime(j.since)}.`);
      await load();
    } catch (e) {
      setMsg(`Sync error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function onDisconnect() {
    if (!confirm('Disconnect Strava? Imported activities are kept.')) return;
    setBusy('disconnect');
    try {
      await fetch('/api/strava/disconnect', { method: 'POST', credentials: 'include' });
      setMsg('Strava disconnected.');
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!status) return <p className="text-xs text-muted">Loading Strava status…</p>;
  if (!status.configured) {
    return (
      <p className="text-xs text-muted">
        Strava integration is not configured on the server. Set STRAVA_CLIENT_ID and
        STRAVA_CLIENT_SECRET in app settings.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {!status.connected ? (
        <button
          type="button"
          onClick={onConnect}
          disabled={busy !== null}
          className="rounded-lg bg-[#fc4c02] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy === 'connect' ? 'Redirecting…' : 'Connect Strava'}
        </button>
      ) : (
        <>
          <div className="flex items-center justify-between text-sm">
            <div>
              <div className="font-medium">{status.athleteName}</div>
              <div className="text-xs text-muted">
                Last sync: {fmtDateTime(status.lastSyncAt)}
              </div>
              {status.hrZones && (
                <div className="text-xs text-muted">
                  HR zones: {status.hrZones.slice(0, 4).join(' / ')} bpm
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSync}
              disabled={busy !== null}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg disabled:opacity-50"
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              type="button"
              onClick={onDisconnect}
              disabled={busy !== null}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
            >
              Disconnect
            </button>
          </div>
        </>
      )}
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  );
}
