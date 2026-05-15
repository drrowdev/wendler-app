// Agent contract foundation — public entry point. Currently exports the
// contract types + the Programmer specialist agent. Future specialists
// (coach, periodizer, summarizer) re-export from here as they're added in
// subsequent phases.

export * from './types';

// Specialists. Each agent module exposes its prompt builder, response
// validator, AGENT_NAME constant, and AGENT_DESCRIPTION. Phases 3+ will add
// `tools.ts` exports for chat tool-use orchestration.
export * as ProgrammerAgent from './programmer';
export * as CoachAgent from './coach';
export * as PeriodizerAgent from './periodizer';
export * as SummarizerAgent from './summarizer';
