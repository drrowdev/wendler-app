import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { Readable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { verifyRequest } from '../auth';
import { CHAT_TOOL_SPECS } from '../llm/chat-tool-specs';
import { dispatchTool } from '../llm/chat-tools';
import { parseChatActionsBlock } from '../llm/chat-actions-parse';
import { randomUUID } from 'node:crypto';

interface IncomingMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  context: string;
  messages: IncomingMessage[];
  contextPath?: string;
  todayLocal?: string;
}

const SYSTEM_PROMPT_BASE = `You are the user's personal training coach assistant inside the Wendler 5/3/1 PWA. You have access to a snapshot of their training data (cardio sessions, strength logs, training maxes, races, recovery entries, training profile, active limitations) AND four specialist tools you can consult:

- **consult_coach** — pain, soreness, "should I keep training X?", any movement-modification question. The Coach is the only authority on injury reasoning; do NOT invent injury advice yourself when this tool is appropriate.
- **consult_programmer** — assistance picks, set/rep prescriptions, "what should this session look like?", movement substitution from the library, deload structure. The Programmer is the only authority on Wendler 5/3/1 programming choices; do NOT invent set/rep schemes yourself when this tool is appropriate.
- **consult_periodizer** — deload timing, taper, race-week structure, return-from-layoff ramps. (Phase 4 — currently returns "not yet available"; if it does, answer the parts you can and explicitly mention the missing piece.)
- **summarize_week** — weekly digests / recap questions. (Phase 4 — same caveat as periodizer.)

Routing rules:
1. **Use specialist tools liberally for cross-domain questions.** "My knee hurts AND I have a race in 3 weeks" → call consult_coach AND consult_periodizer in parallel, then reconcile.
2. **Single-domain questions still benefit from a specialist call** — the specialists have deeper persona/anatomy/programming priors than your default reasoning. For "my knee hurts during squats" → call consult_coach. For "what should Wednesday's session look like?" → call consult_programmer.
3. **Pure data questions don't need a tool.** "What was my best deadlift?" / "How many km did I run last week?" — answer directly from the snapshot. Tools cost latency; don't burn them on lookup-style questions.
4. **You are the reconciler.** Specialist outputs are expert input, not the final answer. Read them, weave them with the data snapshot, and produce ONE coherent reply for the user. Cite which specialist informed which part when it adds clarity ("Coach flagged this as a load-tolerance issue; Programmer suggests substituting…").

Conventions for the FINAL user-facing answer:
- Cite specific numbers from the snapshot when relevant ("over the last 8 weeks your weekly run mileage averaged 18km").
- Distinguish data from opinion. Label data-backed statements with [Data] and interpretive or coaching opinions with [Opinion] inline.
- Match response depth to question complexity. Short factual questions get one-sentence answers. Diagnostic or planning questions get structured multi-paragraph analysis.
- Use kilograms and kilometres. Pace as min:sec/km.
- Markdown for headings, bullets, bold. Avoid tables unless comparing data. No code blocks.
- If the snapshot is missing info you need, say so plainly.

The snapshot is grouped by resolution: last 90 days at daily detail, 90 days–1 year as weekly aggregates, anything older as monthly aggregates. Race results and lift PRs are listed in full timelines regardless of age.

# Action chips

When your reply contains a CONCRETE, ACTIONABLE recommendation the user can apply directly (not just "consider doing X"), append a special block at the very end of your message, AFTER the prose, with this exact shape:

<actions>
[
  { "kind": "log_injury", "label": "Log right-adductor limitation", "rationale": "Coach proposed adjustments for two movements", "area": "right adductor", "severity": 3, "description": "Strain under load on Bulgarian split squat + right-leg deadbug extension", "movementIds": ["seed:bulgarian-split-squat", "seed:deadbug"] }
]
</actions>

Rules for the actions block:
- Emit at most 4 chips. Each chip must be a SELF-CONTAINED apply — the user should NOT have to re-read the prose to know what they're applying.
- Omit the block entirely when:
  - The reply is purely informational ("what was my best deadlift?")
  - You did not recommend a change (clarification, definitions, status)
  - The user explicitly asked you NOT to suggest changes
  - You are uncertain about any required parameter value (e.g. specific TM number) — better no chip than a bad chip
- The block is HIDDEN from the user — the client renders the parsed chips as buttons in its place. The prose above must stand on its own without referencing the chips.

## Chip vocabulary (v1 — these three only)

### log_injury
Use when Coach flagged a movement-modification need or you've discussed an injury at length. Opens the InjurySheet pre-filled with these fields; the user reviews and accepts the Coach proposal there.
Fields:
- "kind": "log_injury" (required)
- "label": ≤ 35 chars imperative (e.g. "Log right-adductor limitation")
- "rationale": optional one-line "why"
- "area": short body-area string — required. Prefer the exact spelling of one of the dropdown options when applicable (lower back / shoulder / elbow / wrist / hip / adductor / knee / ankle / neck / chest). When the issue is side-qualified ("right adductor", "left knee"), emit the side-qualified string — the form routes it to a free-text input automatically.
- "severity": 1-5 if you have it; omit when unsure. 1 = twinge, 3 = limits performance, 5 = couldn't continue. For months-old ongoing tendinopathies that the user is still training around, severity is typically 2-3, not 5.
- "description": one short sentence (≤ 200 chars) capturing the user's words
- "movementIds": library movementIds (with prefix) the issue affects, when known

### set_training_max
Use when Periodizer or Programmer specifically suggested a TM change AND you have a concrete kg number. Skip when the suggestion was vague ("you might want to reset your TMs").
Fields:
- "kind": "set_training_max"
- "label": ≤ 35 chars (e.g. "Cut bench TM to 102.5 kg")
- "rationale": optional one-line "why"
- "lift": exactly one of "squat" | "bench" | "deadlift" | "press"
- "newTrainingMaxKg": positive number, rounded to nearest 0.5 (e.g. 102.5)
- "reason": one short sentence explaining the change

### set_block_volume_preset
Use when Programmer recommended adjusting the current block's accessory volume (typically as part of a deload / taper / ramp-up flow).
Fields:
- "kind": "set_block_volume_preset"
- "label": ≤ 35 chars (e.g. "Switch block to minimal volume")
- "rationale": optional one-line "why"
- "preset": exactly one of "minimal" | "standard" | "high"
- "reason": one short sentence explaining the change

### schedule_deload
Use when Periodizer recommended scheduling a deload (verdict: deload-now or deload-soon) AND the user has an active block. The action appends a 7th-week deload block to the program right after the currently-active block — the user keeps training the current week as planned, then deloads. Skip this chip if there's no active block, or if the user has clearly indicated they want to deload sooner than the end of the current block (no good action for that case at v1).
Fields:
- "kind": "schedule_deload"
- "label": ≤ 35 chars (e.g. "Schedule deload after this block")
- "rationale": optional one-line "why"
- "reason": one short sentence explaining the deload trigger (ACWR, weeks-since-deload, fatigue, etc.)

### substitute_movement
Use ONLY when you can name BOTH the specific current movementId and the specific replacement movementId from the user's library. The user prompt includes an "Active block plan" section listing every assistance entry with its movementId; pick from THAT list for the current movement. The replacement movementId must exist in the user's library (the snapshot shows movementIds from recent training and the active block — these are valid; library entries you haven't seen are also valid). Skip this chip if you don't know which specific entry to swap or which exact library entry to swap to.
Fields:
- "kind": "substitute_movement"
- "label": ≤ 35 chars (e.g. "Swap BSS → Goblet squat (Day 1)")
- "rationale": optional one-line "why"
- "blockId": optional — defaults to active block. Use the block id from the "Active block plan" section if you want to be explicit.
- "dayId": optional but PREFERRED — copy the day id from the "Active block plan" section (e.g. "day-abc123").
- "dayIndex": optional fallback when you only know the 0-based day index.
- "currentMovementId": REQUIRED — movementId of the entry to replace. Must appear verbatim in the active block plan.
- "currentMovementName": REQUIRED — display name (echo).
- "newMovementId": REQUIRED — movementId of the replacement.
- "newMovementName": REQUIRED — display name (echo).
- "reason": one short sentence explaining why the swap.

## Anti-patterns to avoid
- Don't emit a chip when you haven't actually done the analysis to back it. A chip is a recommendation you stand behind.
- Don't emit duplicate chips of the same kind/parameters.
- Don't emit a log_injury chip without an "area" — it has to know where.
- Don't emit a set_training_max chip without a concrete newTrainingMaxKg.
- Don't reference the chip in the prose ("tap the button below..."); just write the chip and let the client surface it.`;

