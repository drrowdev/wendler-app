// Programmer agent — public entry point. Re-exports the prompt builder and
// response validator from the agent's canonical namespace, plus an
// `AGENT_NAME` constant for registry/logging.
//
// Future additions in subsequent phases:
//   - `tools.ts` for chat tool-use orchestration (Phase 3)
//   - `runProgrammer()` server-side runner (Phase 2+, when Coach's
//     analyzeInjury workflow needs to call this agent directly)

export const AGENT_NAME = 'programmer' as const;

/**
 * Static, human-readable description of the Programmer agent. Used by the
 * agent registry and (in Phase 3) as the basis for the chat tool description
 * shown to the orchestrator.
 */
export const AGENT_DESCRIPTION =
  'Picks Wendler 5/3/1 assistance work (sets, reps, supplemental targeting) ' +
  'for a block, respecting volume budgets, goal flags, equipment, cross-week ' +
  'dedup, and active limitations. Does NOT handle anatomy, periodization, or ' +
  'run programming.';

export * from './prompt';
export * from './response';
