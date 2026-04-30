/**
 * Epley estimated 1RM formula: w * (1 + reps/30)
 * Standard, simple, used by Wendler-style apps. Reps capped at 12 for sanity (above that
 * the formula's accuracy degrades sharply).
 */
export function epley1RM(weightKg: number, reps: number): number {
  if (weightKg <= 0 || reps <= 0) return 0;
  const cappedReps = Math.min(reps, 12);
  return weightKg * (1 + cappedReps / 30);
}

/**
 * Wendler-style "training max from AMRAP" suggestion — use the AMRAP set to estimate a
 * new 1RM, then take 90% of that as the new TM. This is the conservative recommendation
 * from 5/3/1 Forever for adjusting TM after a strong rep PR.
 */
export function suggestNewTrainingMax(
  amrapWeightKg: number,
  amrapReps: number,
  tmPercent = 0.9,
): number {
  return epley1RM(amrapWeightKg, amrapReps) * tmPercent;
}
