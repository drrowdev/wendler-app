import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../../auth.js';
import { runSummarizer, type SummarizerInput } from '../../agents/summarizer/runner.js';

interface RequestBody {
  userPrompt: string;
  expectedWeekStart?: string;
  expectedWeekEnd?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * POST /api/agents/summarizer
 *
 * Returns the unified AgentResponse<SummarizerSuccessData> shape.
 */
async function summarizerAgent(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    ctx.log(`agents.summarizer: unauthenticated (${reason ?? 'unknown'})`);
    return { status: 401, jsonBody: { error: 'unauthenticated' } };
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'Invalid JSON.' } };
  }

  const input: SummarizerInput = {
    userPrompt: body.userPrompt,
    expectedWeekStart: body.expectedWeekStart,
    expectedWeekEnd: body.expectedWeekEnd,
    model: body.model,
    temperature: body.temperature,
    maxTokens: body.maxTokens,
  };

  const result = await runSummarizer(input);
  return { status: 200, jsonBody: result };
}

app.http('agents-summarizer', {
  route: 'agents/summarizer',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: summarizerAgent,
});
