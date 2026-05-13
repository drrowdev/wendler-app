'use client';

import { useEffect } from 'react';
import { getDb } from '@/lib/db';
import { notify } from '@/lib/notify';

const FLAG_KEY = 'wendler:legacy-inblock-deload-migrated:v1';

/**
 * One-shot, per-device migration that flips every block's legacy
 * `includesDeload` flag to `false`.
 *
 * Background: the in-block "Includes deload?" toggle was removed from the
 * UI in favour of the 7th-Week prompt logic, which schedules deloads
 * automatically as standalone seventh-week blocks once enough consecutive
 * training weeks have accumulated. Existing programs may still have blocks
 * whose `includesDeload === true`, which would inflate the timeline week
 * count and reintroduce a redundant in-block deload alongside the
 * automatically-prompted seventh-week block. This migrator resolves both.
 *
 * The flag is stored in localStorage so the migration runs at most once
 * per browser; subsequent loads are a no-op. It's safe to mount once at
 * the root layout.
 */
export function LegacyDeloadMigrator() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(FLAG_KEY) === '1') return;
    let cancelled = false;
    void (async () => {
      try {
        const db = getDb();
        const blocks = await db.blocks.toArray();
        const stale = blocks.filter((b) => b.includesDeload === true);
        if (stale.length > 0) {
          const now = new Date().toISOString();
          await db.transaction('rw', db.blocks, async () => {
            for (const b of stale) {
              await db.blocks.update(b.id, { includesDeload: false, updatedAt: now });
            }
          });
          // Log to the inbox so the migration is auditable later — the user
          // would otherwise have no idea the in-block deload flag was flipped.
          void notify.info({
            channel: 'migration',
            title: `Cleared in-block deload flag on ${stale.length} block${stale.length === 1 ? '' : 's'}`,
            body: 'The in-block "Includes deload?" toggle was replaced by the 7th-Week prompt logic, which schedules deloads as separate one-week blocks. Existing programs were migrated automatically.',
            deepLink: { href: '/program', label: 'Open /program' },
            context: { staleBlockIds: stale.map((b) => b.id) },
          });
        }
        if (!cancelled) localStorage.setItem(FLAG_KEY, '1');
      } catch {
        // Swallow: the migration is best-effort. If the DB isn't ready
        // yet (first visit, no Dexie store), we simply try again next
        // page load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
