// Coach agent — response validator.
//
// Parses + validates the structured JSON the Coach agent emits. Returns a
// discriminated union: `{ ok: true, data }` on success, `{ ok: false, errors }`
// when the response doesn't conform to the schema. Mirrors the approach used
// by the Programmer agent's response validator.

const VALID_ACTIONS = new Set([
  'skip',
  'reduce-load',
  'reduce-range',
  'modify-execution',
  'monitor',
] as const);

export type CoachAction =
  | 'skip'
  | 'reduce-load'
  | 'reduce-range'
  | 'modify-execution'
  | 'monitor';

export interface CoachProposedAdjustment {
  movementId: string;
  action: CoachAction;
  modification: string;
  reasoning: string;
}

export interface CoachResponse {
  summary: string;
  proposedAdjustments: CoachProposedAdjustment[];
  monitoringAdvice?: string;
  consultRecommended?: boolean;
  consultReason?: string;
}

export type CoachParseResult =
  | { ok: true; data: CoachResponse }
  | { ok: false; errors: string[] };

export interface ParseCoachResponseOptions {
  /** Movement IDs the agent is allowed to reference. */
  allowedMovementIds?: ReadonlySet<string>;
  /** Hard cap on adjustments per response (defensive). Default 50. */
  maxAdjustments?: number;
  /** Hard cap on individual string lengths (defensive). Default 500. */
  maxStringLength?: number;
}

const DEFAULT_MAX_ADJUSTMENTS = 50;
const DEFAULT_MAX_STRING_LENGTH = 500;

/**
 * Parse the model's raw text. Strips a code fence if present (defensive —
 * the system prompt asks for none, but Claude occasionally adds one).
 */