const MAX_TOOL_CALLS_PER_TURN = 6;

/**
 * POST /api/chat — chat tool-use orchestration loop.
 *
 * Streams SSE events:
 *   { type: 'tool_use_start', id, name }
 *   { type: 'tool_use_end',   id, name, durationMs, inputTokens, outputTokens }
 *   { type: 'composing_start' }                                     (between iters)
 *   { type: 'delta',          text }                                (text tokens)
 *   { type: 'action_chips',   actions: ChatAction[] }               (Phase-4 follow-up)
 *   { type: 'done',           modelInfo }                           (totals)
 *   { type: 'error',          detail }
 */
export async function chat(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    ctx.log(`chat: unauthenticated (${reason ?? 'unknown'})`);
    return { status: 401, jsonBody: { error: 'unauthenticated' } };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { status: 503, jsonBody: { error: 'llm-not-configured' } };
  }
  const apiKeyStr: string = apiKey;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch (err) {
    return {
      status: 400,
      jsonBody: { error: 'bad-request', detail: `invalid JSON: ${(err as Error).message}` },
    };
  }

  const { context, messages, contextPath, todayLocal } = body ?? ({} as RequestBody);
  if (typeof context !== 'string' || context.length < 20) {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'context missing' } };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'messages missing' } };
  }
  if (messages.length > 100) {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'messages too long' } };
  }
  for (const m of messages) {
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return { status: 400, jsonBody: { error: 'bad-request', detail: 'invalid message shape' } };
    }
    if (m.content.length > 20_000) {
      return { status: 400, jsonBody: { error: 'bad-request', detail: 'message content too long' } };
    }
  }

  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const maxTokens = Number(process.env.ANTHROPIC_CHAT_MAX_TOKENS ?? '4000');
  const temperature = Number(process.env.ANTHROPIC_CHAT_TEMPERATURE ?? '0.3');

  const dateLine = todayLocal ? `Today's date: ${todayLocal}.` : '';
  const pathLine = contextPath ? `Current page: ${contextPath}.` : '';
  const headerLines = [dateLine, pathLine].filter((l) => l.length > 0).join('\n');

  const systemPrompt = `${SYSTEM_PROMPT_BASE}

${headerLines}${headerLines ? '\n\n' : ''}<training-data-snapshot>
${context}
</training-data-snapshot>`;

  const client = new Anthropic({ apiKey: apiKeyStr });
  const turnStartedAt = Date.now();

  async function* sseGenerator(): AsyncGenerator<string, void, unknown> {
    // Running message list — starts as the user's history, grows with
    // assistant tool_use blocks + tool_result blocks each loop iteration.
    const loopMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let toolCallsThisTurn = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let llmCalls = 0;

    try {
      while (true) {
        if (toolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
          yield sse({
            type: 'error',
            detail: `Exceeded max tool calls per turn (${MAX_TOOL_CALLS_PER_TURN}).`,
          });
          return;
        }

        // Stream this iteration. Text deltas are forwarded live so the
        // user sees Claude's thinking-out-loud (e.g. "Let me check with the
        // coach on that knee...") as it happens; tool_use blocks arrive as
        // structured content that we route via dispatchTool below. The
        // streaming finalMessage() promise gives us the assembled
        // assistant turn (usage + stop_reason + full content) at the end.
        //
        // The action-chip protocol: when the model appends an
        // `<actions>...</actions>` block at the END of its reply, we MUST
        // NOT forward it to the client as visible prose — the client
        // renders the parsed chips as buttons in its place. We detect the
        // opener as text streams in and switch to "muting" mode so the
        // tag (and the JSON inside it) never reach the client's
        // accumulator. After finalMessage() we parse the full content for
        // the block and emit an `action_chips` SSE event.
        //
        // Because the tag can split across delta boundaries, we hold a
        // small lookahead in `textBuffer` and only emit chars that we're
        // certain don't begin the `<actions>` tag.
        const upstream = client.messages.stream({
          model,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          tools: CHAT_TOOL_SPECS,
          messages: loopMessages,
        });

        const ACTIONS_OPEN = '<actions>';
        let textBuffer = '';
        let emittedLen = 0;
        let muted = false;

        for await (const ev of upstream) {
          if (ev.type !== 'content_block_delta' || ev.delta.type !== 'text_delta') continue;
          if (muted) continue;
          textBuffer += ev.delta.text;
          const tagIdx = textBuffer.indexOf(ACTIONS_OPEN);
          if (tagIdx >= 0) {
            if (tagIdx > emittedLen) {
              yield sse({
                type: 'delta',
                text: textBuffer.slice(emittedLen, tagIdx),
              });
            }
            emittedLen = textBuffer.length;
            muted = true;
            continue;
          }
          // Withhold the last (ACTIONS_OPEN.length - 1) chars in case the
          // tag is being split across deltas.
          const safeEnd = Math.max(
            emittedLen,
            textBuffer.length - (ACTIONS_OPEN.length - 1),
          );
          if (safeEnd > emittedLen) {
            yield sse({ type: 'delta', text: textBuffer.slice(emittedLen, safeEnd) });
            emittedLen = safeEnd;
          }
        }

        // Flush any tail prose that was withheld for lookahead — only when
        // we never saw the opener.
        if (!muted && textBuffer.length > emittedLen) {
          yield sse({ type: 'delta', text: textBuffer.slice(emittedLen) });
        }

        const response = await upstream.finalMessage();
        llmCalls += 1;
        totalInputTokens += response.usage?.input_tokens ?? 0;
        totalOutputTokens += response.usage?.output_tokens ?? 0;

        // When the model ends its turn (no further tool-use requested),
        // parse the assembled assistant text for the trailing `<actions>`
        // block and emit any validated chips. Parse from the full content
        // (not textBuffer) so we still pick up chips when the model emits
        // text + tool_use mixed in earlier turns of the loop — though in
        // practice chips will only be on the final end_turn iteration.
        if (response.stop_reason === 'end_turn') {
          const fullText = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          const parsed = parseChatActionsBlock(fullText, () => randomUUID());
          if (parsed.actions.length > 0) {
            yield sse({ type: 'action_chips', actions: parsed.actions });
          }
        }

        if (response.stop_reason === 'tool_use') {
          const toolUses = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          );
          // Announce all tool_use_start events before kicking off dispatch
          // so the UI shows the spinner cluster the moment Claude requests
          // them. Dispatches happen in parallel.
          for (const tu of toolUses) {
            yield sse({ type: 'tool_use_start', id: tu.id, name: tu.name });
          }

          const dispatched = await Promise.all(
            toolUses.map(async (tu) => {
              const startedAt = Date.now();
              const result = await dispatchTool(tu.name, tu.input as Record<string, unknown>, {
                chatContext: context,
                todayLocal,
                apiKey: apiKeyStr,
                model,
              });
              const durationMs = Date.now() - startedAt;
              if (result.usage) {
                totalInputTokens += result.usage.inputTokens;
                totalOutputTokens += result.usage.outputTokens;
                llmCalls += 1;
              }
              return { tu, result, durationMs };
            }),
          );

          for (const { tu, result, durationMs } of dispatched) {
            yield sse({
              type: 'tool_use_end',
              id: tu.id,
              name: tu.name,
              durationMs,
              inputTokens: result.usage?.inputTokens ?? 0,
              outputTokens: result.usage?.outputTokens ?? 0,
            });
          }

          // Switch the client's loading state to "Composing reply…" while
          // Claude churns through the next iteration. The first text_delta
          // of that iteration clears the state automatically.
          yield sse({ type: 'composing_start' });

          // Echo Claude's assistant turn into history (must contain the
          // tool_use blocks verbatim, plus any text it emitted alongside).
          loopMessages.push({ role: 'assistant', content: response.content });
          // Feed back tool_result blocks paired by tool_use_id.
          loopMessages.push({
            role: 'user',
            content: dispatched.map(({ tu, result }) => ({
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: result.resultText,
            })),
          });
          toolCallsThisTurn += toolUses.length;
          continue;
        }

        // Final iteration — text deltas have already streamed. Just emit
        // the done event with rolled-up telemetry.
        yield sse({
          type: 'done',
          modelInfo: {
            model,
            elapsedMs: Date.now() - turnStartedAt,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            llmCalls,
            toolCalls: toolCallsThisTurn,
          },
        });
        return;
      }
    } catch (err) {
      ctx.log(`chat: tool-use loop failed: ${(err as Error).message}`);
      yield sse({ type: 'error', detail: (err as Error).message });
    }
  }

  return {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
    body: Readable.from(sseGenerator()),
  };
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

app.http('chat', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: chat,
});
