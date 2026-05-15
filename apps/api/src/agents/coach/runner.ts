// Coach agent — server-side runner. Mirror of the prompt + response validator
// in packages/domain/src/agents/coach/. Kept local because Azure Functions
// on Node16 module resolution can't consume the extensionless ESM imports
// in @wendler/domain (same pattern as apps/api/src/llm/validate.ts).
//
// Keep the system prompt + validator in lockstep with
// packages/domain/src/agents/coach/{prompt,response}.ts.

import Anthropic from '@anthropic-ai/sdk';
import {
  agentError,
  agentSuccess,
  type AgentResponse,
  type AgentUsage,
} from '../types.js';
import { COACH_SYSTEM_PROMPT } from './prompt.js';
import { parseCoachResponse, type CoachResponse } from './response.js';

export interface CoachInput {
  /** Pre-built user prompt (constructed client-side from the dynamic context). */
  userPrompt: string;
  /** Movement IDs the agent is allowed to reference in adjustments. */
  movementIds: readonly string[];
  /** Optional override of the agent's default model. */
  model?: string;
  /** Optional override of the agent's default temperature (0.2 default). */
  temperature?: number;
  /** Optional override of max output tokens. */
  maxTokens?: number;
}

export interface CoachSuccessData {
  response: CoachResponse;
  modelInfo: {
    model: string;
    elapsedMs: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export async function runCoach(
  input: CoachInput,
): Promise<AgentResponse<CoachSuccessData>> {
  if (typeof input.userPrompt !== 'string' || input.userPrompt.trim() === '') {
    return agentError('bad-input', ['userPrompt is required and must be a non-empty string.']);
  }
  if (!Array.isArray(input.movementIds)) {
    return agentError('bad-input', ['movementIds is required and must be a string[].']);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return agentError('llm-unreachable', [
      'ANTHROPIC_API_KEY is not configured on the server.',
    ]);
  }

  const model = input.model ?? process.env.ANTHROPIC_COACH_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  // Coach typically emits 1500-2500 tokens of JSON (summary + 3-5
  // adjustments + monitoring + consult). 4000 has plenty of headroom and
  // keeps generation latency below the SWA proxy timeout. Lifted via
  // ANTHROPIC_COACH_MAX_TOKENS or the global ANTHROPIC_MAX_TOKENS env.
  const maxTokens =
    input.maxTokens ??
    Number(
      process.env.ANTHROPIC_COACH_MAX_TOKENS ??
        process.env.ANTHROPIC_MAX_TOKENS ??
        '4000',
    );
  // Coach defaults to 0.2 — slightly more conservative than Programmer's 0.3.
  // Anatomical reasoning + safety bias don't benefit from token-level
  // randomness; structured-output reliability is more important here.
  const temperature =
    input.temperature ?? Number(process.env.ANTHROPIC_COACH_TEMPERATURE ?? '0.2');

  const client = new Anthropic({ apiKey });

  const startedAt = Date.now();
  let raw = '';
  let sdkUsage: { input_tokens?: number; output_tokens?: number } | undefined;

  // Race the Anthropic call against a hard timeout slightly below the
  // Azure Static Web Apps proxy ceiling (~30-45s). Returning a clean
  // structured error here is far better than the proxy timing out and
  // surfacing the generic "Backend call failure" 500. The cutoff is
  // configurable via ANTHROPIC_COACH_TIMEOUT_MS for shifty deployments.
  const timeoutMs = Number(process.env.ANTHROPIC_COACH_TIMEOUT_MS ?? '25000');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const stream = await client.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        temperature,
        system: COACH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: input.userPrompt }],
      },
      { signal: ac.signal },
    );
    // Drain to completion. We do NOT forward chunks anywhere — Coach
    // returns a single JSON object — but streaming keeps the HTTP
    // connection alive with frequent chunks, which tends to keep the
    // SWA proxy from short-circuiting on long generations.
    for await (const _ of stream) {
      // no-op: just iterate to drive the stream.
      void _;
    }
    const final = await stream.finalMessage();
    raw = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    sdkUsage = final.usage;
  } catch (err) {
    clearTimeout(timer);
    const message = (err as Error).message ?? 'unknown LLM error';
    if (ac.signal.aborted) {
      return agentError('llm-timeout', [
        `Coach call exceeded the ${Math.round(timeoutMs / 1000)}s timeout. ` +
          `Try again — if it persists, the prompt may be too large; consider reducing the library payload or lowering ANTHROPIC_MAX_TOKENS.`,
      ]);
    }
    return agentError('llm-unreachable', [`Coach LLM call failed: ${message}`]);
  }
  clearTimeout(timer);

  const elapsedMs = Date.now() - startedAt;
  const usage: AgentUsage = {
    inputTokens: sdkUsage?.input_tokens ?? 0,
    outputTokens: sdkUsage?.output_tokens ?? 0,
    latencyMs: elapsedMs,
  };

  const parsed = parseCoachResponse(raw, {
    allowedMovementIds: new Set(input.movementIds),
  });

  if (!parsed.ok) {
    return agentError('validation-failed', parsed.errors, { rawResponse: raw, usage });
  }

  return agentSuccess(
    {
      response: parsed.data,
      modelInfo: {
        model,
        elapsedMs,
        inputTokens: sdkUsage?.input_tokens,
        outputTokens: sdkUsage?.output_tokens,
      },
    },
    { rawResponse: raw, usage },
  );
}
