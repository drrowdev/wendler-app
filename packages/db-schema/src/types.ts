import type {
  EquipmentType,
  MainLift,
  Movement,
  MovementPattern,
  MuscleGroup,
  ProgramBlock,
  ProgramSchedule,
  SupplementalTemplateId,
} from '@wendler/domain';

export type {
  EquipmentType,
  MainLift,
  Movement,
  MovementPattern,
  MuscleGroup,
  ProgramBlock,
  ProgramSchedule,
  SupplementalTemplateId,
};

/**
 * A persisted user-configured Training Max for a given main lift, valid from a date.
 * Append-only: changing the TM creates a new row rather than mutating.
 */
export interface TrainingMaxRecord {
  id: string;
  lift: MainLift;
  trainingMaxKg: number;
  oneRmKg?: number;
  tmPercent: number;
  createdAt: string; // ISO
  source: 'manual' | 'amrap-suggestion';
  note?: string;
}

export interface UserSettings {
  /** Always 'singleton' — only one row exists. */
  id: 'singleton';
  barWeightKg: number;
  /** plates: pairs available per kg weight */
  pairsByWeight: Record<number, number>;
  roundingKg: number;
  warmupPercents: number[];
  warmupReps: number[];
  defaultTmPercent: number;
  units: 'kg';
  /** Rest timer defaults in seconds, per set kind. */
  restSecondsByKind?: Partial<
    Record<'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance' | 'joker', number>
  >;
  /** Auto-start rest timer when a set is logged. */
  autoStartRestTimer?: boolean;
  /** Joker set prompt threshold: prompt when AMRAP RPE <= this value. */
  jokerRpeThreshold?: number;
  updatedAt: string;
}

/**
 * A logged set, append-only. Edits to past sets create amendment rows referencing this id.
 */
export interface SetRecord {
  id: string;
  movementId: string;
  /** Optional grouping into a session. */
  sessionId?: string;
  /** ISO timestamp the set was performed. */
  performedAt: string;
  weightKg: number;
  reps: number;
  /** Rated Perceived Exertion 1-10 (Wendler / Tuchscherer scale). */
  rpe?: number;
  /** "warmup" | "main" | "amrap" | "supplemental" | "assistance" | "joker" */
  kind: 'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance' | 'joker';
  isAmrap?: boolean;
  /** When this set is part of a planned 5/3/1 wave. */
  percentOfTm?: number;
  trainingMaxKgAtTime?: number;
  /** Free-text note attached to this specific set. */
  note?: string;
  /** Was this set skipped vs. completed. */
  skipped?: boolean;
  /** Why a set was skipped or modified. */
  skipReason?: 'pain' | 'fatigue' | 'time' | 'equipment' | 'other';
  /** Pain/injury flag tagged to this set. Carries forward as a caution indicator. */
  painFlag?: {
    area: string;
    severity: 1 | 2 | 3 | 4 | 5;
    note?: string;
  };
  /** True if this row supersedes another set (amendment). */
  amendsSetId?: string;
  /** Soft-delete marker. */
  deletedAt?: string;
}

export interface SessionRecord {
  id: string;
  /** ISO date. */
  performedAt: string;
  /** Main lift being trained, if any (null for pure assistance days). */
  mainLift?: MainLift;
  /** 5/3/1 week if applicable. */
  week?: 1 | 2 | 3 | 'deload';
  /** Block this session belongs to (v0.2+). */
  blockId?: string;
  /** Day index within the rotation when this session was logged (0..3 typically). */
  dayIndex?: number;
  /** Supplemental template active for this session. */
  supplementalTemplateId?: SupplementalTemplateId;
  notes?: string;
  completedAt?: string;
}
