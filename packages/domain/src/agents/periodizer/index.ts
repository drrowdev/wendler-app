// Periodizer agent — Phase 4 system prompt + validator. Ships the macro-
// structure specialist (deload timing, taper, ramp-up, TM-test).

export const AGENT_NAME = 'periodizer' as const;

export const AGENT_DESCRIPTION =
  'Periodization specialist for deload timing, block-to-block transitions, ' +
  'race-week tapers, return-from-layoff ramps. Reasons over recent volume + ' +
  'intensity + ACWR signals plus upcoming priority races. Returns a structured ' +
  'verdict (deload-now / deload-soon / continue / taper-now / ramp-up / tm-test ' +
  '/ extend-block) with evidence and next steps.';

export * from './prompt';
export * from './response';
export * from './tools';
