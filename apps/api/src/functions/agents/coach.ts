import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../../auth';
import { runCoach, type CoachInput } from '../../agents/coach/runner';

interface RequestBody {
  userPrompt: string;
  movementIds: string[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * POST /api/agents/coach
 *
 * Returns the unified AgentResponse<CoachSuccessData> shape — discriminated
 * on `ok`. The user prompt is built client-side via `buildCoachPrompt` from
 * @wendler/domain (the system prompt is fixed at the API layer); the client
 * also ships the catalog of movement IDs the Coach is allowed to reference.
 */
async function coachAgent(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    ctx.log(`agents.coach: unauthenticated (${reason ?? 'unknown'})`);
    return { status: 401, jsonBody: { error: 'unauthenticated' } };
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'Invalid JSON.' } };
  }

  const input: CoachInput = {
    userPrompt: body.userPrompt,
    movementIds: body.movementIds ?? [],
    model: body.model,
    temperature: body.temperature,
    maxTokens: body.maxTokens,
  };

  const result = await runCoach(input);
  if (!result.ok) {
    ctx.log(`agents.coach: ${result.errorCode} (${result.errors.length} error(s))`);
  }
  return { status: 200, jsonBody: result };
}

app.http('agentsCoach', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agents/coach',
  handler: coachAgent,
});
