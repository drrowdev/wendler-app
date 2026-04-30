import type {
  EquipmentType,
  MainLift,
  Movement,
  MovementPattern,
  MuscleGroup,
} from '@wendler/domain';

export type {
  EquipmentType,
  MainLift,
  Movement,
  MovementPattern,
  MuscleGroup,
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
  rpe?: number;
  /** "warmup" | "main" | "amrap" | "supplemental" | "assistance" | "joker" */
  kind: 'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance' | 'joker';
  isAmrap?: boolean;
  /** When this set is part of a planned 5/3/1 wave. */
  percentOfTm?: number;
  trainingMaxKgAtTime?: number;
  /** Free-text note attached to this specific set. */
  note?: string;
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
  notes?: string;
  completedAt?: string;
}
