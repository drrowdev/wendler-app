/**
 * Assistance suggester (Phase 5).
 *
 * Pure function that proposes per-day assistance entries for a block, given:
 *   - The block's resolved AssistanceVolume budget (mainDayReps / accessoryDayReps / movementsPerWeek)
 *   - The block's days (with mainLifts; empty array == accessory day)
 *   - Active goal flavors (aggregated across all active goals)
 *   - The Movement library
 *   - Prior block's per-day entries (to bias toward what user already ran — "history wins")
 *   - cardioPeakActive flag (de-emphasize quad-heavy single-leg work near a race)
 *   - warmupCoversPrehab flag (skip prehab slot if warmup already does it)
 *
 * Output is { perDay: [{ dayIndex, entries }], rationale: string[] } where each
 * entry carries a one-line rationale string in `entry.notes` (so the UI can
 * surface "why" without a parallel data structure).
 *
 * The suggester NEVER modifies the input block. Caller decides whether to
 * accept all suggestions, accept per-movement, or discard.
 *
 * NOTE: GoalFlavor is duplicated locally to keep domain free of db-schema deps.
 * Keep these in sync with packages/db-schema/src/types.ts GoalFlavor.
 */

import type { EquipmentType, MainLift, Movement } from './types';
import {
  categoryFromMovement,
  type AssistanceCategory,
  type AssistanceEntry,
  type AssistanceVolumeCustom,
  type BlockDay,
} from './blocks';
import type { GoalFlavor } from './volume-recommend';
import type { RuleDirectives, RuleSlot } from './goal-flags';
import { emptyRuleDirectives } from './goal-flags';
import { isMetabolicConditioning, movementFamily } from './movement-families';

export type { GoalFlavor };

export interface AssistanceSuggestInput {
  /** Resolved per-block volume budget (call resolveAssistanceVolume first). */
  volume: AssistanceVolumeCustom;
  /** Days in display order. Empty mainLifts == accessory day. */
  days: Pick<BlockDay, 'id' | 'mainLifts'>[];
  /** Aggregated active-goal flavors. Multiple goals can each contribute multiple flavors. */
  activeGoalFlavors: GoalFlavor[][];
  /** Available Movement library (custom + built-in). */
  movements: Movement[];
  /** Optional prior-block per-day entries (same dayIndex). Used to favor reuse. */
  prevPerDayEntries?: Array<AssistanceEntry[] | undefined>;
  /**
   * Optional per-day entries already present on each day of the **current**
   * block (manually added or accepted from a prior suggestion call). Movement
   * IDs from these entries pre-populate the cross-day dedup set so the
   * suggester won't re-suggest a movement the user already has on any day.
   * Index aligns with `days`.
   */
  existingPerDayEntries?: Array<AssistanceEntry[] | undefined>;
  /** True if a high-priority endurance race is within ~28d. Avoids quad-heavy SL. */
  cardioPeakActive?: boolean;
  /** True if the block's warmup config already includes prehab work (face pulls, hip mobility). */
  warmupCoversPrehab?: boolean;
  /**
   * If set, the suggester filters movement candidates to only those whose
   * `equipment` is in this list. When undefined, no filter is applied.
   * Resolve via {@link resolveAvailableEquipment} before passing in.
   */
  availableEquipment?: EquipmentType[];
  /**
   * Goal-flag derived rule directives. Pass `evaluateGoalsForRules(flags)`.
   * When omitted, behaves identically to no goal flags being set.
   */
  goalDirectives?: RuleDirectives;
  /**
   * Block-day indices (into `days`) that the user runs a long endurance
   * effort on. When provided and non-empty, the day immediately preceding
   * any of these indices excludes squat-pattern compound assistance with
   * quads as primary. Pre-long-run leg protection is automatic — it does
   * not require the marathon goal flag.
   */
  longRunDayIndices?: number[];
}

