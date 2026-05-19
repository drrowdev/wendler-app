// Strict validator for `propose_edit` tool-use input. Parses the
// Anthropic tool input shape into a typed proposal.
//
// Whole-proposal rejection on any per-op validation failure — the
// caller sends the error list back to the model as the tool_result so
// it can retry within the same turn.
//
// Type SHAPE mirrors the EditOperation / ProposeEditChatAction unions
// in packages/db-schema/src/types.ts. We can't import from db-schema
// here (domain → db-schema would invert the dependency rule + break
// tsc rootDir). KEEP IN LOCKSTEP. Adding a new op kind requires a
// validator branch here AND the type addition in db-schema.

import { WENDLER_TEMPLATES } from '../../wendler-templates';

// --- Local type mirrors (shape parity with db-schema's EditOperation) ---

export type ParsedEditOperationKind =
  | 'set_training_max'
  | 'set_block_volume_preset'
  | 'trim_assistance_entry'
  | 'swap_assistance_movement'
  | 'add_assistance_entry'
  | 'add_movement_to_library'
  | 'add_cardio_plan_slot'
  | 'remove_cardio_plan_slot'
  | 'remove_assistance_entry'
  | 'schedule_deload'
  | 'skip_day_in_week'
  | 'switch_to_template';

interface ParsedEditOpBase {
  id: string;
  kind: ParsedEditOperationKind;
  label: string;
  rationale?: string;
}

export interface ParsedSetTrainingMaxOp extends ParsedEditOpBase {
  kind: 'set_training_max';
  lift: 'squat' | 'bench' | 'deadlift' | 'press';
  newTrainingMaxKg: number;
}

export interface ParsedSetBlockVolumePresetOp extends ParsedEditOpBase {
  kind: 'set_block_volume_preset';
  blockId?: string;
  preset: 'minimal' | 'standard' | 'high';
}

export interface ParsedTrimAssistanceEntryOp extends ParsedEditOpBase {
  kind: 'trim_assistance_entry';
  blockId?: string;
  dayId: string;
  entryId: string;
  movementName: string;
  newSets: number;
  newReps: number;
  newRepsMax?: number;
}

export interface ParsedSwapAssistanceMovementOp extends ParsedEditOpBase {
  kind: 'swap_assistance_movement';
  blockId?: string;
  dayId: string;
  entryId: string;
  currentMovementId: string;
  currentMovementName: string;
  newMovementId: string;
  newMovementName: string;
}

export interface ParsedAddAssistanceEntryOp extends ParsedEditOpBase {
  kind: 'add_assistance_entry';
  blockId?: string;
  dayId: string;
  movementId: string;
  movementName: string;
  category: string;
  sets: number;
  reps: number;
  repsMax?: number;
  unit: 'reps' | 'sec';
}

export interface ParsedAddMovementToLibraryOp extends ParsedEditOpBase {
  kind: 'add_movement_to_library';
  /** `tmp:<slug>` reference the AI invented. Parser rejects non-tmp: prefixes. */
  tempMovementId: string;
  name: string;
  category: string;
  primaryMuscles: string[];
  secondaryMuscles?: string[];
  equipment?: string;
  pattern: string;
  isCompound?: boolean;
  externallyLoadable?: boolean;
  cues?: string;
  dedupHint?: string;
}

export interface ParsedRemoveAssistanceEntryOp extends ParsedEditOpBase {
  kind: 'remove_assistance_entry';
  blockId?: string;
  dayId: string;
  entryId: string;
  movementName: string;
}

export interface ParsedAddCardioPlanSlotOp extends ParsedEditOpBase {
  kind: 'add_cardio_plan_slot';
  /** ISO weekday: 0 = Mon … 6 = Sun. */
  dayOfWeek: number;
  /** Modality: run | bike | swim | row | walk | padel | other. */
  modality: string;
  /** Planned kind: rest | easy | long | quality | recovery | race-pace | z2 | intervals | cross. */
  planKind: string;
  durationMin?: number;
  notes?: string;
  /**
   * When true (default), the apply path tags the slot with the active
   * block's id so it auto-removes when that block completes. Pass
   * false to keep the slot permanent.
   */
  linkedToActiveBlock?: boolean;
  /**
   * When set, the slot only renders on calendar dates inside these
   * weeks of the linked block. Apply resolves to effectiveFrom /
   * effectiveUntil on the CardioPlanSlot.
   */
  appliesToWeeks?: Array<'1' | '2' | '3' | 'deload' | '7w'>;
}

