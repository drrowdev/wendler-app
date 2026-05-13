/**
 * Assistance suggester — LLM response validator (Phase 3b).
 *
 * Pure function. Parses the JSON returned by the LLM (system prompt in
 * `assistance-prompt.ts` defines the schema) and validates structure +
 * referential integrity (movementIds must exist in the supplied catalog).
 *
 * Returns either a typed success or a list of error strings. The caller
 * decides whether to fall back to the deterministic suggester or surface
 * the errors to the user.
 *
 * NOTE: the LLM-facing "slot" vocabulary (push/pull/single-leg/...) is
 * intentionally distinct from the persisted AssistanceCategory enum used
 * by the deterministic suggester and the on-disk blocks. Callers that
 * want to insert validated entries into a block must map slot -> category
 * (a small concern not handled here so this module stays UI-free).
 */
import type { RuleSlot } from './goal-flags';
import type { EquipmentType, MovementPattern, MuscleGroup } from './types';

const VALID_SLOTS: ReadonlySet<RuleSlot> = new Set([
  'push',
  'pull',
  'single-leg',
  'core',
  'prehab',
  'isolation',
  'carry',
]);

const VALID_UNITS = new Set(['reps', 'sec']);

const VALID_EQUIPMENT: ReadonlySet<EquipmentType> = new Set<EquipmentType>([
  'barbell',
  'trap-bar',
  'dumbbell',
  'kettlebell',
  'sandbag',
  'bodyweight',
  'machine',
  'cable',
  'band',
  'other',
]);

const VALID_PATTERNS: ReadonlySet<MovementPattern> = new Set<MovementPattern>([
  'hinge',
  'squat',
  'push-horizontal',
  'push-vertical',
  'pull-horizontal',
  'pull-vertical',
  'carry',
  'core',
]);

const VALID_MUSCLES: ReadonlySet<MuscleGroup> = new Set<MuscleGroup>([
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'chest',
  'back',
  'lats',
  'traps',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'core',
  'obliques',
  'erectors',
]);

const MAX_NEW_MOVEMENT_NAME_CHARS = 80;

/**
 * Hard cap on rationale length. The system prompt asks for ≤120 chars; we
 * enforce by truncating (with ellipsis) rather than failing validation,
 * because a slightly long rationale is cosmetic — punishing an otherwise
 * good pick by rejecting the whole response would be worse than trimming.
 */
const MAX_RATIONALE_CHARS = 120;

/**
 * Inline definition for a movement the LLM proposes that does NOT yet exist
 * in the user's library. The accept path inserts it into Dexie before
 * writing the block entry, so e1RM history is tracked from the very first
 * set. Equipment must be in the available list (bodyweight always allowed).
 */
export interface LlmNewMovement {
  name: string;
  equipment: EquipmentType;
  pattern: MovementPattern;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles?: MuscleGroup[];
  isBodyweight?: boolean;
}

export interface LlmAssistanceEntry {
  slot: RuleSlot;
  /**
   * Reference to an existing library movement. Exactly one of `movementId`
   * or `newMovement` must be present.
   */
  movementId?: string;
  /**
   * Inline definition for a novel movement (no library match). Exactly one
   * of `movementId` or `newMovement` must be present. The accept path
   * inserts this into the library and rewrites the entry to use the new id.
   */
  newMovement?: LlmNewMovement;
  movementName: string;
  sets: number;
  reps: number;
  /** Optional AMRAP cap; absent or null => fixed prescription. */
  repsMax?: number;
  unit: 'reps' | 'sec';
  rationale: string;
}

export interface LlmDayPlan {
  dayIndex: number;
  isAccessoryDay: boolean;
  entries: LlmAssistanceEntry[];
}

export interface LlmAssistanceResponse {
  perDay: LlmDayPlan[];
  blockRationale: string[];
}

export type ParseResult =
  | { ok: true; data: LlmAssistanceResponse }
  | { ok: false; errors: string[] };