export interface SuggestedEntry extends AssistanceEntry {
  /** One-line "why this movement" — surfaced in the UI as a chip/tooltip. */
  rationale: string;
}

export interface AssistanceSuggestResult {
  perDay: Array<{
    dayIndex: number;
    /** True if this day was treated as an accessory day (no mainLifts). */
    isAccessoryDay: boolean;
    entries: SuggestedEntry[];
  }>;
  /** Top-level reasons (block-wide signals that affected ALL days). */
  rationale: string[];
}

/* ---------- helpers ----------------------------------------------------- */

function flatten<T>(arr: T[][]): T[] {
  const out: T[] = [];
  for (const a of arr) for (const x of a) out.push(x);
  return out;
}

function flavorCounts(flavors: GoalFlavor[][]): Record<GoalFlavor, number> {
  const counts: Record<GoalFlavor, number> = {
    strength: 0,
    hypertrophy: 0,
    functional: 0,
    conditioning: 0,
    prehab: 0,
  };
  for (const f of flatten(flavors)) counts[f] = (counts[f] ?? 0) + 1;
  return counts;
}

/** Bucket an AssistanceCategory into the slot families the suggester picks from. */
type Slot = RuleSlot;

function inferSlot(m: Movement, forcedPrehab?: ReadonlySet<string>): Slot {
  if (forcedPrehab?.has(m.id)) return 'prehab';
  const cat = categoryFromMovement(m);
  const lower = m.name.toLowerCase();
  if (/(face pull|band pull|pull-apart|pull apart|hip mobility|hip flexor)/.test(lower)) return 'prehab';
  if (m.pattern === 'carry') return 'carry';
  if (cat === 'single-leg') return 'single-leg';
  // Pure-isolation keywords beat the broader push/pull bucketing — a Lateral
  // Raise is technically push-vertical but lives in the hypertrophy slot.
  if (/(curl|lateral raise|front raise|rear delt|fly|kickback|extension|shrug|calf)/.test(lower))
    return 'isolation';
  if (cat === 'push' || cat === 'pull' || cat === 'core') return cat;
  return 'isolation';
}

/**
 * Build the set of movement IDs whose name matches any directive
 * `prehabKeywords` (case-insensitive substring). Empty set when no keywords.
 */
function buildForcedPrehab(
  movements: Movement[],
  keywords: readonly string[],
): Set<string> {
  const set = new Set<string>();
  if (keywords.length === 0) return set;
  const lowered = keywords.map((k) => k.toLowerCase());
  for (const m of movements) {
    const name = m.name.toLowerCase();
    for (const kw of lowered) {
      if (name.includes(kw)) {
        set.add(m.id);
        break;
      }
    }
  }
  return set;
}

/** Score a movement for a given slot, biased by goal-flavor counts and signals. */
function scoreMovement(
  m: Movement,
  slot: Slot,
  counts: Record<GoalFlavor, number>,
  cardioPeak: boolean,
  directives: RuleDirectives,
  forcedPrehab: ReadonlySet<string>,
): number {
  if (inferSlot(m, forcedPrehab) !== slot) return -Infinity;
  let s = 0;

  // Hypertrophy loves isolation and high-rep cousins of push/pull.
  if (counts.hypertrophy > 0) {
    if (slot === 'isolation') s += 2;
    if (slot === 'push' || slot === 'pull') s += 1;
  }
  // Strength loves heavy compound push/pull.
  if (counts.strength > 0) {
    if (m.isCompound && (slot === 'push' || slot === 'pull')) s += 2;
    if (slot === 'isolation') s -= 1;
  }
  // Functional loves carries, dips, chins, lunges.
  if (counts.functional > 0) {
    if (slot === 'carry') s += 3;
    if (slot === 'single-leg') s += 1;
    if (m.isCompound) s += 1;
  }
  // Prehab flavor weights prehab work even higher (already handled by slot pick).
  if (counts.prehab > 0 && slot === 'prehab') s += 2;
  // Conditioning: shave isolation, prefer compound.
  if (counts.conditioning > 0 && slot === 'isolation') s -= 1;

  // Cardio peak: drop quad-loaded single-leg.
  if (cardioPeak && slot === 'single-leg') {
    if (m.primaryMuscles.includes('quads')) s -= 3;
  }

  // Goal-directive deltas. Sum any matching primary-muscle deltas + slot delta.
  const slotDelta = directives.slotScoreDelta[slot];
  if (typeof slotDelta === 'number') s += slotDelta;
  for (const muscle of m.primaryMuscles) {
    const d = directives.muscleScoreDelta[muscle as keyof typeof directives.muscleScoreDelta];
    if (typeof d === 'number') s += d;
  }

  // Custom movements get a small nudge — user added them for a reason.
  if (m.isCustom) s += 0.5;

  return s;
}

