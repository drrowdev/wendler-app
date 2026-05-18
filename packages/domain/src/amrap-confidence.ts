// amrap-confidence — pure scoring for "should we propose a TM bump?" Used by
// the AMRAP trigger to gate the per-set chat proposal so it only fires when
// multiple independent signals agree the training max is genuinely under-set.
//
// Replaces the previous "if reps − target ≥ 5, fire" rule which over-fired
// on essentially every Wk1 for any conservatively-set TM. See the v473
// CHANGELOG entry for the design rationale.

import { epley1RM } from './e1rm';

/**
 * 5/3/1 AMRAP targets per regular wave week.
 *   Wk1 = 5+ (5s wave)
 *   Wk2 = 3+ (3s wave)
 *   Wk3 = 1+ (5/3/1 wave)
 * Deload / 7th-week weeks must be filtered out by the caller — they're not
 * AMRAP weeks and don't belong here.
 */
export const AMRAP_TARGET_REPS: Record<1 | 2 | 3, number> = {
  1: 5,
  2: 3,
  3: 1,
};

/** Days. */
const DAY = 86_400_000;

/**
 * Prior AMRAP-smash signal — every entry is a main-lift AMRAP for the SAME
 * movement, within ~6 weeks of the current set, that beat its week's target
 * by ≥3 reps. Caller populates this from the user's set history.
 */
export interface PriorAmrapSmash {
  performedAt: string;
  /** Reps logged minus the week target on that set. Always ≥ 3 to qualify. */
  repsOverTarget: number;
}

export interface AmrapConfidenceInput {
  /** ISO timestamp of the AMRAP set under evaluation. */
  setPerformedAt: string;
  /** 1 | 2 | 3 — caller pre-filters deload / 7w. */
  week: 1 | 2 | 3;
  /** Reps the user logged on this AMRAP set. */
  reps: number;
  /** Weight on the AMRAP set, in kg. */
  weightKg: number;
  /** The training max in effect when this set was logged, kg. */
  trainingMaxKg: number;
  /**
   * ISO timestamp of the most recent TM record for THIS lift (any direction).
   * Used for both the 4-week cooldown gate AND the "≥1 full cycle since
   * last change" soft signal. Omit when this is the user's first TM for
   * the lift (no cooldown applies).
   */
  lastTmChangeAt?: string;
  /**
   * Has the AI fired a TM-bump proposal for this movement within the last
   * 4 weeks (accepted or not)? Hard gate when true.
   */
  recentTmBumpProposal?: boolean;
  /**
   * True iff at least one active (non-resolved) injury has an accepted
   * adjustment targeting this movement. Hard gate when true — caller
   * cross-references injury.adjustments[].movementId.
   */
  injuryBlocksMovement?: boolean;
  /**
   * Days until the next A-priority race (positive integer, undefined when
   * no upcoming A-race). Hard gate when ≤ 21 (3 weeks).
   */
  daysToNextARace?: number;
  /**
   * TSB (training stress balance, CTL − ATL) as of `setPerformedAt`. Highly
   * negative = significant fatigue. Reduces confidence by 1 when ≤ −30.
   * Undefined → skipped.
   */
  tsb?: number;
  /**
   * Prior AMRAP-smashes for this movement in the ~6-week window leading up
   * to (but not including) the current set. Caller filters and computes
   * repsOverTarget. Each entry contributes +1, capped at +2.
   */
  priorSmashes?: PriorAmrapSmash[];
}

export type HardGate = 'cooldown' | 'injury' | 'a-race' | 'reps-non-positive';

export interface AmrapConfidenceResult {
  /** Final fire decision. True iff all hard gates pass AND score ≥ 3. */
  fire: boolean;
  /** Soft-signal total. */
  score: number;
  /** Threshold used (currently 3). */
  threshold: number;
  /** First failing hard gate, when fire=false because of a gate. */
  blockedBy?: HardGate;
  /**
   * Human-readable per-signal lines (the WHY). Caller may surface these
   * verbatim in the notification body / coach prompt.
   */
  reasons: string[];
  /** Caller-friendly diagnostics. */
  details: {
    repsOverTarget: number;
    estimatedOneRmKg: number;
    /** What the TM would need to be at 85% of e1RM to "match" the AMRAP. */
    impliedTmKg: number;
    /** e1rm-vs-(tm/0.85) gap as a fraction (0.07 = 7%). */
    e1rmGapPct: number;
    /** Days since lastTmChangeAt, or undefined. */
    daysSinceLastTmChange?: number;
  };
}

/** Single point of truth for the soft-signal threshold. Tuned conservatively
 * so a one-off Wk1 PR does not fire, but a clear Wk3-crush + e1RM gap does. */
export const CONFIDENCE_THRESHOLD = 3;

/** Cooldown window in days for the same-movement TM-bump proposal. */
const COOLDOWN_DAYS = 28;

/** Hard-gate window for A-priority races. */
const A_RACE_GATE_DAYS = 21;

/**
 * Score the confidence that the user's training max for this AMRAP's lift
 * should be bumped. See module header for the design rationale.
 */
