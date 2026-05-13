'use client';

// Imperative notification API. Every callsite emits a row into the
// `notifications` Dexie table; the `NotificationBell` + /notifications
// inbox subscribe via useLiveQuery and the bell shows an unread count.
//
// Design tenets (Phase 1):
//  - Existing transient UX (toasts, banners, undo) stays. notify.* is
//    ADDITIVE: an emitter calls it alongside whatever inline UI it already
//    shows. Nothing in the rest of the app changes when this lands.
//  - Persistent by default. expiresAt is opt-in per call.
//  - Synced across devices via the existing LWW pipeline (the table rides
//    on the same `OutboundDoc[]` flow as wellness / races / cardio).
//  - One single user, no severity filters / mute settings / push delivery.
//
// Usage:
//   notify.info({ channel: 'phase-auto', title: 'Phase auto-shifted to deload' })
//   notify.action({
//     channel: 'ai-suggester',
//     title: 'Trimmed assistance for elevated cardio load',
//     body: '5 picks trimmed; mandates kept',
//     deepLink: { href: `/program/block?id=${blockId}`, label: 'View block' },
//     context: { rationale, modelInfo },
//   })

import { nanoid } from 'nanoid';
import type {
  Notification,
  NotificationChannel,
  NotificationDeepLink,
  NotificationSeverity,
} from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';

export interface NotifyInput {
  channel: NotificationChannel;
  title: string;
  body?: string;
  deepLink?: NotificationDeepLink;
  context?: Record<string, unknown>;
  /** ISO timestamp; absent ⇒ persists indefinitely (the Phase 1 default). */
  expiresAt?: string;
}

async function emit(severity: NotificationSeverity, input: NotifyInput): Promise<string> {
  if (typeof window === 'undefined') return '';
  const now = new Date().toISOString();
  const record: Notification = {
    id: nanoid(),
    createdAt: now,
    updatedAt: now,
    channel: input.channel,
    severity,
    title: input.title,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.deepLink ? { deepLink: input.deepLink } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  await getDb().notifications.add(record);
  // Sync-channel notifications must NOT kick another sync — they're typically
  // emitted from inside the sync loop itself (conflict warnings, Strava
  // import summaries) and kicking would create a feedback loop where each
  // cycle's notification re-pushes and re-triggers the same conflicts.
  // Other channels do kick: the user expects the badge to update across
  // devices promptly when something automatic happens.
  if (input.channel !== 'sync') {
    kickSync();
  }
  return record.id;
}

export const notify = {
  info: (input: NotifyInput) => emit('info', input),
  success: (input: NotifyInput) => emit('success', input),
  warn: (input: NotifyInput) => emit('warn', input),
  action: (input: NotifyInput) => emit('action', input),

  async markRead(id: string): Promise<void> {
    if (typeof window === 'undefined') return;
    const now = new Date().toISOString();
    const row = await getDb().notifications.get(id);
    if (!row || row.readAt) return;
    await getDb().notifications.update(id, { readAt: now, updatedAt: now });
    kickSync();
  },

  async markAllRead(): Promise<void> {
    if (typeof window === 'undefined') return;
    const now = new Date().toISOString();
    const unread = await getDb().notifications.where('readAt').equals('').toArray();
    // Dexie's `where('readAt').equals('')` won't match undefined values; do a
    // table scan for safety. The notifications table is tiny by design so
    // this is fine.
    const all = await getDb().notifications.toArray();
    const targets = all.filter((n) => !n.readAt);
    if (targets.length === 0 && unread.length === 0) return;
    await getDb().transaction('rw', getDb().notifications, async () => {
      for (const n of targets) {
        await getDb().notifications.update(n.id, { readAt: now, updatedAt: now });
      }
    });
    kickSync();
  },

  async dismiss(id: string): Promise<void> {
    // Hide the inline transient UI without removing from the inbox. Useful
    // when an emitter shows a banner alongside the notification — the user
    // can dismiss the banner but still see the entry in /notifications.
    if (typeof window === 'undefined') return;
    const now = new Date().toISOString();
    await getDb().notifications.update(id, { dismissedAt: now, updatedAt: now });
    kickSync();
  },
};

/**
 * Hard-delete a notification. Goes through the tombstone pipeline so peers
 * also remove the row. Use sparingly — most users prefer "mark read" so the
 * audit trail survives.
 */
export async function deleteNotification(id: string): Promise<void> {
  if (typeof window === 'undefined') return;
  // Lazy-import to avoid a cycle with delete.ts → sync.ts.
  const { deleteWithTombstones } = await import('./delete');
  await deleteWithTombstones('notification', [id]);
}