export interface ParsedRemoveCardioPlanSlotOp extends ParsedEditOpBase {
  kind: 'remove_cardio_plan_slot';
  /** ISO weekday: 0 = Mon … 6 = Sun. */
  dayOfWeek: number;
  /** Modality: run | bike | swim | row | walk | padel | other. */
  modality: string;
  modalityLabel?: string;
  planKindLabel?: string;
}

export interface ParsedScheduleDeloadOp extends ParsedEditOpBase {
  kind: 'schedule_deload';
}

export interface ParsedSkipDayInWeekOp extends ParsedEditOpBase {
  kind: 'skip_day_in_week';
  blockId?: string;
  dayId: string;
  dayLabel?: string;
  weeks: Array<'1' | '2' | '3' | 'deload' | '7w'>;
  skipReason:
    | 'cardio-replacement'
    | 'rest-day'
    | 'travel'
    | 'fatigue'
    | 'pain'
    | 'other';
  skipNote?: string;
}

export interface ParsedSwitchToTemplateOp extends ParsedEditOpBase {
  kind: 'switch_to_template';
  /** Stable id from the WENDLER_TEMPLATES catalog (e.g. 'bbb-forever'). */
  templateId: string;
  /** Optional override for the new program's name. Defaults to the template's name. */
  programName?: string;
  /**
   * Optional override for the new block's name. Defaults to the template's
   * name (so a Leader becomes "BBB Forever — Leader 1" only if the AI sets
   * this explicitly; otherwise it stays unadorned).
   */
  blockName?: string;
}

export type ParsedEditOperation =
  | ParsedSetTrainingMaxOp
  | ParsedSetBlockVolumePresetOp
  | ParsedTrimAssistanceEntryOp
  | ParsedSwapAssistanceMovementOp
  | ParsedAddAssistanceEntryOp
  | ParsedAddMovementToLibraryOp
  | ParsedAddCardioPlanSlotOp
  | ParsedRemoveCardioPlanSlotOp
  | ParsedRemoveAssistanceEntryOp
  | ParsedScheduleDeloadOp
  | ParsedSkipDayInWeekOp
  | ParsedSwitchToTemplateOp;

export interface ParsedProposeEditAction {
  id: string;
  kind: 'propose_edit';
  status: 'pending';
  label: string;
  headline: string;
  reason: string;
  rationale?: string;
  confidence?: 'high' | 'medium' | 'low';
  operations: ParsedEditOperation[];
}

const OP_KINDS = new Set<ParsedEditOperationKind>([
  'set_training_max',
  'set_block_volume_preset',
  'trim_assistance_entry',
  'swap_assistance_movement',
  'add_assistance_entry',
  'add_movement_to_library',
  'add_cardio_plan_slot',
  'remove_cardio_plan_slot',
  'remove_assistance_entry',
  'schedule_deload',
  'skip_day_in_week',
  'switch_to_template',
]);

const VALID_LIFTS = new Set(['squat', 'bench', 'deadlift', 'press']);
const VALID_PRESETS = new Set(['minimal', 'standard', 'high']);
const VALID_CATEGORIES = new Set([
  'push',
  'pull',
  'single-leg',
  'core',
  'prehab',
  'isolation',
  'carry',
]);
const VALID_CONFIDENCES = new Set(['high', 'medium', 'low']);

