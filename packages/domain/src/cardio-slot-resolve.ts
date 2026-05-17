// Dynamic resolution helpers for CardioPlanSlot visibility on the
// calendar. Pure: takes the slot + the date being queried + the
// linked block (if any) and returns whether the slot should render
// on that date. Lives in domain so the calendar AND the AI snapshot
// can use the same logic.
//
// Resolution order (first match wins):
//   1. Wrong weekday → never matches.
//   2. `appliesToWeeks` + a linked block with `startedAt`: compute
//      the date range per week label dynamically and check
//      membership. THIS is the canonical path going forward.
//   3. Legacy `effectiveFrom` / `effectiveUntil` ISO bounds set on
//      the slot: static range check. Used for pre-dynamic slots and
//      as a self-healing cache when the linked block's startedAt
//      shifts after the slot was created.
//   4. Unscoped: always renders.

import type { CardioPlanSlot } from './types';
import type { ProgramBlock } from './blocks';

type WendlerWeek = '1' | '2' | '3' | 'deload' | '7w';

function isoMonday(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  const wd = (m.getDay() + 6) % 7; // Mon=0 … Sun=6
  m.setDate(m.getDate() - wd);
  return m;
}

function toIsoYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

/**
 * Compute (Monday, Sunday) ISO date range for a Wendler week label,
 * relative to the linked block's `startedAt` Monday.
 * `weekIndex` is 0-based from the block's start:
 *   '1' → 0, '2' → 1, '3' → 2, 'deload' → weeksBeforeDeload, '7w' → 0.
 */
export function weekRangeForBlock(
  block: ProgramBlock,
  startMonday: Date,
  wk: WendlerWeek,
): { startIso: string; endIso: string } {
  let weekIndex: number;
  if (wk === 'deload') weekIndex = block.weeksBeforeDeload;
  else if (wk === '7w') weekIndex = 0;
  else weekIndex = Number(wk) - 1;
  const start = new Date(startMonday);
  start.setDate(start.getDate() + weekIndex * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { startIso: toIsoYmd(start), endIso: toIsoYmd(end) };
}

/**
 * Returns true when the slot should render on `dateIso` (YYYY-MM-DD)
 * given the supplied calendar weekday (0=Mon … 6=Sun) and the lookup
 * table of all blocks (used to resolve `slot.linkedBlockId`).
 *
 * Pure — no Dexie / no clock reads. Safe to call from the calendar
 * render loop (every cell, every render); micro-cost per call.
 */
export function slotAppliesOnDate(
  slot: CardioPlanSlot,
  dateIso: string,
  dayOfWeek: number,
  blocksById: Map<string, ProgramBlock>,
): boolean {
  if (slot.dayOfWeek !== dayOfWeek) return false;

  // Path 1 — dynamic resolution: appliesToWeeks + a linked block
  // with a known startedAt. The window auto-corrects if the user
  // edits the block's startedAt later (no AI re-run needed).
  if (slot.appliesToWeeks && slot.appliesToWeeks.length > 0 && slot.linkedBlockId) {
    const block = blocksById.get(slot.linkedBlockId);
    if (block?.startedAt) {
      const startMonday = isoMonday(new Date(block.startedAt));
      for (const wk of slot.appliesToWeeks) {
        const { startIso, endIso } = weekRangeForBlock(block, startMonday, wk);
        if (dateIso >= startIso && dateIso <= endIso) return true;
      }
      return false;
    }
    // Linked block missing or has no startedAt — fall through to the
    // legacy static cache so we don't accidentally render every week.
  }

  // Path 2 — static cache: effectiveFrom / effectiveUntil set by the
  // apply path at create-time. Used for legacy slots and as a
  // safety net when path 1 can't resolve.
  if (slot.effectiveFrom || slot.effectiveUntil) {
    if (slot.effectiveFrom && dateIso < slot.effectiveFrom) return false;
    if (slot.effectiveUntil && dateIso > slot.effectiveUntil) return false;
    return true;
  }

  // Path 3 — unscoped: always render.
  return true;
}
