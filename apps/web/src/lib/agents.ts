// Client-side specialist-agent invokers.
//
// Each agent in the registry gets a thin `call<Name>()` wrapper here that
// POSTs to its HTTP endpoint and returns the typed `AgentResponse<T>` shape
// from `@wendler/domain`. Callers can narrow on `result.ok` to handle
// success vs. failure with the same code path across agents.
//
// Why this layer exists (and is not just an inline `fetch`):
//   1. Single place to add cross-cutting concerns (auth, timing logs, retry
//      policy, optional in-memory caching).
//   2. Type safety on both ends. The agent's input + output shapes live in
//      domain; this module imports them and the caller gets full IntelliSense.
//   3. Future workflows + chat tool-use orchestration call agents through
//      these helpers so the agent boundary is consistent.

import type { AgentResponse, LlmAssistanceResponse } from '@wendler/domain';
import { authFetch } from './auth';

export interface ProgrammerInput {
  systemPrompt: string;
  userPrompt: string;
  movementIds: readonly string[];
  maxDayIndex?: number;
  availableEquipment?: readonly string[];
  crossWeekUsedMovementIds?: readonly string[];
  model?: string;
  temperature?: number;
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
 * Invoke the Programmer agent via POST /api/agents/programmer.
 *
 * The existing assistance-suggester UI (`SuggestAssistanceForBlock.tsx`)
 * still uses the legacy `/api/suggestAssistance` endpoint for now. New
 * callers (Phase 2's injury workflow, Phase 3's chat tool-use) should use
 * this helper.
 *
 * Returns an AgentResponse — narrow on `result.ok` before reading
 * `result.data` / `result.errors`.
 */
export async function callProgrammer(
  input: ProgrammerInput,
): Promise<AgentResponse<ProgrammerSuccessData>> {
  try {
    const res = await authFetch('/api/agents/programmer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      // The server-side handler always returns 200 with an AgentResponse
      // body; non-200 means transport-layer issue (network, auth).
      if (res.status === 401) {
        return {
          ok: false,
          errorCode: 'llm-unreachable',
          errors: ['Not authenticated. Sign in and try again.'],
        };
      }
      return {
        ok: false,
        errorCode: 'llm-unreachable',
        errors: [`Server returned HTTP ${res.status}.`],
      };
    }
    const body = (await res.json()) as AgentResponse<ProgrammerSuccessData>;
    return body;
  } catch (err) {
    return {
      ok: false,
      errorCode: 'llm-unreachable',
      errors: [`Network error: ${(err as Error).message}`],
    };
  }
}