/**
 * Pick the best movement for a slot. Falls back to ANY movement matching the
 * slot if scoring eliminates them all (e.g. tiny library). Returns undefined
 * if nothing in the library fits the slot at all.
 */
function pickForSlot(
  slot: Slot,
  movements: Movement[],
  counts: Record<GoalFlavor, number>,
  cardioPeak: boolean,
  excludeIds: Set<string>,
  coverage?: { push: number; pull: number; squatLeg: number; hingeLeg: number },
  directives: RuleDirectives = emptyRuleDirectives(),
  forcedPrehab: ReadonlySet<string> = new Set(),
  rejectMovement?: (m: Movement) => boolean,
): Movement | undefined {
  const candidates = movements.filter(
    (m) =>
      !excludeIds.has(m.id) &&
      inferSlot(m, forcedPrehab) === slot &&
      !(rejectMovement?.(m) ?? false),
  );
  if (candidates.length === 0) return undefined;
  let best: Movement | undefined;
  let bestScore = -Infinity;
  for (const m of candidates) {
    let sc = scoreMovement(m, slot, counts, cardioPeak, directives, forcedPrehab);
    // Pair-awareness: when a main lift already covers a pattern, prefer
    // assistance that complements rather than redundantly piles on.
    if (coverage) {
      // Bench/Press already done → push slot prefers shoulder/tri over chest.
      if (slot === 'push' && coverage.push >= 1) {
        if (m.primaryMuscles.includes('shoulders') || m.primaryMuscles.includes('triceps')) sc += 1;
        if (m.primaryMuscles.includes('chest')) sc -= 0.5;
      }
      // Deadlift already done → pull slot prefers back/biceps over more posterior-chain pulling.
      if (slot === 'pull' && coverage.hingeLeg >= 1) {
        if (m.primaryMuscles.includes('back') || m.primaryMuscles.includes('biceps')) sc += 0.5;
        if (m.primaryMuscles.includes('hamstrings') || m.primaryMuscles.includes('glutes')) sc -= 0.5;
      }
      // Squat already done → SL slot prefers posterior-chain (hams/glutes) over more quads.
      if (slot === 'single-leg' && coverage.squatLeg >= 1) {
        if (m.primaryMuscles.includes('hamstrings') || m.primaryMuscles.includes('glutes')) sc += 1;
        if (m.primaryMuscles.includes('quads')) sc -= 1;
      }
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = m;
    }
  }
  return best ?? candidates[0];
}

/**
 * Reps per movement, bucketed by slot, with tag-aware adjustments.
 *
 * Phase 7b — tags now shape rep ranges across ALL slots (not just movement
 * choice). Net effect of competing tags is a sum: Strength dominant pulls
 * push/pull toward 5×5; Hypertrophy dominant pushes them to 3×12-15;
 * Conditioning shaves 1 set across the board (min 2). Functional bumps
 * carry sets by 1.
 *
 * Tie-breaking: when Strength and Hypertrophy counts are equal, the base
 * Forever range (push/pull = 4×8-12) is preserved. The shifts compose so
 * a "Focus everything" goal lands close to the canonical default.
 */
