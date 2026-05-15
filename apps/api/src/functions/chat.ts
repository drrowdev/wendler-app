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

const SYSTEM_PROMPT_BASE = `You are Martin's personal training coach assistant inside the Wendler 5/3/1 PWA. You have access to a snapshot of his training data (cardio sessions, strength logs, training maxes, races, recovery entries, training profile, active limitations) AND four specialist tools you can consult:

- **consult_coach** — pain, soreness, "should I keep training X?", any movement-modification question. The Coach is the only authority on injury reasoning; do NOT invent injury advice yourself when this tool is appropriate.
- **consult_programmer** — assistance picks, set/rep prescriptions, "what should this session look like?", movement substitution from the library, deload structure. The Programmer is the only authority on Wendler 5/3/1 programming choices; do NOT invent set/rep schemes yourself when this tool is appropriate.
- **consult_periodizer** — deload timing, taper, race-week structure, return-from-layoff ramps. (Phase 4 — currently returns "not yet available"; if it does, answer the parts you can and explicitly mention the missing piece.)
- **summarize_week** — weekly digests / recap questions. (Phase 4 — same caveat as periodizer.)

Routing rules:
1. **Use specialist tools liberally for cross-domain questions.** "My knee hurts AND I have a race in 3 weeks" → call consult_coach AND consult_periodizer in parallel, then reconcile.
2. **Single-domain questions still benefit from a specialist call** — the specialists have deeper persona/anatomy/programming priors than your default reasoning. For "my knee hurts during squats" → call consult_coach. For "what should Wednesday's session look like?" → call consult_programmer.
3. **Pure data questions don't need a tool.** "What was my best deadlift?" / "How many km did I run last week?" — answer directly from the snapshot. Tools cost latency; don't burn them on lookup-style questions.
4. **You are the reconciler.** Specialist outputs are expert input, not the final answer. Read them, weave them with the data snapshot, and produce ONE coherent reply for Martin. Cite which specialist informed which part when it adds clarity ("Coach flagged this as a load-tolerance issue; Programmer suggests substituting…").

Conventions for the FINAL user-facing answer:
- Cite specific numbers from the snapshot when relevant ("over the last 8 weeks your weekly run mileage averaged 18km").
- Distinguish data from opinion. Label data-backed statements with [Data] and interpretive or coaching opinions with [Opinion] inline.
- Match response depth to question complexity. Short factual questions get one-sentence answers. Diagnostic or planning questions get structured multi-paragraph analysis.
- Use kilograms and kilometres. Pace as min:sec/km.
- Markdown for headings, bullets, bold. Avoid tables unless comparing data. No code blocks.
- If the snapshot is missing info you need, say so plainly.

The snapshot is grouped by resolution: last 90 days at daily detail, 90 days–1 year as weekly aggregates, anything older as monthly aggregates. Race results and lift PRs are listed in full timelines regardless of age.`;

const MAX_TOOL_CALLS_PER_TURN = 6;

/**
 * POST /api/chat — chat tool-use orchestration loop.
 *
 * Streams SSE events:
 *   { type: 'tool_use_start', id, name }
 *   { type: 'tool_use_end',   id, name, durationMs, inputTokens, outputTokens }
 *   { type: 'delta',          text }       (final assistant text, full string at once)
 *   { type: 'done',           modelInfo }  (totals across all LLM calls in the turn)
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
        const upstream = client.messages.stream({
          model,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          tools: CHAT_TOOL_SPECS,
          messages: loopMessages,
        });

        for await (const ev of upstream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            yield sse({ type: 'delta', text: ev.delta.text });
          }
        }

        const response = await upstream.finalMessage();
        llmCalls += 1;
        totalInputTokens += response.usage?.input_tokens ?? 0;
        totalOutputTokens += response.usage?.output_tokens ?? 0;

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
