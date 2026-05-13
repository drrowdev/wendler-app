/**
 * Pure decision logic for the first-run onboarding wizard. The React
 * component in apps/web/src/components/OnboardingWizard.tsx wraps these,
 * but the rules themselves don't need a DOM and live here so they can be
 * unit-tested.
 */

export interface OnboardingPersisted {
  step: 1 | 2 | 3 | 'done';
  tmDone: boolean;
  scheduleDone: boolean;
  raceHandled: boolean;
  /** True iff the user explicitly tapped "Skip TMs". */
  tmSkipped: boolean;
}

export const ONBOARDING_INITIAL: OnboardingPersisted = {
  step: 1,
  tmDone: false,
  scheduleDone: false,
  raceHandled: false,
  tmSkipped: false,
};

/**
 * When opening the wizard on a fresh visit, find the right step to land on
 * given prior progress. We never re-prompt for a step the user already
 * completed (or explicitly skipped, in the TM case).
 */
export function nextOnboardingStep(
  persisted: OnboardingPersisted,
): OnboardingPersisted['step'] {
  if (persisted.raceHandled) return 'done';
  if (persisted.scheduleDone) return 3;
  if (persisted.tmDone || persisted.tmSkipped) return 2;
  return 1;
}

/**
 * Decide whether the wizard should open on app boot.
 *
 * Open conditions:
 * - URL has `?onboarding=1` (debug / re-test path), regardless of state
 * - The install has neither a schedule singleton nor any program blocks
 */
export function shouldOpenOnboarding(input: {
  hasSchedule: boolean;
  hasBlocks: boolean;
  urlForceFlag: boolean;
}): boolean {
  if (input.urlForceFlag) return true;
  return !input.hasSchedule && !input.hasBlocks;
}

/**
 * Validate a single training-max input. Used by the wizard's TM step.
 * Returns the parsed kg value (after unit conversion) or an error message.
 */
export function parseTrainingMaxInput(
  raw: string,
  units: 'kg' | 'lb',
): { ok: true; kg: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Required.' };
  const value = parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Enter a positive number.' };
  }
  if (value > 500) {
    return { ok: false, error: 'That looks too high — typo?' };
  }
  const factor = units === 'lb' ? 0.45359237 : 1;
  return { ok: true, kg: roundTo(value * factor, 0.5) };
}

function roundTo(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}
