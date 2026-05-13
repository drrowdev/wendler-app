/**
 * Goal flags for assistance suggestion (v1).
 *
 * These flags are training-context modifiers that influence which assistance
 * movements get picked. Distinct from `Goal` in goals.ts (race times, strength
 * PRs) — those are user-facing, milestone-tracked records. Goal flags here
 * affect the suggester directly:
 *
 *  - rule-engine fallback consumes `evaluateGoalsForRules(flags)` to inject
 *    mandatory slots, demote certain patterns, and apply guardrails. This
 *    must work fully offline without LLM access.
 *  - LLM suggester consumes `goalsToPromptContext(flags, notes)` for natural-
 *    language reasoning, with the free-text `notes` field as escape valve.
 *
 * IMPORTANT: every flag in `GoalFlags` must independently affect the rule
 * engine. Anything that only matters to the LLM goes in `notes`, not as a
 * flag. That bar keeps the rule-engine fallback honest and testable.
 */

/**
 * v1 set of training-context flags. All booleans, default false. Each flag
 * must drive at least one rule-engine directive in `evaluateGoalsForRules`.
 */
export interface GoalFlags {
  /**
   * Marathon / endurance running prep. Mandates calf, hip-stability, and
   * hamstring assistance; vetoes heavy lower-body work the day before a
   * planned long run.
   */
  marathon: boolean;
  /**
   * "Real-life strength" — carry capacity, asymmetric loading, day-to-day
   * functional strength. Mandates a carry slot.
   */
  realLifeStrength: boolean;
  /**
   * Bias toward direct arm volume (curls, tricep work). Adds an extra
   * isolation slot and weights biceps/triceps higher in scoring.
   */
  bigArms: boolean;
  /**
   * Deload week / recovery focus. Reduces volume across all assistance,
   * drops AMRAP-style overload picks, prefers movement quality over load.
   */
  deload: boolean;
  /**
   * Peaking 2–3 weeks out from a competition or A-race. Fatigue-conservative:
   * bias toward proven/familiar picks, avoid novel or high-injury-risk
   * movements, reduce total volume.
   */
  competitionPeaking: boolean;
  /**
   * Athletic-movement focus (kept under the legacy `mobilityFocus` flag
   * name for back-compat). Bias toward single-leg, anti-rotation, and
   * low-amplitude jump/throw variants — does NOT touch carries (those
   * belong to {@link realLifeStrength}) and does NOT suppress bilateral
   * barbell volume (that fights the 5/3/1 main lifts).
   */
  mobilityFocus: boolean;
}

export const DEFAULT_GOAL_FLAGS: GoalFlags = {
  marathon: false,
  realLifeStrength: false,
  bigArms: false,
  deload: false,
  competitionPeaking: false,
  mobilityFocus: false,
};

export const GOAL_FLAG_KEYS = Object.keys(DEFAULT_GOAL_FLAGS) as ReadonlyArray<keyof GoalFlags>;

/** Free-text constraints/context. UI enforces this length. */
export const GOAL_NOTES_MAX_LENGTH = 500;

export interface UserGoalSettings {
  flags: GoalFlags;
  /** Free-text constraints — consumed by LLM only, not the rule engine. */
  notes: string;
  /** ISO timestamp of last edit. */
  updatedAt: string;
}

export const DEFAULT_USER_GOAL_SETTINGS: UserGoalSettings = {
  flags: DEFAULT_GOAL_FLAGS,
  notes: '',
  updatedAt: new Date(0).toISOString(),
};

/**
 * Slot-vocabulary the rule engine uses (mirrors the `Slot` type in
 * assistance-suggest.ts but kept independent here so this module has no
 * dependency on the suggester).
 */
export type RuleSlot = 'push' | 'pull' | 'single-leg' | 'core' | 'prehab' | 'isolation' | 'carry';

/** Muscle groups that flags can demote in scoring. Matches MuscleGroup in types.ts. */
export type RuleMuscleGroup =
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'calves'
  | 'chest'
  | 'back'
  | 'lats'
  | 'traps'
  | 'shoulders'
  | 'biceps'
  | 'triceps'
  | 'forearms'
  | 'core'
  | 'obliques'
  | 'erectors';

