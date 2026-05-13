/**
 * Four-axis training profile types. The shape lives here in
 * `@wendler/domain` because it's a shared type between the domain
 * (which derives `GoalFlags` from it) and `@wendler/db-schema` (which
 * persists it on UserSettings). db-schema re-exports these.
 *
 * See `training-profile.ts` for the derivation/migration logic.
 *
 * Note: this type is named `TrainingPhase` (not `BlockPhase`) to avoid
 * a collision with `return-plan.ts`'s pre-existing `BlockPhase` (a 5/3/1
 * block-strategy enum: standard / deload / seventh-week / meet-prep).
 * The two concepts overlap on "deload" but are otherwise distinct —
 * one describes block structure, the other describes training intent.
 */

/** Temporal training-phase modifier. Phase intent overrides secondary-goal emphasis. */
export type TrainingPhase = 'normal' | 'deload' | 'taper' | 'peak';

/** Primary goal (top-level direction). Exactly one is active per training profile. */
export type PrimaryGoal =
  | 'marathon-prep'
  | 'strength'
  | 'hypertrophy'
  | 'balanced-development';

/** Secondary goal (complementary bias). At most {@link MAX_SECONDARY_GOALS} simultaneously. */
export type SecondaryGoal =
  | 'real-life-strength'
  | 'functional-movement'
  | 'isolation-emphasis';

/**
 * Filter entry (formerly "Tier 3 constraint"). Filters are user-authored free-text labels
 * — there is no built-in vocabulary. The user controls every suggestion
 * that appears in the prompt by adding, activating, deactivating, or
 * removing entries via the constraints UI.
 *
 * The `kind` field is retained as the literal `'custom'` so that
 * persisted records stay schema-compatible with earlier versions.
 *
 * `active` defaults to `true` when missing (back-compat with stored
 * profiles from before the toggle existed). Only active constraints are
 * serialized into the assistance prompt.
 */
export interface Constraint {
  id: string;
  kind: 'custom';
  label: string;
  createdAt: string;
  active?: boolean;
}

/** Hard cap on secondary-goal selections. Enforced both in UI and at write time. */
export const MAX_SECONDARY_GOALS = 2;

/** The full four-axis training profile. */
export interface TrainingProfile {
  trainingPhase: TrainingPhase;
  /** True if the user manually overrode the auto-derived trainingPhase. */
  trainingPhaseManual?: boolean;
  primaryGoal: PrimaryGoal;
  /** Length 0–{@link MAX_SECONDARY_GOALS}; enforce on write. */
  secondaryGoals: SecondaryGoal[];
  constraints: Constraint[];
  /**
   * Set by the migration when the legacy `goalFlags` couldn't be mapped
   * to a confident primary. UI surfaces a one-time "set your primary
   * goal" prompt while this is true.
   */
  primaryGoalAmbiguous?: boolean;
  updatedAt: string;
}

export const DEFAULT_TRAINING_PROFILE: TrainingProfile = {
  trainingPhase: 'normal',
  primaryGoal: 'balanced-development',
  secondaryGoals: [],
  constraints: [],
  updatedAt: new Date(0).toISOString(),
};
