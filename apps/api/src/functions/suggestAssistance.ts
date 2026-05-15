import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import Anthropic from '@anthropic-ai/sdk';
import { verifyRequest } from '../auth';
import { parseAssistanceResponse } from '../llm/validate.js';

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
 * POST /api/suggestAssistance
 *
 * Body: { systemPrompt, userPrompt, movementIds[], maxDayIndex? }
 * The client builds the prompts with `buildAssistancePrompt` from
 * @wendler/domain and ships the catalog whitelist alongside.
 *
 * Returns:
 *   200 { ok: true,  data: LlmAssistanceResponse, raw: string, modelInfo }
 *   200 { ok: false, errors: string[], raw: string, modelInfo }   // valid call, bad model output
 *   400 { error: 'bad-request', detail }
 *   401 { error: 'unauthenticated' }
 *   503 { error: 'llm-not-configured' }                            // no ANTHROPIC_API_KEY
 *   502 { error: 'llm-call-failed', detail }                       // upstream failure
 *
 * Note that schema-validation failure is a 200 — the client decides whether
 * to surface the errors to the user, retry, or fall back to the
 * deterministic suggester.
 */
export async function suggestAssistance(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    ctx.log(`suggestAssistance: unauthenticated (${reason ?? 'unknown'})`);
    return { status: 401, jsonBody: { error: 'unauthenticated' } };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { status: 503, jsonBody: { error: 'llm-not-configured' } };
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

  const { systemPrompt, userPrompt, movementIds, maxDayIndex, availableEquipment, crossWeekUsedMovementIds } =
    body ?? ({} as RequestBody);
  if (typeof systemPrompt !== 'string' || systemPrompt.length < 50) {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'systemPrompt missing or too short' } };
  }
  if (typeof userPrompt !== 'string' || userPrompt.length < 50) {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'userPrompt missing or too short' } };
  }
  if (!Array.isArray(movementIds) || movementIds.length === 0) {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'movementIds must be a non-empty array' } };
  }
  if (movementIds.length > 5000) {
    return { status: 400, jsonBody: { error: 'bad-request', detail: 'movementIds exceeds 5000' } };
  }

  // Defaults below are tuned for the assistance-suggester payload shape.
  // Override per-deployment via env if Anthropic ships a newer model or you
  // want to dial cost vs. creativity differently.
  //
  // - model: Sonnet 4.6 — strong instruction-following on structured JSON,
  //   fast enough for an interactive panel (~2-4s round-trip in practice).
  // - max_tokens: 8000. A typical response is ~1500-2500 output tokens
  //   (3-4 days × 3-5 entries × ~10 short fields + a few blockRationale
  //   lines). Bumped from 4000 because a truncated JSON forces a full
  //   retry — output tokens are cheap relative to that round-trip.
  // - temperature: 0.3. Structured-output guidance for strict JSON-schema
  //   tasks lands in the 0.0–0.3 band; we sit at the top of that range.
  //   The case for non-zero is real (regenerating at T=0 returns the same
  //   picks every time), but token-level entropy is the WRONG lever for
  //   selection variety — at higher temperatures it manifests as ID drift
  //   (seed:bench-press → seed:bench_press), creative departures from the
  //   library when an OK match exists, and JSON schema deviations. The
  //   variety we want is at the *movement-selection* layer, achieved
  //   structurally by:
  //     (a) shuffling the per-day movement-library section on each call
  //         (kills LLM primacy bias for early-in-list entries)
  //     (b) directive cross-week dedup ("actively avoid these")
  //     (c) the hard cross-week validator (system rule 5)
  //
  // Caching note (for whoever adds it next): an input-hash cache still
  // pays its keep at non-zero temperature — saves the round-trip — but
  // a cached response is one sampled point from a distribution, not the
  // canonically "best" answer. That's fine for our use case (suggestion
  // tool, not a planner) but be explicit about it in the cache layer.
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS ?? '8000');
  const temperature = Number(process.env.ANTHROPIC_TEMPERATURE ?? '0.3');

  const client = new Anthropic({ apiKey });

  const startedAt = Date.now();
  let raw = '';
  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    usage = msg.usage;
  } catch (err) {
    ctx.log(`suggestAssistance: LLM call failed: ${(err as Error).message}`);
    return {
      status: 502,
      jsonBody: { error: 'llm-call-failed', detail: (err as Error).message },
    };
  }

  const elapsedMs = Date.now() - startedAt;
  const modelInfo = {
    model,
    elapsedMs,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
  };

  const parsed = parseAssistanceResponse(raw, {
    allowedMovementIds: new Set(movementIds),
    maxDayIndex,
    availableEquipment:
      Array.isArray(availableEquipment) && availableEquipment.length > 0
        ? new Set(availableEquipment)
        : undefined,
    crossWeekUsedMovementIds:
      Array.isArray(crossWeekUsedMovementIds) && crossWeekUsedMovementIds.length > 0
        ? new Set(crossWeekUsedMovementIds)
        : undefined,
  });

  if (!parsed.ok) {
    ctx.log(
      `suggestAssistance: LLM responded but validation failed (${parsed.errors.length} errors)`,
    );
    return {
      status: 200,
      jsonBody: { ok: false, errors: parsed.errors, raw, modelInfo },
    };
  }

  return {
    status: 200,
    jsonBody: { ok: true, data: parsed.data, raw, modelInfo },
  };
}

app.http('suggestAssistance', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'suggestAssistance',
  handler: suggestAssistance,
});