export function scoreAmrapConfidence(input: AmrapConfidenceInput): AmrapConfidenceResult {
  const target = AMRAP_TARGET_REPS[input.week];
  const repsOverTarget = input.reps - target;
  const e1rm = epley1RM(input.weightKg, input.reps);
  // Wendler convention: TM ≈ 85% of true 1RM. Implied TM is the TM that
  // would match THIS AMRAP if 85% were exact. Comparing the user's stored
  // TM against this gives the "how under-set is the TM" gap.
  const impliedTm = e1rm * 0.85;
  const e1rmGapPct = input.trainingMaxKg > 0
    ? (impliedTm - input.trainingMaxKg) / input.trainingMaxKg
    : 0;
  const setMs = new Date(input.setPerformedAt).getTime();
  const daysSinceLastTmChange = input.lastTmChangeAt
    ? Math.floor((setMs - new Date(input.lastTmChangeAt).getTime()) / DAY)
    : undefined;

  const details = {
    repsOverTarget,
    estimatedOneRmKg: e1rm,
    impliedTmKg: impliedTm,
    e1rmGapPct,
    ...(daysSinceLastTmChange !== undefined ? { daysSinceLastTmChange } : {}),
  };

  // -- Hard gates ----------------------------------------------------------
  if (input.reps <= 0) {
    return {
      fire: false, score: 0, threshold: CONFIDENCE_THRESHOLD,
      blockedBy: 'reps-non-positive', reasons: [], details,
    };
  }
  if (input.injuryBlocksMovement) {
    return {
      fire: false, score: 0, threshold: CONFIDENCE_THRESHOLD,
      blockedBy: 'injury', reasons: [
        'Skipped: an active injury has an accepted adjustment for this movement. Resolve / re-evaluate the injury before bumping.',
      ], details,
    };
  }
  if (typeof input.daysToNextARace === 'number' && input.daysToNextARace <= A_RACE_GATE_DAYS) {
    return {
      fire: false, score: 0, threshold: CONFIDENCE_THRESHOLD,
      blockedBy: 'a-race', reasons: [
        `Skipped: A-priority race in ${input.daysToNextARace} days. Hold the TM through taper and revisit post-race.`,
      ], details,
    };
  }
  if (
    input.recentTmBumpProposal ||
    (daysSinceLastTmChange !== undefined && daysSinceLastTmChange < COOLDOWN_DAYS)
  ) {
    return {
      fire: false, score: 0, threshold: CONFIDENCE_THRESHOLD,
      blockedBy: 'cooldown', reasons: [
        `Skipped: TM for this lift changed within the last ${COOLDOWN_DAYS} days. One cycle minimum between bumps.`,
      ], details,
    };
  }

  // -- Soft signals --------------------------------------------------------
  let score = 0;
  const reasons: string[] = [];

  // Standard "AMRAP crushed" baseline.
  if (repsOverTarget >= 5) {
    score += 1;
    reasons.push(`AMRAP beat target by ${repsOverTarget} reps (+1).`);
  }

  // Wk3 Wendler-canonical signal: 1+ AMRAP crushed by ≥5 reps.
  if (input.week === 3 && repsOverTarget >= 5) {
    score += 2;
    reasons.push('Wk3 1+ AMRAP crushed by 5+ reps — the canonical Wendler "TM is light" signal (+2).');
  }

  // Big-outlier signal for the early weeks where small over-deliveries
  // are common. Beat by ≥7 in Wk1/Wk2 is much rarer and more meaningful.
  if ((input.week === 1 || input.week === 2) && repsOverTarget >= 7) {
    score += 2;
    reasons.push(`Wk${input.week} AMRAP beat target by ${repsOverTarget} reps — large outlier (+2).`);
  }

  // e1RM gap signal — the math says the TM is genuinely under-set.
  if (e1rmGapPct >= 0.07) {
    score += 2;
    reasons.push(
      `Estimated 1RM (${e1rm.toFixed(1)} kg) implies TM ≈ ${impliedTm.toFixed(1)} kg, ${(e1rmGapPct * 100).toFixed(1)}% above current TM (+2).`,
    );
  }

  // Prior smashes signal — sustained pattern, not a one-off PR. +1 each, cap +2.
  const priors = input.priorSmashes ?? [];
  const priorPoints = Math.min(2, priors.length);
  if (priorPoints > 0) {
    score += priorPoints;
    reasons.push(
      `${priors.length} prior AMRAP-smash${priors.length === 1 ? '' : 'es'} on this lift in the last ~6 weeks (+${priorPoints}).`,
    );
  }

  // "Enough time has passed since last TM change for the signal to be trustworthy."
  if (daysSinceLastTmChange !== undefined && daysSinceLastTmChange >= 21) {
    score += 1;
    reasons.push(`At least one full cycle (${daysSinceLastTmChange} days) since last TM change for this lift (+1).`);
  } else if (daysSinceLastTmChange === undefined) {
    // No prior TM change recorded → treat as fully-cycled (e.g., first-ever cycle).
    score += 1;
    reasons.push('First cycle on this TM, or no prior TM change recorded (+1).');
  }

  // Fatigue penalty — high ATL relative to CTL means form may be drifting
  // or recent stress is masking the signal. Reduce confidence by 1.
  if (typeof input.tsb === 'number' && input.tsb <= -30) {
    score -= 1;
    reasons.push(`High recent fatigue (TSB ${input.tsb.toFixed(0)}) — discount the signal (−1).`);
  }

  return {
    fire: score >= CONFIDENCE_THRESHOLD,
    score,
    threshold: CONFIDENCE_THRESHOLD,
    reasons,
    details,
  };
}
