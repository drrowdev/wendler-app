// Assistance ordering — pure function that ensures a day's assistance entries
// are presented in a sensible session flow.
//
// **Strategy after v286:** the primary ordering happens INSIDE the LLM via a
// new system-prompt instruction (compound work first, prehab last, avoid
// consecutive same-muscle movements). This function's job is to be a
// guardrail / safety net:
//
//   1. When slot information is available (the LLM emitted `slot` per entry),
//      we trust the LLM's order but force `prehab` slot entries to the end.
//      Prehab is maintenance work — it should never lead a session. Everything
//      else keeps its LLM-given order.
//   2. When slot information is NOT available (e.g. the deterministic
//      fallback, or any older caller), we fall back to the legacy category-
//      based sort: matching-main-category first on main-lift days, then
//      push → pull → single-leg → core → accessory → other.
//
// Pure / stable. Re-running on already-sorted entries is a no-op.

import type { AssistanceCategory, AssistanceEntry } from './blocks';
import type { RuleSlot } from './goal-flags';
import type { MainLift } from './types';

/**
 * Default category order on an accessory day (no main lifts).
 *
 * Compound categories first (push/pull/single-leg), then trunk work (core),
 * then accessory (a bucket containing both isolation and prehab — they're
 * indistinguishable at the AssistanceCategory layer), then carries which
 * Wendler treats as session finishers.
 *
 * 'other' catches anything we couldn't classify; it lands last.
 */
const DEFAULT_CATEGORY_ORDER: readonly AssistanceCategory[] = [
  'push',
  'pull',
  'single-leg',
  'core',
  'accessory',
  'other',
];

/**
 * Pick the "primary" assistance category for a main lift — the slot that
 * sits closest to the main lift's pattern in Wendler's prescription. On
 * main-lift days, this category is promoted to the FRONT of the order so
 * the heaviest assistance (e.g. dip after bench, row after deadlift)
 * follows the main work directly.
 */
function primaryCategoryForLift(lift: MainLift): AssistanceCategory {
  if (lift === 'bench' || lift === 'press') return 'push';
  if (lift === 'deadlift') return 'pull';
  if (lift === 'squat') return 'single-leg';
  // exhaustive — the four 5/3/1 lifts above cover MainLift
  return 'push';
}

/**
 * Compute the category order for a specific day. On a main-lift day the
 * primary category for the first main lift goes first; the rest of the
 * order follows the default flow with that category removed (no
 * duplication). On an accessory day (no main lifts), the default order
 * applies.
 *
 * When a day has multiple main lifts (e.g. bench + deadlift), we use the
 * first one's primary category — Wendler's pair-awareness rule says each
 * slot follows its matching main lift independently, so there's no single
 * "right" ordering. First-listed is a reasonable, stable choice; users
 * who reorder main lifts implicitly reorder assistance with them.
 */
function categoryOrderForDay(mainLifts: readonly MainLift[]): readonly AssistanceCategory[] {
  if (mainLifts.length === 0) return DEFAULT_CATEGORY_ORDER;
  const primary = primaryCategoryForLift(mainLifts[0]!);
  const rest = DEFAULT_CATEGORY_ORDER.filter((c) => c !== primary);
  return [primary, ...rest];
}

/**
 * Reorder a day's assistance entries.
 *
 * - If `slotByEntryId` is provided (LLM path), the function trusts the
 *   LLM's order for everything except `prehab` slots, which it pulls to
 *   the end. This preserves the LLM's intra-day muscle-group rotation
 *   and compound-before-isolation reasoning while guaranteeing that
 *   maintenance work doesn't accidentally lead a session.
 * - If `slotByEntryId` is omitted (deterministic fallback or any older
 *   caller), the function falls back to the legacy category-based sort:
 *   matching-main-category first on main-lift days, then
 *   push → pull → single-leg → core → accessory → other.
 *
 * Pure / stable. Same input → same output. Idempotent.
 *
 * Use this on NEWLY-PRODUCED picks (LLM response or deterministic
 * fallback) before they land in the block. Manually-arranged user
 * entries should not be re-sorted — calling this on them would override
 * user intent.
 */
export function sortAssistanceEntriesForDay(
  entries: readonly AssistanceEntry[],
  mainLifts: readonly MainLift[],
  slotByEntryId?: ReadonlyMap<string, RuleSlot>,
): AssistanceEntry[] {
  if (entries.length <= 1) return [...entries];

  // LLM path — trust the model's intra-day ordering but force prehab to end.
  if (slotByEntryId) {
    const nonPrehab: AssistanceEntry[] = [];
    const prehab: AssistanceEntry[] = [];
    for (const e of entries) {
      const slot = slotByEntryId.get(e.id);
      if (slot === 'prehab') prehab.push(e);
      else nonPrehab.push(e);
    }
    return [...nonPrehab, ...prehab];
  }

  // Fallback path — legacy category-based sort.
  const order = categoryOrderForDay(mainLifts);
  // Map category → its rank. Unknown categories fall to the end via Infinity.
  const rankOf = (cat: AssistanceCategory): number => {
    const idx = order.indexOf(cat);
    return idx === -1 ? Number.POSITIVE_INFINITY : idx;
  };
  // Stable sort by category rank; entries with the same rank keep their
  // original relative order. JS `Array.prototype.sort` has been stable
  // since ES2019, so we don't need a manual stabilization pass.
  return [...entries].sort((a, b) => rankOf(a.category) - rankOf(b.category));
}