/**
 * Structured directives the rule engine consumes. Returned by
 * `evaluateGoalsForRules`. The rule engine merges these with its existing
 * slot-pick logic; nothing here is consumed by the LLM path.
 */
export interface RuleDirectives {
  /**
   * Slots that MUST be picked at least once across the week's assistance.
   * Rule engine ensures each appears in at least one day; if all days are
   * full, the lowest-priority existing slot is replaced.
   */
  mandatorySlots: RuleSlot[];
  /**
   * Movement-name keywords that flag a slot as "hip-stability prehab" so
   * the prehab slot picker can find them. Existing prehab regex in
   * inferSlot only matches face-pull/band-pull-apart; marathon goal needs
   * clamshell, hip abduction, lateral band walk, glute bridge to be
   * findable as prehab.
   */
  prehabKeywords: string[];
  /**
   * Reduce target sets/reps across all assistance by this multiplier
   * (1.0 = no change, 0.7 = 30% reduction). Applied after slot picks.
   */
  volumeMultiplier: number;
  /**
   * Drop AMRAP / max-rep style top-set overload on assistance picks.
   */
  dropAmrapOverload: boolean;
  /**
   * Prefer movements seen in recent blocks over novel ones (fatigue-
   * conservative competition peaking).
   */
  preferProven: boolean;
  /**
   * Add to the per-slot scoring bias for these muscle groups (positive =
   * up-weight, negative = demote).
   */
  muscleScoreDelta: Partial<Record<RuleMuscleGroup, number>>;
  /**
   * Add to the per-slot scoring bias for these slots.
   */
  slotScoreDelta: Partial<Record<RuleSlot, number>>;
}

const EMPTY_DIRECTIVES: RuleDirectives = {
  mandatorySlots: [],
  prehabKeywords: [],
  volumeMultiplier: 1,
  dropAmrapOverload: false,
  preferProven: false,
  muscleScoreDelta: {},
  slotScoreDelta: {},
};

export interface EvaluateGoalsForRulesOptions {
  /**
   * When true, skip the phase-driven volume multiplier (`deload × 0.6`,
   * `competitionPeaking × 0.75`) but keep every other side-effect of
   * those flags (dropAmrapOverload, preferProven, slot biases).
   *
   * Used by the suggester to avoid double-cutting volume when the
   * phase was auto-derived: the assistance-volume preset auto-shift
   * (e.g. `standard → minimal` in deload/taper) already reduces the
   * rep budget, and stacking the multiplier on top compounds the cut
   * more aggressively than intended.
   */
  suppressPhaseVolumeMultiplier?: boolean;
  /**
   * Effective training phase. When supplied, refines flag side effects:
   *  - `competitionPeaking` is set for both peak and taper, but
   *    `preferProven` (bias toward familiar/proven picks) only really
   *    applies in **taper** — the ≤14d window where introducing novel
   *    movements is genuinely risky. In **peak** (15–28d for A,
   *    15–21d for B) the lifter is still training; Wendler explicitly
   *    endorses varying assistance ("I don't see any problem in
   *    changing the exercises from workout to workout" — 5/3/1
   *    Forever, p.86). With `phase === 'peak'`, `preferProven` is
   *    suppressed; `dropAmrapOverload` and the volume multiplier
   *    still fire.
   *  - Without `phase`, the legacy combined behavior is preserved for
   *    back-compat.
   */
  phase?: 'normal' | 'deload' | 'taper' | 'peak';
}

/**
 * Translate flags to deterministic rule-engine directives. Pure function:
 * same input → same output. The rule-engine fallback path calls this and
 * merges results with its existing logic.
 *
 * Multiple flags compose additively. Volume multipliers multiply; mandatory
 * slots union; score deltas sum. If no flag is set, returns EMPTY_DIRECTIVES.
 */
