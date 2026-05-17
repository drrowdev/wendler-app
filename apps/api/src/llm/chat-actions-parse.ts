// Action-chip parser. Mirror of packages/domain/src/agents/chat/
// chat-actions-parse.ts — kept local because Azure Functions on Node16
// module resolution can't consume @wendler/domain's extensionless ESM
// imports (same pattern as apps/api/src/llm/validate.ts).
//
// As of v450 the <actions> sidecar carries `log_injury`,
// `schedule_followup`, and `remember` chips. Every other AI-driven
// write goes through the `propose_edit` tool-use path; see
// edit-proposal-parse.ts.

export type ParsedChatActionKind = 'log_injury' | 'schedule_followup' | 'remember';

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

/**
 * Schedule a follow-up message from the AI itself, delivered as a
 * future-dated notification. When the user opens the notification at
 * or after `inHours`, the resulting deeplink pre-fills `prompt` as a
 * new user message in the SAME chat and auto-sends it — so the AI's
 * follow-up call has the prior conversation as context.
 *
 * Example: after an injury log, the AI emits one chip per check-in
 * point ("In 1 day", "In 3 days", "In 1 week") with prompts tailored
 * to the rehab timeline. The user accepts the ones they want.
 */
export interface ParsedScheduleFollowupAction extends ParsedActionBase {
  kind: 'schedule_followup';
  /** Hours from acceptance until the notification fires. 1–720 (30d max). */
  inHours: number;
  /** Brief headline shown in the notification (≤60 chars). */
  topic: string;
  /** The user-message text the chat will auto-send on tap (≤500 chars). */
  prompt: string;
}

/**
 * Commit a durable fact / preference / constraint about the user to
 * the persistent memory store. Accepted memories surface in every
 * future chat snapshot under "## Your trainer remembers" so the AI
 * has continuous personal context.
 */
export interface ParsedRememberAction extends ParsedActionBase {
  kind: 'remember';
  /** ≤200 chars trimmed. */
  text: string;
  category: 'preference' | 'fact' | 'goal' | 'constraint' | 'context';
}

export type ParsedChatAction =
  | ParsedLogInjuryAction
  | ParsedScheduleFollowupAction
  | ParsedRememberAction;

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
  if (typeof r.label !== 'string') return null;
  const label = r.label.trim();
  if (label.length === 0 || label.length > 60) return null;
  const rationale =
    typeof r.rationale === 'string' && r.rationale.trim().length > 0
      ? r.rationale.trim().slice(0, 200)
      : undefined;

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
      id: getId(),
      label,
      ...(rationale ? { rationale } : {}),
      status: 'pending' as const,
      kind: 'log_injury',
      area,
      ...(severity ? { severity } : {}),
      ...(description ? { description } : {}),
      ...(movementIds && movementIds.length > 0 ? { movementIds } : {}),
    };
  }

  if (kind === 'schedule_followup') {
    if (typeof r.inHours !== 'number' || !Number.isFinite(r.inHours)) return null;
    const inHours = Math.max(1, Math.min(720, Math.round(r.inHours)));
    if (typeof r.topic !== 'string') return null;
    const topic = r.topic.trim().slice(0, 60);
    if (!topic) return null;
    if (typeof r.prompt !== 'string') return null;
    const prompt = r.prompt.trim().slice(0, 500);
    if (!prompt) return null;
    return {
      id: getId(),
      label,
      ...(rationale ? { rationale } : {}),
      status: 'pending' as const,
      kind: 'schedule_followup',
      inHours,
      topic,
      prompt,
    };
  }

  if (kind === 'remember') {
    if (typeof r.text !== 'string') return null;
    const text = r.text.trim().slice(0, 200);
    if (!text) return null;
    const VALID_CATEGORIES = new Set([
      'preference',
      'fact',
      'goal',
      'constraint',
      'context',
    ]);
    const cat = typeof r.category === 'string' ? r.category.trim() : '';
    const category = (VALID_CATEGORIES.has(cat) ? cat : 'context') as
      | 'preference'
      | 'fact'
      | 'goal'
      | 'constraint'
      | 'context';
    return {
      id: getId(),
      label,
      ...(rationale ? { rationale } : {}),
      status: 'pending' as const,
      kind: 'remember',
      text,
      category,
    };
  }

  return null;
}
