import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import Anthropic from '@anthropic-ai/sdk';
import { verifyRequest } from '../auth';
import { CHAT_TOOL_SPECS } from '../llm/chat-tool-specs';
import { dispatchTool } from '../llm/chat-tools';
import { parseChatActionsBlock } from '../llm/chat-actions-parse';
import { parseEditProposal } from '../llm/edit-proposal-parse';
import { randomUUID } from 'node:crypto';

// Opt the Functions runtime into HTTP-stream mode. By default
// @azure/functions v4 buffers the entire response body in memory before
// flushing to the SWA/Functions proxy. For SSE that means none of our
// keepalives or text deltas reach the client until the whole turn ends —
// and on a multi-tool chat turn that easily exceeds the proxy's ~45 s
// ceiling, giving the user a "Backend call failure" 500.
// Reference: https://aka.ms/AzFuncNodeHttpStreams (requires
// @azure/functions ≥ 4.5 + Functions host ≥ 4.34, both satisfied).
//
// app.setup() is idempotent and safe to call from a function-file module
// scope — the runtime applies the merged options before any handler runs.
app.setup({ enableHttpStream: true });

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
- **consult_periodizer** — deload timing, taper, race-week structure, return-from-layoff ramps. Returns a verdict (deload-now / deload-soon / continue / taper-now / ramp-up / tm-test / extend-block) plus headline + reasoning.
- **summarize_week** — weekly digests / recap questions. Returns a structured 6-section summary with highlights.

Routing rules:
1. **Use specialist tools liberally for cross-domain questions.** "My knee hurts AND I have a race in 3 weeks" → call consult_coach AND consult_periodizer in parallel, then reconcile.
2. **Single-domain questions still benefit from a specialist call** — the specialists have deeper persona/anatomy/programming priors than your default reasoning. Examples that route to a tool:
   - "my knee hurts during squats" → consult_coach
   - "what should Wednesday's session look like?" → consult_programmer
   - "what's a good bench accessory?" → consult_programmer (programming opinion, not pure lookup)
3. **Pure data questions don't need a tool.** Examples that stay in-prose:
   - "what was my best deadlift?" / "how many km did I run last week?" — snapshot lookup
   - "when did I last deload?" — snapshot lookup
   - "what's my current bench TM?" — snapshot lookup
   Tools cost latency; don't burn them on lookup-style questions.
4. **You are the reconciler.** Specialist outputs are expert input, not the final answer. Read them, weave them with the data snapshot, and produce ONE coherent reply for the user. Cite which specialist informed which part when it adds clarity ("Coach flagged this as a load-tolerance issue; Programmer suggests substituting…").

# Specialist precedence (when reconciling conflicting outputs)

When two specialists' outputs would lead to different recommendations, this hierarchy decides which wins:

1. **Active limitations / safety** (Coach output, user-accepted injury adjustments) — inviolable. NEVER override even when other signals push the other way (e.g. Programmer's preferred accessory list, Periodizer's "push hard this week" verdict).
2. **Macro structure** (Periodizer verdict — deload/taper/ramp) — bounds timing & intensity. Overrides Programmer recommendations that would push outside the verdict's envelope (e.g. if Periodizer says \`taper-now\`, do NOT surface a high-volume assistance suggestion from Programmer even if it scored well).
3. **Micro programming** (Programmer output — assistance picks, set/rep schemes) — fills the envelope set by 1 & 2.
4. **Presentation** (Summarizer, your prose) — narrates layers 1-3, never changes them.

In any prose where you describe a recommendation that defers up the hierarchy (e.g. "Programmer wanted X but Coach flagged a skip that would have included X, so we substituted Y"), label the precedence call explicitly so the user sees why.

