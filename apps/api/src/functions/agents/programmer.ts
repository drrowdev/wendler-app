import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../../auth';
import { runProgrammer, type ProgrammerInput } from '../../agents/programmer/runner';

interface RequestBody {
  systemPrompt: string;
  userPrompt: string;
  movementIds: string[];
  maxDayIndex?: number;
  availableEquipment?: string[];
  crossWeekUsedMovementIds?: string[];
  forbiddenMovementIds?: string[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * POST /api/agents/programmer
 *
 * Canonical entry point for the Programmer agent. Returns the unified
 * AgentResponse<ProgrammerSuccessData> shape — discriminated on `ok`.
 *
 * The legacy /api/suggestAssistance endpoint shares the same `runProgrammer`
 * runner but returns the legacy success/error shape for back-compat with
 * the existing web client. New callers should use this endpoint.
 */
async function programmerAgent(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    ctx.log(`agents.programmer: unauthenticated (${reason ?? 'unknown'})`);
    return { status: 401, jsonBody: { error: 'unauthenticated' } };
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'Invalid JSON.' } };
  }

  const input: ProgrammerInput = {
    systemPrompt: body.systemPrompt,
    userPrompt: body.userPrompt,
    movementIds: body.movementIds ?? [],
    maxDayIndex: body.maxDayIndex,
    availableEquipment: body.availableEquipment,
    crossWeekUsedMovementIds: body.crossWeekUsedMovementIds,
    forbiddenMovementIds: body.forbiddenMovementIds,
    model: body.model,
    temperature: body.temperature,
    maxTokens: body.maxTokens,
  };

  const result = await runProgrammer(input);
  if (!result.ok) {
    ctx.log(
      `agents.programmer: ${result.errorCode} (${result.errors.length} error(s))`,
    );
  }
  return { status: 200, jsonBody: result };
}

app.http('agentsProgrammer', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agents/programmer',
  handler: programmerAgent,
});
