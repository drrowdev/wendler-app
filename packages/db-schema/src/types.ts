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

/**
 * Cross-domain training: cardio / running / cycling / etc. Manually logged
 * or auto-imported from Strava.
 */
export interface CardioSession {
  id: string;
  performedAt: string;        // ISO
  modality: 'run' | 'bike' | 'swim' | 'row' | 'walk' | 'other';
  durationSec: number;
  distanceKm?: number;
  avgHrBpm?: number;
  maxHrBpm?: number;
  /** Total elevation gain in metres. */
  elevGainM?: number;
  /** RPE 1-10, subjective */
  rpe?: number;
  /** Strava's "perceived_exertion" (1-10) when set on the activity. */
  perceivedExertion?: number;
  /** Strava's HR-derived "suffer score" / relative effort. */
  sufferScore?: number;
  /**
   * Seconds spent in each Strava HR zone, indexed Z1..Z5 (length 5).
   * Computed from the heart-rate stream + athlete zone definitions.
   */
  hrZoneSeconds?: number[];
  /**
   * Best efforts for runs: distance (m) → time (s).
   * Common keys: 1000, 1609 (mile), 5000, 10000, 21097 (HM), 42195 (M).
   */
  bestEffortsSec?: Record<number, number>;
  /** Encoded polyline for the route (low-res from summary, hi-res from detailed). */
  polyline?: string;
  /** Original sport code from the source (e.g. 'TrailRun', 'VirtualRide'). */
  sport?: string;
  notes?: string;
  source?: 'manual' | 'strava' | 'gpx';
  /** External provider id, e.g. Strava activity id, used for de-dup. */
  externalId?: string;
  updatedAt: string;
}

/**
 * Daily recovery checkin. One row per date (YYYY-MM-DD).
 */
export interface RecoveryEntry {
  /** Date "YYYY-MM-DD" — used as primary key (one entry per day). */
  id: string;
  /** Sleep duration in hours (decimal, e.g. 7.5). */
  sleepHours?: number;
  /** Heart Rate Variability in ms (rMSSD or your wearable's value). */
  hrv?: number;
  /** Subjective fatigue 1 (fresh) – 10 (wrecked). */
  fatigue?: number;
  /** Overall soreness 1-10. */
  soreness?: number;
  /** Mood 1-10. */
  mood?: number;
  notes?: string;
  updatedAt: string;
}

/**
 * Long-running training goal with target and deadline.
 */
export interface Goal {
  id: string;
  kind: 'strength-pr' | 'race-time' | 'body-comp' | 'habit' | 'custom';
  title: string;
  /** Numeric target (kg / sec / kg / sessions / etc.). */
  target?: number;
  /** Unit label, displayed alongside. */
  targetUnit?: string;
  /** ISO date the goal should be achieved by. */
  deadline?: string;
  createdAt: string;
  completedAt?: string;
  notes?: string;
  updatedAt: string;
}

/**
 * A Web Push subscription stored locally so we can re-render UI state
 * (subscribed / not subscribed) and re-send to the server if needed.
 */
export interface PushSubscriptionRecord {
  id: 'pushSub';
  endpoint: string;
  /** Base64URL p256dh key. */
  p256dh: string;
  /** Base64URL auth key. */
  auth: string;
  createdAt: string;
}