export function evaluateGoalsForRules(
  flags: GoalFlags,
  opts: EvaluateGoalsForRulesOptions = {},
): RuleDirectives {
  const result: RuleDirectives = {
    mandatorySlots: [],
    prehabKeywords: [],
    volumeMultiplier: 1,
    dropAmrapOverload: false,
    preferProven: false,
    muscleScoreDelta: {},
    slotScoreDelta: {},
  };

  const addSlot = (slot: RuleSlot) => {
    if (!result.mandatorySlots.includes(slot)) result.mandatorySlots.push(slot);
  };
  const bumpMuscle = (m: RuleMuscleGroup, delta: number) => {
    result.muscleScoreDelta[m] = (result.muscleScoreDelta[m] ?? 0) + delta;
  };
  const bumpSlot = (s: RuleSlot, delta: number) => {
    result.slotScoreDelta[s] = (result.slotScoreDelta[s] ?? 0) + delta;
  };
  const addKeywords = (...kws: string[]) => {
    for (const kw of kws) if (!result.prehabKeywords.includes(kw)) result.prehabKeywords.push(kw);
  };

  if (flags.marathon) {
    // Mandate hip-stability prehab + posterior chain + carries (calves live
    // in the isolation slot via name keyword 'calf' but we still demand the
    // prehab slot get filled with hip-stability work).
    addSlot('prehab');
    addSlot('isolation'); // calf raise / hamstring isolation lives here
    addSlot('carry'); // sled drag / suitcase carry
    addKeywords('clamshell', 'hip abduction', 'lateral band walk', 'glute bridge', 'band walk');
    bumpMuscle('calves', 3);
    bumpMuscle('glutes', 2);
    bumpMuscle('hamstrings', 2);
    bumpMuscle('quads', -1); // less direct quad work, marathon legs already taxed
  }

  if (flags.realLifeStrength) {
    addSlot('carry');
    bumpSlot('carry', 3);
  }

  if (flags.bigArms) {
    addSlot('isolation');
    bumpMuscle('biceps', 2);
    bumpMuscle('triceps', 2);
  }

  if (flags.deload) {
    if (!opts.suppressPhaseVolumeMultiplier) result.volumeMultiplier *= 0.6;
    result.dropAmrapOverload = true;
    bumpSlot('prehab', 2);
    bumpSlot('core', 1);
    bumpSlot('isolation', -1); // less direct hypertrophy on a deload
  }

  if (flags.competitionPeaking) {
    if (!opts.suppressPhaseVolumeMultiplier) result.volumeMultiplier *= 0.75;
    // preferProven is meaningful in TAPER (≤14d, don't introduce risk
    // before the race) but oversold in PEAK (15–28d, still training,
    // Wendler endorses variation). When the caller passes phase, scope
    // preferProven to taper only. Without phase context, keep the
    // legacy combined behavior for back-compat.
    if (opts.phase === undefined || opts.phase === 'taper') {
      result.preferProven = true;
    }
    result.dropAmrapOverload = true;
  }

  if (flags.mobilityFocus) {
    addSlot('single-leg');
    bumpSlot('single-leg', 2);
    bumpSlot('isolation', -1);
  }

  return result;
}

/**
 * Returns a constant reference equal to EMPTY_DIRECTIVES for callers that
 * want a no-op default. Exported so consumers can identity-compare.
 */
export function emptyRuleDirectives(): RuleDirectives {
  return EMPTY_DIRECTIVES;
}

/**
 * Build the prompt context string the LLM consumer pastes into the user
 * message. Only this function should ever read `notes`. Format kept compact
 * (≤ 600 tokens) — cost-sensitive.
 *
 * The optional `phase` lets the caller distinguish `peak` (sharpening) from
 * `taper` (recovery) — both share `flags.competitionPeaking === true`, but
 * the operational guidance is quite different. Without `phase`, the
 * combined peak/taper line falls back to the previous wording for
 * back-compat with older callers.
 */
