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
import { runPeriodizer } from '../agents/periodizer/runner.js';

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
      return dispatchPeriodizer(input, ctx);
    case 'summarize_week':
      return dispatchSummarizer(input, ctx);
    default:
      return { resultText: `[Tool dispatch error] Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Coach specialist — chat flavor.

const COACH_CHAT_SYSTEM = `You are a movement-modification coach with sports-physio (MSK / PT) training, embedded inside the user's Wendler 5/3/1 PWA chat. The parent chat orchestrator has consulted you for one specific question about pain, soreness, or a suspected injury.

Your job:
1. Identify the underlying anatomical issue from the user's description (which structure, which side, which load context).
2. Cross-reference the user's training-data snapshot for movements that load the same structure — these are connected even when the movements look different (e.g. right adductor = Bulgarian split squat under load AND right-leg deadbug extension).
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

const PROGRAMMER_CHAT_SYSTEM = `You are the Wendler 5/3/1 programming specialist embedded inside the user's training PWA chat. The parent chat orchestrator has consulted you for a specific question about session/week/block planning, assistance selection, or movement substitution.

The user's flavor (DO NOT depart from this unless they explicitly ask):
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
// Periodizer specialist — chat flavor.
//
// The Periodizer agent itself returns strict structured JSON (verdict +
// evidence + nextSteps + shortReply) for UI surfacing. For chat tool-use
// we only need the `shortReply` field; the rest is discarded since the
// chat orchestrator just embeds prose. We pass through any LLM errors as
// a readable string so the chat agent can reconcile around them.

async function dispatchPeriodizer(
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  const question = String(input.question ?? '').trim();
  if (!question) return { resultText: '[Periodizer] No question provided.' };

  const userPromptParts: string[] = [];
  userPromptParts.push(`<training-data-snapshot>\n${ctx.chatContext}\n</training-data-snapshot>`);
  if (ctx.todayLocal) userPromptParts.push(`Today: ${ctx.todayLocal}`);
  userPromptParts.push('## Question routed to you');
  userPromptParts.push(question);

  // The Periodizer system prompt expects pre-computed signals in its own
  // section, but at chat-tool-call time we only have the chat snapshot.
  // That's intentional — the snapshot already includes TSB/CTL/ATL/ACWR
  // lines for the last 90 days (see chat-context.ts), and the model can
  // read them from there. We still pass the question so it knows what
  // verdict to land on.

  const startedAt = Date.now();
  const result = await runPeriodizer({
    userPrompt: userPromptParts.join('\n\n'),
    model: ctx.model,
  });
  const elapsedMs = Date.now() - startedAt;

  if (!result.ok) {
    return {
      resultText:
        `[Periodizer call failed — errorCode=${result.errorCode}] ` +
        result.errors.join('; '),
      usage: { inputTokens: 0, outputTokens: 0, latencyMs: elapsedMs },
    };
  }

  const data = result.data.response;
  const lines: string[] = [];
  lines.push(`**Verdict:** ${data.verdict}`);
  lines.push(data.shortReply);
  if (data.evidence.length > 0) {
    lines.push('');
    lines.push('Evidence:');
    for (const e of data.evidence.slice(0, 4)) {
      lines.push(`- ${e.label}: ${e.value} — ${e.interpretation}`);
    }
  }
  if (data.nextSteps.length > 0) {
    lines.push('');
    lines.push('Next steps:');
    for (const s of data.nextSteps.slice(0, 3)) lines.push(`- ${s}`);
  }

  return {
    resultText: lines.join('\n'),
    usage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      latencyMs: elapsedMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Summarizer specialist — chat flavor.
//
// The Summarizer agent's "real" job (the structured 6-section JSON card)
// lives in the /api/workflows/weeklyReview workflow which expects a
// pre-built signal payload assembled from the user's IndexedDB. For chat
// tool-use we just need a prose recap based on the snapshot the chat
// already has, so this dispatch makes a focused chat-flavored Anthropic
// call (similar to dispatchCoach / dispatchProgrammer) rather than going
// through runSummarizer.

const SUMMARIZER_CHAT_SYSTEM = `You are the weekly-training summarizer embedded inside the user's PWA chat. The parent chat orchestrator has consulted you to recap a recent training week. You have access to the chat snapshot (last 90 days at daily detail; older as weekly/monthly aggregates).

Your job: produce a concise 4-6 paragraph recap of the week the user asked about (default: the most recent completed Mon-Sun week if no weekStart given). Include:
- sessions logged + days trained
- top sets / any PRs on main lifts (concrete numbers)
- cardio totals: run km, longest run, bike km
- load/recovery direction: TSB / CTL / ACWR trend, recovery entry averages (fatigue + soreness on the 0-10 Borg scale)
- 1-2 highlights if there's something genuinely notable (PR, biggest mileage week of the cycle)

Output: ≤400 words of prose with light markdown (bold for highlights, occasional bullet lists for top sets). No tables. No JSON. No code fences. Speak TO the user in second person.

If the snapshot doesn't contain enough data for the requested week (e.g. user asks about a week before the 90-day window), say so plainly and offer to recap a week we do have data for.

Your response will be folded back into the parent chat as expert input — write for a peer LLM that will reconcile and produce the final user-facing answer.`;

async function dispatchSummarizer(
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  const weekStart = typeof input.weekStart === 'string' ? input.weekStart.trim() : undefined;

  const userPromptParts: string[] = [];
  userPromptParts.push(`<training-data-snapshot>\n${ctx.chatContext}\n</training-data-snapshot>`);
  if (ctx.todayLocal) userPromptParts.push(`Today: ${ctx.todayLocal}`);
  if (weekStart) {
    userPromptParts.push(`Week to summarise: Monday ${weekStart} → the following Sunday.`);
  } else {
    userPromptParts.push(
      'Week to summarise: the most recent COMPLETED Monday→Sunday week relative to today.',
    );
  }

  return runSpecialist({
    system: SUMMARIZER_CHAT_SYSTEM,
    userPrompt: userPromptParts.join('\n\n'),
    ctx,
    temperatureEnv: 'ANTHROPIC_SUMMARIZER_TEMPERATURE',
    defaultTemperature: 0.3,
    speciality: 'Summarizer',
  });
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
