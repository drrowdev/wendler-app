// Programmer agent — response validator.
//
// Parses + validates the Programmer agent's structured JSON output. Mirrors
// the validator in `apps/api/src/llm/validate.ts` (which runs server-side
// before the response leaves the API boundary). The two must stay in lockstep
// — they're separate files because the API-side validator pre-dates the
// agent contract and the domain copy is what tests + the deterministic
// fallback path import.
//
// Implementation lives in `packages/domain/src/assistance-response.ts`; this
// module re-exports under the canonical `agents/programmer/` path so future
// workflows + tool-use orchestrators can import the agent's response shape
// from one consistent place.

export {
  parseAssistanceResponse,
  type LlmNewMovement,
  type LlmAssistanceEntry,
  type LlmDayPlan,
  type LlmAssistanceResponse,
  type ParseResult,
  type ParseAssistanceResponseOptions,
} from '../../assistance-response';
