// Core domain types for the Wendler 5/3/1 app.

export type MainLift = 'squat' | 'bench' | 'deadlift' | 'press';

export type EquipmentType = 'barbell' | 'trap-bar' | 'dumbbell' | 'kettlebell' | 'sandbag' | 'bodyweight' | 'machine' | 'cable' | 'band' | 'weighted-vest' | 'dip-belt' | 'other';

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
  | 'adductors'
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
  /**
   * Multi-joint, free-weight-style movement that can carry a real Training Max.
   * Used to gate the per-slot movement picker so users can choose e.g. Front
   * Squat or Push Press for their main lifts but not Leg Extension or
   * Lateral Raise. Defaults to false on custom movements unless explicitly set.
   */
  isCompound?: boolean;
  /**
   * Compound bodyweight movement that can be loaded externally (weighted
   * vest, dip belt, dumbbell between feet, plate on back, KB goblet, etc.).
   * Surfaced in the assistance suggester so it can propose loaded variants
   * when the user has a loader in `availableEquipment`. Acts as a hard gate:
   * even when a vest/belt is available, the LLM only loads movements where
   * this is true. Defaults to false. Never set on prehab/recovery work,
   * mobility drills, plyometrics, or already-loaded movements (DB/KB/BB).
   */
  externallyLoadable?: boolean;
  techniqueCues?: string;
  videoUrl?: string;
}

export type WendlerWeek = 1 | 2 | 3 | 'deload' | '7w';

/**
 * Variants of the 7th Week Protocol from 5/3/1 Forever (Wendler, 2017).
 *  - tm-test: verify TM is correct prior to a new Leader. Top set: TM × 3–5.
 *  - deload : recover between a Leader pair and an Anchor. Top set: TM × 1.
 *  - pr-test: push a rep PR after a 5s-PRO heavy phase. Top set: TM × max reps.
 */
export type SeventhWeekKind = 'tm-test' | 'deload' | 'pr-test';

export interface PrescribedSet {
  /** "warmup" | "main" | "amrap" | "supplemental" | "assistance" */
  kind: 'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance';
  percentOfTm?: number; // 0..1, only for percentage-based sets
  weightKg: number; // resolved target weight
  reps: number; // target reps (minimum if amrap)
  isAmrap?: boolean;
  /**
   * Optional display override for the reps cell (e.g. "3–5", "PR").
   * When set, UI should render this string instead of the raw reps number.
   * Used by 7th-week protocol top sets where the target is a range or "max reps".
   */
  repsLabelOverride?: string;
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

/**
 * Kind of cardio planned for a given weekday in the recurring weekly
 * cardio template. Lives in domain (not db-schema) because the matching
 * algorithm in `cardioPlan.ts` needs to reference it without a circular
 * import.
 *
 * The vocabulary covers run + bike + swim + row + other modalities. Some
 * kinds are modality-flavoured (e.g. `long` reads as "long run" when
 * modality is `run` and "long ride" when modality is `bike`); the
 * matching + AI-reasoning logic combines `modality + kind` to produce
 * the right behaviour.
 */
export type CardioPlannedKind =
  | 'rest'
  | 'easy'
  | 'long'
  | 'quality'
  | 'recovery'
  | 'race-pace'
  | 'z2'
  | 'intervals'
  | 'cross';

/**
 * Back-compat alias. The old name is still re-exported so external
 * callers don't break during the rebrand; new code should use the
 * `CardioPlannedKind` name directly.
 *
 * @deprecated use CardioPlannedKind
 */
export type RunPlannedKind = CardioPlannedKind;

/** Cardio modality. Used both for logged sessions (CardioSession.modality) and planned slots (CardioPlanSlot.modality). */
export type CardioModality = 'run' | 'bike' | 'swim' | 'row' | 'walk' | 'padel' | 'other';

export interface CardioPlanSlot {
  /** ISO day-of-week: 0 = Monday … 6 = Sunday (European convention). */
  dayOfWeek: number;
  /**
   * Modality. Defaults to `'run'` on rows migrated from the legacy
   * RunPlan; new slots set it explicitly via the cardio-plan editor.
   * AI prompts + the `findNextCardio` helper key on this field to pick
   * icons + run-specific reasoning (e.g. pre-long-run lower-body veto
   * fires only when modality === 'run' && kind === 'long').
   */
  modality: CardioModality;
  kind: CardioPlannedKind;
  /** Optional planned duration in minutes. UI only. */
  durationMin?: number;
  /** Free-text note shown to the user (e.g. "60 min indoor trainer"). */
  notes?: string;
  /**
   * Optional block this slot is tied to. When set, the slot is
   * automatically removed from the cardio plan when the linked block
   * transitions to `completedAt`. Used by the AI's
   * `add_cardio_plan_slot` op when it pairs a cardio replacement with
   * `skip_day_in_week` — the bike ride scheduled to replace a strength
   * day during taper goes away on its own once the taper block ends,
   * so the user doesn't have to remember to clean it up.
   */
  linkedBlockId?: string;
  /**
   * Inclusive lower bound on calendar dates where the slot renders.
   * ISO date (YYYY-MM-DD). When set, the slot only shows on /calendar
   * for dates >= this. Combined with `effectiveUntil` to express
   * 'recurring weekly slot, but only during Wk 2 / Wk 3 / Deload of
   * the active block'. Optional — when unset the slot is always
   * effective (legacy behaviour).
   */
  effectiveFrom?: string;
  /**
   * Inclusive upper bound on calendar dates where the slot renders.
   * ISO date (YYYY-MM-DD). Pairs with `effectiveFrom`.
   */
  effectiveUntil?: string;
}

/**
 * Back-compat alias for the legacy slot shape. New code should use
 * `CardioPlanSlot` directly; this exists so module-resolution + existing
 * callers don't fan out during the rebrand.
 *
 * @deprecated use CardioPlanSlot
 */
export type RunPlanSlot = CardioPlanSlot;

