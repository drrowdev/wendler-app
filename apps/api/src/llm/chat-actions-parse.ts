// Action-chip parser. Mirror of packages/domain/src/agents/chat/
// chat-actions-parse.ts — kept local because Azure Functions on Node16
// module resolution can't consume @wendler/domain's extensionless ESM
// imports (same pattern as apps/api/src/llm/validate.ts).
//
// Mirrors the ChatAction union in packages/db-schema/src/types.ts. Add new
// kinds by adding a validator branch + extending the discriminated union
// in BOTH copies and in db-schema.

export type ParsedChatActionKind =
  | 'log_injury'
  | 'set_training_max'
  | 'set_block_volume_preset'
  | 'schedule_deload'
  | 'substitute_movement';

interface ParsedActionBase {
  id: string;
  kind: ParsedChatActionKind;
  label: string;
  rationale?: string;
  status: 'pending';
}

export interface ParsedLogInjuryAction extends ParsedActionBase {
  kind: 'log_injury';
  area: string;
  severity?: 1 | 2 | 3 | 4 | 5;
  description?: string;
  movementIds?: string[];
}

export interface ParsedSetTrainingMaxAction extends ParsedActionBase {
  kind: 'set_training_max';
  lift: 'squat' | 'bench' | 'deadlift' | 'press';
  newTrainingMaxKg: number;
  reason: string;
}

export interface ParsedSetBlockVolumePresetAction extends ParsedActionBase {
  kind: 'set_block_volume_preset';
  blockId?: string;
  preset: 'minimal' | 'standard' | 'high';
  reason: string;
}

export interface ParsedScheduleDeloadAction extends ParsedActionBase {
  kind: 'schedule_deload';
  reason: string;
}

export interface ParsedSubstituteMovementAction extends ParsedActionBase {
  kind: 'substitute_movement';
  blockId?: string;
  dayId?: string;
  dayIndex?: number;
  currentMovementId: string;
  currentMovementName: string;
  newMovementId: string;
  newMovementName: string;
  reason: string;
}

export type ParsedChatAction =
  | ParsedLogInjuryAction
  | ParsedSetTrainingMaxAction
  | ParsedSetBlockVolumePresetAction
  | ParsedScheduleDeloadAction
  | ParsedSubstituteMovementAction;

const ACTIONS_OPEN = '<actions>';
const ACTIONS_CLOSE = '</actions>';
const MAX_ACTIONS = 4;
const VALID_LIFTS = new Set(['squat', 'bench', 'deadlift', 'press']);
const VALID_PRESETS = new Set(['minimal', 'standard', 'high']);
const VALID_SEVERITIES = new Set([1, 2, 3, 4, 5]);

export interface ParseChatActionsResult {
  prose: string;
  actions: ParsedChatAction[];
}

/**
 * Pull the trailing `<actions>...</actions>` block out of an assistant
 * message. Returns the prose with the block stripped (and trailing
 * whitespace trimmed) plus the validated chip array. When no block is
 * present (or the JSON is malformed / no chip validates), `actions` is
 * empty and `prose` is the original input.
 *
 * `getId` allocates a stable id per chip. Callers should pass a UUID
 * generator (so the chips can be referenced later by id).
 */
export function parseChatActionsBlock(
  raw: string,
  getId: () => string,
): ParseChatActionsResult {
  const open = raw.lastIndexOf(ACTIONS_OPEN);
  if (open < 0) return { prose: raw, actions: [] };
  const close = raw.indexOf(ACTIONS_CLOSE, open + ACTIONS_OPEN.length);
  // If we have an opener but no closer, strip from opener onward (the
  // model started emitting chips but never finished — better to drop
  // the truncated mess than render it as prose).
  const prose = raw.slice(0, open).trimEnd();
  if (close < 0) return { prose, actions: [] };
  const jsonText = raw.slice(open + ACTIONS_OPEN.length, close).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { prose, actions: [] };
  }
  if (!Array.isArray(parsed)) return { prose, actions: [] };
  const actions: ParsedChatAction[] = [];
  for (const entry of parsed) {
    const v = validateOne(entry, getId);
    if (v) actions.push(v);
    if (actions.length >= MAX_ACTIONS) break;
  }
  return { prose, actions };
}