export function parseCoachResponse(
  raw: string,
  options: ParseCoachResponseOptions = {},
): CoachParseResult {
  const errors: string[] = [];

  const cleaned = stripCodeFence(raw).trim();
  if (cleaned === '') {
    return { ok: false, errors: ['Coach response was empty.'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { ok: false, errors: [`Coach response was not valid JSON: ${(e as Error).message}`] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['Coach response must be a JSON object.'] };
  }

  const obj = parsed as Record<string, unknown>;
  const allowedMovementIds = options.allowedMovementIds;
  const maxAdjustments = options.maxAdjustments ?? DEFAULT_MAX_ADJUSTMENTS;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  // summary (required string)
  const summary = obj.summary;
  if (typeof summary !== 'string' || summary.trim() === '') {
    errors.push('Field `summary` is required and must be a non-empty string.');
  } else if (summary.length > maxStringLength * 4) {
    errors.push(
      `Field \`summary\` exceeds ${maxStringLength * 4} characters (got ${summary.length}).`,
    );
  }

  // proposedAdjustments (required array — may be empty)
  const adjustments = obj.proposedAdjustments;
  const cleanAdjustments: CoachProposedAdjustment[] = [];
  if (!Array.isArray(adjustments)) {
    errors.push('Field `proposedAdjustments` is required and must be an array (may be empty).');
  } else {
    if (adjustments.length > maxAdjustments) {
      errors.push(
        `Field \`proposedAdjustments\` has ${adjustments.length} entries; cap is ${maxAdjustments}.`,
      );
    }
    const seenMovementIds = new Set<string>();
    adjustments.forEach((adj, i) => {
      const where = `proposedAdjustments[${i}]`;
      if (!adj || typeof adj !== 'object' || Array.isArray(adj)) {
        errors.push(`${where} must be an object.`);
        return;
      }
      const a = adj as Record<string, unknown>;
      const movementId = a.movementId;
      const action = a.action;
      const modification = a.modification;
      const reasoning = a.reasoning;

      let bad = false;
      if (typeof movementId !== 'string' || movementId.trim() === '') {
        errors.push(`${where}.movementId is required and must be a non-empty string.`);
        bad = true;
      } else if (allowedMovementIds && !allowedMovementIds.has(movementId)) {
        errors.push(
          `${where}.movementId ${JSON.stringify(movementId)} is not in the user's library.`,
        );
        bad = true;
      } else if (seenMovementIds.has(movementId)) {
        errors.push(
          `${where}.movementId ${JSON.stringify(movementId)} appears multiple times in proposedAdjustments. ` +
            'Each movement should have at most one adjustment.',
        );
        bad = true;
      }

      if (typeof action !== 'string' || !VALID_ACTIONS.has(action as CoachAction)) {
        errors.push(
          `${where}.action must be one of ${[...VALID_ACTIONS].join(', ')}; got ${JSON.stringify(action)}.`,
        );
        bad = true;
      }
      if (typeof modification !== 'string' || modification.trim() === '') {
        errors.push(`${where}.modification is required and must be a non-empty string.`);
        bad = true;
      } else if (modification.length > maxStringLength) {
        errors.push(
          `${where}.modification exceeds ${maxStringLength} chars (got ${modification.length}).`,
        );
        bad = true;
      }
      if (typeof reasoning !== 'string' || reasoning.trim() === '') {
        errors.push(`${where}.reasoning is required and must be a non-empty string.`);
        bad = true;
      } else if (reasoning.length > maxStringLength) {
        errors.push(
          `${where}.reasoning exceeds ${maxStringLength} chars (got ${reasoning.length}).`,
        );
        bad = true;
      }

      if (!bad && typeof movementId === 'string') {
        seenMovementIds.add(movementId);
        cleanAdjustments.push({
          movementId: movementId.trim(),
          action: action as CoachAction,
          modification: (modification as string).trim(),
          reasoning: (reasoning as string).trim(),
        });
      }
    });
  }

  // monitoringAdvice (optional string)
  let monitoringAdvice: string | undefined;
  if (obj.monitoringAdvice !== undefined && obj.monitoringAdvice !== null) {
    if (typeof obj.monitoringAdvice !== 'string') {
      errors.push('Field `monitoringAdvice` must be a string when present.');
    } else if (obj.monitoringAdvice.length > maxStringLength * 4) {
      errors.push(`Field \`monitoringAdvice\` exceeds ${maxStringLength * 4} chars.`);
    } else if (obj.monitoringAdvice.trim() !== '') {
      monitoringAdvice = obj.monitoringAdvice.trim();
    }
  }

  // consultRecommended (optional boolean)
  const consultRecommended =
    typeof obj.consultRecommended === 'boolean' ? obj.consultRecommended : false;
  if (
    obj.consultRecommended !== undefined &&
    obj.consultRecommended !== null &&
    typeof obj.consultRecommended !== 'boolean'
  ) {
    errors.push('Field `consultRecommended` must be a boolean when present.');
  }

  // consultReason (required when consultRecommended)
  let consultReason: string | undefined;
  if (consultRecommended) {
    if (typeof obj.consultReason !== 'string' || obj.consultReason.trim() === '') {
      errors.push(
        'Field `consultReason` is required when `consultRecommended` is true; must be a non-empty string.',
      );
    } else if (obj.consultReason.length > maxStringLength * 2) {
      errors.push(`Field \`consultReason\` exceeds ${maxStringLength * 2} chars.`);
    } else {
      consultReason = obj.consultReason.trim();
    }
  } else if (typeof obj.consultReason === 'string' && obj.consultReason.trim() !== '') {
    // Carry through anyway — not an error, just unusual.
    consultReason = obj.consultReason.trim();
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      summary: (summary as string).trim(),
      proposedAdjustments: cleanAdjustments,
      ...(monitoringAdvice !== undefined ? { monitoringAdvice } : {}),
      consultRecommended,
      ...(consultReason !== undefined ? { consultReason } : {}),
    },
  };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    // Strip the opening fence (with optional language tag) and the closing fence.
    const withoutOpening = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
    return withoutOpening.replace(/\n?```\s*$/, '');
  }
  return trimmed;
}