Also: Coach and Periodizer may return a \`confidence\` field on their outputs (\`high\` / \`medium\` / \`low\`). When a \`low\`-confidence specialist output conflicts with a \`high\`-confidence one in a NEIGHBORING tier, the high-confidence one can pull rank — but never across tier 1 (active limitations are absolute regardless of confidence).

# Safety escalation

If the user describes red-flag symptoms (numbness, radiating pain, sudden weakness, fever, severity 5 + daily-life impairment) OR explicitly states they intend to train through such symptoms, you MUST call consult_coach and surface its \`consultRecommended\` output prominently. Do NOT endorse the user's plan to train through red flags. Phrase the deferral as "this needs an in-person clinician" rather than "yes go ahead" — even when the user pushes. This is the one place you firmly disagree with the user's stated intent.

# Multi-turn context

Re-read the full conversation before each response. Do not regress on facts established earlier in the thread (an injury logged in turn 1 is still active in turn 8 unless the user said it resolved). When the conversation gets long, lean on the snapshot for ground-truth state and the prior messages for the user's stated intent.

Conventions for the FINAL user-facing answer:
- Cite specific numbers from the snapshot when relevant ("over the last 8 weeks your weekly run mileage averaged 18km").
- Distinguish data from opinion. Label data-backed statements with [Data] and interpretive or coaching opinions with [Opinion] inline.
- Match response depth to question complexity. Short factual questions get one-sentence answers. Diagnostic or planning questions get structured multi-paragraph analysis.
- Use kilograms and kilometres. Pace as min:sec/km.
- Markdown for headings, bullets, bold. Avoid tables unless comparing data. No code blocks.
- If the snapshot is missing info you need, say so plainly.

The snapshot is grouped by resolution: last 90 days at daily detail, 90 days–1 year as weekly aggregates, anything older as monthly aggregates. Race results and lift PRs are listed in full timelines regardless of age.

# Recommendations: propose_edit tool + log_injury sidecar

When your reply contains a CONCRETE, ACTIONABLE recommendation the user can apply directly, surface it through ONE of these two mechanisms — never both for the same recommendation:

## propose_edit (PRIMARY — Anthropic tool-use)

For ANY program change (training-max tweaks, volume-preset shifts, assistance trims/swaps/adds/removes, deload scheduling, OR ANY COMBINATION of them), call the \`propose_edit\` tool with a single structured plan containing 1-10 typed operations. The user sees the WHOLE plan as a diff with per-op accept / decline / modify and one atomic Apply.

**Use this for**:
- Single-op changes ("cut bench TM to 102.5 kg") — one-op proposal keeps UI consistent.
- Coordinated multi-op changes ("trim next week's accessory volume for the taper" = preset shift + per-entry trim ops together).
- Anything where the user benefits from seeing the WHOLE diff in one place before committing.

**Skip when**:
- Purely informational replies ("what was my best deadlift?").
- You did not actually recommend a change.
- You're uncertain about required parameter values.
- The user asked you NOT to suggest changes.

**Tool input shape** — see the \`propose_edit\` tool's JSON schema for full field requirements. Headline + reason + 1-10 operations. Each operation has a stable \`id\` (assigned by you or generated server-side), a \`kind\` from the controlled vocabulary, a \`label\` (≤ 80 chars), an optional \`rationale\`, plus kind-specific fields.

**Operation kinds**:

- \`set_training_max\`: \`{ lift, newTrainingMaxKg }\`. lift ∈ squat|bench|deadlift|press. kg rounded to 0.5.
- \`set_block_volume_preset\`: \`{ blockId?, preset }\`. preset ∈ minimal|standard|high. blockId defaults to the active block. **Guard**: skip when the EFFECTIVE preset (look for \`EFFECTIVE=\` in the snapshot) already matches your proposed value, when every week is COMPLETE, or when the user didn't ask about volume. This op only changes the preset — pair it with \`trim_assistance_entry\` ops to actually trim already-scheduled entries.
- \`trim_assistance_entry\`: \`{ blockId?, dayId, entryId, movementName, newSets, newReps, newRepsMax? }\`. Targets a specific scheduled entry; user can override the new values.
- \`swap_assistance_movement\`: \`{ blockId?, dayId, entryId, currentMovementId, currentMovementName, newMovementId, newMovementName }\`. **CRITICAL — copy ids VERBATIM from the snapshot.** seed:dead-bug is NOT seed:deadbug. Hyphenation + casing matter; the apply path matches exactly.
- \`add_assistance_entry\`: \`{ blockId?, dayId, movementId, movementName, category, sets, reps, repsMax?, unit? }\`. category ∈ push|pull|single-leg|core|prehab|isolation|carry. movementId must exist in the user's library.
- \`remove_assistance_entry\`: \`{ blockId?, dayId, entryId, movementName }\`.
- \`schedule_deload\`: \`{ }\`. Inserts a 7th-week deload block right after the active block.

**Plan-level guidance**:
- Coordinate ops — if you're cutting the volume preset, also emit the trim_assistance_entry ops that actually rescale the already-scheduled entries proportionally. Don't ship the preset change alone and leave the user to manually wipe + regenerate.
- Mention plan-wide rationale once in \`reason\`. Use per-op \`rationale\` only when an individual op has a non-obvious why.
- Set \`confidence\` (high / medium / low) — used by the UI for visual toning. Treat as relative ordering, not absolute probability.
- Reference days as "Day 1, Day 2…" in prose. dayIndex is internal — never put the bare number in prose to the user. (The snapshot lists days as Day 1+ already.)
- Reference movements by their human name in prose. movementId is internal — only goes in tool input fields.

**Self-check before emitting**:
- Are all required fields filled?
- Are dayId / entryId / movementId values copied verbatim from the snapshot (not invented)?
- Would the EFFECTIVE preset / current state already satisfy what you're proposing? If yes, skip.
- Does the plan touch only weeks NOT marked COMPLETE? If you'd only affect complete weeks, skip.

If the proposal fails validation server-side, the tool will return a \`tool_result\` with the errors — fix the input and retry within the same turn.

## log_injury (SIDECAR — \`<actions>\` JSON tag, single chip kind only)

For injury / movement-limitation reports, append a hidden \`<actions>\` block at the END of your message after the prose, containing exactly one log_injury chip:

<actions>
[
  { "kind": "log_injury", "label": "Log right-adductor limitation", "rationale": "Coach proposed adjustments for two movements", "area": "right adductor", "severity": 3, "description": "Strain under load on Bulgarian split squat + right-leg deadbug extension", "movementIds": ["seed:bulgarian-split-squat", "seed:deadbug"] }
]
</actions>

The block is HIDDEN from the user — the client renders the chip as a button in its place. The prose above must stand on its own without referencing the chip.

**log_injury fields**:
- "kind": "log_injury" (required).
- "label": ≤ 35 chars imperative summary (e.g. "Log right-adductor limitation").
- "rationale": optional one-line "why".
- "area": short body-area string — required. Prefer the exact spelling of one of the dropdown options when applicable (lower back / shoulder / elbow / wrist / hip / adductor / knee / ankle / neck / chest). When the issue is side-qualified ("right adductor", "left knee"), emit the side-qualified string — the form routes it to a free-text input automatically.
- "severity": 1-5 if you have it; omit when unsure. 1 = twinge, 3 = limits performance, 5 = couldn't continue. For months-old ongoing tendinopathies that the user is still training around, severity is typically 2-3, not 5.
- "description": one short sentence (≤ 200 chars) capturing the user's words. **If the area is side-qualified, the description MUST mention the side too.**
- "movementIds": library movementIds (with prefix) the issue affects, when known.

log_injury is the ONLY chip kind allowed in the \`<actions>\` sidecar. The earlier set_training_max / set_block_volume_preset / schedule_deload / substitute_movement kinds were removed — every other recommendation MUST go through the \`propose_edit\` tool. The server silently drops any other kind it finds in \`<actions>\`.

(Why log_injury stays separate: it opens the InjurySheet which spawns its own Coach-proposal multi-op review — it's a meta-review, not a single edit.)

## Anti-patterns to avoid
- Don't put set_training_max / set_block_volume_preset / schedule_deload / substitute_movement / propose_edit in the \`<actions>\` sidecar. Only log_injury belongs there. Every other write goes through the \`propose_edit\` tool.
- Don't emit a propose_edit when you haven't actually done the analysis to back it. A proposal is a recommendation you stand behind.
- Don't emit a propose_edit AND a log_injury chip for the same underlying issue — pick one path.
- Don't reference the proposal in the prose ("review the changes below..."); just call the tool and let the client surface the sheet.
- Don't propose ops that would have no effect (preset already matches; weeks already complete; entry not in any plan).`;

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
  const maxTokens = Number(process.env.ANTHROPIC_CHAT_MAX_TOKENS ?? '8000');
  const temperature = Number(process.env.ANTHROPIC_CHAT_TEMPERATURE ?? '0.3');

  const dateLine = todayLocal ? `Today's date: ${todayLocal}.` : '';
  const pathLine = contextPath ? `Current page: ${contextPath}.` : '';
  const headerLines = [dateLine, pathLine].filter((l) => l.length > 0).join('\n');

  const systemPrompt = `${SYSTEM_PROMPT_BASE}

${headerLines}${headerLines ? '\n\n' : ''}<training-data-snapshot>
The snapshot below is grouped by resolution: the last 90 days at daily detail, 90 days–1 year as weekly aggregates, older as monthly aggregates. Race results and lift PRs are full timelines regardless of age. Active limitations are listed verbatim from the user's injuries table.
${context}
</training-data-snapshot>`;

  const client = new Anthropic({ apiKey: apiKeyStr });
  const turnStartedAt = Date.now();

  // Per-Anthropic-call timeout. Each iteration of the tool-use loop is one
  // Anthropic call; if any single call stalls past this, abort it with a
  // user-friendly message. Default 25 s — under SWA managed-Functions'
  // synchronous-call ceiling (~30 s) but tight enough that retrying with a
  // shorter prompt is the obvious next step.
  const callTimeoutMs = Number(process.env.ANTHROPIC_CHAT_CALL_TIMEOUT_MS ?? '25000');
  // Overall budget across the entire tool-use loop. A turn that consults
  // two specialists + a final composition can legitimately need ~60 s; this
  // bounds the worst case before SWA's connection-level timer kicks in
  // anyway. Heartbeats below keep the SSE connection warm independent of
  // this.
  const overallBudgetMs = Number(process.env.ANTHROPIC_CHAT_OVERALL_BUDGET_MS ?? '90000');

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

        // Bail before starting a new iteration if the overall budget is
        // spent. Better a graceful error than a silent SWA proxy 502.
        const elapsedMs = Date.now() - turnStartedAt;
        if (elapsedMs > overallBudgetMs) {
          yield sse({
            type: 'error',
            detail: `Chat turn exceeded the ${Math.round(overallBudgetMs / 1000)}s overall budget after ${Math.round(elapsedMs / 1000)}s. Try a shorter prompt, or split the question into smaller follow-ups.`,
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
        // Per-call abort: bound any single Anthropic stream against the
        // SWA proxy ceiling. The SDK accepts a `signal` in the second arg
        // of stream() and surfaces an AbortError when triggered.
        const callController = new AbortController();
        const callTimer = setTimeout(() => callController.abort(), callTimeoutMs);
        let upstream;
        try {
          upstream = client.messages.stream(
            {
              model,
              max_tokens: maxTokens,
              temperature,
              system: systemPrompt,
              tools: CHAT_TOOL_SPECS,
              messages: loopMessages,
            },
            { signal: callController.signal },
          );
        } catch (err) {
          clearTimeout(callTimer);
          throw err;
        }

        const ACTIONS_OPEN = '<actions>';
        let textBuffer = '';
        let emittedLen = 0;
        let muted = false;

        let response: Anthropic.Message;
        try {
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

          response = await upstream.finalMessage();
        } catch (err) {
          if (callController.signal.aborted) {
            yield sse({
              type: 'error',
              detail: `Chat call exceeded the ${Math.round(callTimeoutMs / 1000)}s per-call timeout. The prompt may be too large; try a shorter conversation or fewer follow-ups, then retry.`,
            });
            return;
          }
          throw err;
        } finally {
          clearTimeout(callTimer);
        }

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
          // Split out `propose_edit` — it doesn't dispatch to a sub-agent.
          // Each propose_edit tool_use is parsed inline, surfaced to the
          // client as an action_chips SSE event, and acked back to the model
          // with a synthetic tool_result so the turn can end cleanly.
          // Specialist consultations (consult_coach / consult_programmer /
          // etc.) keep the existing dispatch path.
          const proposeEditUses = toolUses.filter((tu) => tu.name === 'propose_edit');
          const specialistUses = toolUses.filter((tu) => tu.name !== 'propose_edit');

          // Announce all tool_use_start events before kicking off dispatch
          // so the UI shows the spinner cluster the moment Claude requests
          // them. Dispatches happen in parallel.
          for (const tu of toolUses) {
            yield sse({ type: 'tool_use_start', id: tu.id, name: tu.name });
          }

          // Inline propose_edit handling: parse + emit + ack.
          const proposeEditResults: Array<{
            tu: Anthropic.ToolUseBlock;
            resultText: string;
            durationMs: number;
          }> = [];
          for (const tu of proposeEditUses) {
            const startedAt = Date.now();
            const parsed = parseEditProposal(tu.input as unknown, { idGen: () => randomUUID() });
            const durationMs = Date.now() - startedAt;
            if (parsed.proposal) {
              // Emit ONE action_chips event carrying the parsed proposal.
              // The client's existing chip-rendering pipeline will pick up
              // the propose_edit kind and route it to EditProposalSheet
              // (Phase 2 UI). For Phase 1 the chip still persists on the
              // ChatMessage like every other chip kind.
              yield sse({ type: 'action_chips', actions: [parsed.proposal] });
              proposeEditResults.push({
                tu,
                durationMs,
                resultText:
                  'Proposal emitted for user review. They will accept, decline, or modify each operation in the EditProposalSheet UI. Do not re-emit unless the user asks for a different plan.',
              });
            } else {
              // Send the validation errors back to the model so it can
              // self-correct within the same turn (it'll retry the tool_use
              // with a fixed input on the next iteration).
              const errBody = parsed.errors.join('\n  - ');
              proposeEditResults.push({
                tu,
                durationMs,
                resultText:
                  `Proposal REJECTED — validation errors. Fix and retry with corrected input:\n  - ${errBody}`,
              });
            }
          }

          // Specialist dispatch path (parallel) — same as before.
          const dispatched = await Promise.all(
            specialistUses.map(async (tu) => {
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

          // Emit tool_use_end events for both propose_edit + specialists.
          for (const { tu, durationMs } of proposeEditResults) {
            yield sse({
              type: 'tool_use_end',
              id: tu.id,
              name: tu.name,
              durationMs,
              inputTokens: 0,
              outputTokens: 0,
            });
          }
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
          // Feed back tool_result blocks paired by tool_use_id — one per
          // tool_use, both propose_edit acks and specialist results.
          const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [
            ...proposeEditResults.map(({ tu, resultText }) => ({
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: resultText,
            })),
            ...dispatched.map(({ tu, result }) => ({
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: result.resultText,
            })),
          ];
          loopMessages.push({
            role: 'user',
            content: toolResultBlocks,
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

  // Build the response as a Web ReadableStream. Azure Functions v4 with
  // enableHttpStream: true honors a Web ReadableStream body and pipes
  // chunks straight through the worker → host → SWA proxy chain without
  // buffering. Three layers in the stream:
  //   1. Immediate `: connected` SSE comment — locks in the HTTP
  //      connection before any Anthropic latency can starve it.
  //   2. Periodic `: hb` heartbeat (every 10 s) — keeps the SWA proxy
  //      from giving up during long composing pauses.
  //   3. The actual sseGenerator chunks (text deltas, tool events, etc.).
  // SSE comments (lines starting with `:`) are spec-defined as keepalives;
  // the browser EventSource API + our manual fetch parser ignore them.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      let closed = false;
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': hb\n\n'));
        } catch {
          // Stream already closed — swallow.
        }
      }, 10_000);

      try {
        for await (const chunk of sseGenerator()) {
          if (closed) break;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        ctx.log(`chat: stream writer failed: ${(err as Error).message}`);
        if (!closed) {
          try {
            controller.enqueue(
              encoder.encode(sse({ type: 'error', detail: (err as Error).message })),
            );
          } catch {
            // ignore
          }
        }
      } finally {
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
    // Cast: Azure Functions' HttpResponseBodyInit expects a ReadableStream
    // shape that includes values()/[Symbol.asyncIterator], which the global
    // Node ReadableStream type doesn't yet declare. The runtime accepts it
    // fine — this is purely a types-mismatch papering.
    body: stream as unknown as HttpResponseInit['body'],
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
