// Action-chip parser. Server-side. Extracts the `<actions>...</actions>`
// JSON block (if present) at the end of a chat assistant message, returns
// the validated chip array plus the prose with the block stripped.
//
// As of v397 the <actions> sidecar carries ONLY `log_injury` chips.
// Every other AI-driven write goes through the `propose_edit` tool-use
// path; see packages/domain/src/agents/chat/edit-proposal-parse.ts.

export type ParsedChatActionKind = 'log_injury';

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

export type ParsedChatAction = ParsedLogInjuryAction;

const ACTIONS_OPEN = '<actions>';
const ACTIONS_CLOSE = '</actions>';
const MAX_ACTIONS = 4;
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
 * Unknown chip kinds (e.g. legacy `set_training_max` from older AI
 * emissions) are silently dropped — they're no longer supported and
 * the model should have used `propose_edit` instead.
 */
export function parseChatActionsBlock(
  raw: string,
  getId: () => string,
): ParseChatActionsResult {
  const open = raw.lastIndexOf(ACTIONS_OPEN);
  if (open < 0) return { prose: raw, actions: [] };
  const close = raw.indexOf(ACTIONS_CLOSE, open + ACTIONS_OPEN.length);
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
  if (kind !== 'log_injury') return null;
  if (typeof r.label !== 'string') return null;
  const label = r.label.trim();
  if (label.length === 0 || label.length > 60) return null;
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
    id: getId(),
    label,
    rationale:
      typeof r.rationale === 'string' && r.rationale.trim().length > 0
        ? r.rationale.trim().slice(0, 200)
        : undefined,
    status: 'pending' as const,
    kind: 'log_injury',
    area,
    ...(severity ? { severity } : {}),
    ...(description ? { description } : {}),
    ...(movementIds && movementIds.length > 0 ? { movementIds } : {}),
  };
}
