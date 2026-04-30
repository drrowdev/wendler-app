import { epley1RM } from './e1rm';
import type { LoggedSet } from './types';

export type PrKind = 'weight' | 'reps-at-weight' | 'e1rm';

export interface PrFlag {
  kind: PrKind;
  /** The new value achieved (kg for weight/e1rm, reps for reps-at-weight). */
  value: number;
  /** Previous best for context. */
  previous: number;
}

export interface MovementHistory {
  /** All previously logged sets for this movement, oldest first. */
  sets: LoggedSet[];
}

/**
 * Detect any PRs created by the new set against the prior history.
 * Returns an empty array if no PRs were broken.
 */
export function detectPrs(newSet: LoggedSet, history: MovementHistory): PrFlag[] {
  const prs: PrFlag[] = [];
  const prior = history.sets;

  // Weight PR: heaviest weight ever lifted (any reps).
  const maxPriorWeight = prior.reduce((m, s) => Math.max(m, s.weightKg), 0);
  if (newSet.weightKg > maxPriorWeight && newSet.reps > 0) {
    prs.push({ kind: 'weight', value: newSet.weightKg, previous: maxPriorWeight });
  }

  // Reps-at-weight PR: most reps ever at this exact weight.
  const maxRepsAtWeight = prior
    .filter((s) => s.weightKg === newSet.weightKg)
    .reduce((m, s) => Math.max(m, s.reps), 0);
  if (newSet.reps > maxRepsAtWeight) {
    prs.push({ kind: 'reps-at-weight', value: newSet.reps, previous: maxRepsAtWeight });
  }

  // e1RM PR: highest estimated 1RM from any set.
  const maxPriorE1rm = prior.reduce((m, s) => Math.max(m, epley1RM(s.weightKg, s.reps)), 0);
  const newE1rm = epley1RM(newSet.weightKg, newSet.reps);
  if (newE1rm > maxPriorE1rm && newSet.reps > 0) {
    prs.push({ kind: 'e1rm', value: newE1rm, previous: maxPriorE1rm });
  }

  return prs;
}
