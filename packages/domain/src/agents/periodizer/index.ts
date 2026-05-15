// Periodizer agent — Phase 4 will ship the prompt builder + response
// validator + runner. For Phase 3 only the tool spec exists so the chat
// orchestrator can declare the tool from day one.

export const AGENT_NAME = 'periodizer' as const;

export const AGENT_DESCRIPTION =
  'Periodization specialist for deload timing, block-to-block transitions, ' +
  'race-week tapers, return-from-layoff ramps. Reasons over recent volume + ' +
  'intensity + ACWR signals plus upcoming priority races. Phase 4 ships the ' +
  'implementation; Phase 3 only declares the tool spec.';

export * from './tools';
