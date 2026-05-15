// Summarizer agent — Phase 4 will ship the prompt builder + response
// validator + runner. For Phase 3 only the tool spec exists so the chat
// orchestrator can declare the tool from day one.

export const AGENT_NAME = 'summarizer' as const;

export const AGENT_DESCRIPTION =
  'Generates a structured summary of a recent training week: key metrics ' +
  '(tonnage, sessions, top sets, cardio minutes) plus qualitative ' +
  'commentary. Phase 4 ships the implementation; Phase 3 only declares the ' +
  'tool spec.';

export * from './tools';