export interface ParseAssistanceResponseOptions {
  /**
   * Set of every movementId the model is allowed to return — typically the
   * same library that was rendered into the user prompt. When provided,
   * unknown IDs become validation errors.
   */
  allowedMovementIds?: ReadonlySet<string>;
  /** Highest dayIndex that's valid (0..maxDayIndex). When provided, out-of-range indices error. */
  maxDayIndex?: number;
  /**
   * Equipment types available to the user. When provided, every
   * `newMovement.equipment` MUST be in this set (bodyweight is always
   * allowed even when not listed). Omit to skip equipment validation
   * entirely (every novel movement passes regardless of equipment).
   */
  availableEquipment?: ReadonlySet<string>;
  /**
   * Lowercased name → existing movementId map. When provided, the validator
   * does NOT reject a `newMovement` whose name matches an existing library
   * entry — it leaves the entry as-is so the accept path can rewrite to
   * the matching id. Without this map the validator can't detect dups,
   * which is fine for server-side use where the catalog isn't shipped.
   */
  existingNamesLowercase?: ReadonlyMap<string, string>;
}

/**
 * Strip a Markdown code fence if the LLM ignored the "no fence" rule.
 * Tolerates ```json, ```, leading/trailing whitespace, and BOM.
 */
function stripCodeFence(raw: string): string {
  let s = raw.trim().replace(/^\uFEFF/, '');
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*\n?/, '');
    s = s.replace(/\n?```\s*$/, '');
    s = s.trim();
  }
  return s;
}

/**
 * Parse + validate the LLM response. Returns typed success or a flat list
 * of human-readable errors. NEVER throws.
 */
export function parseAssistanceResponse(
  raw: string,
  options: ParseAssistanceResponseOptions = {},
): ParseResult {
  const errors: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON: ${(err as Error).message}`] };
  }
  if (!isObject(json)) {
    return { ok: false, errors: ['Response is not a JSON object.'] };
  }

  const perDayRaw = (json as Record<string, unknown>).perDay;
  if (!Array.isArray(perDayRaw)) {
    return { ok: false, errors: ['Missing or non-array `perDay`.'] };
  }

  const blockRationaleRaw = (json as Record<string, unknown>).blockRationale ?? [];
  if (!Array.isArray(blockRationaleRaw)) {
    errors.push('`blockRationale` must be an array of strings.');
  }
  const blockRationale = Array.isArray(blockRationaleRaw)
    ? blockRationaleRaw.filter((s): s is string => typeof s === 'string')
    : [];

  const perDay: LlmDayPlan[] = [];
  for (let i = 0; i < perDayRaw.length; i++) {
    const day = perDayRaw[i];
    if (!isObject(day)) {
      errors.push(`perDay[${i}] is not an object.`);
      continue;
    }
    const dayIndex = (day as Record<string, unknown>).dayIndex;
    const isAccessoryDay = (day as Record<string, unknown>).isAccessoryDay;
    const entriesRaw = (day as Record<string, unknown>).entries;

    if (typeof dayIndex !== 'number' || !Number.isInteger(dayIndex) || dayIndex < 0) {
      errors.push(`perDay[${i}].dayIndex must be a non-negative integer.`);
      continue;
    }
    if (options.maxDayIndex !== undefined && dayIndex > options.maxDayIndex) {
      errors.push(
        `perDay[${i}].dayIndex=${dayIndex} exceeds block size (max ${options.maxDayIndex}).`,
      );
      continue;
    }
    if (typeof isAccessoryDay !== 'boolean') {
      errors.push(`perDay[${i}].isAccessoryDay must be a boolean.`);
      continue;
    }
    if (!Array.isArray(entriesRaw)) {
      errors.push(`perDay[${i}].entries must be an array.`);
      continue;
    }

    const entries: LlmAssistanceEntry[] = [];
    for (let j = 0; j < entriesRaw.length; j++) {
      const entry = entriesRaw[j];
      const where = `perDay[${i}].entries[${j}]`;
      const validated = validateEntry(entry, where, options, errors);
      if (validated) entries.push(validated);
    }

    perDay.push({ dayIndex, isAccessoryDay, entries });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { perDay, blockRationale } };
}

