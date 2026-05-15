// Coach agent — public entry point.
//
// The Coach agent is the movement-modification specialist (Phase 2). Given
// an injury description + the user's library + recent training context, it
// proposes a structured adjustment plan the user reviews (accept / decline /
// edit per item).
//
// Future additions in subsequent phases:
//   - `tools.ts` for chat tool-use orchestration (Phase 3 — `consult_coach`)

export const AGENT_NAME = 'coach' as const;

export const AGENT_DESCRIPTION =
  'Movement-modification coach with sports-physio training. Identifies the ' +
  'underlying anatomical issue from a user\'s pain description, maps its ' +
  'biomechanical demand across the user\'s full library, proposes per-movement ' +
  'adjustments (skip/reduce-load/reduce-range/modify-execution/monitor) with ' +
  'reasoning, and recommends a PT consult when warranted. NOT a medical ' +
  'diagnostic tool.';

export * from './prompt';
export * from './response';
