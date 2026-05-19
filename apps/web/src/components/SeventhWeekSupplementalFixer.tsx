'use client';

// SeventhWeekSupplementalFixer — one-shot per-device migrator that
// normalizes any 7th-week block whose `supplementalTemplate` is not
// 'none'. Per Wendler 5/3/1 Forever, p.21: "no supplemental work is
// done" during the 7th-week protocol regardless of sub-kind (deload /
// TM test / PR test). Earlier versions of the chat AI's schedule_deload
// op (pre-v477) copied the active block's supplemental into the new
// 7th-week block — typically FSL or BBB — leaving the metadata wrong
// even though the renderer short-circuits 7w supplemental sets.
//
// This fixer corrects existing affected blocks in-place so the user
// doesn't have to manually toggle each one. localStorage flag stops
// re-runs after success on this device.

import { useEffect } from 'react';
import { getDb } from '@/lib/db';

const FLAG_KEY = 'wendler:seventh-week-supplemental-fix:v1';

export function SeventhWeekSupplementalFixer() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(FLAG_KEY) === '1') return;
    let cancelled = false;
    void (async () => {
      try {
        const db = getDb();
        const blocks = await db.blocks.toArray();
        const affected = blocks.filter(
          (b) => b.kind === 'seventh-week' && b.supplementalTemplate !== 'none',
        );
        if (affected.length === 0) {
          // Nothing to do — set the flag so we skip the scan on every
          // subsequent page load too.
          if (!cancelled) localStorage.setItem(FLAG_KEY, '1');
          return;
        }
        const now = new Date().toISOString();
        await db.transaction('rw', db.blocks, async () => {
          for (const b of affected) {
            // Re-read inside the transaction in case sync pulled a
            // fresher state in between — only act if the block still
            // needs correcting.
            const current = await db.blocks.get(b.id);
            if (!current) continue;
            if (current.kind !== 'seventh-week') continue;
            if (current.supplementalTemplate === 'none') continue;
            await db.blocks.update(b.id, {
              supplementalTemplate: 'none',
              updatedAt: now,
            });
          }
        });
        if (!cancelled) localStorage.setItem(FLAG_KEY, '1');
      } catch {
        // Best-effort: try again on next page load if Dexie isn't ready.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
