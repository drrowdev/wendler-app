'use client';

// Notifications inbox — unified history of everything the app has surfaced.
// Phase 1: foundation. Pre-instrumentation, this page is mostly empty for
// existing installs; later sessions wire the real emitters (AI suggester,
// phase-auto, migrations, sync, auth recovery, etc.).
//
// UX shape:
//  - Grouped by day (Today / Yesterday / explicit dates further back)
//  - Channel filter chips above the list
//  - Per-entry: title + body + relative-time (with absolute on hover) +
//    deep-link button + dismiss/delete
//  - "Mark all read" at the top
//  - Severity = small accent color on the icon only

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { NotificationChannel, NotificationSeverity } from '@wendler/db-schema';
import { useNotifications } from '@/lib/hooks';
import { notify, deleteNotification } from '@/lib/notify';
import { fmtDate } from '@/lib/format';
const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  'ai-suggester': 'AI suggester',
  'ai-action': 'AI action',
  'phase-auto': 'Phase auto-shift',
  sync: 'Sync',
  migration: 'Migration',
  auth: 'Auth',
  'training-profile': 'Training profile',
  'plan-match': 'Plan match',
  recovery: 'Recovery',
  'goal-flag': 'Goal flag',
  system: 'System',
};

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info: 'bg-sky-500',
  success: 'bg-emerald-500',
  warn: 'bg-amber-500',
  action: 'bg-violet-500',
};

const SEVERITY_RING: Record<NotificationSeverity, string> = {
  info: 'ring-sky-500/30',
  success: 'ring-emerald-500/30',
  warn: 'ring-amber-500/30',
  action: 'ring-violet-500/30',
};

export default function NotificationsPage() {
  const all = useNotifications();
  const [channelFilter, setChannelFilter] = useState<NotificationChannel | 'all'>('all');

  const filtered = useMemo(() => {
    if (!all) return [];
    const nowIso = new Date().toISOString();
    // Hide future-due notifications (scheduled follow-ups) — they
    // appear in the inbox only once their `dueAt` has arrived.
    const visible = all.filter((n) => !n.dueAt || n.dueAt <= nowIso);
    if (channelFilter === 'all') return visible;
    return visible.filter((n) => n.channel === channelFilter);
  }, [all, channelFilter]);

  const unreadCount = useMemo(
    () => (filtered ?? []).reduce((acc, n) => (n.readAt ? acc : acc + 1), 0),
    [filtered],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof filtered>();
    for (const n of filtered) {
      const key = dayBucket(n.createdAt);
      const arr = groups.get(key) ?? [];
      arr.push(n);
      groups.set(key, arr);
    }
    return Array.from(groups.entries());
  }, [filtered]);

  const presentChannels = useMemo(() => {
    if (!all) return new Set<NotificationChannel>();
    return new Set(all.map((n) => n.channel));
  }, [all]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 md:py-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
          <p className="text-xs text-muted">
            History of automatic events and AI rationales — synced across your devices.
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void notify.markAllRead()}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg/60"
          >
            Mark all read ({unreadCount})
          </button>
        )}
      </header>

      <div className="-mx-1 flex flex-wrap gap-1.5 overflow-x-auto px-1">
        <ChannelChip
          label="All"
          active={channelFilter === 'all'}
          onClick={() => setChannelFilter('all')}
        />
        {Array.from(presentChannels).map((ch) => (
          <ChannelChip
            key={ch}
            label={CHANNEL_LABELS[ch]}
            active={channelFilter === ch}
            onClick={() => setChannelFilter(ch)}
          />
        ))}
      </div>

      {!all && (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted">
          Loading…
        </div>
      )}
      {all && filtered.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted">
          {all.length === 0
            ? 'No notifications yet. New events will appear here as they happen.'
            : 'No notifications in this channel.'}
        </div>
      )}

      {grouped.map(([day, items]) => (
        <section key={day} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{day}</h2>
          <div className="space-y-2">
            {items.map((n) => (
              <article
                key={n.id}
                className={`relative rounded-xl border p-3 transition ${
                  n.readAt
                    ? 'border-border/50 bg-card/40 opacity-80'
                    : `border-border bg-card ring-1 ${SEVERITY_RING[n.severity]}`
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[n.severity]}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                        {CHANNEL_LABELS[n.channel]}
                      </span>
                      <time
                        className="text-[11px] text-muted"
                        dateTime={n.createdAt}
                        title={fmtAbsolute(n.createdAt)}
                      >
                        {fmtRelative(n.createdAt)}
                      </time>
                    </div>
                    <h3 className={`mt-0.5 text-sm font-medium ${n.readAt ? 'text-muted' : 'text-fg'}`}>
                      {n.title}
                    </h3>
                    {n.body && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-snug text-muted">
                        {n.body}
                      </p>
                    )}
                    {n.deepLink && (
                      <Link
                        href={n.deepLink.href}
                        onClick={() => void notify.markRead(n.id)}
                        className="mt-2 inline-block rounded-md border border-border/60 bg-bg px-2 py-1 text-[11px] font-medium text-fg hover:bg-bg/60"
                      >
                        {n.deepLink.label} →
                      </Link>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {!n.readAt && (
                      <button
                        type="button"
                        onClick={() => void notify.markRead(n.id)}
                        className="text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                        title="Mark read"
                      >
                        Mark read
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm('Delete this notification? This cannot be undone.')) {
                          void deleteNotification(n.id);
                        }
                      }}
                      className="text-[11px] text-muted/70 underline-offset-2 hover:text-rose-300 hover:underline"
                      title="Delete permanently"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ChannelChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium ring-1 transition-colors ${
        active ? 'bg-accent text-bg ring-accent' : 'bg-bg text-muted ring-border hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

function dayBucket(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const todayKey = ymd(today);
  const yKey = ymd(new Date(today.getTime() - 86_400_000));
  const k = ymd(d);
  if (k === todayKey) return 'Today';
  if (k === yKey) return 'Yesterday';
  return fmtDate(iso);
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'in the future';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}mo ago`;
  const yr = Math.round(month / 12);
  return `${yr}y ago`;
}

function fmtAbsolute(iso: string): string {
  const d = new Date(iso);
  const date = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time}`;
}
