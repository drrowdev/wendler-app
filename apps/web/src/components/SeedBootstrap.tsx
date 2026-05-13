'use client';

import { useEffect } from 'react';
import { ensureSeeded } from '@/lib/db';
import { runDedupeSessionRowsMigration } from '@/lib/migrations/dedupeSessionRows';

/**
 * Runs seedIfEmpty() once on mount, outside of any Dexie liveQuery zone.
 * Calling it from inside getDb() (which is invoked by liveQuery queriers) makes
 * the bulkAdd throw ReadOnlyError because liveQuery wraps the call in a
 * read-only transaction. This component breaks out of that context.
 *
 * Also kicks off any pending one-shot data-repair migrations after seeding
 * completes.
 */
export function SeedBootstrap() {
  useEffect(() => {
    void (async () => {
      await ensureSeeded();
      // Kick off after seeding so we never race against the seed transaction.
      // Each migration self-gates on a localStorage flag so re-runs are no-ops.
      void runDedupeSessionRowsMigration();
    })();
  }, []);
  return null;
}
