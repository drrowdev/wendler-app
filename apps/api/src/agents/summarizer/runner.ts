// Summarizer agent — server-side runner. Mirror of the prompt + response
// validator in packages/domain/src/agents/summarizer/. Same Node16/ESM
// rationale as the other mirrors.

import Anthropic from '@anthropic-ai/sdk';
import {
  agentError,
  agentSuccess,
  type AgentResponse,
  type AgentUsage,
} from '../types.js';
import { SUMMARIZER_SYSTEM_PROMPT } from './prompt.js';
import { parseSummarizerResponse, type SummarizerResponse } from './response.js';

export interface SummarizerInput {
  userPrompt: string;
  expectedWeekStart?: string;
  expectedWeekEnd?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface SummarizerSuccessData {
  response: SummarizerResponse;
  modelInfo: {
    model: string;
    elapsedMs: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export async function runSummarizer(
  input: SummarizerInput,
): Promise<AgentResponse<SummarizerSuccessData>> {
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
  // Summarizer is presentation; some narrative variety is welcome but
  // reliability matters more than novelty. 0.3 mirrors Programmer.
  const temperature =
    input.temperature ?? Number(process.env.ANTHROPIC_SUMMARIZER_TEMPERATURE ?? '0.3');

  const client = new Anthropic({ apiKey });
  const startedAt = Date.now();
  let raw = '';
  let sdkUsage: { input_tokens?: number; output_tokens?: number } | undefined;
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: SUMMARIZER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input.userPrompt }],
    });
    raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    sdkUsage = msg.usage;
  } catch (err) {
    const message = (err as Error).message ?? 'unknown LLM error';
    return agentError('llm-unreachable', [`Summarizer LLM call failed: ${message}`]);
  }

  const elapsedMs = Date.now() - startedAt;
  const usage: AgentUsage = {
    inputTokens: sdkUsage?.input_tokens ?? 0,
    outputTokens: sdkUsage?.output_tokens ?? 0,
    latencyMs: elapsedMs,
  };

  const parsed = parseSummarizerResponse(raw, {
    expectedWeekStart: input.expectedWeekStart,
    expectedWeekEnd: input.expectedWeekEnd,
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
