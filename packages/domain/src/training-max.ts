import { roundToIncrement } from './rounding';
import type { TrainingMaxConfig } from './types';

/**
 * Compute the Training Max from a 1RM (or estimated 1RM).
 * Wendler typically uses 85% (Anchor) or 90% (some advanced templates) — but the canonical
 * `5/3/1 Forever` baseline is 85%. We round to the user's configured plate increment.
 */
export function computeTrainingMax(oneRepMaxKg: number, config: TrainingMaxConfig): number {
  if (oneRepMaxKg <= 0) throw new Error('1RM must be > 0');
  if (config.tmPercent <= 0 || config.tmPercent >= 1) {
    throw new Error('tmPercent must be between 0 and 1 exclusive');
  }
  return roundToIncrement(oneRepMaxKg * config.tmPercent, config.roundingKg);
}