function repsForSlot(
  slot: Slot,
  counts?: Record<GoalFlavor, number>,
  directives: RuleDirectives = emptyRuleDirectives(),
): { sets: number; reps: number; repsMax?: number } {
  const c = counts ?? {
    strength: 0,
    hypertrophy: 0,
    functional: 0,
    conditioning: 0,
    prehab: 0,
  };

  // Net "intensity bias": positive = lower reps higher weight; negative = higher reps.
  const intensityBias = c.strength - c.hypertrophy;

  let sets: number;
  let reps: number;
  let repsMax: number | undefined;

  switch (slot) {
    case 'push':
    case 'pull':
      if (intensityBias > 0) {
        sets = 5;
        reps = 5;
        repsMax = 8;
      } else if (intensityBias < 0) {
        sets = 3;
        reps = 10;
        repsMax = 15;
      } else {
        sets = 4;
        reps = 8;
        repsMax = 12;
      }
      break;
    case 'single-leg':
      if (intensityBias > 0) {
        sets = 4;
        reps = 6;
        repsMax = 10;
      } else if (intensityBias < 0) {
        sets = 3;
        reps = 12;
        repsMax = 15;
      } else {
        sets = 3;
        reps = 10;
        repsMax = 12;
      }
      break;
    case 'core':
      sets = 3;
      reps = 12;
      repsMax = 15;
      break;
    case 'isolation':
      if (c.hypertrophy > 0) {
        sets = 3;
        reps = 12;
        repsMax = 20;
      } else {
        sets = 3;
        reps = 12;
        repsMax = 15;
      }
      break;
    case 'carry':
      sets = c.functional > 0 ? 4 : 3;
      reps = 30;
      break;
    case 'prehab':
      sets = 2;
      reps = 15;
      break;
  }

  // Conditioning trims a set off everything (floor at 2).
  if (c.conditioning > 0) sets = Math.max(2, sets - 1);

  // Goal directive: scale sets by volumeMultiplier (deload, peaking). Floor at 1.
  if (directives.volumeMultiplier !== 1) {
    sets = Math.max(1, Math.round(sets * directives.volumeMultiplier));
  }
  // Goal directive: drop AMRAP-style top-end overload — strip the upper bound
  // so reps are a fixed prescription, not a "do as many as you can up to N".
  if (directives.dropAmrapOverload) {
    repsMax = undefined;
  }

  return repsMax !== undefined ? { sets, reps, repsMax } : { sets, reps };
}

function approxRepsPerMovement(
  slot: Slot,
  counts?: Record<GoalFlavor, number>,
  directives: RuleDirectives = emptyRuleDirectives(),
): number {
  const { sets, reps, repsMax } = repsForSlot(slot, counts, directives);
  const mid = repsMax ? (reps + repsMax) / 2 : reps;
  return sets * mid;
}

/* ---------- per-day slot planning -------------------------------------- */

/**
 * Decide which slots a day needs based on its main lifts, the active flavors,
 * and (for accessory days) what's left after main days are populated.
 *
 * Forever convention for main lift days: every session should hit
 * **push + pull + single-leg/core** (25-100 reps each). The first two slots
 * are fixed; the third varies by tags (SL, core, isolation, or carry) plus
 * what's already covered by the day's main lifts. A 4th prehab slot is
 * appended when the goal asks for it and the warmup doesn't already cover it.
 *
 * Pair-awareness: each main lift "consumes" one pattern. The 3-slot
 * allocation still hits all 3 categories — but movement scoring inside each
 * slot biases toward complementary work (handled in pickForSlot via
 * patternCoverage). E.g., on a Bench+DL day the push slot prefers
 * shoulder/tri-focused movements over more chest pressing.
 */
