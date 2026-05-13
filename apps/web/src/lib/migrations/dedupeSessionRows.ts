'use client';

import type { SessionRecord } from '@wendler/db-schema';
import { getDb } from '../db';
import { deleteWithTombstones } from '../delete';

const FLAG_KEY = 'wendler:migration:dedupe-session-rows:v1';

/**
 * One-shot migration: collapse duplicate session rows that share the same
 * (blockId, week, dayIndex, mainLift). These can exist in the wild from a
 * race in the pre-fix `useDaySessionRow` (two parallel callers — e.g.
 * PreLiftingWarmup + LiftTrack — both pre-allocated a nanoid before either
 * finished writing, so both rows ended up in IndexedDB). The completion path
 * stamps `workoutCompletedAt` on every row for the day, so the dupes survive
 * and inflate per-lift completion counts forever.
 *
 * Strategy per duplicate group:
 *   1. Pick the "best" row to keep:
 *      - has `completedAt` (a real per-lift completion happened against it)
 *      - then most attached sets
 *      - then earliest `performedAt` (the original)
 *   2. Re-point every set from loser rows to the winner's id.
 *   3. Tombstone-delete loser session rows so the deletion propagates to
 *      other devices via sync.
 *
 * Idempotent: gated on a localStorage flag. The fix in `useDaySessionRow`
 * prevents new dupes from forming, so a single pass is enough.
 */
export async function runDedupeSessionRowsMigration(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (localStorage.getItem(FLAG_KEY) === 'done') return;

  try {
    const db = getDb();
    const allSessions = await db.sessions.toArray();

    // Group by natural key. Only sessions with all four fields defined are
    // candidates — legacy rows missing any of them can't be safely identified
    // as duplicates and are left alone.
    const groups = new Map<string, SessionRecord[]>();
    for (const s of allSessions) {
      if (!s.blockId || s.week === undefined || s.dayIndex === undefined || !s.mainLift) {
        continue;
      }
      const key = `${s.blockId}|${s.week}|${s.dayIndex}|${s.mainLift}`;
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }

    let collapsed = 0;
    for (const [, rows] of groups) {
      if (rows.length < 2) continue;

      // Count attached sets per row so we can prefer the one with the most
      // real data on it.
      const setCounts = new Map<string, number>();
      for (const r of rows) {
        const c = await db.sets.where('sessionId').equals(r.id).count();
        setCounts.set(r.id, c);
      }

      const sorted = [...rows].sort((a, b) => {
        // 1. has completedAt wins
        const aDone = a.completedAt ? 1 : 0;
        const bDone = b.completedAt ? 1 : 0;
        if (aDone !== bDone) return bDone - aDone;
        // 2. more sets wins
        const aSets = setCounts.get(a.id) ?? 0;
        const bSets = setCounts.get(b.id) ?? 0;
        if (aSets !== bSets) return bSets - aSets;
        // 3. earliest performedAt wins (the original)
        return a.performedAt < b.performedAt ? -1 : 1;
      });

      const keeper = sorted[0]!;
      const losers = sorted.slice(1);
      collapsed += losers.length;

      // Re-point sets from losers onto the keeper so we don't orphan any
      // logged work.
      for (const loser of losers) {
        const orphans = await db.sets.where('sessionId').equals(loser.id).toArray();
        if (orphans.length > 0) {
          await Promise.all(
            orphans.map((set) => db.sets.update(set.id, { sessionId: keeper.id })),
          );
        }
      }

      // Tombstone-delete the loser session rows. Using deleteWithTombstones so
      // the deletion propagates to other devices via sync.
      await deleteWithTombstones(
        'session',
        losers.map((l) => l.id),
      );
    }

    localStorage.setItem(FLAG_KEY, 'done');
    if (collapsed > 0) {
      console.info(`[migration] dedupe-session-rows: collapsed ${collapsed} duplicate session row(s)`);
    }
  } catch (err) {
    // Don't set the flag — let it retry on next boot. Don't throw — never
    // brick the app over a cleanup pass.
    console.error('[migration] dedupe-session-rows failed', err);
  }
}