export function goalsToPromptContext(
  flags: GoalFlags,
  notes: string,
  phase?: 'normal' | 'deload' | 'taper' | 'peak',
): string {
  const active: string[] = [];
  if (flags.marathon) {
    active.push(
      '- marathon prep (app-specific extension — NOT a 5/3/1 Forever template): the user is running a long-distance race plan in parallel with their lifting. Protect long-run quality (no heavy lower body OR systemic conditioning the day before a long run); **MUST include at least one calf raise variant somewhere in the block** (the isolation slot mandate is not satisfied by curls or lateral raises — calves specifically); also mandatory hip-stability prehab (clamshell / band walk / hip abduction) and hamstring work; balance pressing with horizontal pulling (face pulls / band pull-aparts). These accessory choices are this app\'s interpretation of Wendler\'s general advice for endurance athletes — they are not from a specific Forever template.',
    );
  }
  if (flags.realLifeStrength) {
    active.push('- real-life strength: include at least one loaded carry per week');
  }
  if (flags.bigArms) {
    active.push(
      '- direct arm work: **MUST include both at least one bicep curl variant AND at least one direct tricep isolation movement** (push-down / skull crusher / kickback / overhead extension) somewhere in the block. Compound pulling (chin-ups, rows) and pressing (dips, close-grip bench) do NOT satisfy this — direct isolation is required.',
    );
  }
  if (flags.deload) {
    active.push(
      '- deload phase: drop AMRAP/max-rep overload; prefer movement quality over load; bias toward prehab/core slots. Do NOT additionally cut volume in your picks — the per-day rep budget shown above is already phase-adjusted upstream.',
    );
  }
  if (flags.competitionPeaking) {
    if (phase === 'taper') {
      active.push(
        '- taper phase (race ≤14 days out — recovery, not training): the budget shown above has already been cut to maintenance level upstream. Bias toward prehab, light isolation, and short low-load carries. Do NOT introduce novel movements — let recovery do the work. Drop AMRAP overload. Keep accessory sets short (2–3) and reps moderate (6–10); the goal is tissue maintenance and neuromuscular sharpness, not stimulus.',
      );
    } else if (phase === 'peak') {
      active.push(
        '- peak phase (race 15–28 days out for A-priority, 15–21 days out for B-priority — sharpening, still training): drop AMRAP overload to manage fatigue, but variation is fine — Wendler explicitly allows changing assistance exercises between workouts ("It is the work that matters" — 5/3/1 Forever, p.86). Volume is modestly reduced; do NOT additionally cut volume in your picks — the per-day rep budget shown above is already phase-adjusted upstream.',
      );
    } else {
      // No phase context — fall back to the combined wording for older
      // callers (preserves back-compat with tests that don't pass phase).
      active.push(
        '- competition peaking (race in 15–28 days for A-priority, 15–21 days for B-priority): fatigue-conservative; bias toward familiar/proven picks; avoid novel or high-injury-risk movements; drop AMRAP overload. Do NOT additionally cut volume in your picks — the per-day rep budget shown above is already phase-adjusted upstream.',
      );
    }
  }
  if (flags.mobilityFocus) {
    active.push(
      '- functional movement: include at least one single-leg variant (split squat, lunge, step-up, single-leg RDL) and one anti-rotation movement (Pallof press, suitcase carry hold, bird-dog, dead-bug) across the week. Optional low-amplitude jump or med-ball throw variant when load budget allows. Do NOT use this as a reason to reduce bilateral barbell volume — accessories only.',
    );
  }

  const parts: string[] = [];
  if (active.length > 0) {
    parts.push('Training context flags currently active:\n' + active.join('\n'));
  } else {
    parts.push('No specific training context flags set.');
  }
  const trimmedNotes = notes.trim();
  if (trimmedNotes.length > 0) {
    const safe = trimmedNotes.slice(0, GOAL_NOTES_MAX_LENGTH);
    parts.push(`User-supplied free-text notes (treat as authoritative):\n${safe}`);
  }
  return parts.join('\n\n');
}

/**
 * True iff the given settings are the default (all flags false, empty notes).
 * Used by callers to decide whether to send goal context at all.
 */
export function goalsAreEmpty(settings: UserGoalSettings): boolean {
  if (settings.notes.trim().length > 0) return false;
  return GOAL_FLAG_KEYS.every((k) => settings.flags[k] === false);
}

// ---------------------------------------------------------------------------
// (Phase × secondary-goal directives and Filter serialization were split
// out into `profile-directives.ts` in v279 — they depend on the four-axis
// TrainingProfile model and don't belong with the legacy GoalFlags axis.
// Re-exports preserved below for back-compat with existing call sites.)
// ---------------------------------------------------------------------------

export {
  PHASE_DIRECTIVE_FUNCTIONAL_MOVEMENT_LIGHT,
  phaseDirectiveString,
  constraintsToPromptContext,
} from './profile-directives';