function patternCoverage(mainLifts: MainLift[]): {
  push: number;
  pull: number;
  squatLeg: number;
  hingeLeg: number;
} {
  let push = 0;
  let pull = 0;
  let squatLeg = 0;
  let hingeLeg = 0;
  for (const l of mainLifts) {
    if (l === 'bench' || l === 'press') push += 1;
    if (l === 'squat') squatLeg += 1;
    if (l === 'deadlift') {
      hingeLeg += 1;
      pull += 0.5; // DL hits back/grip
    }
  }
  return { push, pull, squatLeg, hingeLeg };
}

function slotsForMainDay(
  mainLifts: BlockDay['mainLifts'],
  counts: Record<GoalFlavor, number>,
  warmupCoversPrehab: boolean,
  budget: number,
): Slot[] {
  // Forever's 3 categories: push + pull + (SL or core or iso or carry).
  const slots: Slot[] = ['push', 'pull'];

  const cov = patternCoverage(mainLifts);
  const legAlreadyHit = cov.squatLeg + cov.hingeLeg > 0;

  // 3rd slot: tag-driven priority. SL/core gets a bonus when no leg lift
  // covered the day; isolation/carry only ride on relevant tag weight.
  const thirdCandidates: Array<{ slot: Slot; weight: number }> = [
    {
      slot: 'single-leg',
      weight: 1 + counts.functional + (legAlreadyHit ? 0 : 1),
    },
    { slot: 'core', weight: 1 + counts.functional + counts.hypertrophy },
    { slot: 'isolation', weight: counts.hypertrophy * 2 },
    { slot: 'carry', weight: counts.functional * 2 },
  ];
  thirdCandidates.sort((a, b) => b.weight - a.weight);
  slots.push(thirdCandidates[0]!.slot);

  // Phase 7b: tag-driven slot count modifiers.
  // Hypertrophy dominant → add a 4th slot (typically isolation) for more volume.
  // Conditioning dominant → drop the 3rd slot to leave room for cardio.
  // Both on → cancel out, stay at 3.
  const slotBias = counts.hypertrophy - counts.conditioning;
  if (slotBias > 0 && budget >= 200) {
    // Add a 2nd "fill" slot — pick the next-best from the 3rd-slot list that
    // wasn't already chosen, preferring isolation if hypertrophy is the driver.
    const taken = new Set(slots);
    const second = thirdCandidates.find((c) => !taken.has(c.slot));
    if (second) slots.push(second.slot);
  } else if (slotBias < 0 && slots.length > 2) {
    // Conditioning trumps: drop the 3rd slot to keep the day light.
    slots.pop();
  }

  // Optional prehab slot when tag is on, warmup doesn't cover it,
  // and there's enough budget to absorb it.
  if (!warmupCoversPrehab && counts.prehab > 0 && budget >= 200) {
    slots.push('prehab');
  }

  return slots;
}

function slotsForAccessoryDay(
  counts: Record<GoalFlavor, number>,
  warmupCoversPrehab: boolean,
  count: number,
): Slot[] {
  // Build a priority list weighted by flavors, then take top `count`.
  const candidates: Array<{ slot: Slot; weight: number }> = [
    { slot: 'isolation', weight: 1 + counts.hypertrophy * 2 },
    { slot: 'core', weight: 1 + counts.functional + counts.hypertrophy },
    { slot: 'pull', weight: 1 + counts.strength + counts.functional },
    { slot: 'single-leg', weight: 1 + counts.functional },
    { slot: 'push', weight: 1 + counts.strength },
    { slot: 'carry', weight: counts.functional * 2 },
    { slot: 'prehab', weight: warmupCoversPrehab ? 0 : 1 + counts.prehab * 2 },
  ];
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates.slice(0, count).map((c) => c.slot);
}

/* ---------- main entry -------------------------------------------------- */

