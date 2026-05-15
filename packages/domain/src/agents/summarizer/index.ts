// Summarizer agent — Phase 4. Produces the weekly review digest by
// reconciling Periodizer + Coach specialist outputs with raw signals.

export const AGENT_NAME = 'summarizer' as const;

export const AGENT_DESCRIPTION =
  'Generates structured weekly training summaries (metrics + commentary). ' +
  'Reconciliation + presentation specialist — not first-principles reasoning. ' +
  'Takes raw weekly signals + pre-computed specialist outputs (Periodizer, Coach) ' +
  'and emits a 6-section card the user reads on Sunday/Monday.';

export * from './prompt';
export * from './response';
export * from './tools';
