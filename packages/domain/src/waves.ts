import { roundToIncrement } from './rounding';
import type { PrescribedSet, WendlerWeek } from './types';

/**
 * The canonical 5/3/1 main-set wave. The top set of each non-deload week is AMRAP.
 * Source: 5/3/1 Forever (Wendler, 2017), Part 2.
 */
export const WAVES: Record<WendlerWeek, { percent: number; reps: number; isAmrap?: boolean }[]> = {
  1: [
    { percent: 0.65, reps: 5 },
    { percent: 0.75, reps: 5 },
    { percent: 0.85, reps: 5, isAmrap: true },
  ],
  2: [
    { percent: 0.7, reps: 3 },
    { percent: 0.8, reps: 3 },
    { percent: 0.9, reps: 3, isAmrap: true },
  ],
  3: [
    { percent: 0.75, reps: 5 },
    { percent: 0.85, reps: 3 },
    { percent: 0.95, reps: 1, isAmrap: true },
  ],
  deload: [
    { percent: 0.4, reps: 5 },
    { percent: 0.5, reps: 5 },
    { percent: 0.6, reps: 5 },
  ],
};

export interface BuildMainSetsArgs {
  trainingMaxKg: number;
  week: WendlerWeek;
  /** Plate increment used to round each set (typically 2 × smallest plate weight, e.g. 2.5 kg). */
  roundingKg: number;
}

export function buildMainSets({
  trainingMaxKg,
  week,
  roundingKg,
}: BuildMainSetsArgs): PrescribedSet[] {
  return WAVES[week].map((s) => ({
    kind: s.isAmrap ? 'amrap' : 'main',
    percentOfTm: s.percent,
    weightKg: roundToIncrement(trainingMaxKg * s.percent, roundingKg),
    reps: s.reps,
    isAmrap: s.isAmrap,
  }));
}
