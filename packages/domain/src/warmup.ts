import { floorToIncrement } from './rounding';
import type { PrescribedSet, WarmupConfig } from './types';

export const DEFAULT_WARMUP: WarmupConfig = {
  percents: [0.4, 0.6, 0.8],
  reps: [5, 5, 3],
};

/**
 * Build the warm-up ramp for a given top working weight.
 * Each warm-up set is floored to the nearest increment so it's always loadable below the
 * working weight (avoids accidentally overshooting after rounding).
 */
export function buildWarmupSets(
  topWorkingWeightKg: number,
  roundingKg: number,
  config: WarmupConfig = DEFAULT_WARMUP,
): PrescribedSet[] {
  if (config.percents.length !== config.reps.length) {
    throw new Error('warmup percents and reps must have the same length');
  }
  return config.percents.map((p, i) => ({
    kind: 'warmup',
    percentOfTm: undefined,
    weightKg: Math.max(0, floorToIncrement(topWorkingWeightKg * p, roundingKg)),
    reps: config.reps[i] ?? 5,
  }));
}