function validateEntry(
  raw: unknown,
  where: string,
  options: ParseAssistanceResponseOptions,
  errors: string[],
): LlmAssistanceEntry | null {
  if (!isObject(raw)) {
    errors.push(`${where} is not an object.`);
    return null;
  }
  const e = raw as Record<string, unknown>;
  let bad = false;

  const slot = e.slot;
  if (typeof slot !== 'string' || !VALID_SLOTS.has(slot as RuleSlot)) {
    errors.push(`${where}.slot=${JSON.stringify(slot)} is not a valid slot.`);
    bad = true;
  }

  const hasMovementId = e.movementId !== undefined && e.movementId !== null;
  const hasNewMovement = e.newMovement !== undefined && e.newMovement !== null;
  let movementId: string | undefined;
  let newMovement: LlmNewMovement | undefined;
  if (hasMovementId === hasNewMovement) {
    errors.push(
      `${where} must have exactly one of \`movementId\` or \`newMovement\` (got ${
        hasMovementId && hasNewMovement ? 'both' : 'neither'
      }).`,
    );
    bad = true;
  } else if (hasMovementId) {
    if (typeof e.movementId !== 'string' || e.movementId.length === 0) {
      errors.push(`${where}.movementId must be a non-empty string.`);
      bad = true;
    } else if (
      options.allowedMovementIds &&
      !options.allowedMovementIds.has(e.movementId)
    ) {
      errors.push(
        `${where}.movementId=${JSON.stringify(e.movementId)} is not in the supplied movement library.`,
      );
      bad = true;
    } else {
      movementId = e.movementId;
    }
  } else {
    const nm = validateNewMovement(e.newMovement, `${where}.newMovement`, options, errors);
    if (nm) newMovement = nm;
    else bad = true;
  }

  const movementName = e.movementName;
  if (typeof movementName !== 'string' || movementName.length === 0) {
    errors.push(`${where}.movementName must be a non-empty string.`);
    bad = true;
  }

  const sets = e.sets;
  if (typeof sets !== 'number' || !Number.isInteger(sets) || sets < 1 || sets > 20) {
    errors.push(`${where}.sets must be an integer in [1, 20].`);
    bad = true;
  }

  const reps = e.reps;
  if (typeof reps !== 'number' || !Number.isInteger(reps) || reps < 1 || reps > 200) {
    errors.push(`${where}.reps must be an integer in [1, 200].`);
    bad = true;
  }

  let repsMax: number | undefined;
  if (e.repsMax !== undefined && e.repsMax !== null) {
    if (
      typeof e.repsMax !== 'number' ||
      !Number.isInteger(e.repsMax) ||
      e.repsMax < 1 ||
      e.repsMax > 200
    ) {
      errors.push(`${where}.repsMax must be an integer in [1, 200] (or null).`);
      bad = true;
    } else if (typeof reps === 'number' && e.repsMax < reps) {
      errors.push(`${where}.repsMax (${e.repsMax}) must be >= reps (${reps}).`);
      bad = true;
    } else {
      repsMax = e.repsMax;
    }
  }

  const unit = e.unit;
  if (typeof unit !== 'string' || !VALID_UNITS.has(unit)) {
    errors.push(`${where}.unit must be "reps" or "sec".`);
    bad = true;
  }

  const rationale = e.rationale;
  let truncatedRationale: string | undefined;
  if (typeof rationale !== 'string') {
    errors.push(`${where}.rationale must be a string.`);
    bad = true;
  } else if (rationale.length > MAX_RATIONALE_CHARS) {
    // Truncate (don't fail) — a slightly long rationale shouldn't kill an
    // otherwise valid pick. Preserve the leading slice and append an ellipsis.
    truncatedRationale = rationale.slice(0, MAX_RATIONALE_CHARS - 1) + '…';
  }

  if (bad) return null;
  return {
    slot: slot as RuleSlot,
    ...(movementId !== undefined ? { movementId } : {}),
    ...(newMovement !== undefined ? { newMovement } : {}),
    movementName: movementName as string,
    sets: sets as number,
    reps: reps as number,
    repsMax,
    unit: unit as 'reps' | 'sec',
    rationale: truncatedRationale ?? (rationale as string),
  };
}

