// Chat tool-use dispatch — Phase 3.
//
// Each tool the chat orchestrator can call routes through a small
// specialist Anthropic call here. For Phase 3 only the Coach + Programmer
// specialists have working dispatch. Periodizer + Summarizer are
// registered (so Claude can decide when they'd be appropriate) but
// dispatch returns a "not yet available" tool result; the chat agent then
// reconciles around the missing piece.
//
// Design notes:
//   * Each specialist runs as a separate, focused Anthropic call. System
//     prompt is the specialist's persona; user prompt is the chat context
//     snapshot + the tool input. Output is intentionally short prose
//     (≤300 words target) — it is folded back into the parent chat call's
//     working context, not shown directly to the user, and we want to keep
//     the parent's token budget healthy.
//   * Specialists ARE NOT the same code as the formal Coach/Programmer
//     agents (which return strict JSON for the suggester / injury flow).
//     Chat needs prose advice, not JSON. The formal agents are still the
//     source of truth for /api/agents/* and /api/workflows/*; this file
//     is the chat-flavored equivalent.
//   * Cost is captured per tool call so the chat orchestrator can log a
//     per-turn total.

import Anthropic from '@anthropic-ai/sdk';

export interface ToolDispatchContext {
  /** The full chat context snapshot the parent chat call already has. */
  chatContext: string;
  /** ISO date of "today" in user's local timezone. */
  todayLocal?: string;
  /** Anthropic API key (already validated by the parent). */
  apiKey: string;
  /** Anthropic model id. */
  model: string;
}

