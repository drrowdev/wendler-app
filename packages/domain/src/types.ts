// Core domain types for the Wendler 5/3/1 app.

export type MainLift = 'squat' | 'bench' | 'deadlift' | 'press';

export type EquipmentType = 'barbell' | 'dumbbell' | 'bodyweight' | 'machine' | 'cable' | 'other';

export type MovementPattern =
  | 'hinge'
  | 'squat'
  | 'push-horizontal'
  | 'push-vertical'
  | 'pull-horizontal'
  | 'pull-vertical'
  | 'carry'
  | 'core';

export type MuscleGroup =
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

export interface Movement {
  id: string;
  name: string;
  equipment: EquipmentType;
  pattern: MovementPattern;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  isMainLift?: MainLift; // identifies the four 5/3/1 lifts
  isCustom?: boolean;
  techniqueCues?: string;
  videoUrl?: string;
}

export type WendlerWeek = 1 | 2 | 3 | 'deload';

export interface PrescribedSet {
  /** "warmup" | "main" | "amrap" | "supplemental" | "assistance" | "joker" */
  kind: 'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance' | 'joker';
  percentOfTm?: number; // 0..1, only for percentage-based sets
  weightKg: number; // resolved target weight
  reps: number; // target reps (minimum if amrap)
  isAmrap?: boolean;
}

export interface LoggedSet {
  weightKg: number;
  reps: number;
  rpe?: number;
}

export interface PlateInventory {
  /** Pairs available per plate weight (e.g. {25: 2, 20: 2, 10: 4, 5: 4, 2.5: 4, 1.25: 2}) */
  pairsByWeight: Record<number, number>;
  barWeightKg: number;
}

export interface PlateBreakdown {
  totalWeightKg: number;
  perSide: { weightKg: number; count: number }[];
  achievable: boolean;
  remainderKg: number; // weight that couldn't be loaded
}

export interface WarmupConfig {
  /** Each entry is a percent (0..1) of the working weight. Defaults to [0.4, 0.6, 0.8]. */
  percents: number[];
  reps: number[]; // optional, defaults to [5, 5, 3]
}

export interface TrainingMaxConfig {
  /** Percent (0..1) of estimated 1RM used as the Training Max. Wendler default 0.85. */
  tmPercent: number;
  /** Smallest plate increment per side × 2, used to round target weights. */
  roundingKg: number;
}