// Mirror of MuscleGroup / EquipmentType / MovementPattern from
// packages/domain/src/types.ts. Kept in lockstep with the source-of-
// truth unions — when adding a new value there, add it here too.
const VALID_MUSCLES = new Set<string>([
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'adductors',
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
const VALID_EQUIPMENT = new Set<string>([
  'barbell',
  'trap-bar',
  'dumbbell',
  'kettlebell',
  'sandbag',
  'bodyweight',
  'machine',
  'cable',
  'band',
  'weighted-vest',
  'dip-belt',
  'other',
]);
const VALID_PATTERNS = new Set<string>([
  'hinge',
  'squat',
  'push-horizontal',
  'push-vertical',
  'pull-horizontal',
  'pull-vertical',
  'carry',
  'core',
]);
const TEMP_MOVEMENT_ID_RX = /^tmp:[a-z0-9-]+$/;

export interface ParseEditProposalResult {
  /** Set when validation succeeded — ready to surface to the user. */
  proposal?: ParsedProposeEditAction;
  /** Per-op + plan-level errors. Empty when `proposal` is set. */
  errors: string[];
}

export interface ParseEditProposalOptions {
  /** Returns a stable id for the chip + each op. Inject crypto.randomUUID. */
  idGen: () => string;
  /** Hard cap on operations per proposal. Defaults to 10. */
  maxOperations?: number;
  /**
   * User-configured movement exclusions (verbatim labels from
   * TrainingProfile.constraints, active-only). Each entry is a phrase
   * like "no skull crushers" or "no close-grip bench press" — the
   * leading "no " is stripped and the remainder is matched as a
   * case-insensitive substring against the target movement name of any
   * add_assistance_entry / swap_assistance_movement (newMovementName) /
   * add_movement_to_library op. Matches REJECT the whole proposal —
   * the tool_result returned to the model lists the violating ops so
   * it can self-correct within the same turn. Semantic equivalents
   * (e.g. "skull crusher" vs "lying triceps extension") are NOT caught
   * by the substring match — the system prompt covers those.
   */
  activeExclusions?: string[];
}

/**
 * Validate a `propose_edit` tool input and return a typed proposal.
 * On ANY validation failure the whole proposal is rejected — partial
 * proposals are worse than none (the user can't trust the partial set,
 * the AI doesn't know which ops were dropped).
 */
export function parseEditProposal(
  toolInput: unknown,
  opts: ParseEditProposalOptions,
): ParseEditProposalResult {
  const errors: string[] = [];
  const maxOps = opts.maxOperations ?? 10;

  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return { errors: ['Tool input must be an object.'] };
  }
  const obj = toolInput as Record<string, unknown>;

  const label = strField(obj.label, 'label', errors, 80);
  const headline = strField(obj.headline, 'headline', errors, 200);
  const reason = strField(obj.reason, 'reason', errors, 500);
  const rationale =
    typeof obj.rationale === 'string' && obj.rationale.trim() !== ''
      ? obj.rationale.trim()
      : undefined;

  let confidence: 'high' | 'medium' | 'low' | undefined;
  if (obj.confidence !== undefined) {
    if (typeof obj.confidence === 'string' && VALID_CONFIDENCES.has(obj.confidence)) {
      confidence = obj.confidence as 'high' | 'medium' | 'low';
    } else {
      errors.push('`confidence` must be one of "high" | "medium" | "low" when present.');
    }
  }

  const rawOps = obj.operations;
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    errors.push('`operations` must be a non-empty array.');
  } else if (rawOps.length > maxOps) {
    errors.push(`Too many operations (${rawOps.length}). Maximum is ${maxOps}.`);
  }

  const operations: ParsedEditOperation[] = [];
  if (Array.isArray(rawOps)) {
    const seenIds = new Set<string>();
    rawOps.forEach((rawOp, i) => {
      const op = validateOp(rawOp, i, opts.idGen, errors);
      if (op) {
        if (seenIds.has(op.id)) {
          errors.push(`operations[${i}].id "${op.id}" is duplicated within the proposal.`);
        } else {
          seenIds.add(op.id);
          operations.push(op);
        }
      }
    });
  }

  // Hard exclusion enforcement. Substring-match the user's "no <X>"
  // filters against the target movement name of every op that
  // INTRODUCES a movement (add_assistance_entry / swap target /
  // add_movement_to_library). Existing entries that already reference
  // an excluded movement are not blocked here (the user already has
  // them — trim/remove ops MUST still work on those).
  const normalizedExclusions = (opts.activeExclusions ?? [])
    .map((raw) => raw.toLowerCase().trim().replace(/^no\s+/, '').trim())
    .filter((s) => s.length > 0);
  if (normalizedExclusions.length > 0) {
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]!;
      const targetName: string | undefined =
        op.kind === 'add_assistance_entry'
          ? op.movementName
          : op.kind === 'swap_assistance_movement'
            ? op.newMovementName
            : op.kind === 'add_movement_to_library'
              ? op.name
              : undefined;
      if (!targetName) continue;
      const targetLower = targetName.toLowerCase();
      const hit = normalizedExclusions.find((ex) => targetLower.includes(ex));
      if (hit) {
        errors.push(
          `operations[${i}] (${op.kind}) introduces "${targetName}" which matches the active user exclusion "no ${hit}". Propose a different movement that respects the user's filters, or omit the op entirely.`,
        );
      }
    }
  }

  if (errors.length > 0 || !label || !headline || !reason || operations.length === 0) {
    return { errors };
  }

  const proposal: ParsedProposeEditAction = {
    id: opts.idGen(),
    kind: 'propose_edit',
    status: 'pending',
    label,
    headline,
    reason,
    operations,
    ...(rationale ? { rationale } : {}),
    ...(confidence ? { confidence } : {}),
  };
  return { proposal, errors: [] };
}

