'use client';

// One-shot cleanup for the v297 sync-conflict notification flood. Between
// v297 and v298, the sync-conflict emitter wrote a notification on every
// sync tick, kickSync() rebroadcast each notification immediately, and the
// underlying singleton conflicts didn't resolve — so each cycle compounded.
// Users in this window can accumulate dozens of identical "N sync conflicts
// on push" rows.
//
// This component runs once per device (localStorage flag) and deletes every
// notification whose title matches the pattern `\d+ sync conflicts? on push`
// AND was created before the local flag was set. v298+ users are unaffected
// because the emitter is now rate-limited to one per 10 minutes and won't
// trigger a feedback push.

import { useEffect } from 'react';
import { getDb } from '@/lib/db';
import { deleteWithTombstones } from '@/lib/delete';

const FLAG_KEY = 'wendler:sync-conflict-flood-cleanup:v1';
const FLOOD_TITLE_RE = /^\d+ sync conflicts? on push$/;

export function SyncConflictFloodCleanup() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(FLAG_KEY) === '1') return;
    let cancelled = false;
    void (async () => {
      try {
        const db = getDb();
        const all = await db.notifications.toArray();
        const flooded = all.filter((n) => FLOOD_TITLE_RE.test(n.title));
        // Keep the most recent one as a single audit-trail entry; nuke the
        // rest. If there's only one (or zero), nothing to do.
        if (flooded.length > 1) {
          flooded.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
          const toDelete = flooded.slice(1).map((n) => n.id);
          await deleteWithTombstones('notification', toDelete);
        }
        if (!cancelled) localStorage.setItem(FLAG_KEY, '1');
      } catch {
        // Best-effort: try again next page load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