function validateOne(raw: unknown, getId: () => string): ParsedChatAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof r.label !== 'string') return null;
  const label = r.label.trim();
  if (label.length === 0 || label.length > 60) return null;
  const base = {
    id: getId(),
    label,
    rationale:
      typeof r.rationale === 'string' && r.rationale.trim().length > 0
        ? r.rationale.trim().slice(0, 200)
        : undefined,
    status: 'pending' as const,
  };

  if (kind === 'log_injury') {
    if (typeof r.area !== 'string') return null;
    const area = r.area.trim();
    if (!area) return null;
    const severity =
      typeof r.severity === 'number' && VALID_SEVERITIES.has(r.severity)
        ? (r.severity as 1 | 2 | 3 | 4 | 5)
        : undefined;
    const description =
      typeof r.description === 'string' ? r.description.trim().slice(0, 500) : undefined;
    const movementIds = Array.isArray(r.movementIds)
      ? (r.movementIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 10) as string[])
      : undefined;
    return {
      ...base,
      kind: 'log_injury',
      area,
      ...(severity ? { severity } : {}),
      ...(description ? { description } : {}),
      ...(movementIds && movementIds.length > 0 ? { movementIds } : {}),
    };
  }

  if (kind === 'set_training_max') {
    if (typeof r.lift !== 'string' || !VALID_LIFTS.has(r.lift)) return null;
    const kg = Number(r.newTrainingMaxKg);
    if (!Number.isFinite(kg) || kg <= 0 || kg > 500) return null;
    if (typeof r.reason !== 'string' || !r.reason.trim()) return null;
    return {
      ...base,
      kind: 'set_training_max',
      lift: r.lift as 'squat' | 'bench' | 'deadlift' | 'press',
      newTrainingMaxKg: Math.round(kg * 2) / 2,
      reason: r.reason.trim().slice(0, 300),
    };
  }

  if (kind === 'set_block_volume_preset') {
    if (typeof r.preset !== 'string' || !VALID_PRESETS.has(r.preset)) return null;
    if (typeof r.reason !== 'string' || !r.reason.trim()) return null;
    return {
      ...base,
      kind: 'set_block_volume_preset',
      ...(typeof r.blockId === 'string' && r.blockId.length > 0 ? { blockId: r.blockId } : {}),
      preset: r.preset as 'minimal' | 'standard' | 'high',
      reason: r.reason.trim().slice(0, 300),
    };
  }

  if (kind === 'schedule_deload') {
    if (typeof r.reason !== 'string' || !r.reason.trim()) return null;
    return {
      ...base,
      kind: 'schedule_deload',
      reason: r.reason.trim().slice(0, 300),
    };
  }

  if (kind === 'substitute_movement') {
    if (typeof r.currentMovementId !== 'string' || !r.currentMovementId.trim()) return null;
    if (typeof r.newMovementId !== 'string' || !r.newMovementId.trim()) return null;
    if (typeof r.currentMovementName !== 'string' || !r.currentMovementName.trim()) return null;
    if (typeof r.newMovementName !== 'string' || !r.newMovementName.trim()) return null;
    if (r.currentMovementId === r.newMovementId) return null;
    if (typeof r.reason !== 'string' || !r.reason.trim()) return null;
    const dayIndex =
      typeof r.dayIndex === 'number' && Number.isInteger(r.dayIndex) && r.dayIndex >= 0 && r.dayIndex < 10
        ? r.dayIndex
        : undefined;
    return {
      ...base,
      kind: 'substitute_movement',
      ...(typeof r.blockId === 'string' && r.blockId.length > 0 ? { blockId: r.blockId } : {}),
      ...(typeof r.dayId === 'string' && r.dayId.length > 0 ? { dayId: r.dayId } : {}),
      ...(dayIndex !== undefined ? { dayIndex } : {}),
      currentMovementId: r.currentMovementId.trim(),
      currentMovementName: r.currentMovementName.trim().slice(0, 80),
      newMovementId: r.newMovementId.trim(),
      newMovementName: r.newMovementName.trim().slice(0, 80),
      reason: r.reason.trim().slice(0, 300),
    };
  }

  return null;
}