function strField(
  v: unknown,
  name: string,
  errors: string[],
  maxLen: number,
): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push(`\`${name}\` is required and must be a non-empty string.`);
    return undefined;
  }
  if (v.length > maxLen) {
    errors.push(`\`${name}\` exceeds ${maxLen} chars (got ${v.length}).`);
    return undefined;
  }
  return v.trim();
}

function num(v: unknown, name: string, errors: string[], where: string): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${where}.${name} is required and must be a finite number.`);
    return undefined;
  }
  return v;
}

function posInt(v: unknown, name: string, errors: string[], where: string): number | undefined {
  const n = num(v, name, errors, where);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 1) {
    errors.push(`${where}.${name} must be a positive integer (got ${n}).`);
    return undefined;
  }
  return n;
}

function validateOp(
  raw: unknown,
  i: number,
  idGen: () => string,
  errors: string[],
): ParsedEditOperation | undefined {
  const where = `operations[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${where} must be an object.`);
    return undefined;
  }
  const op = raw as Record<string, unknown>;
  const kind = op.kind;
  if (typeof kind !== 'string' || !OP_KINDS.has(kind as ParsedEditOperationKind)) {
    errors.push(
      `${where}.kind must be one of ${[...OP_KINDS].join(', ')} (got ${JSON.stringify(kind)}).`,
    );
    return undefined;
  }
  const id = typeof op.id === 'string' && op.id.trim() ? op.id.trim() : idGen();
  const label = strField(op.label, `${where}.label`, errors, 80);
  if (!label) return undefined;
  const rationale =
    typeof op.rationale === 'string' && op.rationale.trim()
      ? op.rationale.trim()
      : undefined;

  const base = { id, label, ...(rationale ? { rationale } : {}) };
  const blockId =
    typeof op.blockId === 'string' && op.blockId.trim() ? op.blockId.trim() : undefined;

  switch (kind) {
    case 'set_training_max': {
      const lift = op.lift;
      const newTrainingMaxKg = num(op.newTrainingMaxKg, 'newTrainingMaxKg', errors, where);
      if (typeof lift !== 'string' || !VALID_LIFTS.has(lift)) {
        errors.push(`${where}.lift must be one of ${[...VALID_LIFTS].join(', ')}.`);
        return undefined;
      }
      if (newTrainingMaxKg === undefined) return undefined;
      const rounded = Math.round(newTrainingMaxKg * 2) / 2;
      return {
        ...base,
        kind,
        lift: lift as 'squat' | 'bench' | 'deadlift' | 'press',
        newTrainingMaxKg: rounded,
      };
    }
    case 'set_block_volume_preset': {
      const preset = op.preset;
      if (typeof preset !== 'string' || !VALID_PRESETS.has(preset)) {
        errors.push(`${where}.preset must be one of ${[...VALID_PRESETS].join(', ')}.`);
        return undefined;
      }
      return {
        ...base,
        kind,
        preset: preset as 'minimal' | 'standard' | 'high',
        ...(blockId ? { blockId } : {}),
      };
    }
    case 'trim_assistance_entry': {
      const dayId = strField(op.dayId, `${where}.dayId`, errors, 100);
      const entryId = strField(op.entryId, `${where}.entryId`, errors, 100);
      const movementName = strField(op.movementName, `${where}.movementName`, errors, 120);
      const newSets = posInt(op.newSets, 'newSets', errors, where);
      const newReps = posInt(op.newReps, 'newReps', errors, where);
      if (!dayId || !entryId || !movementName || newSets === undefined || newReps === undefined) {
        return undefined;
      }
      let newRepsMax: number | undefined;
      if (op.newRepsMax !== undefined && op.newRepsMax !== null) {
        const n = posInt(op.newRepsMax, 'newRepsMax', errors, where);
        if (n === undefined) return undefined;
        if (n < newReps) {
          errors.push(`${where}.newRepsMax (${n}) must be >= newReps (${newReps}).`);
          return undefined;
        }
        newRepsMax = n;
      }
      return {
        ...base,
        kind,
        dayId,
        entryId,
        movementName,
        newSets,
        newReps,
        ...(blockId ? { blockId } : {}),
        ...(newRepsMax !== undefined ? { newRepsMax } : {}),
      };
    }
    case 'swap_assistance_movement': {
      const dayId = strField(op.dayId, `${where}.dayId`, errors, 100);
      const entryId = strField(op.entryId, `${where}.entryId`, errors, 100);
      const currentMovementId = strField(
        op.currentMovementId,
        `${where}.currentMovementId`,
        errors,
        100,
      );
      const currentMovementName = strField(
        op.currentMovementName,
        `${where}.currentMovementName`,
        errors,
        120,
      );
      const newMovementId = strField(op.newMovementId, `${where}.newMovementId`, errors, 100);
      const newMovementName = strField(
        op.newMovementName,
        `${where}.newMovementName`,
        errors,
        120,
      );
      if (
        !dayId ||
        !entryId ||
        !currentMovementId ||
        !currentMovementName ||
        !newMovementId ||
        !newMovementName
      ) {
        return undefined;
      }
      return {
        ...base,
        kind,
        dayId,
        entryId,
        currentMovementId,
        currentMovementName,
        newMovementId,
        newMovementName,
        ...(blockId ? { blockId } : {}),
      };
    }
    case 'add_assistance_entry': {
      const dayId = strField(op.dayId, `${where}.dayId`, errors, 100);
      const movementId = strField(op.movementId, `${where}.movementId`, errors, 100);
      const movementName = strField(op.movementName, `${where}.movementName`, errors, 120);
      const category = op.category;
      const sets = posInt(op.sets, 'sets', errors, where);
      const reps = posInt(op.reps, 'reps', errors, where);
      const categoryValid = typeof category === 'string' && VALID_CATEGORIES.has(category);
      if (
        !dayId ||
        !movementId ||
        !movementName ||
        sets === undefined ||
        reps === undefined ||
        !categoryValid
      ) {
        if (!categoryValid) {
          errors.push(`${where}.category must be one of ${[...VALID_CATEGORIES].join(', ')}.`);
        }
        return undefined;
      }
      let repsMax: number | undefined;
      if (op.repsMax !== undefined && op.repsMax !== null) {
        const n = posInt(op.repsMax, 'repsMax', errors, where);
        if (n === undefined) return undefined;
        if (n < reps) {
          errors.push(`${where}.repsMax (${n}) must be >= reps (${reps}).`);
          return undefined;
        }
        repsMax = n;
      }
      const unit: 'reps' | 'sec' = op.unit === 'sec' ? 'sec' : 'reps';
      return {
        ...base,
        kind,
        dayId,
        movementId,
        movementName,
        category: category as string,
        sets,
        reps,
        unit,
        ...(blockId ? { blockId } : {}),
        ...(repsMax !== undefined ? { repsMax } : {}),
      };
    }
    case 'add_movement_to_library': {
      const tempMovementId = strField(
        op.tempMovementId,
        `${where}.tempMovementId`,
        errors,
        80,
      );
      const name = strField(op.name, `${where}.name`, errors, 80);
      const category = op.category;
      const pattern = op.pattern;
      const rawPrimary = op.primaryMuscles;
      const rawSecondary = op.secondaryMuscles;
      const categoryValid = typeof category === 'string' && VALID_CATEGORIES.has(category);
      const patternValid = typeof pattern === 'string' && VALID_PATTERNS.has(pattern);
      const tempIdValid =
        typeof tempMovementId === 'string' && TEMP_MOVEMENT_ID_RX.test(tempMovementId);
      if (tempMovementId && !tempIdValid) {
        errors.push(
          `${where}.tempMovementId must match ^tmp:[a-z0-9-]+$ (e.g. "tmp:banded-clamshell"). Got "${tempMovementId}".`,
        );
      }
      if (!categoryValid) {
        errors.push(`${where}.category must be one of ${[...VALID_CATEGORIES].join(', ')}.`);
      }
      if (!patternValid) {
        errors.push(`${where}.pattern must be one of ${[...VALID_PATTERNS].join(', ')}.`);
      }
      let primaryMuscles: string[] | undefined;
      if (!Array.isArray(rawPrimary) || rawPrimary.length === 0) {
        errors.push(
          `${where}.primaryMuscles must be a non-empty array of MuscleGroup values.`,
        );
      } else {
        const ok: string[] = [];
        for (const m of rawPrimary) {
          if (typeof m !== 'string' || !VALID_MUSCLES.has(m)) {
            errors.push(
              `${where}.primaryMuscles contains invalid muscle "${String(m)}". Allowed: ${[...VALID_MUSCLES].join(', ')}.`,
            );
            continue;
          }
          if (!ok.includes(m)) ok.push(m);
        }
        if (ok.length > 0) primaryMuscles = ok;
      }
      let secondaryMuscles: string[] | undefined;
      if (rawSecondary !== undefined && rawSecondary !== null) {
        if (!Array.isArray(rawSecondary)) {
          errors.push(`${where}.secondaryMuscles must be an array or omitted.`);
        } else {
          const ok: string[] = [];
          for (const m of rawSecondary) {
            if (typeof m !== 'string' || !VALID_MUSCLES.has(m)) {
              errors.push(
                `${where}.secondaryMuscles contains invalid muscle "${String(m)}".`,
              );
              continue;
            }
            if (!ok.includes(m) && !primaryMuscles?.includes(m)) ok.push(m);
          }
          if (ok.length > 0) secondaryMuscles = ok;
        }
      }
      let equipment: string | undefined;
      if (op.equipment !== undefined && op.equipment !== null) {
        if (typeof op.equipment !== 'string' || !VALID_EQUIPMENT.has(op.equipment)) {
          errors.push(
            `${where}.equipment must be one of ${[...VALID_EQUIPMENT].join(', ')} (or omitted).`,
          );
        } else {
          equipment = op.equipment;
        }
      }
      const cues =
        typeof op.cues === 'string' && op.cues.trim()
          ? op.cues.trim().slice(0, 300)
          : undefined;
      const dedupHint =
        typeof op.dedupHint === 'string' && op.dedupHint.trim()
          ? op.dedupHint.trim().slice(0, 300)
          : undefined;
      if (
        !tempMovementId ||
        !tempIdValid ||
        !name ||
        !categoryValid ||
        !patternValid ||
        !primaryMuscles
      ) {
        return undefined;
      }
      return {
        ...base,
        kind,
        tempMovementId,
        name,
        category: category as string,
        pattern: pattern as string,
        primaryMuscles,
        ...(secondaryMuscles ? { secondaryMuscles } : {}),
        ...(equipment ? { equipment } : {}),
        ...(typeof op.isCompound === 'boolean' ? { isCompound: op.isCompound } : {}),
        ...(typeof op.externallyLoadable === 'boolean'
          ? { externallyLoadable: op.externallyLoadable }
          : {}),
        ...(cues ? { cues } : {}),
        ...(dedupHint ? { dedupHint } : {}),
      };
    }
    case 'remove_assistance_entry': {
      const dayId = strField(op.dayId, `${where}.dayId`, errors, 100);
      const entryId = strField(op.entryId, `${where}.entryId`, errors, 100);
      const movementName = strField(op.movementName, `${where}.movementName`, errors, 120);
      if (!dayId || !entryId || !movementName) return undefined;
      return {
        ...base,
        kind,
        dayId,
        entryId,
        movementName,
        ...(blockId ? { blockId } : {}),
      };
    }
    case 'add_cardio_plan_slot': {
      const VALID_MODALITIES = new Set<string>([
        'run',
        'bike',
        'swim',
        'row',
        'walk',
        'padel',
        'other',
      ]);
      const VALID_PLAN_KINDS = new Set<string>([
        'rest',
        'easy',
        'long',
        'quality',
        'recovery',
        'race-pace',
        'z2',
        'intervals',
        'cross',
      ]);
      const rawDow = op.dayOfWeek;
      let dayOfWeek: number | undefined;
      if (typeof rawDow === 'number' && Number.isInteger(rawDow) && rawDow >= 0 && rawDow <= 6) {
        dayOfWeek = rawDow;
      } else {
        errors.push(
          `${where}.dayOfWeek must be an integer 0-6 (0=Mon … 6=Sun). Got ${String(rawDow)}.`,
        );
      }
      const modalityRaw = op.modality;
      const modalityValid =
        typeof modalityRaw === 'string' && VALID_MODALITIES.has(modalityRaw);
      if (!modalityValid) {
        errors.push(
          `${where}.modality must be one of ${[...VALID_MODALITIES].join(', ')}.`,
        );
      }
      // The op field is named planKind (not 'kind') so it doesn't shadow
      // the op-discriminator 'kind' field.
      const planKindRaw = op.planKind;
      const planKindValid =
        typeof planKindRaw === 'string' && VALID_PLAN_KINDS.has(planKindRaw);
      if (!planKindValid) {
        errors.push(
          `${where}.planKind must be one of ${[...VALID_PLAN_KINDS].join(', ')}.`,
        );
      }
      let durationMin: number | undefined;
      if (op.durationMin !== undefined && op.durationMin !== null) {
        const n = num(op.durationMin, 'durationMin', errors, where);
        if (n !== undefined) {
          if (!Number.isFinite(n) || n <= 0 || n > 600) {
            errors.push(
              `${where}.durationMin must be a positive number ≤ 600 minutes.`,
            );
          } else {
            durationMin = Math.round(n);
          }
        }
      }
      const notes =
        typeof op.notes === 'string' && op.notes.trim()
          ? op.notes.trim().slice(0, 200)
          : undefined;
      if (dayOfWeek === undefined || !modalityValid || !planKindValid) {
        return undefined;
      }
      return {
        ...base,
        kind,
        dayOfWeek,
        modality: modalityRaw as string,
        planKind: planKindRaw as string,
        ...(durationMin !== undefined ? { durationMin } : {}),
        ...(notes ? { notes } : {}),
        ...(typeof op.linkedToActiveBlock === 'boolean'
          ? { linkedToActiveBlock: op.linkedToActiveBlock }
          : {}),
        ...(Array.isArray(op.appliesToWeeks) && op.appliesToWeeks.length > 0
          ? (() => {
              const VALID_WEEKS = new Set<string>(['1', '2', '3', 'deload', '7w']);
              const cleaned: Array<'1' | '2' | '3' | 'deload' | '7w'> = [];
              for (const w of op.appliesToWeeks as unknown[]) {
                const s = typeof w === 'number' ? String(w) : (w as string);
                if (typeof s === 'string' && VALID_WEEKS.has(s) && !cleaned.includes(s as never)) {
                  cleaned.push(s as '1' | '2' | '3' | 'deload' | '7w');
                }
              }
              return cleaned.length > 0 ? { appliesToWeeks: cleaned } : {};
            })()
          : {}),
      };
    }
    case 'schedule_deload': {
      return { ...base, kind };
    }
    case 'switch_to_template': {
      const templateId =
        typeof op.templateId === 'string' ? op.templateId.trim() : '';
      if (!templateId) {
        errors.push(`${where}.templateId is required.`);
        return undefined;
      }
      const template = WENDLER_TEMPLATES.find((t) => t.id === templateId);
      if (!template) {
        errors.push(
          `${where}.templateId "${templateId}" is not a known Wendler template. Pick an id from the ## Wendler templates catalog in the snapshot (e.g. "bbb-forever", "5spro-fsl", "pervertor").`,
        );
        return undefined;
      }
      const programName =
        typeof op.programName === 'string' && op.programName.trim()
          ? op.programName.trim().slice(0, 80)
          : undefined;
      const blockName =
        typeof op.blockName === 'string' && op.blockName.trim()
          ? op.blockName.trim().slice(0, 80)
          : undefined;
      return {
        ...base,
        kind,
        templateId,
        ...(programName ? { programName } : {}),
        ...(blockName ? { blockName } : {}),
      };
    }
    case 'remove_cardio_plan_slot': {
      const VALID_MODALITIES = new Set<string>([
        'run',
        'bike',
        'swim',
        'row',
        'walk',
        'padel',
        'other',
      ]);
      const rawDow = op.dayOfWeek;
      let dayOfWeek: number | undefined;
      if (typeof rawDow === 'number' && Number.isInteger(rawDow) && rawDow >= 0 && rawDow <= 6) {
        dayOfWeek = rawDow;
      } else {
        errors.push(
          `${where}.dayOfWeek must be an integer 0-6 (0=Mon … 6=Sun). Got ${String(rawDow)}.`,
        );
      }
      const modalityRaw = op.modality;
      const modalityValid =
        typeof modalityRaw === 'string' && VALID_MODALITIES.has(modalityRaw);
      if (!modalityValid) {
        errors.push(
          `${where}.modality must be one of ${[...VALID_MODALITIES].join(', ')}.`,
        );
      }
      const modalityLabel =
        typeof op.modalityLabel === 'string' && op.modalityLabel.trim()
          ? op.modalityLabel.trim().slice(0, 40)
          : undefined;
      const planKindLabel =
        typeof op.planKindLabel === 'string' && op.planKindLabel.trim()
          ? op.planKindLabel.trim().slice(0, 40)
          : undefined;
      if (dayOfWeek === undefined || !modalityValid) return undefined;
      return {
        ...base,
        kind,
        dayOfWeek,
        modality: modalityRaw as string,
        ...(modalityLabel ? { modalityLabel } : {}),
        ...(planKindLabel ? { planKindLabel } : {}),
      };
    }
    case 'skip_day_in_week': {
      const dayId = strField(op.dayId, `${where}.dayId`, errors, 100);
      const skipReasonRaw = op.skipReason;
      const VALID_SKIP_REASONS = new Set<string>([
        'cardio-replacement',
        'rest-day',
        'travel',
        'fatigue',
        'pain',
        'other',
      ]);
      const VALID_WEEKS = new Set<string>(['1', '2', '3', 'deload', '7w']);
      const rawWeeks = op.weeks;
      let weeks: Array<'1' | '2' | '3' | 'deload' | '7w'> | undefined;
      if (!Array.isArray(rawWeeks) || rawWeeks.length === 0) {
        errors.push(`${where}.weeks must be a non-empty array of week labels.`);
      } else {
        const ok: Array<'1' | '2' | '3' | 'deload' | '7w'> = [];
        for (const w of rawWeeks) {
          // Accept both string ("1") and number (1) for week labels.
          const s = typeof w === 'number' ? String(w) : w;
          if (typeof s === 'string' && VALID_WEEKS.has(s)) {
            ok.push(s as '1' | '2' | '3' | 'deload' | '7w');
          } else {
            errors.push(
              `${where}.weeks[] entries must be one of "1" | "2" | "3" | "deload" | "7w" (got ${JSON.stringify(w)}).`,
            );
          }
        }
        // De-dupe + stable order.
        const uniq = Array.from(new Set(ok));
        if (uniq.length > 0) weeks = uniq;
      }
      if (
        typeof skipReasonRaw !== 'string' ||
        !VALID_SKIP_REASONS.has(skipReasonRaw)
      ) {
        errors.push(
          `${where}.skipReason must be one of ${[...VALID_SKIP_REASONS].join(', ')}.`,
        );
      }
      const dayLabel =
        typeof op.dayLabel === 'string' && op.dayLabel.trim()
          ? op.dayLabel.trim().slice(0, 80)
          : undefined;
      const skipNote =
        typeof op.skipNote === 'string' && op.skipNote.trim()
          ? op.skipNote.trim().slice(0, 200)
          : undefined;
      if (!dayId || !weeks || typeof skipReasonRaw !== 'string' || !VALID_SKIP_REASONS.has(skipReasonRaw)) {
        return undefined;
      }
      return {
        ...base,
        kind,
        dayId,
        weeks,
        skipReason: skipReasonRaw as
          | 'cardio-replacement'
          | 'rest-day'
          | 'travel'
          | 'fatigue'
          | 'pain'
          | 'other',
        ...(blockId ? { blockId } : {}),
        ...(dayLabel ? { dayLabel } : {}),
        ...(skipNote ? { skipNote } : {}),
      };
    }
    default:
      errors.push(`${where}.kind unhandled: ${kind}`);
      return undefined;
  }
}

/**
 * Merge a user's per-op decision modifications onto the AI's original
 * op input. Returns the effective op the apply handler should use.
 * Only fields present in `modifiedInput` are taken from the override.
 * The caller is responsible for re-validating the merged op against
 * the kind's schema (post-modify validation runs in the apply
 * orchestrator).
 */
export function applyDecisionToOp(
  op: ParsedEditOperation,
  modifiedInput: Record<string, unknown> | undefined,
): ParsedEditOperation {
  if (!modifiedInput) return op;
  return { ...op, ...modifiedInput } as ParsedEditOperation;
}
