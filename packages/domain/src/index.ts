export const VERSION = '1.1.0';

export * from './types';
export * from './rounding';
export * from './training-max';
export * from './waves';
export * from './warmup';
export * from './plate-calculator';
export * from './e1rm';
export * from './pr-detection';
export * from './supplemental';
export * from './blocks';
export * from './seventh-week';
export * from './upcoming';
export * from './analytics';
export * from './load';
export * from './taper';
export * from './pace';
export * from './rpe-zones';
export * from './runPlan';
export * from './cardio-analytics';
export * from './cardio-muscle-load';
export * from './strength-hr-match';
export * from './goals';
export * from './goal-flags';
export * from './training-profile-types';
export {
  // training-profile re-exports — explicit list to avoid type-name collisions
  // with other modules (e.g. taper's `BlockPhase` enum, if any).
  compatibilityWarnings,
  type CompatibilityWarning,
  type CompatLevel,
  type SecondaryEffect,
  secondaryEffect,
  effectiveSecondaryGoals,
  phaseDirective,
  effectiveTrainingPhase,
  effectiveTrainingPhaseInfo,
  type EffectivePhaseInfo,
  type PhaseSource,
  type ActivePhaseBlockLike,
  deriveGoalFlags,
  type DerivedGoalFlagsResult,
  toggleSecondaryGoal,
  migrateLegacyToTrainingProfile,
  normalizeTrainingProfile,
  type LegacyGoalLike,
  type MigrateInput,
  type MigrateResult,
  customConstraint,
} from './training-profile';
export * from './races';
export * from './backup';
export * from './onboarding';
export * from './quickjump';
export * from './return-plan';
export * from './deload-scaling';
export * from './volume-recommend';
export * from './assistance-suggest';
export * from './assistance-prompt';
export * from './assistance-response';
export * from './assistance-ordering';
export * from './suggester-context';
export * from './validate-block';
export * from './equipment-presets';
