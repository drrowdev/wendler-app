// Programmer agent — server-side runner.
//
// Pure function that takes the agent's structured input and returns an
// AgentResponse<LlmAssistanceResponse>. Both the legacy /api/suggestAssistance
// HTTP route and the new /api/agents/programmer route delegate to this
// runner so the agent's behavior is defined in exactly one place.
//
// The runner is also callable from server-side workflows (e.g. Phase 2's
// analyzeInjury, which calls Programmer to ground substitution proposals)
// without an HTTP hop.

import Anthropic from '@anthropic-ai/sdk';
import {
  agentError,
  agentSuccess,
  type AgentResponse,
  type AgentUsage,
} from '../types.js';
import { parseAssistanceResponse, type LlmAssistanceResponse } from '../../llm/validate.js';

export interface ProgrammerInput {
  systemPrompt: string;
  userPrompt: string;
  /** Movement IDs the LLM may pick from (client-supplied — server has no library). */
  movementIds: readonly string[];
  /** Highest valid block-day index. Optional; omit to skip the check. */
  maxDayIndex?: number;
  /** Equipment types available to the user. Optional. */
  availableEquipment?: readonly string[];
  /** Movement IDs already used in OTHER weeks of the same block. Optional. */
  crossWeekUsedMovementIds?: readonly string[];
  /** Override the agent's default model (env: ANTHROPIC_MODEL). */
  model?: string;
  /** Override the agent's default temperature (env: ANTHROPIC_TEMPERATURE). */
  temperature?: number;
  /** Override the agent's default max output tokens (env: ANTHROPIC_MAX_TOKENS). */
  maxTokens?: number;
}

export interface ProgrammerSuccessData {
  response: LlmAssistanceResponse;
  modelInfo: {
    model: string;
    elapsedMs: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

/**
 * Run the Programmer agent. Returns AgentResponse<ProgrammerSuccessData>.
 *
 * Failure modes (each → typed errorCode):
 *   - `bad-input`: missing or malformed input field before the LLM is called
 *   - `llm-unreachable`: no ANTHROPIC_API_KEY configured
 *   - `llm-timeout` / `llm-unreachable`: SDK threw during the call
 *   - `validation-failed`: model responded but the JSON didn't validate
 */
export async function runProgrammer(
  input: ProgrammerInput,
): Promise<AgentResponse<ProgrammerSuccessData>> {
  if (typeof input.systemPrompt !== 'string' || input.systemPrompt.trim() === '') {
    return agentError('bad-input', ['systemPrompt is required and must be a non-empty string.']);
  }
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

  const model = input.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const maxTokens = input.maxTokens ?? Number(process.env.ANTHROPIC_MAX_TOKENS ?? '8000');
  const temperature =
    input.temperature ?? Number(process.env.ANTHROPIC_TEMPERATURE ?? '0.3');

  const client = new Anthropic({ apiKey });

  const startedAt = Date.now();
  let raw = '';
  let sdkUsage: { input_tokens?: number; output_tokens?: number } | undefined;
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.userPrompt }],
    });
    raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    sdkUsage = msg.usage;
  } catch (err) {
    const message = (err as Error).message ?? 'unknown LLM error';
    return agentError('llm-unreachable', [`LLM call failed: ${message}`]);
  }

  const elapsedMs = Date.now() - startedAt;
  const usage: AgentUsage = {
    inputTokens: sdkUsage?.input_tokens ?? 0,
    outputTokens: sdkUsage?.output_tokens ?? 0,
    latencyMs: elapsedMs,
  };

  const parsed = parseAssistanceResponse(raw, {
    allowedMovementIds: new Set(input.movementIds),
    maxDayIndex: input.maxDayIndex,
    availableEquipment:
      input.availableEquipment && input.availableEquipment.length > 0
        ? new Set(input.availableEquipment)
        : undefined,
    crossWeekUsedMovementIds:
      input.crossWeekUsedMovementIds && input.crossWeekUsedMovementIds.length > 0
        ? new Set(input.crossWeekUsedMovementIds)
        : undefined,
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
