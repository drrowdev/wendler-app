/**
 * validateBlock — cross-cutting block-level validator.
 *
 * Catches mistakes that *both* the deterministic suggester AND the LLM
 * suggester can make but no per-entry validator can spot:
 *   - duplicate movementIds across days within the same block
 *   - per-day rep budget overflow (with 10% slack to match the suggester's
 *     own headroom rule on line ~689 of assistance-suggest.ts)
 *   - movementIds not present in the supplied catalog (defensive)
 *   - duplicate movement *families* (e.g. trap-bar DL + barbell DL in same
 *     week) — name-based detection via packages/domain/src/movement-families.ts
 *   - main-lift family conflicts (e.g. deadlift assistance scheduled when a
 *     deadlift main lift is already on the roster)
 *   - high-skill movements prescribed at hypertrophy reps (muscle-up 4×8-12)
 *   - goal-flag mandates left unfulfilled (marathon → calves; bigArms →
 *     curls + tri isolation; press-heavy weeks → rear-delt prehab)
 *
 * Pure. NEVER throws. Returns a flat list of warnings (always) and errors
 * (when something would persist a clearly broken plan). Callers decide
 * whether to fail-closed (refuse to apply) or fail-open (apply with a
 * banner).
 *
 * Used by:
 *   - apps/web SuggestAssistanceForBlock as a final guard before calling
 *     onApply (reject and re-trigger the AI corrective retry, or surface
 *     warnings in the applied banner)
 *   - apps/api suggestAssistance as a server-side sanity check after
 *     parseAssistanceResponse
 */
import type { AssistanceVolumeCustom } from './blocks';
import type { GoalFlags } from './goal-flags';
import type { MainLift } from './types';
import {
  movementFamily,
  isHighSkill,
  isCalfMovement,
  isBicepIsolation,
  isTricepIsolation,
  isRearDeltPrehab,
  isPressMovement,
} from './movement-families';

export interface ValidatedEntry {
  movementId: string;
  /**
   * Movement display name. Optional for backward compatibility — the
   * name-based predicates (family dedup, high-skill cap, calf check, etc.)
   * are silently skipped for entries without a name. New callers should
   * always supply it.
   */
  movementName?: string;
  /** Total working reps for this entry: sets * (repsMax ?? reps). */
  sets: number;
  reps: number;
  repsMax?: number;
  unit: 'reps' | 'sec';
}

export interface ValidatedDay {
  dayIndex: number;
  isAccessoryDay: boolean;
  entries: ValidatedEntry[];
}

export interface ValidateBlockInput {
  perDay: ValidatedDay[];
  /** Resolved volume budget — call resolveAssistanceVolume() first. */
  volume: AssistanceVolumeCustom;
  /** Allowed movementIds (the supplied catalog). When omitted, the catalog check is skipped. */
  allowedMovementIds?: ReadonlySet<string>;
  /** Tolerance over budget before it becomes an error (default 1.2 = 20% slack). */
  budgetSlack?: number;
  /**
   * Active goal flags. When supplied, enables goal-driven mandate checks
   * (marathon → calves required; bigArms → curls + tri isolation required).
   */
  goalFlags?: GoalFlags;
  /**
   * Flat list of every main lift scheduled in the block, used to detect
   * cross-day movement-family conflicts (e.g. deadlift main + deadlift
   * assistance). Order doesn't matter.
   */
  scheduledMainLifts?: readonly MainLift[];
}

export interface ValidateBlockResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const DEFAULT_BUDGET_SLACK = 1.2;
const HIGH_SKILL_REP_CEILING = 6; // top-of-range; 3-5 reps is the prescription, allow 6 with no slack.