export function suggestAssistance(input: AssistanceSuggestInput): AssistanceSuggestResult {
  const {
    volume,
    days,
    activeGoalFlavors,
    movements: rawMovements,
    prevPerDayEntries,
    existingPerDayEntries,
    cardioPeakActive = false,
    warmupCoversPrehab = false,
    availableEquipment,
    goalDirectives,
    longRunDayIndices,
  } = input;

  const directives = goalDirectives ?? emptyRuleDirectives();

  // Filter movements by available equipment up front so every downstream pick
  // honors the constraint. 'bodyweight' is implicitly always allowed because
  // bodyweight movements need nothing — refusing them would be hostile.
  const movements =
    availableEquipment && availableEquipment.length > 0
      ? rawMovements.filter(
          (m) => m.equipment === 'bodyweight' || availableEquipment.includes(m.equipment),
        )
      : rawMovements;

  // Build the directive-driven prehab promotion set once.
  const forcedPrehab = buildForcedPrehab(movements, directives.prehabKeywords);

  // Days that immediately precede a long-run day (for the veto).
  const longRunSet = new Set(longRunDayIndices ?? []);
  const isPreLongRunDay = (dayIndex: number) => longRunSet.has(dayIndex + 1);

  // Predicate: a movement is too fatiguing for a pre-long-run day. Covers
  // (1) heavy bilateral squat-pattern compounds with quads as primary,
  // (2) any single-leg compound with quads as primary,
  // (3) any deadlift-family movement (bilateral hinge — meaningfully fatigues
  //     the posterior chain even at moderate load),
  // (4) systemic metabolic conditioning hybrids (devil press, burpees, KB
  //     swings, thrusters) that hit CNS hard regardless of leg involvement.
  // Single-leg RDL is intentionally NOT in this list when prescribed at
  // light/moderate reps — the deterministic engine doesn't know the rep
  // count at slot-rejection time, so we only veto by name pattern. The LLM
  // path handles the SL-RDL-at-high-reps nuance via the prompt.
  const isHeavyLower = (m: Movement): boolean => {
    if (isMetabolicConditioning(m.name)) return true;
    if (movementFamily(m.name) === 'deadlift') return true;
    if (!m.isCompound) return false;
    const cat = categoryFromMovement(m);
    const isSquatPattern = m.pattern === 'squat' || cat === 'single-leg';
    if (!isSquatPattern) return false;
    return m.primaryMuscles.includes('quads');
  };

  const counts = flavorCounts(activeGoalFlavors);
  const blockRationale: string[] = [];
  if (Object.values(counts).some((c) => c > 0)) {
    const dominant = (Object.entries(counts) as [GoalFlavor, number][])
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([f]) => f);
    blockRationale.push(`Goal flavors: ${dominant.join(' + ')}`);
  }
  if (cardioPeakActive) blockRationale.push('Cardio peak — de-emphasized quad-heavy single-leg');
  if (warmupCoversPrehab) blockRationale.push('Warmup covers prehab — no prehab slot allocated');
  if (availableEquipment && availableEquipment.length > 0 && rawMovements.length !== movements.length) {
    blockRationale.push(
      `Equipment-restricted (${availableEquipment.join(', ')}) — ${rawMovements.length - movements.length} movement(s) filtered out`,
    );
  }
  if (directives.mandatorySlots.length > 0) {
    blockRationale.push(`Goal mandates: ${directives.mandatorySlots.join(', ')}`);
  }
  if (directives.volumeMultiplier !== 1) {
    const pct = Math.round((1 - directives.volumeMultiplier) * 100);
    blockRationale.push(`Goal-driven volume reduction (${pct}% lighter)`);
  }
  if (directives.dropAmrapOverload) {
    blockRationale.push('AMRAP/top-end overload dropped on assistance');
  }
  if (longRunSet.size > 0) {
    blockRationale.push('Heavy lower-body excluded the day before long runs');
  }

  const mainDayIndices = days
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.mainLifts.length > 0)
    .map(({ i }) => i);
  const accessoryDayIndices = days
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.mainLifts.length === 0)
    .map(({ i }) => i);

  // Volume budget per day: main days get mainDayReps; accessory days share
  // accessoryDayReps. If no accessory day, redistribute that pool over main days.
  const perDayBudget = new Map<number, number>();
  for (const i of mainDayIndices) perDayBudget.set(i, volume.mainDayReps);
  if (accessoryDayIndices.length > 0) {
    const each = Math.floor(volume.accessoryReps / accessoryDayIndices.length);
    for (const i of accessoryDayIndices) perDayBudget.set(i, each);
  } else if (mainDayIndices.length > 0) {
    const extra = Math.floor(volume.accessoryReps / mainDayIndices.length);
    for (const i of mainDayIndices) perDayBudget.set(i, (perDayBudget.get(i) ?? 0) + extra);
  }

  const usedThisBlock = new Set<string>();

  // Pre-populate dedup set with movements already present on any day of the
  // current block — so suggesting Day 2 doesn't re-pick a movement the user
  // already has on Day 1 (whether from a prior suggestion or manually added).
  if (existingPerDayEntries) {
    for (const dayEntries of existingPerDayEntries) {
      if (!dayEntries) continue;
      for (const e of dayEntries) {
        if (e.movementId) usedThisBlock.add(e.movementId);
      }
    }
  }

  // Track per-day used reps so the post-pass can find headroom for mandates.
  const usedRepsByDay = new Map<number, number>();
  // Track per-day rejector predicates (long-run veto) so the mandate pass uses them too.
  const rejectorByDay = new Map<number, (m: Movement) => boolean>();

  const perDay: AssistanceSuggestResult['perDay'] = days.map((day, dayIndex) => {
    const isAccessory = day.mainLifts.length === 0;
    const budget = perDayBudget.get(dayIndex) ?? 0;
    const veto = isPreLongRunDay(dayIndex);
    const rejector = veto ? isHeavyLower : undefined;
    if (rejector) rejectorByDay.set(dayIndex, rejector);

    // Decide slots first so we can size the list against the budget.
    let slots: Slot[];
    if (isAccessory) {
      const estCount = Math.max(3, Math.min(6, Math.round(budget / 50)));
      slots = slotsForAccessoryDay(counts, warmupCoversPrehab, estCount);
    } else {
      // Forever's 3-categories rule: every main day = push + pull + SL/core.
      // Tags + leg-coverage shape the 3rd slot. Prior block movements still
      // bias the actual pick inside each slot via prevHit logic below.
      slots = slotsForMainDay(day.mainLifts, counts, warmupCoversPrehab, budget);
    }

    const cov = isAccessory
      ? { push: 0, pull: 0, squatLeg: 0, hingeLeg: 0 }
      : patternCoverage(day.mainLifts);

    const entries: SuggestedEntry[] = [];
    let usedReps = 0;
    const prev = prevPerDayEntries?.[dayIndex];
    const prevIds = new Set((prev ?? []).map((e) => e.movementId).filter((x): x is string => !!x));

    for (const slot of slots) {
      // History bias: if prior block used a movement matching this slot, prefer it.
      const prevHit = movements.find(
        (m) =>
          prevIds.has(m.id) &&
          inferSlot(m, forcedPrehab) === slot &&
          !usedThisBlock.has(m.id) &&
          !(rejector?.(m) ?? false),
      );
      const picked =
        prevHit ??
        pickForSlot(
          slot,
          movements,
          counts,
          cardioPeakActive,
          usedThisBlock,
          cov,
          directives,
          forcedPrehab,
          rejector,
        );
      if (!picked) continue;
      usedThisBlock.add(picked.id);
      const reps = repsForSlot(slot, counts, directives);
      const cat: AssistanceCategory = categoryFromMovement(picked);
      const rationaleParts: string[] = [];
      rationaleParts.push(slotLabel(slot));
      if (prevHit) rationaleParts.push('reused from prior block');
      else if (counts.hypertrophy > 0 && slot === 'isolation') rationaleParts.push('aesthetic flavor');
      else if (counts.functional > 0 && (slot === 'carry' || slot === 'single-leg'))
        rationaleParts.push('functional flavor');
      else if (counts.strength > 0 && picked.isCompound && (slot === 'push' || slot === 'pull'))
        rationaleParts.push('strength flavor');
      if (cardioPeakActive && slot === 'single-leg' && !picked.primaryMuscles.includes('quads'))
        rationaleParts.push('non-quad pick (cardio peak)');
      if (directives.mandatorySlots.includes(slot)) rationaleParts.push('goal mandate');

      entries.push({
        id: `sugg-${dayIndex}-${entries.length}`,
        category: cat,
        movementId: picked.id,
        movementName: picked.name,
        sets: reps.sets,
        reps: reps.reps,
        repsMax: reps.repsMax,
        unit: slot === 'carry' ? 'sec' : 'reps',
        rationale: rationaleParts.join(' · '),
      });
      usedReps += approxRepsPerMovement(slot, counts, directives);
      if (usedReps >= budget * 1.1) break;
    }

    usedRepsByDay.set(dayIndex, usedReps);
    return { dayIndex, isAccessoryDay: isAccessory, entries };
  });

  // Mandatory-slot pass: every slot in directives.mandatorySlots must appear
  // on at least one day. If none does, append it to the day with the most
  // remaining budget (or, when all days are over budget, the one closest to
  // budget) — never on a day whose long-run veto would reject the movement.
  for (const slot of directives.mandatorySlots) {
    const alreadyCovered = perDay.some((d) =>
      d.entries.some((e) => {
        const m = movements.find((x) => x.id === e.movementId);
        return !!m && inferSlot(m, forcedPrehab) === slot;
      }),
    );
    if (alreadyCovered) continue;

    // Find the day with the most remaining budget.
    const ranked = [...perDay].sort((a, b) => {
      const slackA = (perDayBudget.get(a.dayIndex) ?? 0) - (usedRepsByDay.get(a.dayIndex) ?? 0);
      const slackB = (perDayBudget.get(b.dayIndex) ?? 0) - (usedRepsByDay.get(b.dayIndex) ?? 0);
      return slackB - slackA;
    });
    let placed = false;
    for (const target of ranked) {
      const rejector = rejectorByDay.get(target.dayIndex);
      const cov = days[target.dayIndex]!.mainLifts.length > 0
        ? patternCoverage(days[target.dayIndex]!.mainLifts)
        : { push: 0, pull: 0, squatLeg: 0, hingeLeg: 0 };
      const picked = pickForSlot(
        slot,
        movements,
        counts,
        cardioPeakActive,
        usedThisBlock,
        cov,
        directives,
        forcedPrehab,
        rejector,
      );
      if (!picked) continue;
      usedThisBlock.add(picked.id);
      const reps = repsForSlot(slot, counts, directives);
      const cat: AssistanceCategory = categoryFromMovement(picked);
      target.entries.push({
        id: `sugg-${target.dayIndex}-mandate-${slot}`,
        category: cat,
        movementId: picked.id,
        movementName: picked.name,
        sets: reps.sets,
        reps: reps.reps,
        repsMax: reps.repsMax,
        unit: slot === 'carry' ? 'sec' : 'reps',
        rationale: `${slotLabel(slot)} · goal mandate`,
      });
      usedRepsByDay.set(
        target.dayIndex,
        (usedRepsByDay.get(target.dayIndex) ?? 0) + approxRepsPerMovement(slot, counts, directives),
      );
      placed = true;
      break;
    }
    if (!placed) {
      blockRationale.push(`Could not place mandatory ${slot} — no eligible movement available`);
    }
  }

  return { perDay, rationale: blockRationale };
}

function slotLabel(s: Slot): string {
  switch (s) {
    case 'single-leg':
      return 'single-leg';
    case 'isolation':
      return 'hypertrophy';
    default:
      return s;
  }
}
