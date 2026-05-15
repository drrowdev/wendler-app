import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../../auth.js';
import { runPeriodizer, type PeriodizerInput } from '../../agents/periodizer/runner.js';

interface RequestBody {
  userPrompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * POST /api/agents/periodizer
 *
 * Returns the unified AgentResponse<PeriodizerSuccessData> shape.
 */
async function periodizerAgent(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    ctx.log(`agents.periodizer: unauthenticated (${reason ?? 'unknown'})`);
    return { status: 401, jsonBody: { error: 'unauthenticated' } };
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'Invalid JSON.' } };
  }

  const input: PeriodizerInput = {
    userPrompt: body.userPrompt,
    model: body.model,
    temperature: body.temperature,
    maxTokens: body.maxTokens,
  };

  const result = await runPeriodizer(input);
  return { status: 200, jsonBody: result };
}

app.http('agents-periodizer', {
  route: 'agents/periodizer',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: periodizerAgent,
});
