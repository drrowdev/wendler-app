// Agent contract foundation.
//
// Every specialist agent in the Wendler PWA conforms to a small, type-level
// contract that's shared across the codebase. The goals are:
//
//   1. Predictable error handling. Every agent caller gets the same
//      discriminated-union response shape (`AgentResponse<T>`), so retries,
//      fallbacks, and UI-level error surfacing have one code path.
//
//   2. Composability for future workflows. Phase 2's `analyzeInjury` workflow
//      will call the Coach agent and (conditionally) the Programmer agent
//      back-to-back; Phase 3's chat orchestrator will expose every agent as
//      a tool. Both rely on a uniform call signature: `(input) =>
//      Promise<AgentResponse<output>>`.
//
//   3. Testability. The contract is data, not framework — agents are pure
//      functions over the wire. The prompt-builder + response-validator
//      pair lives in `packages/domain/src/agents/<name>/`, the Azure-Function
//      transport is a thin wrapper.
//
// What is intentionally NOT in this file:
//   - HTTP-specific types (those live in apps/api/src/functions/agents/)
//   - Anthropic SDK references (transport layer only)
//   - Streaming protocols (the chat agent ships an SSE wrapper alongside)
//
// The static-vs-dynamic prompt convention (locked in the master plan):
//   - SYSTEM prompt is static: role, persona, anatomical priors,
//     output schema. Lives in `agents/<name>/prompt.ts` as a constant.
//   - USER prompt is dynamic: built per call from the live IndexedDB state
//     (user profile, settings, goals, schedule, library, recent history,
//     active limitations). Lives in the same file as a builder function.
//
// If a value lives in IndexedDB or could change without redeploying, it goes
// in the user prompt. If it's a fact about the agent's role or its domain
// that doesn't change, it goes in the system prompt.

/**
 * Discriminated-union response shape every agent returns. Callers narrow on
 * `result.ok` to access either the structured success payload or the
 * structured error metadata.
 */
export type AgentResponse<T> =
  | AgentSuccessResponse<T>
  | AgentErrorResponse;

export interface AgentSuccessResponse<T> {
  ok: true;
  data: T;
  /** Raw model output before validation, useful for debug UIs. Optional. */
  rawResponse?: string;
  usage?: AgentUsage;
  /** Surfaced when the agent had to retry the LLM after a validation failure. */
  warnings?: AgentWarning[];
}

export interface AgentErrorResponse {
  ok: false;
  errorCode: AgentErrorCode;
  /** Human-readable error messages — usually the validator's complaints. */
  errors: string[];
  /** Raw model output if we got one before failure. Useful for debug. */
  rawResponse?: string;
  usage?: AgentUsage;
}

/**
 * Canonical error codes. New codes can be added as agents are built; treat
 * unknown codes as `'unknown'` in any handler.
 */
export type AgentErrorCode =
  /** The model returned text that did not validate against the agent's schema. */
  | 'validation-failed'
  /** Network error or Anthropic API unreachable. */
  | 'llm-unreachable'
  /** Anthropic returned a response but timed out before completion. */
  | 'llm-timeout'
  /** Anthropic refused the request (safety / policy). Rare for this app's domain. */
  | 'llm-refused'
  /** Anthropic returned a rate-limit error; client may retry with backoff. */
  | 'rate-limited'
  /** A required input field was missing/invalid before we even called the LLM. */
  | 'bad-input'
  /** Catch-all for everything else. */
  | 'unknown';

/**
 * Token + latency telemetry. Optional on every response — agents that don't
 * call an LLM (e.g. deterministic-only paths) omit it.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * Non-fatal observations during a successful call. Common case: the model
 * needed a corrective retry. Surfaced separately from `errors` so success
 * paths can still emit useful debug info.
 */
export interface AgentWarning {
  code: string;
  message: string;
}

/**
 * Common per-call config. Each agent has its own defaults (temperature,
 * model) — callers may override on a per-call basis.
 */
export interface AgentCallConfig {
  /** Override the agent's default model. */
  model?: string;
  /** Override the agent's default temperature. */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
  /** Hard cap on corrective retries after validation failure. */
  maxRetries?: number;
}

/**
 * Tool spec for chat tool-use orchestration (Phase 3). Each agent that wants
 * to be callable from chat exports a `<NAME>_TOOL_SPEC` of this shape. The
 * chat agent registers these with Anthropic's tool-use API at runtime.
 *
 * Defined here (and not in Phase 3) so the type is in place when Phase 2
 * starts building specialists.
 */
export interface AgentToolSpec {
  /** Identifier the chat agent calls (e.g. "consult_coach"). */
  name: string;
  /** Description Claude uses to decide when to call this tool. */
  description: string;
  /** JSON-schema-subset describing the tool's input shape. */
  inputSchema: AgentToolInputSchema;
}

export interface AgentToolInputSchema {
  type: 'object';
  properties: Record<string, AgentToolInputProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentToolInputProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly (string | number)[];
  items?: AgentToolInputProperty;
}

/**
 * Helper to construct a success response. Keeps call sites short and
 * preserves the discriminated-union narrowing.
 */
export function agentSuccess<T>(
  data: T,
  opts?: { rawResponse?: string; usage?: AgentUsage; warnings?: AgentWarning[] },
): AgentSuccessResponse<T> {
  return {
    ok: true,
    data,
    ...(opts?.rawResponse !== undefined ? { rawResponse: opts.rawResponse } : {}),
    ...(opts?.usage !== undefined ? { usage: opts.usage } : {}),
    ...(opts?.warnings !== undefined ? { warnings: opts.warnings } : {}),
  };
}

/**
 * Helper to construct an error response. Errors must always carry at least
 * one human-readable message; an empty array is a programming bug, not a
 * legitimate state.
 */
export function agentError(
  errorCode: AgentErrorCode,
  errors: string[],
  opts?: { rawResponse?: string; usage?: AgentUsage },
): AgentErrorResponse {
  if (errors.length === 0) {
    // Defensive — callers should always supply a message.
    errors = [`Agent failed with code ${errorCode} (no message provided)`];
  }
  return {
    ok: false,
    errorCode,
    errors,
    ...(opts?.rawResponse !== undefined ? { rawResponse: opts.rawResponse } : {}),
    ...(opts?.usage !== undefined ? { usage: opts.usage } : {}),
  };
}