export interface ToolDispatchResult {
  /** Plain-text result the chat orchestrator passes back as a tool_result block. */
  resultText: string;
  /** Optional usage telemetry for cost logging. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
}

/**
 * Dispatch a single tool call. Always resolves — failures become a string
 * `resultText` describing the error so the chat orchestrator can reconcile
 * around it instead of blowing up the whole turn.
 */
export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  switch (name) {
    case 'consult_coach':
      return dispatchCoach(input, ctx);
    case 'consult_programmer':
      return dispatchProgrammer(input, ctx);
    case 'consult_periodizer':
      return notYetAvailable('Periodizer');
    case 'summarize_week':
      return notYetAvailable('Weekly summarizer');
    default:
      return { resultText: `[Tool dispatch error] Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Coach specialist — chat flavor.

const COACH_CHAT_SYSTEM = `You are a movement-modification coach with sports-physio (MSK / PT) training, embedded inside Martin's Wendler 5/3/1 PWA chat. The parent chat orchestrator has consulted you for one specific question about pain, soreness, or a suspected injury.

Your job:
1. Identify the underlying anatomical issue from the user's description (which structure, which side, which load context).
2. Cross-reference Martin's training-data snapshot for movements that load the same structure — these are connected even when the movements look different (e.g. right adductor = Bulgarian split squat under load AND right-leg deadbug extension).
3. Propose 1-3 concrete movement modifications using the action vocabulary: skip / reduce-load / reduce-range / modify-execution / monitor.
4. Note when a PT consult is warranted (severity ≥ 4, neurological signs, sudden trauma, ≥2 weeks unresolved).

Output: ≤300 words of prose, no markdown headings, no JSON. Speak in clear conversational paragraphs. Do NOT invent injury diagnoses you can't support; say "could be" / "consistent with" / "worth ruling out". Do NOT prescribe medication, imaging, or anything outside movement modification. You are advisory, NOT diagnostic.

Your response will be folded back into the parent chat as expert input — write for a peer LLM that will reconcile your advice with other specialists' inputs and produce the final user-facing answer.`;

async function dispatchCoach(
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  const question = String(input.question ?? '').trim();
  if (!question) return { resultText: '[Coach] No question provided.' };

  const userPromptParts: string[] = [];
  userPromptParts.push(`<training-data-snapshot>\n${ctx.chatContext}\n</training-data-snapshot>`);
  if (ctx.todayLocal) userPromptParts.push(`Today's date: ${ctx.todayLocal}`);
  userPromptParts.push('## Question being routed to you');
  userPromptParts.push(question);
  if (input.area) userPromptParts.push(`Area: ${String(input.area)}`);
  if (input.severity != null) userPromptParts.push(`Severity (1-5): ${String(input.severity)}`);
  if (Array.isArray(input.affectedMovementIds) && input.affectedMovementIds.length > 0) {
    userPromptParts.push(
      `Affected movementIds: ${(input.affectedMovementIds as string[]).join(', ')}`,
    );
  }

  return runSpecialist({
    system: COACH_CHAT_SYSTEM,
    userPrompt: userPromptParts.join('\n\n'),
    ctx,
    temperatureEnv: 'ANTHROPIC_COACH_TEMPERATURE',
    defaultTemperature: 0.2,
    speciality: 'Coach',
  });
}

// ---------------------------------------------------------------------------
// Programmer specialist — chat flavor.

const PROGRAMMER_CHAT_SYSTEM = `You are the Wendler 5/3/1 programming specialist embedded inside Martin's training PWA chat. The parent chat orchestrator has consulted you for a specific question about session/week/block planning, assistance selection, or movement substitution.

Martin's flavor (DO NOT depart from this unless he explicitly asks):
- TM at 85% of true 1RM.
- Anchor blocks (heavier intensity, lower volume) preferred over leader blocks for now.
- 2 main-lift days + 1 accessory day per week (3 lift days), with running/cycling programmed by Runna outside this app.
- Marathon-prep is a primary secondary goal — calf, hip-stability, single-leg, posterior-chain accessory volume is biased.
- Gym has barbell + EZ-bar + hammer-curl bar + DBs + KBs + rings + sled + sandbag + plyo box + bands. NO cables.

Your job: answer the routed question with concrete picks (specific movements, specific set/rep prescriptions, specific budgets) grounded in the data snapshot. Reference the snapshot inline ("your last bench session", "the active anchor block"). When the question is about "what should this session look like", emit a compact list (movement → sets × reps + 1-line rationale) — do NOT write the full assistance JSON; the suggester handles that.

Output: ≤350 words of prose + compact lists. No JSON. No code fences. Plain markdown headings allowed. Do NOT invent training context the snapshot doesn't show; say "I don't see X in your recent data" instead of guessing.

Your response will be folded back into the parent chat as expert input — write for a peer LLM that will reconcile your advice and produce the final user-facing answer.`;

async function dispatchProgrammer(
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  const question = String(input.question ?? '').trim();
  if (!question) return { resultText: '[Programmer] No question provided.' };

  const userPromptParts: string[] = [];
  userPromptParts.push(`<training-data-snapshot>\n${ctx.chatContext}\n</training-data-snapshot>`);
  if (ctx.todayLocal) userPromptParts.push(`Today's date: ${ctx.todayLocal}`);
  userPromptParts.push('## Question being routed to you');
  userPromptParts.push(question);
  if (input.scope) userPromptParts.push(`Scope: ${String(input.scope)}`);
  if (input.mainLiftFocus) userPromptParts.push(`Main lift focus: ${String(input.mainLiftFocus)}`);

  return runSpecialist({
    system: PROGRAMMER_CHAT_SYSTEM,
    userPrompt: userPromptParts.join('\n\n'),
    ctx,
    temperatureEnv: 'ANTHROPIC_TEMPERATURE',
    defaultTemperature: 0.3,
    speciality: 'Programmer',
  });
}

// ---------------------------------------------------------------------------
// Phase-4 stubs.

function notYetAvailable(label: string): ToolDispatchResult {
  return {
    resultText:
      `[${label} specialist not yet available] This specialist is registered ` +
      `with the orchestrator but its implementation ships in Phase 4. The ` +
      `chat agent should answer the parts of the question it can with the ` +
      `data snapshot it already has, and explicitly flag the missing piece ` +
      `to the user so they know it's coming.`,
  };
}

// ---------------------------------------------------------------------------
// Shared LLM call helper.

interface RunSpecialistArgs {
  system: string;
  userPrompt: string;
  ctx: ToolDispatchContext;
  temperatureEnv: string;
  defaultTemperature: number;
  speciality: string;
}

async function runSpecialist(args: RunSpecialistArgs): Promise<ToolDispatchResult> {
  const startedAt = Date.now();
  const client = new Anthropic({ apiKey: args.ctx.apiKey });
  const temperature = Number(
    process.env[args.temperatureEnv] ?? String(args.defaultTemperature),
  );
  const maxTokens = Number(process.env.ANTHROPIC_TOOL_MAX_TOKENS ?? '1500');
  try {
    const msg = await client.messages.create({
      model: args.ctx.model,
      max_tokens: maxTokens,
      temperature,
      system: args.system,
      messages: [{ role: 'user', content: args.userPrompt }],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const elapsedMs = Date.now() - startedAt;
    return {
      resultText: text || `[${args.speciality}] returned an empty response.`,
      usage: {
        inputTokens: msg.usage?.input_tokens ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
        latencyMs: elapsedMs,
      },
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    return {
      resultText: `[${args.speciality} call failed] ${(err as Error).message}`,
      usage: { inputTokens: 0, outputTokens: 0, latencyMs: elapsedMs },
    };
  }
}
