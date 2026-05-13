// ---------------------------------------------------------------------------
// Profile-Directives — Phase × Tier-2 (secondary-goal) directive strings,
// and Filter (user-authored hard-constraint) serialization for the LLM prompt.
// ---------------------------------------------------------------------------
//
// Split out of `goal-flags.ts` (v279) because it depends on the four-axis
// `TrainingProfile` model rather than the legacy `GoalFlags` axis. Keeping
// these concerns in separate files makes the legacy-vs-modern boundary
// explicit, and removes a mid-file `import` smell from goal-flags.
//
// The phase × secondary matrix that decides WHICH string applies (active /
// light / priority / suppressed) lives in `training-profile.ts` — that's the
// structural concern. The strings below are the LLM-facing voice of those
// cells.
//
// IMPORTANT: only the non-active cells need a directive. 'active'
// secondaries inherit the existing `goalsToPromptContext` directives
// unchanged; 'suppressed' cells are filtered out before reaching the LLM.

import type { SecondaryGoal, TrainingPhase, Constraint } from './training-profile-types';

/**
 * Functional movement, retained at "light" volume during deload / taper.
 * Allows: single-leg, anti-rotation only.
 * Forbids: jumps / throws / plyometrics, AMRAP, top reps > 10.
 * Cap: 1 movement per session, ≤2 working sets.
 *
 * Carries are intentionally excluded — they belong to real-life-strength
 * (which is fully suppressed during deload/taper), so allowing them here
 * would re-introduce that goal through a back door.
 */
export const PHASE_DIRECTIVE_FUNCTIONAL_MOVEMENT_LIGHT =
  'Functional movement is retained at taper-light volume: at most one ' +
  'single-leg or anti-rotation movement per session, ≤2 working sets, ' +
  'no AMRAP, top reps ≤10. Do not include carries, jump/throw variants, ' +
  'or plyometrics while in this phase.';

/**
 * Returns the verbatim prompt directive for a (secondary, phase) pair,
 * or undefined when the cell is 'active' (inherit normal-phase prompt
 * unchanged) or 'suppressed' (caller already filtered the goal out).
 *
 * The cell-effect lookup itself lives in `training-profile.ts`'s
 * `secondaryEffect` matrix; this function only owns the prompt strings.
 */
export function phaseDirectiveString(
  secondary: SecondaryGoal,
  phase: TrainingPhase,
): string | undefined {
  if (secondary === 'functional-movement' && (phase === 'deload' || phase === 'taper')) {
    return PHASE_DIRECTIVE_FUNCTIONAL_MOVEMENT_LIGHT;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Filter serialization — included in the LLM prompt as a hard
// filter section. Constraint vocabulary is fully user-authored; phase-specific
// emphasis (e.g. peak-phase prehab) belongs in the user's free-text notes.
// ---------------------------------------------------------------------------

/**
 * Build the "## Filters" section for the assistance prompt, or undefined
 * when no constraints are active. Constraints are framed as hard filters the
 * LLM must never violate — distinct from goal-context which biases scoring.
 */
export function constraintsToPromptContext(
  constraints: readonly Pick<Constraint, 'kind' | 'label'>[],
  _phase: TrainingPhase = 'normal',
): string | undefined {
  if (constraints.length === 0) return undefined;
  const lines: string[] = [
    'Hard constraints — never propose any movement that violates these. They filter the available movement set; they do not compete with goals for slot budget.',
    ...constraints.map((c) => `- ${c.label}`),
  ];
  return lines.join('\n');
}
