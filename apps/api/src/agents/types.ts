// Agent contract types — mirror of `packages/domain/src/agents/types.ts`.
//
// Why duplicate? Azure Functions on Node16 module resolution can't consume
// the extensionless ESM imports in @wendler/domain without a separate build
// step (see also: `apps/api/src/llm/validate.ts` which mirrors
// `packages/domain/src/assistance-response.ts` for the same reason).
//
// Keep this in lockstep with `packages/domain/src/agents/types.ts`. Any
// schema change to AgentResponse or AgentErrorCode must be reflected here.

export type AgentResponse<T> =
  | AgentSuccessResponse<T>
  | AgentErrorResponse;

export interface AgentSuccessResponse<T> {
  ok: true;
  data: T;
  rawResponse?: string;
  usage?: AgentUsage;
  warnings?: AgentWarning[];
}

export interface AgentErrorResponse {
  ok: false;
  errorCode: AgentErrorCode;
  errors: string[];
  rawResponse?: string;
  usage?: AgentUsage;
}

export type AgentErrorCode =
  | 'validation-failed'
  | 'llm-unreachable'
  | 'llm-timeout'
  | 'llm-refused'
  | 'rate-limited'
  | 'bad-input'
  | 'unknown';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AgentWarning {
  code: string;
  message: string;
}

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

export function agentError(
  errorCode: AgentErrorCode,
  errors: string[],
  opts?: { rawResponse?: string; usage?: AgentUsage },
): AgentErrorResponse {
  if (errors.length === 0) {
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
