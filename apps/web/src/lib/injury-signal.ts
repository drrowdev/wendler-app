// Read-side helper for the assistance-volume recommender (Phase 4) and any
// other consumer that needs to know "did the user flag pain/injury during
// this block?".
//
// SOURCE OF TRUTH — there is no separate "injury record" entity. The user
// flags pain via the "+ Flag pain / injury" button on /day, which writes
// `painFlag: { area, severity, note? }` onto the most-recent SetRecord for
// the active movement (see apps/web/src/app/day/page.tsx, ~line 728/828).
// Pain flags are CARRIED FORWARD on the set row; clearing happens by setting
// `painFlag: undefined` on every flagged set for that movement.
//
// This helper queries the `sets` table for any set whose `painFlag` is set
// AND that was performed within the given window. No new schema, no new UI.

import { getDb } from './db';
import type { SetRecord } from '@wendler/db-schema';

export interface PainFlagOccurrence {
  /** ISO date the set was performed. */
  date: string;
  /** Body area (free text — user-typed in PainFlagModal). */
  area: string;
  /** 1 (twinge) – 5 (could not continue). */
  severity: 1 | 2 | 3 | 4 | 5;
  /** Optional free-text note. */
  note?: string;
  /** Movement ID the flag was attached to (helpful for movement-aware advice). */
  movementId: string;
  /** Source SetRecord id, in case the consumer wants to drill in. */
  setId: string;
}

/**
 * All active (non-deleted) pain flags from sets performed within
 * [fromIso, toIso]. `toIso` is inclusive — pass `new Date().toISOString()` to
 * include up to "now".
 *
 * Returned in chronological order (oldest first). Empty array means no signal.
 */
export async function getPainFlagsInWindow(
  fromIso: string,
  toIso: string,
): Promise<PainFlagOccurrence[]> {
  const all = await getDb().sets.toArray();
  const out: PainFlagOccurrence[] = [];
  for (const s of all as SetRecord[]) {
    if (s.deletedAt) continue;
    if (!s.painFlag) continue;
    if (s.performedAt < fromIso || s.performedAt > toIso) continue;
    out.push({
      date: s.performedAt,
      area: s.painFlag.area,
      severity: s.painFlag.severity,
      note: s.painFlag.note,
      movementId: s.movementId,
      setId: s.id,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

/**
 * Convenience: pain flags raised within the given block's active window.
 * Window = [block.startedAt, block.completedAt ?? now]. Returns [] if the
 * block hasn't started yet.
 */
export async function getPainFlagsForBlock(block: {
  startedAt?: string;
  completedAt?: string;
}): Promise<PainFlagOccurrence[]> {
  if (!block.startedAt) return [];
  const to = block.completedAt ?? new Date().toISOString();
  return getPainFlagsInWindow(block.startedAt, to);
}

/**
 * Quick boolean: did any pain flag with severity ≥ minSeverity (default 2)
 * appear within the given window? The recommender uses this to decide whether
 * to drop one preset step.
 */
export async function hasInjurySignalInWindow(
  fromIso: string,
  toIso: string,
  minSeverity: 1 | 2 | 3 | 4 | 5 = 2,
): Promise<boolean> {
  const flags = await getPainFlagsInWindow(fromIso, toIso);
  return flags.some((f) => f.severity >= minSeverity);
}
