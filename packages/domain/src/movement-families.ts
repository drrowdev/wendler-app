/**
 * Movement family + skill predicates used by the assistance suggester and
 * validator to enforce cross-day rules (no two deadlift variants in one week,
 * no muscle-up at hypertrophy reps, etc.).
 *
 * Pure regex/name-based detection — matches the existing convention used in
 * `assistance-suggest.ts` (`isolation` keyword bucketing, `inferSlot`, etc.)
 * and works automatically for user-defined custom movements without requiring
 * any schema migration or per-movement re-tagging.
 *
 * Important taxonomy note: SINGLE-LEG IS ITS OWN FAMILY, deliberately not
 * folded into `deadlift`. A bilateral deadlift (heavy hip-hinge under load)
 * and a single-leg RDL (unilateral, balance-dependent, asymmetry corrector)
 * serve fundamentally different purposes — for marathon prep especially, both
 * are needed independently. Conflating them lets the suggester satisfy one
 * mandate by picking the other and skip the dedicated work entirely.
 */

export type MovementFamily =
  | 'deadlift'
  | 'squat'
  | 'muscle-up'
  | 'olympic'
  | 'single-leg';

const DEADLIFT_FAMILY =
  /\b(deadlift|sumo|trap[- ]?bar|romanian deadlift|\brdl\b|good[- ]?morning)\b/i;

// Single-leg variants must be excluded from the deadlift family — they live
// in their own bucket. This carve-out lives here so the SL-RDL match below
// in the single-leg family wins.
const SINGLE_LEG_RDL = /\b(single[- ]?leg|one[- ]?leg|sl)[- ]?rdl\b/i;

const SQUAT_FAMILY =
  /\b(back squat|front squat|zercher|safety[- ]?bar squat|hatfield|paused squat|tempo squat|box squat)\b/i;

const MUSCLEUP_FAMILY = /\bmuscle[- ]?up\b/i;

const OLYMPIC_FAMILY =
  /\b(snatch|power clean|hang clean|squat clean|clean and jerk|jerk|clean pull|snatch pull)\b/i;

const SINGLE_LEG_FAMILY =
  /\b(bulgarian split squat|\bbss\b|split squat|reverse lunge|walking lunge|lunge|step[- ]?up|pistol squat|shrimp squat|single[- ]?leg rdl|sl[- ]?rdl|one[- ]?leg rdl|single[- ]?leg romanian deadlift|one[- ]?leg romanian deadlift|single[- ]?leg glute bridge|single[- ]?leg hip thrust|skater squat|cossack squat)\b/i;

/**
 * Movements that demand elite gymnastics-level skill. Should never be
 * prescribed at hypertrophy reps (3-5 reps per set is the practical ceiling).
 * Independent from family — a pistol squat is both `single-leg` family and
 * `high-skill`.
 */
const HIGH_SKILL =
  /\b(muscle[- ]?up|pistol squat|shrimp squat|handstand push[- ]?up|\bhspu\b|one[- ]?arm push[- ]?up|one[- ]?arm pull[- ]?up|planche|front lever|back lever|human flag)\b/i;

/**
 * Calf-targeting movements (any variant). Used to enforce the marathon
 * mandate, since the mandatory `isolation` slot alone could be filled with
 * curls/lateral raises and miss calves entirely.
 */
const CALF_MOVEMENT = /\bcalf\b|gastroc|soleus|tibialis|toe raise/i;

/** Bicep isolation — direct biceps work, not pulling compounds. */
const BICEP_ISOLATION =
  /\b(curl|chin curl|preacher|hammer|spider|concentration)\b/i;

/** Tricep isolation — direct triceps work, not pressing compounds. */
const TRICEP_ISOLATION =
  /\b(tricep|skull[- ]?crusher|push[- ]?down|kick[- ]?back|french press|overhead extension|jm press|tate press)\b/i;

/** Rear-delt / shoulder-health prehab. */
const REAR_DELT_PREHAB =
  /\b(face[- ]?pull|band pull[- ]?apart|pull[- ]?apart|rear[- ]?delt|reverse fly|prone (y|t|w|i)|\bytw\b|external rotation|\bcuban press\b)\b/i;

/** Pressing movements (vertical or horizontal) — used for press-balance check. */
const PRESS_MOVEMENT =
  /\b(bench press|press|push[- ]?up|dip|incline press|decline press|landmine press|overhead press|push press|floor press|close[- ]?grip|cgbp|jm press|dumbbell press|landmine|shoulder press|military press)\b/i;

/** Devil press / metabolic conditioning hybrids that wreck CNS pre-long-run. */
const METABOLIC_CONDITIONING =
  /\b(devil press|burpee|thruster|kettlebell swing|kb swing|wall ball|man[- ]?maker|sled push|prowler|battle rope|assault bike|airdyne|farmer's run)\b/i;

/**
 * Bilateral hip-hinge variants whose ID/name belongs in the deadlift family.
 * Returns false for single-leg deadlifts (those go to single-leg family).
 */
export function movementFamily(name: string): MovementFamily | undefined {
  // Order matters: single-leg patterns are tested first so SL-RDL doesn't
  // get mis-bucketed as deadlift.
  if (SINGLE_LEG_RDL.test(name)) return 'single-leg';
  if (SINGLE_LEG_FAMILY.test(name)) return 'single-leg';
  if (MUSCLEUP_FAMILY.test(name)) return 'muscle-up';
  if (OLYMPIC_FAMILY.test(name)) return 'olympic';
  if (SQUAT_FAMILY.test(name)) return 'squat';
  if (DEADLIFT_FAMILY.test(name)) return 'deadlift';
  return undefined;
}

export function isHighSkill(name: string): boolean {
  return HIGH_SKILL.test(name);
}

export function isCalfMovement(name: string): boolean {
  return CALF_MOVEMENT.test(name);
}

export function isBicepIsolation(name: string): boolean {
  return BICEP_ISOLATION.test(name);
}

export function isTricepIsolation(name: string): boolean {
  return TRICEP_ISOLATION.test(name);
}

export function isRearDeltPrehab(name: string): boolean {
  return REAR_DELT_PREHAB.test(name);
}

export function isPressMovement(name: string): boolean {
  return PRESS_MOVEMENT.test(name);
}

export function isMetabolicConditioning(name: string): boolean {
  return METABOLIC_CONDITIONING.test(name);
}

/**
 * Heavy/high-rep posterior-chain hinge that meaningfully fatigues the lower
 * back & hamstrings — the kind of work to keep off pre-long-run days. This
 * is broader than `movementFamily(name) === 'deadlift'`: it also covers
 * single-leg RDLs *only when prescribed at high reps*. Callers pass the rep
 * count so light prehab-style SL-RDL (3×6) doesn't trigger the veto but a
 * 3×12-15 SL-RDL does.
 */
export function isFatiguingPosteriorChain(name: string, repsTop: number): boolean {
  const fam = movementFamily(name);
  if (fam === 'deadlift') return true;
  if (SINGLE_LEG_RDL.test(name) && repsTop >= 10) return true;
  // Romanian deadlift falls under deadlift family; covered above.
  return false;
}
