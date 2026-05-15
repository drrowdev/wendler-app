// Periodizer agent — server-side runner. Mirror of the prompt + response
// validator in packages/domain/src/agents/periodizer/. Kept local because
// Azure Functions on Node16 module resolution can't consume the
// extensionless ESM imports in @wendler/domain (same pattern as
// apps/api/src/llm/validate.ts).

import Anthropic from '@anthropic-ai/sdk';
import {
  agentError,
  agentSuccess,
  type AgentResponse,
  type AgentUsage,
} from '../types.js';
import { PERIODIZER_SYSTEM_PROMPT } from './prompt.js';
import { parsePeriodizerResponse, type PeriodizerResponse } from './response.js';

export interface PeriodizerInput {
  /** Pre-built user prompt (constructed client-side from the dynamic context). */
  userPrompt: string;
  /** Optional override of the agent's default model. */
  model?: string;
  /** Optional override of the agent's default temperature (0.2 default). */
  temperature?: number;
  /** Optional override of max output tokens. */
  maxTokens?: number;
}

export interface PeriodizerSuccessData {
  response: PeriodizerResponse;
  modelInfo: {
    model: string;
    elapsedMs: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export async function runPeriodizer(
  input: PeriodizerInput,
): Promise<AgentResponse<PeriodizerSuccessData>> {
  if (typeof input.userPrompt !== 'string' || input.userPrompt.trim() === '') {
    return agentError('bad-input', ['userPrompt is required and must be a non-empty string.']);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return agentError('llm-unreachable', [
      'ANTHROPIC_API_KEY is not configured on the server.',
    ]);
  }

  const model = input.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const maxTokens = input.maxTokens ?? Number(process.env.ANTHROPIC_MAX_TOKENS ?? '6000');
  // Periodizer is structural reasoning over a small, well-defined signal
  // set — high reliability on the verdict matters far more than creative
  // variety. Default temp 0.2 mirrors Coach.
  const temperature =
    input.temperature ?? Number(process.env.ANTHROPIC_PERIODIZER_TEMPERATURE ?? '0.2');

  const client = new Anthropic({ apiKey });
  const startedAt = Date.now();
  let raw = '';
  let sdkUsage: { input_tokens?: number; output_tokens?: number } | undefined;
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: PERIODIZER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input.userPrompt }],
    });
    raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    sdkUsage = msg.usage;
  } catch (err) {
    const message = (err as Error).message ?? 'unknown LLM error';
    return agentError('llm-unreachable', [`Periodizer LLM call failed: ${message}`]);
  }

  const elapsedMs = Date.now() - startedAt;
  const usage: AgentUsage = {
    inputTokens: sdkUsage?.input_tokens ?? 0,
    outputTokens: sdkUsage?.output_tokens ?? 0,
    latencyMs: elapsedMs,
  };

  const parsed = parsePeriodizerResponse(raw);
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
