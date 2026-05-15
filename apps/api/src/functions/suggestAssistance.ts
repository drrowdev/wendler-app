import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../auth';
import { runProgrammer } from '../agents/programmer/runner';

interface RequestBody {
  systemPrompt: string;
  userPrompt: string;
  /**
   * Whitelist of movement IDs the LLM is allowed to return. Sent by the
   * client because the API has no access to the user's IndexedDB catalog.
   */
  movementIds: string[];
  /** Highest valid block-day index (length-1). Optional; omit to skip the check. */
  maxDayIndex?: number;
  /**
   * Equipment types available to the user. Used to validate any
   * `newMovement.equipment` the LLM proposes (bodyweight always allowed).
   * Omit to skip equipment validation entirely.
   */
  availableEquipment?: string[];
  /**
   * MovementIds already used in OTHER weeks of the same block. The parser
   * treats a re-used id as a validation error so the corrective-retry path
   * can ask the model to vary. Optional — omit on first-week generation.
   */
  crossWeekUsedMovementIds?: string[];
}

/**
 * POST /api/suggestAssistance — legacy route, kept for back-compat with the
 * existing web client. Delegates to `runProgrammer` and maps the unified
 * AgentResponse back to the legacy success/error shape:
 *
 *   200 { ok: true,  data: LlmAssistanceResponse, raw, modelInfo }
 *   200 { ok: false, errors: string[], raw, modelInfo }
 *   400 { error: 'bad-request', detail }
 *   401 { error: 'unauthenticated' }
 *   503 { error: 'llm-not-configured' }
 *   502 { error: 'llm-call-failed', detail }
 *
 * New callers should prefer `POST /api/agents/programmer` which returns the
 * unified `AgentResponse<ProgrammerSuccessData>` shape.
 */
async function suggestAssistance(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    ctx.log(`suggestAssistance: unauthenticated (${reason ?? 'unknown'})`);
    return { status: 401, jsonBody: { error: 'unauthenticated' } };
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

  const {
    systemPrompt,
    userPrompt,
    movementIds,
    maxDayIndex,
    availableEquipment,
    crossWeekUsedMovementIds,
  } = body ?? ({} as RequestBody);

  // Legacy request validation — stricter than the runner's checks (the
  // runner doesn't gate on prompt length). Kept here so the legacy response
  // shape stays consistent.
  if (typeof systemPrompt !== 'string' || systemPrompt.length < 50) {
    return {
      status: 400,
      jsonBody: { error: 'bad-request', detail: 'systemPrompt missing or too short' },
    };
  }
  if (typeof userPrompt !== 'string' || userPrompt.length < 50) {
    return {
      status: 400,
      jsonBody: { error: 'bad-request', detail: 'userPrompt missing or too short' },
    };
  }
  if (!Array.isArray(movementIds) || movementIds.length === 0) {
    return {
      status: 400,
      jsonBody: { error: 'bad-request', detail: 'movementIds must be a non-empty array' },
    };
  }
  if (movementIds.length > 5000) {
    return {
      status: 400,
      jsonBody: { error: 'bad-request', detail: 'movementIds exceeds 5000' },
    };
  }

  const result = await runProgrammer({
    systemPrompt,
    userPrompt,
    movementIds,
    maxDayIndex,
    availableEquipment,
    crossWeekUsedMovementIds,
  });

  if (result.ok) {
    return {
      status: 200,
      jsonBody: {
        ok: true,
        data: result.data.response,
        raw: result.rawResponse ?? '',
        modelInfo: result.data.modelInfo,
      },
    };
  }

  // Map the agent's error codes back to the legacy HTTP-status shape.
  switch (result.errorCode) {
    case 'llm-unreachable':
      // Distinguish "no API key configured" (503) from "SDK threw" (502).
      if (!process.env.ANTHROPIC_API_KEY) {
        return { status: 503, jsonBody: { error: 'llm-not-configured' } };
      }
      return {
        status: 502,
        jsonBody: { error: 'llm-call-failed', detail: result.errors[0] ?? 'LLM call failed' },
      };
    case 'llm-timeout':
      return {
        status: 502,
        jsonBody: { error: 'llm-call-failed', detail: result.errors[0] ?? 'LLM timed out' },
      };
    case 'validation-failed': {
      ctx.log(
        `suggestAssistance: LLM responded but validation failed (${result.errors.length} errors)`,
      );
      const modelInfo = {
        elapsedMs: result.usage?.latencyMs ?? 0,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      };
      return {
        status: 200,
        jsonBody: {
          ok: false,
          errors: result.errors,
          raw: result.rawResponse ?? '',
          modelInfo,
        },
      };
    }
    case 'bad-input':
      return { status: 400, jsonBody: { error: 'bad-request', detail: result.errors[0] } };
    default:
      return {
        status: 502,
        jsonBody: { error: 'llm-call-failed', detail: result.errors[0] ?? 'unknown' },
      };
  }
}

app.http('suggestAssistance', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'suggestAssistance',
  handler: suggestAssistance,
});
