import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../../auth.js';
import { runPeriodizer } from '../../agents/periodizer/runner.js';
import { runSummarizer } from '../../agents/summarizer/runner.js';
import { agentError, agentSuccess, type AgentResponse } from '../../agents/types.js';
import type { PeriodizerResponse } from '../../agents/periodizer/response.js';
import type { SummarizerResponse } from '../../agents/summarizer/response.js';

interface RequestBody {
  weekStart: string;
  weekEnd: string;
  /**
   * Pre-built Periodizer user prompt — caller assembles it from IndexedDB
   * (load signals, recent training summary, active block, etc).
   */
  periodizerUserPrompt: string;
  /**
   * Pre-built Summarizer user prompt, MINUS the Periodizer specialist
   * section. The workflow injects the Periodizer's structured output
   * into the prompt before calling the Summarizer so the client doesn't
   * have to wait, then call, then re-build.
   *
   * The convention: client supplies the user prompt with a sentinel
   * `<!-- PERIODIZER_INPUT -->` block where the workflow should insert
   * the rendered Periodizer specialist section. Omit the sentinel to
   * append at the end.
   */
  summarizerUserPrompt: string;
}

export interface WeeklyReviewResult {
  weekStart: string;
  weekEnd: string;
  periodizer: PeriodizerResponse;
  summary: SummarizerResponse;
}

const SENTINEL = '<!-- PERIODIZER_INPUT -->';

/**
 * POST /api/workflows/weeklyReview
 *
 * Two-stage workflow:
 *  1) runPeriodizer over the pre-built periodizer user prompt
 *  2) Inject periodizer output into the summarizer user prompt
 *  3) runSummarizer
 *
 * Returns AgentResponse<WeeklyReviewResult>.
 */
async function weeklyReview(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    ctx.log(`workflows.weeklyReview: unauthenticated (${reason ?? 'unknown'})`);
    return { status: 401, jsonBody: { error: 'unauthenticated' } };
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'Invalid JSON.' } };
  }

  if (
    !body ||
    typeof body.weekStart !== 'string' ||
    typeof body.weekEnd !== 'string' ||
    typeof body.periodizerUserPrompt !== 'string' ||
    typeof body.summarizerUserPrompt !== 'string'
  ) {
    return {
      status: 400,
      jsonBody: {
        error: 'bad-request',
        detail:
          'weekStart, weekEnd, periodizerUserPrompt, and summarizerUserPrompt are required.',
      },
    };
  }

  // Stage 1: Periodizer
  const periodizerResult = await runPeriodizer({
    userPrompt: body.periodizerUserPrompt,
  });
  if (!periodizerResult.ok) {
    const response: AgentResponse<WeeklyReviewResult> = agentError(
      periodizerResult.errorCode,
      ['Periodizer stage failed: ' + periodizerResult.errors.join('; ')],
      {
        rawResponse: periodizerResult.rawResponse,
        usage: periodizerResult.usage,
      },
    );
    return { status: 200, jsonBody: response };
  }

  const periodizerOut = periodizerResult.data.response;

  // Stage 2: inject Periodizer output into the Summarizer prompt
  const renderedPeriodizerSection =
    `## Periodizer specialist input\n` +
    `- Verdict: ${periodizerOut.verdict}\n` +
    `- Headline: ${periodizerOut.headline}\n\n` +
    `Periodizer's reasoning (use verbatim in the Load + recovery section when relevant):\n` +
    periodizerOut.shortReply;

  let assembledSummarizerPrompt: string;
  if (body.summarizerUserPrompt.includes(SENTINEL)) {
    assembledSummarizerPrompt = body.summarizerUserPrompt.replace(
      SENTINEL,
      renderedPeriodizerSection,
    );
  } else {
    assembledSummarizerPrompt =
      body.summarizerUserPrompt.trim() + '\n\n' + renderedPeriodizerSection;
  }

  // Stage 3: Summarizer
  const summarizerResult = await runSummarizer({
    userPrompt: assembledSummarizerPrompt,
    expectedWeekStart: body.weekStart,
    expectedWeekEnd: body.weekEnd,
  });
  if (!summarizerResult.ok) {
    const response: AgentResponse<WeeklyReviewResult> = agentError(
      summarizerResult.errorCode,
      ['Summarizer stage failed: ' + summarizerResult.errors.join('; ')],
      {
        rawResponse: summarizerResult.rawResponse,
        usage: summarizerResult.usage,
      },
    );
    return { status: 200, jsonBody: response };
  }

  const response: AgentResponse<WeeklyReviewResult> = agentSuccess({
    weekStart: body.weekStart,
    weekEnd: body.weekEnd,
    periodizer: periodizerOut,
    summary: summarizerResult.data.response,
  });
  return { status: 200, jsonBody: response };
}

app.http('workflows-weeklyReview', {
  route: 'workflows/weeklyReview',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: weeklyReview,
});
