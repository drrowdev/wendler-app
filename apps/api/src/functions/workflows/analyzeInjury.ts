// analyzeInjury — workflow that orchestrates the Coach + Programmer agents
// to produce a complete injury-analysis proposal for the user to review.
//
// Flow:
//   1. Receive: pre-built Coach user prompt + movement library + (optional)
//      hints for grounding.
//   2. Call Coach agent (anatomical reasoning + per-movement adjustments).
//   3. For each Coach-proposed adjustment with action ∈ {skip, reduce-load}:
//      run the deterministic `findSubstitution` against the user's library
//      to surface 1-3 viable same-family alternatives. (Other actions —
//      reduce-range / modify-execution / monitor — don't need a different
//      movementId; the alternatives list stays empty.)
//   4. Reconcile: build the InjuryAnalysisResult with adjustments enriched
//      by alternatives + retain Coach's summary, monitoringAdvice, and
//      consult flags.
//
// Failure modes:
//   - Coach call fails → return AgentResponse error to client; UI shows
//     a manual-entry fallback (user can still create the Injury without AI
//     proposals, just won't get the structured plan).
//   - Programmer grounding is best-effort: if findSubstitution returns []
//     for a given adjustment, we just don't surface alternatives. Never a
//     fatal error.
//   - Validation failures inside Coach response are surfaced as agent
//     `validation-failed`. (No corrective retry yet — Phase 2 ships
//     deterministic-on-failure; Phase 3+ can add retry if needed.)

import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../../auth';
import { runCoach } from '../../agents/coach/runner';
import {
  findSubstitution,
  type SubstitutionAlternative,
} from '../../agents/programmer/substitution';
import { agentSuccess, type AgentResponse } from '../../agents/types';

interface MovementShape {
  id: string;
  name: string;
  equipment: string;
  pattern: string;
  primaryMuscles: string[];
  secondaryMuscles?: string[];
  externallyLoadable?: boolean;
  isCompound?: boolean;
}

interface RequestBody {
  /** Pre-built Coach user prompt. Built client-side via buildCoachPrompt. */
  userPrompt: string;
  /** Full movement library as the Coach sees it (post-equipment-filter). */
  library: MovementShape[];
}

export interface InjuryAnalysisAdjustment {
  movementId: string;
  movementName: string;
  action: 'skip' | 'reduce-load' | 'reduce-range' | 'modify-execution' | 'monitor';
  modification: string;
  reasoning: string;
  /**
   * Deterministic substitution alternatives, when Coach's action is `skip`
   * or `reduce-load` on a non-bodyweight movement. Empty for actions that
   * keep the same movementId.
   */
  alternatives: SubstitutionAlternative[];
}

export interface InjuryAnalysisResult {
  summary: string;
  proposedAdjustments: InjuryAnalysisAdjustment[];
  monitoringAdvice?: string;
  consultRecommended: boolean;
  consultReason?: string;
  /** Telemetry from the Coach call. */
  coachUsage?: { inputTokens: number; outputTokens: number; latencyMs: number };
}

async function analyzeInjury(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    return await analyzeInjuryInner(req, ctx);
  } catch (err) {
    const message = (err as Error)?.message ?? 'unknown error';
    const stack = (err as Error)?.stack ?? '';
    ctx.log(`workflows.analyzeInjury: UNCAUGHT ${message}\n${stack}`);
    // Return a structured agent error rather than a 500 so the client can
    // surface the failure to the user. Stack stays in server logs only.
    return {
      status: 200,
      jsonBody: {
        ok: false,
        errorCode: 'unknown',
        errors: [`Analyze-injury workflow crashed: ${message}`],
      },
    };
  }
}

async function analyzeInjuryInner(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    ctx.log(`workflows.analyzeInjury: unauthenticated (${reason ?? 'unknown'})`);
    return { status: 401, jsonBody: { error: 'unauthenticated' } };
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'Invalid JSON.' } };
  }

  if (typeof body.userPrompt !== 'string' || body.userPrompt.trim() === '') {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'userPrompt is required.' } };
  }
  if (!Array.isArray(body.library)) {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'library must be an array.' } };
  }

  const movementIds = body.library.map((m) => m.id);
  const libraryById = new Map(body.library.map((m) => [m.id, m]));

  const coachResult = await runCoach({
    userPrompt: body.userPrompt,
    movementIds,
  });

  if (!coachResult.ok) {
    ctx.log(
      `workflows.analyzeInjury: Coach failed (${coachResult.errorCode}; ${coachResult.errors.length} errors)`,
    );
    return { status: 200, jsonBody: coachResult };
  }

  const coach = coachResult.data.response;

  // Ground each Coach adjustment with deterministic substitution
  // alternatives (best-effort — never fatal).
  const proposedAdjustments: InjuryAnalysisAdjustment[] = coach.proposedAdjustments.map(
    (adj) => {
      const movement = libraryById.get(adj.movementId);
      const alternatives = movement
        ? findSubstitution({
            originalMovementId: adj.movementId,
            constraintNote: adj.reasoning,
            action: adj.action,
            library: body.library,
          })
        : [];
      return {
        movementId: adj.movementId,
        movementName: movement?.name ?? adj.movementId,
        action: adj.action,
        modification: adj.modification,
        reasoning: adj.reasoning,
        alternatives,
      };
    },
  );

  const result: InjuryAnalysisResult = {
    summary: coach.summary,
    proposedAdjustments,
    ...(coach.monitoringAdvice !== undefined ? { monitoringAdvice: coach.monitoringAdvice } : {}),
    consultRecommended: coach.consultRecommended ?? false,
    ...(coach.consultReason !== undefined ? { consultReason: coach.consultReason } : {}),
    ...(coachResult.usage !== undefined ? { coachUsage: coachResult.usage } : {}),
  };

  const response: AgentResponse<InjuryAnalysisResult> = agentSuccess(result, {
    rawResponse: coachResult.rawResponse,
    usage: coachResult.usage,
  });

  return { status: 200, jsonBody: response };
}

app.http('workflowsAnalyzeInjury', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'workflows/analyzeInjury',
  handler: analyzeInjury,
});
