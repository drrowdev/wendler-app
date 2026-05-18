'use client';

import { useEffect } from 'react';
import type { AssistanceEntry } from '@wendler/domain';
import { getDb } from '@/lib/db';
import { notify } from '@/lib/notify';

const FLAG_KEY = 'wendler:legacy-default-assistance-migrated:v1';

const WEEKS: Array<1 | 2 | 3 | 'deload'> = [1, 2, 3, 'deload'];

/**
 * One-shot, per-device migration that promotes each block's legacy
 * per-day **default** assistance list (`day.assistance`) into explicit
 * per-week overrides (Wk1/Wk2/Wk3/Deload), so the v287 editor — which no
 * longer has a "Default" tab — shows the user's existing programming
 * verbatim on each week tab. Subsequent edits then stay scoped per-week.
 *
 * Rules per (block × day):
 *   - If `day.assistance` is empty, do nothing.
 *   - If `assistanceOverrides[`${week}|${day.id}`]` already exists for a
 *     given week, leave that override alone (user already customized).
 *   - Otherwise, copy `day.assistance` into that week's override slot.
 *
 * `day.assistance` itself is left intact so old clients on the previous
 * build (which still read it via the resolver fallback) continue to work
 * during the rollout. The new resolver still falls back to it as a safety
 * net for any unmigrated paths.
 *
 * The flag is stored in localStorage so the migration runs at most once
 * per browser. Mount once at the root layout.
 */
export function LegacyDefaultAssistanceMigrator() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(FLAG_KEY) === '1') return;
    let cancelled = false;
    void (async () => {
      try {
        const db = getDb();
        const blocks = await db.blocks.toArray();
        const now = new Date().toISOString();
        const toUpdate: Array<{ id: string; assistanceOverrides: Record<string, AssistanceEntry[]> }> = [];

        for (const block of blocks) {
          const plan = block.plan;
          if (!plan?.days?.length) continue;
          // Skip blocks that already have ANY per-week override. The
          // presence of overrides means this block has been edited by
          // another device (AI chat, manual editor, or another browser's
          // migration that already ran). Re-running this migration would
          // overlay LEGACY defaults from `day.assistance` and bump
          // `block.updatedAt = now`, which under last-write-wins sync
          // would clobber that fresher edit when this device next pushes.
          // Real-world impact (incident 2026-05-18): the chat AI trimmed
          // a Wk2 entry on desktop; a fresh mobile session ran the
          // migrator before its first sync pull, wrote a newer timestamp
          // with the legacy default still in place, pushed, and the
          // desktop's correct edit was overwritten on the next pull.
          if (
            plan.assistanceOverrides &&
            Object.keys(plan.assistanceOverrides).length > 0
          ) {
            continue;
          }
          const overrides: Record<string, AssistanceEntry[]> = {
            ...(plan.assistanceOverrides ?? {}),
          };
          let changed = false;
          for (const day of plan.days) {
            const defaults = day.assistance ?? [];
            if (defaults.length === 0) continue;
            for (const w of WEEKS) {
              const key = `${w}|${day.id}`;
              if (overrides[key]) continue;
              overrides[key] = defaults.map((e) => ({ ...e }));
              changed = true;
            }
          }
          if (changed) {
            toUpdate.push({ id: block.id, assistanceOverrides: overrides });
          }
        }

        if (toUpdate.length > 0) {
          await db.transaction('rw', db.blocks, async () => {
            for (const u of toUpdate) {
              const current = await db.blocks.get(u.id);
              if (!current?.plan) continue;
              await db.blocks.update(u.id, {
                plan: { ...current.plan, assistanceOverrides: u.assistanceOverrides },
                updatedAt: now,
              });
            }
          });
          // Log the migration so the user has an audit trail — v287 promoted
          // legacy "default" assistance lists into per-week overrides and we
          // want that to be visible weeks later.
          void notify.info({
            channel: 'migration',
            title: `Promoted default assistance to per-week overrides on ${toUpdate.length} block${toUpdate.length === 1 ? '' : 's'}`,
            body: 'The block editor "Default" tab was removed (v287). Each block now has assistance prescribed per week. Existing default lists were copied into Wk1/2/3/Deload overrides verbatim — no entries lost.',
            deepLink: { href: '/program', label: 'Open /program' },
            context: { migratedBlockIds: toUpdate.map((u) => u.id) },
          });
        }
        if (!cancelled) localStorage.setItem(FLAG_KEY, '1');
      } catch {
        // Best-effort: try again on next page load if Dexie isn't ready yet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