function validateNewMovement(
  raw: unknown,
  where: string,
  options: ParseAssistanceResponseOptions,
  errors: string[],
): LlmNewMovement | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const e = raw as Record<string, unknown>;
  let bad = false;

  const name = e.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    errors.push(`${where}.name must be a non-empty string.`);
    bad = true;
  } else if (name.length > MAX_NEW_MOVEMENT_NAME_CHARS) {
    errors.push(
      `${where}.name exceeds ${MAX_NEW_MOVEMENT_NAME_CHARS} chars (got ${name.length}).`,
    );
    bad = true;
  }

  const equipment = e.equipment;
  if (typeof equipment !== 'string' || !VALID_EQUIPMENT.has(equipment as EquipmentType)) {
    errors.push(
      `${where}.equipment=${JSON.stringify(equipment)} must be one of: ${[
        ...VALID_EQUIPMENT,
      ].join(', ')}.`,
    );
    bad = true;
  } else if (
    options.availableEquipment &&
    equipment !== 'bodyweight' &&
    !options.availableEquipment.has(equipment)
  ) {
    errors.push(
      `${where}.equipment=${JSON.stringify(equipment)} is not in the available equipment list.`,
    );
    bad = true;
  }

  const pattern = e.pattern;
  if (typeof pattern !== 'string' || !VALID_PATTERNS.has(pattern as MovementPattern)) {
    errors.push(
      `${where}.pattern=${JSON.stringify(pattern)} must be one of: ${[
        ...VALID_PATTERNS,
      ].join(', ')}.`,
    );
    bad = true;
  }

  const primaryMuscles = e.primaryMuscles;
  if (!Array.isArray(primaryMuscles) || primaryMuscles.length === 0) {
    errors.push(`${where}.primaryMuscles must be a non-empty array.`);
    bad = true;
  } else {
    for (const m of primaryMuscles) {
      if (typeof m !== 'string' || !VALID_MUSCLES.has(m as MuscleGroup)) {
        errors.push(
          `${where}.primaryMuscles contains invalid muscle ${JSON.stringify(m)}.`,
        );
        bad = true;
        break;
      }
    }
  }

  let secondaryMuscles: MuscleGroup[] | undefined;
  if (e.secondaryMuscles !== undefined && e.secondaryMuscles !== null) {
    if (!Array.isArray(e.secondaryMuscles)) {
      errors.push(`${where}.secondaryMuscles must be an array when present.`);
      bad = true;
    } else {
      for (const m of e.secondaryMuscles) {
        if (typeof m !== 'string' || !VALID_MUSCLES.has(m as MuscleGroup)) {
          errors.push(
            `${where}.secondaryMuscles contains invalid muscle ${JSON.stringify(m)}.`,
          );
          bad = true;
          break;
        }
      }
      if (!bad) secondaryMuscles = e.secondaryMuscles as MuscleGroup[];
    }
  }

  let isBodyweight: boolean | undefined;
  if (e.isBodyweight !== undefined && e.isBodyweight !== null) {
    if (typeof e.isBodyweight !== 'boolean') {
      errors.push(`${where}.isBodyweight must be a boolean when present.`);
      bad = true;
    } else {
      isBodyweight = e.isBodyweight;
    }
  }

  if (bad) return null;
  return {
    name: (name as string).trim(),
    equipment: equipment as EquipmentType,
    pattern: pattern as MovementPattern,
    primaryMuscles: primaryMuscles as MuscleGroup[],
    ...(secondaryMuscles !== undefined ? { secondaryMuscles } : {}),
    ...(isBodyweight !== undefined ? { isBodyweight } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
