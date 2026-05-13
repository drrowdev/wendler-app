import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import Anthropic from '@anthropic-ai/sdk';
import { verifyRequest } from '../auth';

interface IncomingMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  /**
   * The pre-rendered training-data snapshot built client-side by
   * `buildChatContext` + `renderChatContextAsText`. The server never sees the
   * user's raw IndexedDB; the client decides what to surface.
   */
  context: string;
  /** Full message history. Last entry should be the new user prompt. */
  messages: IncomingMessage[];
  /** Optional pathname the user was on when sending — included in system prompt. */
  contextPath?: string;
}

const SYSTEM_PROMPT_BASE = `You are Martin's personal training coach assistant inside the Wendler 5/3/1 PWA. You have access to a snapshot of his training data (cardio sessions, strength logs, training maxes, races, recovery entries, training profile). Your job is to give grounded, data-backed answers to his questions about his training.

Rules:
- Cite specific numbers from the snapshot when relevant ("over the last 8 weeks your weekly run mileage averaged 18km").
- Distinguish what the data shows versus your training-science opinion. Mark opinions explicitly.
- Be concise. Default to short, direct answers. Expand only when the question demands it.
- If the snapshot is missing info you need, say so plainly. Don't invent.
- Use kilograms and kilometres. Pace as min:sec/km.
- Markdown is fine for headings, lists, and code blocks.

The snapshot is grouped by resolution: last 90 days at daily detail, 90 days–1 year as weekly aggregates, anything older as monthly aggregates. Race results and lift PRs are listed in full timelines regardless of age.`;

/**
 * POST /api/chat
 *
 * Body: { context, messages, contextPath? }
 * Returns:
 *   200 { ok: true, content: string, modelInfo }
 *   400 { error: 'bad-request', detail }
 *   401 { error: 'unauthenticated' }
 *   503 { error: 'llm-not-configured' }
 *   502 { error: 'llm-call-failed', detail }
 *
 * The full assistant response is returned in one shot. Future revision may
 * upgrade to SSE streaming.
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

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch (err) {
    return {
      status: 400,
      jsonBody: { error: 'bad-request', detail: `invalid JSON: ${(err as Error).message}` },
    };
  }

  const { context, messages, contextPath } = body ?? ({} as RequestBody);
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
  const temperature = Number(process.env.ANTHROPIC_CHAT_TEMPERATURE ?? '0.5');

  const systemPrompt = `${SYSTEM_PROMPT_BASE}

${contextPath ? `Current page: ${contextPath}\n` : ''}<training-data-snapshot>
${context}
</training-data-snapshot>`;

  const client = new Anthropic({ apiKey });
  const startedAt = Date.now();
  let raw = '';
  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    usage = msg.usage;
  } catch (err) {
    ctx.log(`chat: LLM call failed: ${(err as Error).message}`);
    return {
      status: 502,
      jsonBody: { error: 'llm-call-failed', detail: (err as Error).message },
    };
  }

  const elapsedMs = Date.now() - startedAt;
  return {
    status: 200,
    jsonBody: {
      ok: true,
      content: raw,
      modelInfo: {
        model,
        elapsedMs,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      },
    },
  };
}

app.http('chat', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: chat,
});