export function validateBlock(input: ValidateBlockInput): ValidateBlockResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const slack = input.budgetSlack ?? DEFAULT_BUDGET_SLACK;

  // --- Cross-day duplicate movementIds --------------------------------------
  const movementToDays = new Map<string, number[]>();
  for (const day of input.perDay) {
    for (const e of day.entries) {
      const list = movementToDays.get(e.movementId);
      if (list) list.push(day.dayIndex);
      else movementToDays.set(e.movementId, [day.dayIndex]);
    }
  }
  for (const [movementId, dayIndices] of movementToDays) {
    if (dayIndices.length > 1) {
      warnings.push(
        `Movement "${movementId}" appears on multiple days (${dayIndices.join(', ')}).`,
      );
    }
  }

  // --- Per-day volume budget ------------------------------------------------
  for (const day of input.perDay) {
    const budget = day.isAccessoryDay
      ? input.volume.accessoryReps
      : input.volume.mainDayReps;
    if (budget <= 0) continue;

    let total = 0;
    for (const e of day.entries) {
      if (e.unit !== 'reps') continue;
      const repsTop = e.repsMax ?? e.reps;
      total += e.sets * repsTop;
    }
    const cap = budget * slack;
    if (total > cap) {
      errors.push(
        `Day ${day.dayIndex} (${day.isAccessoryDay ? 'accessory' : 'main'}): ` +
          `${total} working reps exceeds budget ${budget} (cap ${Math.round(cap)} with ${Math.round(
            (slack - 1) * 100,
          )}% slack).`,
      );
    }
  }

  // --- Catalog membership (defensive) ---------------------------------------
  if (input.allowedMovementIds) {
    for (const day of input.perDay) {
      for (const e of day.entries) {
        if (!input.allowedMovementIds.has(e.movementId)) {
          errors.push(
            `Day ${day.dayIndex}: movementId "${e.movementId}" not in supplied catalog.`,
          );
        }
      }
    }
  }

  // --- Name-based checks ----------------------------------------------------
  // All of the below depend on movementName being supplied. Silently skip
  // when callers haven't migrated yet.
  type NamedRef = { name: string; dayIndex: number; entry: ValidatedEntry };
  const named: NamedRef[] = [];
  for (const day of input.perDay) {
    for (const e of day.entries) {
      if (!e.movementName) continue;
      named.push({ name: e.movementName, dayIndex: day.dayIndex, entry: e });
    }
  }

  if (named.length > 0) {
    // --- Movement-family dedup across week ----------------------------------
    // Same family = pick at most one variant. Excludes single-leg (its own
    // family is large by design and many weeks include 2+ unilateral
    // movements legitimately).
    const familyMap = new Map<string, NamedRef[]>();
    for (const ref of named) {
      const fam = movementFamily(ref.name);
      if (!fam) continue;
      if (fam === 'single-leg') continue;
      const list = familyMap.get(fam);
      if (list) list.push(ref);
      else familyMap.set(fam, [ref]);
    }
    for (const [fam, refs] of familyMap) {
      if (refs.length > 1) {
        const labels = refs
          .map((r) => `"${r.name}" (day ${r.dayIndex})`)
          .join(', ');
        warnings.push(
          `${refs.length} ${fam}-family movements in the same block: ${labels}. Pick one variant per family per week.`,
        );
      }
    }

    // --- Main-lift family conflict ------------------------------------------
    // If a main lift in the block is a deadlift, no deadlift-family
    // assistance should appear; same for squat → squat-family assistance.
    const mainLifts = new Set(input.scheduledMainLifts ?? []);
    if (mainLifts.has('deadlift')) {
      const conflicts = named.filter((r) => movementFamily(r.name) === 'deadlift');
      for (const c of conflicts) {
        warnings.push(
          `Day ${c.dayIndex}: "${c.name}" duplicates the deadlift main lift's movement family. Pick a non-deadlift assistance (back/biceps/posterior accessory).`,
        );
      }
    }
    if (mainLifts.has('squat')) {
      const conflicts = named.filter((r) => movementFamily(r.name) === 'squat');
      for (const c of conflicts) {
        warnings.push(
          `Day ${c.dayIndex}: "${c.name}" duplicates the squat main lift's movement family. Pick single-leg or accessory work instead.`,
        );
      }
    }

    // --- High-skill rep ceiling ---------------------------------------------
    // Muscle-ups, pistols, HSPUs, etc. should be 3-5 reps per set. Anything
    // above 6 working reps (top of range) is a structural mistake.
    for (const ref of named) {
      if (!isHighSkill(ref.name)) continue;
      const repsTop = ref.entry.repsMax ?? ref.entry.reps;
      if (repsTop > HIGH_SKILL_REP_CEILING) {
        warnings.push(
          `Day ${ref.dayIndex}: "${ref.name}" prescribed at ${ref.entry.sets}×${ref.entry.reps}${ref.entry.repsMax ? '-' + ref.entry.repsMax : ''} — high-skill movements should be 3-5 reps per set, not hypertrophy ranges.`,
        );
      }
    }

    // --- Goal-flag mandate fulfillment --------------------------------------
    if (input.goalFlags?.marathon) {
      const hasCalf = named.some((r) => isCalfMovement(r.name));
      if (!hasCalf) {
        warnings.push(
          'Marathon prep flag is on but no calf-raise variant is scheduled anywhere in the block. The isolation slot mandate isn\'t satisfied by curls or lateral raises — calves specifically.',
        );
      }
    }
    if (input.goalFlags?.bigArms) {
      const hasBicep = named.some((r) => isBicepIsolation(r.name));
      const hasTricep = named.some((r) => isTricepIsolation(r.name));
      if (!hasBicep) {
        warnings.push(
          'Big-arms flag is on but no direct bicep isolation (curl variant) is scheduled. Compound pulling like chin-ups doesn\'t satisfy this — direct isolation is required.',
        );
      }
      if (!hasTricep) {
        warnings.push(
          'Big-arms flag is on but no direct tricep isolation (push-down / skull crusher / kickback / overhead extension) is scheduled. Compound pressing like dips doesn\'t satisfy this — direct isolation is required.',
        );
      }
    }

    // --- Press-balance check (always-on) ------------------------------------
    // 3+ pressing movements (across main + assistance) without any
    // rear-delt / shoulder-health prehab is a structural imbalance.
    const pressCount =
      named.filter((r) => isPressMovement(r.name)).length +
      (input.scheduledMainLifts?.filter(
        (l) => l === 'bench' || l === 'press',
      ).length ?? 0);
    const hasRearDelt = named.some((r) => isRearDeltPrehab(r.name));
    if (pressCount >= 3 && !hasRearDelt) {
      warnings.push(
        `Block contains ${pressCount} pressing movements but no rear-delt / face-pull / band-pull-apart work. Add at least one shoulder-health prehab item to balance the pressing volume.`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
