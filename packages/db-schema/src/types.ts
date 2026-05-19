import type {
  AssistanceEntry,
  Constraint,
  EquipmentType,
  GoalFlags,
  MainLift,
  Movement,
  MovementPattern,
  MuscleGroup,
  PrimaryGoal,
  Program,
  ProgramBlock,
  ProgramSchedule,
  CardioModality,
  CardioPlannedKind,
  CardioPlanSlot,
  RunPlannedKind,
  RunPlanSlot,
  SecondaryGoal,
  SupplementalTemplateId,
  TrainingPhase,
  TrainingProfile,
} from '@wendler/domain';

export type {
  AssistanceEntry,
  EquipmentType,
  GoalFlags,
  MainLift,
  Movement,
  MovementPattern,
  MuscleGroup,
  Program,
  ProgramBlock,
  ProgramSchedule,
  CardioModality,
  CardioPlannedKind,
  CardioPlanSlot,
  RunPlannedKind,
  RunPlanSlot,
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

/**
 * A movement inside a warm-up block. Free-form name + optional dose
 * (sets × reps, duration, "/side", etc.).
 */
export interface WarmupMovementDef {
  id: string;
  name: string;
  dose?: string;
}

/**
 * One block of the pre-lifting warm-up (e.g. General, Mobility, Activation).
 *
 * `appliesTo` lets a block be conditional on which main lifts are trained
 * on the day:
 * - `'always'` (default)              → always shown
 * - `string` (canonical lift-set key) → only on days whose main lifts match
 *   the key. Built via {@link liftSetKey} (lifts sorted alphabetically and
 *   joined with `+`, e.g. `"bench+deadlift"`).
 *
 * For backwards compatibility, the legacy values `'press'` and `'lower'`
 * are still recognised by {@link selectWarmupBlocks}:
 * - `'press'` → matches days that include bench or press
 * - `'lower'` → matches days that include squat or deadlift, or accessory
 *               days with no main lift
 *
 * Blocks render in array order; the editor in /settings persists the
 * intended order.
 */
export interface WarmupBlockDef {
  id: string;
  title: string;
  /**
   * Optional manual override for the displayed duration label (e.g. "~3 min").
   * When omitted, the renderer estimates one from the movements via
   * {@link estimateBlockDurationSec} / {@link displayDuration}.
   */
  durationOverride?: string;
  /** Optional one-line context shown next to the title. */
  note?: string;
  /** Conditional applicability based on the day's main lifts. */
  appliesTo?: 'always' | string;
  movements: WarmupMovementDef[];
}

/**
 * Hardcoded default warm-up protocol — historically baked into
 * `PreLiftingWarmup.tsx`. Used when `UserSettings.preLiftingWarmup` is
 * undefined and as the target of the "Reset to built-in defaults" button
 * in the editor. Kept here (in db-schema) so both the renderer and the
 * editor read the exact same source.
 *
 * All blocks default to `appliesTo: 'always'` — the legacy press/lower
 * activation split is preserved as `appliesTo: 'press' | 'lower'` only
 * when the user's persisted settings already contain those values
 * (handled by {@link selectWarmupBlocks}). New installs see one
 * Activation block that applies every day; the user can split it with
 * the day-combo dropdown if they want.
 */
export const DEFAULT_PRE_LIFTING_WARMUP_BLOCKS: WarmupBlockDef[] = [
  {
    id: 'general',
    title: 'General',
    note: 'Get core temp up, joints lubricated.',
    appliesTo: 'always',
    movements: [
      {
        id: 'gen-cardio',
        name: 'Easy cardio (rower, bike, jump rope, or brisk walk)',
        dose: '~3 min',
      },
    ],
  },
  {
    id: 'mobility',
    title: 'Mobility',
    appliesTo: 'always',
    movements: [
      { id: 'mob-ankle', name: 'Ankle rocks', dose: '2 × 10 / side' },
      { id: 'mob-hip', name: '90/90 hip switches', dose: '2 × 8 / side' },
      { id: 'mob-wgs', name: 'World’s greatest stretch', dose: '3 / side' },
      { id: 'mob-thoracic', name: 'Thoracic open-book or wall slides', dose: '2 × 8' },
    ],
  },
  {
    id: 'activation-upper',
    title: 'Activation (upper)',
    note: 'Press / bench prep.',
    appliesTo: 'always',
    movements: [
      { id: 'act-pull-aparts', name: 'Band pull-aparts', dose: '2 × 15' },
      { id: 'act-scap', name: 'Scap pushups', dose: '2 × 10' },
    ],
  },
  {
    id: 'activation-lower',
    title: 'Activation (lower)',
    note: 'Squat / deadlift prep.',
    appliesTo: 'always',
    movements: [
      { id: 'act-glute', name: 'Glute bridges', dose: '2 × 10' },
      { id: 'act-birddog', name: 'Bird-dog', dose: '2 × 8 / side' },
    ],
  },
];

const UPPER_LIFTS: ReadonlySet<MainLift> = new Set<MainLift>(['bench', 'press']);
const LOWER_LIFTS: ReadonlySet<MainLift> = new Set<MainLift>(['squat', 'deadlift']);

/**
 * Canonical key for a set of main lifts trained together on one day.
 * Lifts are sorted alphabetically and joined with `+` so order doesn't
 * matter. Empty input → `''` (used as the accessory-day key).
 *
 * @example
 *   liftSetKey(['squat', 'press']) === 'press+squat'
 *   liftSetKey(['bench'])           === 'bench'
 *   liftSetKey([])                  === ''
 */
export function liftSetKey(lifts: readonly MainLift[]): string {
  return [...lifts].sort().join('+');
}

const LIFT_DISPLAY: Record<MainLift, string> = {
  press: 'Press',
  bench: 'Bench',
  squat: 'Squat',
  deadlift: 'Deadlift',
};

/**
 * Human label for a set of main lifts trained together (e.g.
 * `['bench','deadlift'] → 'Bench + Deadlift'`). Empty input → `'Accessory'`.
 */
export function liftSetLabel(lifts: readonly MainLift[]): string {
  if (lifts.length === 0) return 'Accessory';
  return [...lifts]
    .sort()
    .map((l) => LIFT_DISPLAY[l])
    .join(' + ');
}

/**
 * Pick the warm-up blocks to render for a given day's main lifts.
 *
 * - `appliesTo === 'always'` (or unset) → always included
 * - `appliesTo === 'press'`  → legacy: matches if dayLifts contains bench/press
 * - `appliesTo === 'lower'`  → legacy: matches if dayLifts contains squat/deadlift,
 *                              or no main lifts (accessory day)
 * - Any other string         → matches when {@link liftSetKey}(dayLifts) === appliesTo
 */
export function selectWarmupBlocks(
  blocks: WarmupBlockDef[],
  dayLifts: readonly MainLift[],
): WarmupBlockDef[] {
  const key = liftSetKey(dayLifts);
  const hasUpper = dayLifts.some((l) => UPPER_LIFTS.has(l));
  const hasLower = dayLifts.some((l) => LOWER_LIFTS.has(l));
  return blocks.filter((b) => {
    const a = b.appliesTo ?? 'always';
    if (a === 'always') return true;
    if (a === 'press') return hasUpper;
    if (a === 'lower') return hasLower || dayLifts.length === 0;
    return a === key;
  });
}

const TIME_RX = /(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i;
const SETS_REPS_RX = /(\d+)\s*[x×*]\s*(\d+)/i;
const PER_SIDE_RX = /\/\s*side\b/i;

const REP_SECONDS = 4; // ~4 s per rep (mobility-paced)
const BETWEEN_SETS_SECONDS = 30; // brief reset between mobility/activation sets
const BETWEEN_MOVEMENTS_SECONDS = 15; // transition time
const FALLBACK_PER_MOVEMENT_SECONDS = 30;

/**
 * Estimate the time (in seconds) a warm-up block will take to complete,
 * based on its movements' dose strings. Heuristic — intended to give the
 * user a reasonable label, not be precise.
 *
 * Per movement:
 *  - If dose contains `N × M` → `N × (M × REP_SECONDS) + (N-1) × BETWEEN_SETS_SECONDS`.
 *    `/side` doubles the rep count.
 *  - Else if dose contains an explicit time (e.g. `~3 min`, `30 s`) → use it directly,
 *    doubled when `/side` is present.
 *  - Else `FALLBACK_PER_MOVEMENT_SECONDS`.
 *
 * Plus `(movements - 1) × BETWEEN_MOVEMENTS_SECONDS` for transitions.
 */
export function estimateBlockDurationSec(block: WarmupBlockDef): number {
  if (block.movements.length === 0) return 0;
  let total = 0;
  for (const mv of block.movements) {
    const dose = mv.dose ?? '';
    const sr = SETS_REPS_RX.exec(dose);
    if (sr) {
      const sets = Number(sr[1]);
      let reps = Number(sr[2]);
      if (PER_SIDE_RX.test(dose)) reps *= 2;
      const work = sets * reps * REP_SECONDS;
      const rest = Math.max(0, sets - 1) * BETWEEN_SETS_SECONDS;
      total += work + rest;
      continue;
    }
    const t = TIME_RX.exec(dose);
    if (t) {
      const n = Number(t[1]);
      const unit = (t[2] ?? '').toLowerCase();
      let secs = unit.startsWith('m') ? n * 60 : n;
      // "40 s / side" → both sides, so double the duration. Same for
      // "1 min / side". Sets×reps already handled above.
      if (PER_SIDE_RX.test(dose)) secs *= 2;
      total += secs;
      continue;
    }
    total += FALLBACK_PER_MOVEMENT_SECONDS;
  }
  total += Math.max(0, block.movements.length - 1) * BETWEEN_MOVEMENTS_SECONDS;
  return total;
}

/**
 * Format a duration in seconds as a short label like `"≈ 3 min"` or
 * `"≈ 45 s"`. Rounded to the nearest 15 s under a minute, nearest
 * half-minute under 5 min, nearest minute otherwise.
 */
export function formatDurationSec(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return '—';
  if (secs < 60) {
    const rounded = Math.max(15, Math.round(secs / 15) * 15);
    return `≈ ${rounded} s`;
  }
  if (secs < 5 * 60) {
    const halves = Math.max(1, Math.round(secs / 30));
    const mins = halves / 2;
    const label = Number.isInteger(mins) ? `${mins}` : mins.toFixed(1);
    return `≈ ${label} min`;
  }
  const mins = Math.max(1, Math.round(secs / 60));
  return `≈ ${mins} min`;
}

/**
 * Display label for a block's duration: returns the user's manual
 * override if set, otherwise the auto-estimate.
 */
export function displayDuration(block: WarmupBlockDef): string {
  if (block.durationOverride && block.durationOverride.trim() !== '') {
    return block.durationOverride;
  }
  return formatDurationSec(estimateBlockDurationSec(block));
}

export interface UserSettings {
  /** Always 'singleton' — only one row exists. */
  id: 'singleton';
  barWeightKg: number;
  /**
   * Bar weight (kg) used by the plate calculator when the lift is performed
   * on a trap bar (movement.equipment === 'trap-bar'). Trap bars are commonly
   * heavier than a standard 20 kg Olympic bar (often 25 kg or more), so a
   * separate value keeps the per-side plate math correct without forcing the
   * user to override `barWeightKg` for one movement.
   */
  trapBarWeightKg?: number;
  /**
   * When true, the app requests a Screen Wake Lock while a tab/PWA window
   * is visible so the screen doesn't blank between sets. Re-acquired
   * automatically on visibility changes.
   */
  keepScreenOn?: boolean;
  /**
   * When set, the plate calculator first attempts to load each working set
   * using only plates whose weight is at or below this cap. If a target
   * weight isn't achievable within the cap (e.g. needs a 25 kg plate), the
   * calculator silently falls back to the full inventory.
   *
   * Use case: 25 kg plates are rare in many gyms — users prefer realistic
   * loadouts using 20 kg or smaller. Defaults to undefined (no preference).
   */
  preferredMaxPlateKg?: number;
  /**
   * When true (default), Strava strength activities (WeightTraining,
   * Crossfit, Workout, HighIntensityIntervalTraining) are pulled in for
   * their HR signal only — not as cardio sessions. Their HR-zone time is
   * folded into the weekly load score so heavy lifting weeks register the
   * cardiovascular cost the lifter actually paid. Disable to ignore them.
   */
  strengthHrEnrichment?: boolean;
  /** plates: pairs available per kg weight */
  pairsByWeight: Record<number, number>;
  roundingKg: number;
  warmupPercents: number[];
  warmupReps: number[];
  defaultTmPercent: number;
  units: 'kg';
  /** Rest timer defaults in seconds, per set kind. */
  restSecondsByKind?: Partial<
    Record<'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance', number>
  >;
  /** Auto-start rest timer when a set is logged. */
  autoStartRestTimer?: boolean;
  /**
   * Show the pre-lifting warm-up reference card at the top of /day.
   * Defaults to true on new installs; users can hide it from /settings.
   */
  preLiftingWarmupEnabled?: boolean;
  /**
   * User-customised pre-lifting warm-up protocol. When undefined the app
   * falls back to {@link DEFAULT_PRE_LIFTING_WARMUP_BLOCKS}. Editing happens
   * on the /settings page.
   */
  preLiftingWarmup?: { blocks: WarmupBlockDef[] };
  /**
   * User-saved snapshot of "my default" warm-up. Populated by the
   * "Save current as my default" button in the warm-up editor. The
   * "Reset to my default" button restores from here (falling back to
   * {@link DEFAULT_PRE_LIFTING_WARMUP_BLOCKS} when undefined).
   */
  preLiftingWarmupUserDefault?: { blocks: WarmupBlockDef[] };
  /**
   * Per-slot mapping of which Movement ID is currently performed for each
   * 5/3/1 main lift slot. Lets users swap e.g. the deadlift slot to a Trap Bar
   * Deadlift movement without changing the slot identity (which the program
   * model relies on). Falls back to the seeded movement when unset.
   */
  mainLiftMovements?: Partial<Record<MainLift, string>>;
  /**
   * Training-context flags that influence the assistance suggester. See
   * `GoalFlags` in @wendler/domain for the v1 set (marathon, realLifeStrength,
   * bigArms, deload, competitionPeaking, mobilityFocus). Optional; absence is
   * treated as "all flags off".
   *
   * @deprecated As of the four-axis goals model (TrainingProfile), GoalFlags
   * is a derived shape computed from `trainingProfile` + races. New code
   * should write to `trainingProfile` and read derived flags via
   * `deriveGoalFlags()` in @wendler/domain. This field is kept as a
   * read-fallback for one release so a downgrade doesn't lose state.
   * Will be removed in the release after `trainingProfile` lands.
   */
  goalFlags?: GoalFlags;
  /**
   * Four-axis training profile (v1). Replaces the flat `goalFlags` singleton
   * with a structured model:
   *  - `blockPhase` (1 of normal/deload/taper/peak) — auto-managed by the
   *    race-driven taper pipeline; manual override available
   *  - `primaryGoal` (exactly 1 of marathon-prep/strength/hypertrophy/
   *    balanced-development) — mutually exclusive
   *  - `secondaryGoals` (≤2 of real-life-strength/functional-movement/
   *    isolation-emphasis/injury-prevention) — capped to enforce focus
   *  - `constraints` (unlimited string tags) — hard filters, never compete
   *    with goals for "slot budget"
   *
   * Derived `GoalFlags` for the suggester are produced by
   * `deriveGoalFlags(profile, races, now)` in @wendler/domain — call sites
   * that previously read `settings.goalFlags` should switch to that helper.
   */
  trainingProfile?: TrainingProfile;
  /**
   * Free-text constraints/context for the LLM-based assistance suggester
   * (e.g. "rehabbing left shoulder, avoid overhead above 90°"). Max
   * GOAL_NOTES_MAX_LENGTH (500) chars. Never consumed by the rule-engine
   * fallback — only the LLM path reads this.
   */
  goalNotes?: string;
  /**
   * Daily proactive-brief opt-in. When true, the app generates a
   * daily AI brief on first open of each calendar day — a "good
   * morning, here's today's plan" Coach summary delivered as a
   * notification. Defaults to true; users can turn it off if they
   * find the notifications noisy.
   */
  dailyBriefEnabled?: boolean;
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
  /** "warmup" | "main" | "amrap" | "supplemental" | "assistance" */
  kind: 'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance';
  isAmrap?: boolean;
  /** When this set is part of a planned 5/3/1 wave. */
  percentOfTm?: number;
  trainingMaxKgAtTime?: number;
  /** Free-text note attached to this specific set. */
  note?: string;
  /** Was this set skipped vs. completed. */
  skipped?: boolean;
  /**
   * Position within the prescribed-set list of the lift session this record
   * was logged for (0-based). Distinguishes otherwise-identical prescribed
   * slots — e.g. supplemental 5×5 FSL where every set has the same kind +
   * weight. Optional for backwards compat with rows persisted before this
   * field existed; readers fall back to occurrence-based matching.
   */
  slotIndex?: number;
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
  week?: 1 | 2 | 3 | 'deload' | '7w';
  /** Block this session belongs to (v0.2+). */
  blockId?: string;
  /** Day index within the rotation when this session was logged (0..3 typically). */
  dayIndex?: number;
  /** Supplemental template active for this session. */
  supplementalTemplateId?: SupplementalTemplateId;
  notes?: string;
  /** Set when the per-lift work (main + supplemental) for THIS session is fully logged. */
  completedAt?: string;
  /**
   * Set when the user explicitly marks the whole workout day complete (the
   * "Complete workout" button on /day). Stamped on every session row that
   * shares the same (blockId, week, dayIndex) so the Today page can show
   * the workout as completed regardless of which session is inspected.
   */
  workoutCompletedAt?: string;
  /**
   * Set when the user checks the pre-lifting warm-up box for this day.
   * Stored on the FIRST lift's session row of the day-group (same pattern
   * as assistance work) so it persists per workout, not per lift.
   */
  preWarmupCompletedAt?: string;
  /**
   * YYYY-MM-DD of the planned-slot date this workout-day fulfills.
   *  - Unset (default): the workout fulfills its projected weekday for
   *    (blockId, week, dayIndex) in its `week`. Calendar/adherence treat
   *    it as on-time.
   *  - Set: user explicitly linked this day-group to a different planned
   *    date (e.g. logged Mon's Press on Tue and pinned it to Mon).
   *    Stamped on EVERY session row in the day-group (same fan-out
   *    pattern as `workoutCompletedAt`). Calendar suppresses the
   *    matching planned-strength chip and renders an "↗ planned <date>"
   *    badge on the logged chip.
   */
  planScheduledDate?: string;
  /**
   * Snapshot of the assistance prescription for this day at the moment
   * the workout was marked complete (v282+). Once stamped, the day page
   * renders from this snapshot instead of resolving the live block plan,
   * so historical sessions stay stable across future block-plan edits
   * (new movements generated for Wk2 do NOT retroactively appear in
   * Wk1's completed session).
   *
   * Absent on sessions completed before v282; those fall back to the
   * live block plan as a best-effort, with the documented caveat that
   * later plan edits CAN change how the historical day renders.
   *
   * Only stamped once per day-group (on the lift session that runs
   * `completeDayWorkout`); other rows in the same group inherit by
   * sharing (blockId, week, dayIndex). Fanning out the array across
   * every row would multiply storage cost without benefit.
   */
  assistanceSnapshot?: AssistanceEntry[];

  /**
   * The value of `block.updatedAt` at the moment `assistanceSnapshot` was
   * captured. Lets the day-page reader detect cross-device staleness: if
   * the block's current `updatedAt` is newer than this stamp, the snapshot
   * was likely captured against a stale plan (e.g., chat AI edited the
   * prescription on another device after this device opened /day but
   * before it called completeDayWorkout). In that case the day-page
   * prefers the live plan when no assistance sets have been logged
   * against this session yet, so the user sees the correct prescription
   * instead of the stale snapshot.
   *
   * Absent on snapshots taken before v467; those continue to be treated
   * as authoritative for back-compat (no false invalidations on legacy
   * historical days).
   */
  assistanceSnapshotBlockUpdatedAt?: string;
}

/**
 * Cross-domain training: cardio / running / cycling / etc. Manually logged
 * or auto-imported from Strava.
 */
export interface CardioSession {
  id: string;
  performedAt: string;        // ISO
  modality: 'run' | 'bike' | 'swim' | 'row' | 'walk' | 'padel' | 'other';
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
  /**
   * Auto-matched run-plan kind when this activity lines up with a slot in the
   * weekly RunPlan template. Computed at import time from the activity's
   * day-of-week and (Strava) name. Null/undefined when no match is found.
   */
  plannedKind?: RunPlannedKind;
  /**
   * Confidence of the plan match:
   *  - 'exact'  — performed on the same day-of-week as a non-rest slot.
   *  - 'manual' — user re-tagged the activity from the cardio list (e.g.
   *               schedule was shuffled). Sticky: rematcher won't overwrite.
   *  - 'none'   — explicitly evaluated, no match found.
   */
  planMatch?: 'exact' | 'manual' | 'none';
  /**
   * YYYY-MM-DD of the planned-slot date this activity fulfills.
   *  - Auto-matched runs: same as performedAt's local date.
   *  - Manually linked runs: the planned date the user chose, which may
   *    differ from performedAt (e.g. long run shifted Sat → Sun).
   * Cleared when the user resets the tag to "auto / none". Used by the
   * calendar / week-strip to decide whether a planned date has been
   * fulfilled, regardless of the date the activity was actually performed.
   */
  planScheduledDate?: string;
  updatedAt: string;
}

/**
 * Heart-rate enrichment imported from Strava for a strength-training
 * activity (Garmin → Strava → us). The activity itself is NOT imported as
 * a CardioSession — instead we capture just the HR signal and attach it
 * to the matching in-app strength session at read time (matched by date).
 *
 * Rationale: the user's strength workouts are planned in-app, but the HR
 * monitor captures the true cardiovascular cost (heavy AMRAPs / BBB sit
 * mostly in Z3-Z4). Folding this into Load & Recovery analytics gives a
 * more accurate weekly stress score without inflating cardio volume or
 * polluting the polarized 80/10/10 distribution (cardio-only).
 *
 * Cloud-synced (LWW on `updatedAt`): the desktop runs the Strava import,
 * the mobile PWA pulls the rows on its next sync. Each device still
 * de-dupes locally on `externalId` when the same activity is re-imported
 * directly via Strava sync.
 */
export interface StrengthHrEnrichment {
  /** Local UUID. */
  id: string;
  /** `strava:${activityId}` — used for de-dup across syncs. */
  externalId: string;
  /** Activity start time (ISO) used to match a strength session by date. */
  performedAt: string;
  /** Activity moving time, seconds. */
  durationSec: number;
  avgHrBpm?: number;
  maxHrBpm?: number;
  /** Seconds spent in each HR zone (Z1..Z5). Undefined if HR stream missing. */
  hrZoneSeconds?: number[];
  /** Original Strava sport_type, e.g. 'WeightTraining'. */
  sport?: string;
  /** Activity name from Strava (often Garmin's autogenerated title). */
  notes?: string;
  source: 'strava';
  updatedAt: string;
}

/**
 * Persistent recurring weekly cardio template, stored as a singleton row
 * in the local `cardioPlan` table and synced to Cosmos via the LWW
 * pipeline. Slots are sparse; missing days of week mean "no plan / rest
 * day". Each slot carries a modality (run / bike / swim / row / other)
 * and a kind (easy / long / z2 / intervals / …); AI prompts + the
 * NextUpCard logic combine the two to render the right icon + reason
 * about training stress correctly.
 *
 * The `CardioPlannedKind` / `CardioPlanSlot` / `CardioModality` value
 * types live in `@wendler/domain` (re-exported above) so the matching
 * algorithm there can reference them without a circular import back to
 * db-schema. Legacy `RunPlannedKind` / `RunPlanSlot` aliases stay for
 * back-compat during the rebrand.
 */
export interface CardioPlan {
  id: 'singleton';
  /** Sparse list keyed by dayOfWeek; missing days = no plan / rest. */
  slots: CardioPlanSlot[];
  updatedAt: string;
}

/**
 * Back-compat alias for the previous name. The persisted table is now
 * `cardioPlan`; the old `runPlan` table is migrated forward by the Dexie
 * upgrade fn in apps/web/src/lib/db.ts (v20).
 *
 * @deprecated use CardioPlan
 */
export type RunPlan = CardioPlan;

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
  /**
   * Bodyweight in kilograms, logged the morning of the date this entry
   * represents. Optional; populated from the recovery page or the
   * pre-workout check-in. Used by `effectiveLoadKg` in domain so that
   * weighted bodyweight movements (pull-ups with vest/belt, weighted dips,
   * etc.) report a meaningful e1RM trajectory. The most recent entry on or
   * before a given date is treated as the "current" bodyweight when no
   * entry exists for that date.
   */
  bodyweightKg?: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// User profile (demographics + training background)
// ---------------------------------------------------------------------------
// One singleton row keyed `'singleton'`. All fields optional — the user fills
// in what they want. Demographics feed the Coach agent's anatomical reasoning
// (sex- and age-modulated injury patterns), the Programmer agent's
// conservatism on TM% and deload frequency, and the Summarizer's narrative
// context. Stored locally + synced via the existing LWW pipeline.

export type UserSex = 'male' | 'female';

export type TrainingExperience = 'novice' | 'intermediate' | 'advanced' | 'elite';

export interface UserProfile {
  /** Always 'singleton'. */
  id: 'singleton';
  /** YYYY-MM-DD. Stored as DOB so it never goes stale; display layer computes age. */
  dateOfBirth?: string;
  sex?: UserSex;
  heightCm?: number;
  trainingExperience?: TrainingExperience;
  yearsLifting?: number;
  yearsRunning?: number;
  /**
   * Free-text background — feeds verbatim into Coach and Periodizer prompts.
   * Examples: "Former rugby player. Left ACL reconstruction 2018, fully
   * recovered. Recurring lower-back tightness; PT-cleared but a sensitivity."
   */
  backgroundNotes?: string;
  createdAt: string;
  updatedAt: string;
  /** Soft-delete marker (very unlikely for a singleton, but kept for sync uniformity). */
  deletedAt?: string;
}

// ---------------------------------------------------------------------------
// Injury / active limitation
// ---------------------------------------------------------------------------
// Tracks a current pain or movement-limitation episode. Multiple movements can
// be linked to a single Injury (per-injury adjustments). Each adjustment is
// proposed by the Coach agent, then user-reviewed (accept / decline / edit)
// before becoming active.
//
// Active injuries (resolvedAt undefined) are surfaced via:
//   - ActiveLimitationsBanner on every training surface
//   - The Programmer agent's prompt (so suggestions route around them)
//   - The /day view (per-entry limitation chip)
// Resolved injuries stay in history for pattern-spotting on /recovery/injuries.

export type InjuryAction =
  /** Never suggest this movement until the injury resolves. */
  | 'skip'
  /** Prefer a lighter / bodyweight variant of the same family. */
  | 'reduce-load'
  /** Reduce ROM (e.g. partial squat above pain point). */
  | 'reduce-range'
  /** Specific execution cue (e.g. "avoid right-leg extension"). */
  | 'modify-execution'
  /** Include but flag in rationale; user is monitoring the area. */
  | 'monitor';

export type InjuryAdjustmentStatus =
  /** AI proposed; awaiting user decision. */
  | 'proposed'
  /** User accepted; the suggester treats it as a hard constraint. */
  | 'accepted'
  /** User explicitly declined; suggester ignores. */
  | 'declined'
  /** Replaced by a newer proposal during a re-analysis. Kept for history. */
  | 'superseded';

export interface InjuryAdjustment {
  id: string;
  /** Movement this adjustment applies to. */
  movementId: string;
  action: InjuryAction;
  /**
   * User-facing instruction. AI-generated; the user can edit before
   * accepting (in which case `userEdited: true`).
   */
  modification: string;
  /**
   * Why the AI thinks this movement is affected. AI-generated; usually a
   * one- or two-sentence explanation grounding the recommendation in
   * anatomy and the user's described pain pattern.
   */
  reasoning: string;
  status: InjuryAdjustmentStatus;
  proposedAt: string;
  acceptedAt?: string;
  declinedAt?: string;
  /** True when the user manually edited the action / modification text. */
  userEdited?: boolean;
}

export type InjurySeverity = 1 | 2 | 3 | 4 | 5;

export interface Injury {
  id: string;
  /** Body area in user's words (e.g. "right adductor", "left shoulder"). */
  area: string;
  severity: InjurySeverity;
  /**
   * User's free-text description — fed verbatim to the Coach agent. The
   * specificity here directly drives proposal quality (e.g. "pain only
   * with load; bodyweight is fine; left side fine").
   */
  description: string;
  /**
   * Coach agent's anatomical interpretation of the issue. Set by the
   * analyze workflow; refreshed on re-analysis after user-edited
   * description.
   */
  summary?: string;
  /** Per-movement adjustments. Mix of proposed / accepted / declined. */
  adjustments: InjuryAdjustment[];
  /**
   * Coach's "when to retest / safety notes" guidance.
   * E.g. "Retest loaded BSS at 5–10 kg after 1–2 pain-free weeks."
   */
  monitoringAdvice?: string;
  /**
   * True when the Coach agent recommended a PT consult (severe pain,
   * recurring pattern, unusual mechanism). Surfaced as a banner CTA.
   */
  consultRecommended?: boolean;
  consultReason?: string;
  /** ISO. When the user marked the injury active. */
  startedAt: string;
  /** ISO. Set when the user marks the injury resolved. Undefined = active. */
  resolvedAt?: string;
  /**
   * Pointer to the SetRecord that triggered the per-set pain flag escalation,
   * if the injury was created via that path. Useful for back-linking.
   */
  originSetId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// ---------------------------------------------------------------------------
// WeeklyReview — Phase 4 (Summarizer agent).
//
// Persisted output of the /api/workflows/weeklyReview pipeline (Periodizer
// verdict + Summarizer's 6-section narrative + raw aggregates). One record
// per ISO week (keyed on weekStart, which must be a Monday). Regenerating
// for the same week overwrites the existing row.

export type WeeklyReviewVerdict =
  | 'deload-now'
  | 'deload-soon'
  | 'continue'
  | 'taper-now'
  | 'ramp-up'
  | 'tm-test'
  | 'extend-block';

export interface WeeklyReviewSection {
  heading: string;
  /** Markdown body. May be empty (e.g. Active limitations when there are none). */
  markdown: string;
}

export interface WeeklyReview {
  id: string;
  /** Monday of the week being reviewed (YYYY-MM-DD). Acts as a stable secondary key. */
  weekStart: string;
  /** Sunday of the week being reviewed (YYYY-MM-DD). */
  weekEnd: string;
  /** Periodizer's verdict for the just-ended week. */
  verdict: WeeklyReviewVerdict;
  /** One-line summary the UI shows above the sections. */
  headline: string;
  /** 6-section narrative (Training summary, Strength trend, Running + cardio, Load + recovery, Active limitations, Looking ahead). */
  sections: WeeklyReviewSection[];
  /** 0-4 short chip-style highlights. */
  highlights: string[];
  /** Generation timestamp. Used to surface "Generated N minutes ago" in the UI. */
  generatedAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/**
 * Four-axis training profile types are owned by `@wendler/domain`. Re-exported
 * here so consumers that only depend on db-schema still see them.
 */
export type {
  TrainingPhase,
  PrimaryGoal,
  SecondaryGoal,
  Constraint,
  TrainingProfile,
} from '@wendler/domain';
export {
  MAX_SECONDARY_GOALS,
  DEFAULT_TRAINING_PROFILE,
} from '@wendler/domain';

/**
 * Long-running training goal with target and deadline.
 */
export type GoalKind =
  | 'strength-pr'
  | 'race-time'
  | 'body-comp'
  | 'habit'
  | 'qualitative'
  | 'custom';

/**
 * Optional progress signal for qualitative goals. Hard goals
 * (strength-pr / race-time / body-comp / habit) don't use this field.
 *
 * - 'none' (default for qualitative): goal renders as a pure
 *   reminder card with no metric — for things that are inherently
 *   hard to quantify ("improved aesthetics", "be more consistent").
 * - 'strength-trend': render a sparkline + delta% of the user's
 *   average main-lift e1RM over the last 8 weeks ("getting stronger").
 */
export type GoalSignal = 'none' | 'strength-trend';

/**
 * Training-flavor tags expressing what *kind* of work this goal cares about.
 * Aggregated across all active goals to bias the assistance suggester:
 *
 * - 'strength'        — heavy compound assistance, low rep ranges
 * - 'hypertrophy'     — isolation, 8–15 rep ranges, balanced physique
 * - 'functional'      — carries, single-leg, anti-rotation, real-life strength
 * - 'conditioning'    — keeps total assistance volume in check so cardio/work
 *                       capacity has room
 * - 'prehab'          — reserves a slot for face pulls, band work, hip mobility
 *                       (skipped automatically if the warmup already covers it)
 *
 * Multiple flavors can apply to one goal. Empty/undefined = no opinion.
 */
export type GoalFlavor =
  | 'strength'
  | 'hypertrophy'
  | 'functional'
  | 'conditioning'
  | 'prehab';

/**
 * Sensible flavor defaults derived from `goal.kind`, used when an existing
 * goal has no explicit `flavors` set yet (backfill on first read / first edit).
 * Returns a fresh array each call so callers can mutate safely.
 */
export function defaultFlavorsForKind(kind: GoalKind): GoalFlavor[] {
  switch (kind) {
    case 'strength-pr':
      return ['strength'];
    case 'race-time':
      return ['conditioning', 'prehab'];
    case 'body-comp':
      return ['hypertrophy'];
    case 'habit':
    case 'qualitative':
    case 'custom':
    default:
      return [];
  }
}

export interface Goal {
  id: string;
  kind: GoalKind;
  title: string;
  /** Numeric target (kg / sec / kg / sessions / etc.). */
  target?: number;
  /** Unit label, displayed alongside. */
  targetUnit?: string;
  /** ISO date the goal should be achieved by. */
  deadline?: string;
  /**
   * Optional progress signal. Only meaningful when kind === 'qualitative'.
   * Defaults to 'none' on read if absent.
   */
  signal?: GoalSignal;
  /**
   * For `strength-pr` goals: the Movement.id whose e1RM is compared
   * against `target`. Without this, the summarizer falls back to the
   * highest e1RM across all lifts (always wrong for non-deadlift goals).
   * Only meaningful when kind === 'strength-pr'.
   */
  movementId?: string;
  /**
   * Training-flavor tags for this goal. Aggregated across all active goals
   * to bias the assistance suggester (which movements get prioritized).
   * Optional and additive — when absent, callers should fall back to
   * `defaultFlavorsForKind(kind)`.
   */
  flavors?: GoalFlavor[];
  createdAt: string;
  completedAt?: string;
  notes?: string;
  updatedAt: string;
}

/**
 * A scheduled race/event the user is training toward. Distinct from a
 * race-time Goal: a Goal expresses an *aspiration* (e.g. "HM sub 2:00"),
 * a Race is the actual event on the calendar with a specific date,
 * priority for taper purposes, and an optional logged result.
 */
export type RacePriority = 'A' | 'B' | 'C';

export type RaceKind =
  | '5k'
  | '10k'
  | 'half-marathon'
  | 'marathon'
  | 'ultra'
  | 'trail'
  | 'triathlon'
  | 'other';

export interface RaceResult {
  finishTimeSec?: number;
  placeOverall?: number;
  placeAgeGroup?: number;
  notes?: string;
  /** Optional: matched/manually-linked Strava activity id. */
  stravaActivityId?: string;
  /** ISO date the result was logged. */
  loggedAt: string;
}

export interface Race {
  id: string;
  name: string;
  /** ISO date-time of the race. */
  date: string;
  kind: RaceKind;
  priority: RacePriority;
  /** Derived from kind for standard distances; manual for ultra/trail/other. */
  distanceKm?: number;
  targetTimeSec?: number;
  location?: string;
  notes?: string;
  result?: RaceResult;
  createdAt: string;
  updatedAt: string;
  /** Set when result is logged or user explicitly marks done. */
  completedAt?: string;
  /**
   * Per-race accept/dismiss state for the proposed taper actions panel
   * (see packages/domain/src/taper.ts → `proposedTaperActions`). Sticky:
   * once accepted or dismissed, the action stops being proposed for this
   * race. Auto-applied state stops contributing once the race date passes
   * (handled by `computeEffectiveGoalFlags` reading only upcoming races).
   */
  taperActions?: RaceTaperActions;
}

export interface RaceTaperActions {
  /**
   * "Insert a deload block now" action. `acceptedAt` records when the user
   * clicked Accept; `blockId` is the inserted 7th-week block id (so we can
   * tell history without re-querying). `dismissedAt` records a dismissal.
   * Mutually exclusive — only one of the two shapes is present at a time.
   */
  insertedDeload?:
    | { acceptedAt: string; blockId: string }
    | { dismissedAt: string };
  /**
   * "Activate competition peaking goal flag" action. Pure marker — the
   * effective-flags helper unions this with the manual checkbox so the
   * suggester sees `competitionPeaking: true` without a settings write.
   */
  competitionPeakingActivated?:
    | { acceptedAt: string }
    | { dismissedAt: string };
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

/**
 * A "wellness flag" — for v1, an illness episode (cold, flu, fever, gut bug
 * etc.) the user explicitly logs. Captured to:
 *   1. Suppress workout expectations while sick (don't count as a fail).
 *   2. Drive the "Welcome back" recommender on the first session after
 *      `recoveredAt` is set (see packages/domain/src/return-plan.ts).
 *
 * Schema is intentionally narrow but extensible — future `kind` values may
 * cover injuries, surgery recovery, life events, etc.
 */
export type WellnessKind = 'illness';
export type WellnessSeverity = 'mild' | 'moderate' | 'severe';

export interface WellnessFlag {
  id: string;
  kind: WellnessKind;
  severity: WellnessSeverity;
  /** ISO date "YYYY-MM-DD" — when the user started feeling unwell. */
  startedAt: string;
  /**
   * ISO date "YYYY-MM-DD" — when the user marked themselves recovered.
   * Absent ⇒ still ongoing. The "Welcome back" card fires on the first
   * `/day` open after this is set.
   */
  recoveredAt?: string;
  notes?: string;
  /**
   * When set, the user has dismissed the "Welcome back" recommendation for
   * this episode and the card should not reappear. Stored on the row (not
   * localStorage) so the choice syncs across devices.
   */
  recommendationDismissedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** Soft-delete via tombstone, mirroring goals/recovery/cardio. */
  deletedAt?: string;
}

// ---------------------------------------------------------------------------
// Notifications (v14)
// ---------------------------------------------------------------------------
//
// Unified inbox for everything the app surfaces — auto-derived phase shifts,
// AI suggester applied events, sync conflicts, migrations, auth recovery,
// etc. Replaces the previous fragmented model where every component owned
// its own toast/banner with no audit trail.
//
// Design tenets (Phase 1):
//  - Existing transient UX (toasts, banners, undo) stays. The notification
//    log is ADDITIVE — every emitter calls `notify.*` alongside whatever
//    inline UI it already shows. Nothing breaks.
//  - Persistent by default. `expiresAt` is opt-in; most events live forever.
//  - Synced across devices via the existing LWW pipeline (same shape as
//    `WellnessFlag`, `Race`, etc. — `updatedAt` for tie-breaking).
//  - One single user, no severity filters / mute settings / push delivery.

export type NotificationChannel =
  | 'ai-suggester'
  | 'ai-action'
  | 'phase-auto'
  | 'sync'
  | 'migration'
  | 'auth'
  | 'training-profile'
  | 'plan-match'
  | 'recovery'
  | 'goal-flag'
  | 'system';

export type NotificationSeverity = 'info' | 'success' | 'warn' | 'action';

export interface NotificationDeepLink {
  href: string;
  label: string;
}

export interface Notification {
  /** Stable id (nanoid). */
  id: string;
  /** ISO timestamp of creation; same value used for chronological sort. */
  createdAt: string;
  /** Source bucket — drives icon + filter chip in the inbox UI. */
  channel: NotificationChannel;
  /** Visual emphasis only; no behavioral semantics. */
  severity: NotificationSeverity;
  /** Single-line headline (≤80 chars practically). */
  title: string;
  /** Optional 1-3 line detail. */
  body?: string;
  /** Optional single-tap navigation back to the originating screen. */
  deepLink?: NotificationDeepLink;
  /**
   * Free-form payload paired with the originating event (e.g. the AI's
   * `blockRationale[]`, the phase-shift's from/to, sync conflict diffs).
   * Surfaces in the inbox detail view; not interpreted by the schema.
   */
  context?: Record<string, unknown>;
  /** ISO of when the user marked this read; absent ⇒ unread. */
  readAt?: string;
  /**
   * ISO of when the user dismissed the inline transient UI. The notification
   * stays in the inbox regardless — `dismissedAt` only signals "I've seen
   * the toast, hide the inline surface".
   */
  dismissedAt?: string;
  /**
   * Optional auto-purge timestamp. When absent, the notification persists
   * indefinitely (Phase 1 default). Setting this on noisy routine events
   * (e.g. successful sync) lets the inbox auto-clean; not used yet.
   */
  expiresAt?: string;
  /**
   * Optional future-due timestamp. When set, the notification is hidden
   * from the inbox until `now >= dueAt`. Used by the AI's
   * `schedule_followup` action to defer a check-in notification until
   * the chosen time. The notification still exists in the database the
   * moment it's created (and syncs across devices); only its rendering
   * is gated.
   */
  dueAt?: string;
  /** LWW sync timestamp — bumped on every state change (read, dismiss). */
  updatedAt: string;
  /** Soft-delete via tombstone, mirroring other synced tables. */
  deletedAt?: string;
}

// ---------------------------------------------------------------------------
// AI Generation log (v15)
// ---------------------------------------------------------------------------
//
// Persistent record of every AI suggester invocation: input prompts, raw
// model response, outcome (applied / undone / errored), and diagnostic
// context. Designed to be "AI-paste-friendly": the inbox export will
// concatenate N entries into a single text blob that can be fed to any LLM
// for pattern analysis ("why is the model picking X instead of Y?",
// "what's the suggester missing about my training?").
//
// Synced across devices via the existing LWW pipeline — same shape as
// `Notification` / `Race` / `WellnessFlag`. Append-mostly: rows are only
// updated when the outcome state transitions (e.g. applied → undone).

export type AiGenerationSource = 'ai' | 'fallback';
export type AiGenerationOutcome = 'applied' | 'undone' | 'error';

export interface AiGenerationModelInfo {
  model: string;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiGeneration {
  /** Stable id (nanoid). */
  id: string;
  /** ISO timestamp the generation was issued. */
  createdAt: string;
  /** Block the suggestion was for. */
  blockId: string;
  /** Block name at generation time (copied so listings don't need a join). */
  blockName?: string;
  /** Block kind at generation time. */
  blockKind?: 'leader' | 'anchor' | 'standalone' | 'seventh-week';
  /** Week scope the generation targeted (1 | 2 | 3 | 'deload' | '7w'). */
  weekScope: number | string;
  /** Effective training phase at generation time. */
  phase?: 'normal' | 'deload' | 'taper' | 'peak';
  /** Was this an LLM response, or a deterministic fallback? */
  source: AiGenerationSource;
  /** Full system prompt as sent to the LLM (or rendered for the fallback). */
  systemPrompt: string;
  /** Full user prompt as sent to the LLM. */
  userPrompt: string;
  /** Raw response — JSON string for AI, or JSON-serialized fallback output. */
  rawResponse: string;
  /** Diagnostics for AI generations; absent for fallback. */
  modelInfo?: AiGenerationModelInfo;
  /** Cardio-fatigue shift signal that was in effect (0 / -1 / -2). */
  cardioFatigueShift?: number;
  /** Recent cardio fatigue summary (recent vs baseline weighted-min, delta%). */
  cardioFatigueSummary?: {
    recentWeightedMin: number;
    baselineWeightedMin: number;
    deltaPct: number | null;
  };
  /** How many picks the generation applied, across how many days. */
  pickCount?: number;
  dayCount?: number;
  /**
   * Outcome state machine:
   *   - 'applied' on initial apply
   *   - 'undone' if the user undoes within the window
   *   - 'error' if validation / fallback both failed
   */
  outcome: AiGenerationOutcome;
  /** ISO timestamp of the outcome event. */
  outcomeAt: string;
  /** User-authored note after the fact (free text, optional). */
  userAnnotation?: string;
  /** LWW sync timestamp — bumped on outcome transition or annotation edit. */
  updatedAt: string;
  /** Soft-delete via tombstone. */
  deletedAt?: string;
}


// ---------------------------------------------------------------------------
// Chat conversations (v16)
// ---------------------------------------------------------------------------
//
// User-AI chat conversations grounded in the training data snapshot. Synced
// across devices via the existing LWW pipeline. Each Chat row holds the
// full message thread; messages are not synced as separate rows because
// a conversation is appended-to only on the device that's actively
// chatting, so LWW on the parent row is sufficient.

export type ChatRole = 'user' | 'assistant';

// ---------------------------------------------------------------------------
// Chat action chips — Phase 4 follow-up.
//
// Concrete, applicable recommendations the chat AI emits alongside its prose
// reply. Each chip maps to a small write the client can execute against
// Dexie (and which then propagates via the normal sync engine). Chips
// persist on the assistant ChatMessage so they survive reload + cross-
// device sync; tapping Apply records `appliedAt`, tapping Dismiss records
// `dismissedAt`.
//
// Vocabulary is intentionally narrow at v1 — three kinds covering the most
// common "do this" advice across Coach / Programmer / Periodizer:
//
//   - `log_injury`             → opens InjurySheet pre-filled
//   - `set_training_max`       → confirm sheet → writes TrainingMaxRecord
//   - `set_block_volume_preset`→ confirm sheet → updates active block
//
// New action kinds plug in by adding to the union + a handler in
// `apps/web/src/lib/chat-actions.ts`.

// Op-kind discriminator + operation shapes for the `propose_edit`
// ChatAction. Each op kind has typed input + a parallel before/after
// audit shape captured at apply time. Adding a new op kind requires
// edits in three places: the EditOperation union (here), the parser
// validator (chat-actions-parse.ts), and the apply handler
// (chat-actions.ts).
export type EditOperationKind =
  | 'set_training_max'
  | 'set_block_volume_preset'
  | 'trim_assistance_entry'
  | 'swap_assistance_movement'
  | 'add_assistance_entry'
  | 'add_movement_to_library'
  | 'add_cardio_plan_slot'
  | 'remove_cardio_plan_slot'
  | 'remove_assistance_entry'
  | 'schedule_deload'
  | 'skip_day_in_week'
  | 'switch_to_template';

interface EditOperationBase {
  /** Stable id within the proposal. Assigned by the parser if missing. */
  id: string;
  kind: EditOperationKind;
  /** Human-readable summary the UI puts in the row header (≤ 80 chars). */
  label: string;
  /** Optional per-op rationale. */
  rationale?: string;
}

export interface SetTrainingMaxEditOp extends EditOperationBase {
  kind: 'set_training_max';
  lift: 'squat' | 'bench' | 'deadlift' | 'press';
  /** Proposed new TM, rounded to 0.5 kg. */
  newTrainingMaxKg: number;
}

export interface SetBlockVolumePresetEditOp extends EditOperationBase {
  kind: 'set_block_volume_preset';
  /** Optional — defaults to the currently active block. */
  blockId?: string;
  preset: 'minimal' | 'standard' | 'high';
}

export interface TrimAssistanceEntryEditOp extends EditOperationBase {
  kind: 'trim_assistance_entry';
  /** Optional — defaults to the currently active block. */
  blockId?: string;
  /** Stable day id from the active block's plan. */
  dayId: string;
  /** Stable entry id within the day's assistance list. */
  entryId: string;
  /** Display name (echo, for UI). */
  movementName: string;
  /** New sets count. */
  newSets: number;
  /** New reps target. */
  newReps: number;
  /** Optional new repsMax (range upper bound). Omit to drop AMRAP range. */
  newRepsMax?: number;
}

export interface SwapAssistanceMovementEditOp extends EditOperationBase {
  kind: 'swap_assistance_movement';
  blockId?: string;
  dayId: string;
  entryId: string;
  currentMovementId: string;
  currentMovementName: string;
  newMovementId: string;
  newMovementName: string;
}

export interface AddAssistanceEntryEditOp extends EditOperationBase {
  kind: 'add_assistance_entry';
  blockId?: string;
  dayId: string;
  /**
   * movementId from the user's library — must exist. May ALSO be a
   * `tmp:<slug>` reference paired with a sibling `add_movement_to_library`
   * op in the same proposal; the apply orchestrator rewrites it to the
   * newly-created library movement's real id before the assistance entry
   * is written.
   */
  movementId: string;
  movementName: string;
  /** Slot category — one of push/pull/single-leg/core/prehab/isolation/carry. */
  category: string;
  sets: number;
  reps: number;
  repsMax?: number;
  unit?: 'reps' | 'sec';
}

/**
 * Add a new movement to the user's library. Always sets `isCustom: true`
 * — these are treated identically to manually-added movements (same
 * surface in /movements, no AI badge).
 *
 * Pairs with `add_assistance_entry`: when the AI wants to add a movement
 * to a specific day AND the movement doesn't exist in the library yet,
 * it emits an `add_movement_to_library` op with a `tempMovementId` of
 * shape `tmp:<slug>`, and a sibling `add_assistance_entry` op whose
 * `movementId` is the same `tmp:<slug>`. The apply orchestrator runs
 * the library op first (APPLY_ORDER slot 0), captures the real
 * generated movementId, and rewrites the chained assistance op's
 * `movementId` before applying it.
 *
 * Dedup: the renderer surfaces a "use existing X" warning when a similar
 * library movement exists (Levenshtein ≤ 2 on normalized name, or same
 * pattern + primaryMuscles + ≥60% token overlap). The apply path
 * rejects exact-normalized-name duplicates with a sticky error. When a
 * race condition produces a real duplicate AFTER accept (parallel sync
 * added the same movement), apply fails soft and rewrites chained ops
 * to the existing movement instead.
 */
export interface AddMovementToLibraryEditOp extends EditOperationBase {
  kind: 'add_movement_to_library';
  /**
   * Stable temp id the model invents — used so chained
   * `add_assistance_entry` ops in the same proposal can reference this
   * op's result before the real movementId exists. Must match
   * `^tmp:[a-z0-9-]+$`. Parser rejects anything else.
   */
  tempMovementId: string;
  /** Display name of the new movement (e.g. "Banded Clamshell"). */
  name: string;
  /** Slot category — one of push/pull/single-leg/core/prehab/isolation/carry. */
  category: string;
  /** Required. At least one primary muscle. Used for filtering + dedup. */
  primaryMuscles: MuscleGroup[];
  /** Optional secondary muscles for completeness. */
  secondaryMuscles?: MuscleGroup[];
  /** Defaults to 'bodyweight' if omitted. */
  equipment?: EquipmentType;
  /** Movement pattern — required for the library. */
  pattern: MovementPattern;
  /** Defaults to false. Almost always false for prehab/isolation work. */
  isCompound?: boolean;
  /** Defaults to false. True for movements that accept vest/belt loading. */
  externallyLoadable?: boolean;
  /** Optional cue text — populates Movement.techniqueCues. */
  cues?: string;
  /**
   * AI's dedup self-check (informational only — server validates
   * dedup independently). When set, the parser keeps it on the op so
   * the UI can show "the AI checked these existing entries first".
   */
  dedupHint?: string;
}

/**
 * Add a recurring weekly slot to the user's cardio plan. Pairs
 * naturally with `skip_day_in_week` when the AI is replacing a
 * strength day with cardio — the user can review and accept/decline
 * each side independently in the same accept-sheet.
 *
 * The cardio plan is a weekly template (one entry per weekday +
 * modality combination). After accept the slot persists in the plan
 * indefinitely; the user removes it manually via /program?tab=cardio
 * when the racing block ends.
 */
export interface AddCardioPlanSlotEditOp extends EditOperationBase {
  kind: 'add_cardio_plan_slot';
  /** ISO weekday: 0 = Mon … 6 = Sun. */
  dayOfWeek: number;
  /** Modality: run | bike | swim | row | walk | padel | other. */
  modality: string;
  /**
   * Planned kind: rest | easy | long | quality | recovery | race-pace
   * | z2 | intervals | cross. Named `planKind` so it doesn't shadow
   * the op-discriminator `kind` field.
   */
  planKind: string;
  /** Optional planned duration in minutes. */
  durationMin?: number;
  /** Free-text note (e.g. "60 min indoor trainer"). */
  notes?: string;
  /**
   * When `true` (the default for AI proposals that pair with
   * `skip_day_in_week`), the apply path stamps the new slot with the
   * active block's id. A side-effect on block completion then prunes
   * any slot whose `linkedBlockId` matches the just-completed block.
   * Pass `false` to keep the slot in the cardio plan after the block
   * ends — e.g. when the user explicitly wants a permanent change.
   */
  linkedToActiveBlock?: boolean;
  /**
   * When set (typical for AI cardio-replacement pairings), the slot
   * only renders on /calendar for dates inside the specified weeks of
   * the linked block. Values are the same WendlerWeek labels used by
   * skip_day_in_week ("1" | "2" | "3" | "deload" | "7w"). Apply
   * resolves them to absolute `effectiveFrom` / `effectiveUntil` ISO
   * dates anchored off the linked block's schedule cursor. Requires
   * `linkedToActiveBlock !== false`. When omitted, the slot is fully
   * recurring (every matching weekday, no date bounds).
   */
  appliesToWeeks?: Array<'1' | '2' | '3' | 'deload' | '7w'>;
}

/**
 * Remove a recurring slot from the user's cardio plan. Matched by
 * (dayOfWeek, modality) — the same composite key the cardio plan
 * editor uses for de-duplication. The pair (dayOfWeek=4, modality=
 * 'bike') uniquely identifies the user's 'Friday bike' slot
 * regardless of kind / duration / scope. Apply is a no-op when no
 * matching slot exists.
 *
 * Pairs naturally with `add_cardio_plan_slot` when the user wants to
 * replace one slot with another (e.g. delete the existing unscoped
 * Friday bike and add a new Wk-2/3/Deload-scoped one).
 */
export interface RemoveCardioPlanSlotEditOp extends EditOperationBase {
  kind: 'remove_cardio_plan_slot';
  /** ISO weekday: 0 = Mon … 6 = Sun. */
  dayOfWeek: number;
  /** Modality: run | bike | swim | row | walk | padel | other. */
  modality: string;
  /** Display labels for the accept-sheet — echo of what the user sees. */
  modalityLabel?: string;
  planKindLabel?: string;
}

export interface RemoveAssistanceEntryEditOp extends EditOperationBase {
  kind: 'remove_assistance_entry';
  blockId?: string;
  dayId: string;
  entryId: string;
  /** Display name (echo, for UI confirmation). */
  movementName: string;
}

export interface ScheduleDeloadEditOp extends EditOperationBase {
  kind: 'schedule_deload';
}

/**
 * Skip one or more weeks of a specific day in the active (or specified)
 * block. The day still exists in the rotation; the per-week override
 * marks it skipped + records the reason. Used most often during a race
 * taper to drop a strength day and replace it with a cardio session
 * scheduled in the cardio plan.
 *
 * Multiple weeks can be skipped in one op (e.g. "skip Day 3 in weeks
 * 2 + 3 + deload"). Apply is idempotent — running it twice writes the
 * same override state.
 */
export interface SkipDayInWeekEditOp extends EditOperationBase {
  kind: 'skip_day_in_week';
  /** Optional block id; defaults to the active block. */
  blockId?: string;
  /** Stable day id from the active block's plan. */
  dayId: string;
  /** Display label for the day (for the UI; echo of the BlockDay label). */
  dayLabel?: string;
  /** Which weeks of the block to skip. At least one required. */
  weeks: Array<'1' | '2' | '3' | 'deload' | '7w'>;
  /** Why the day is skipped. UI label hint. */
  skipReason:
    | 'cardio-replacement'
    | 'rest-day'
    | 'travel'
    | 'fatigue'
    | 'pain'
    | 'other';
  /** Free-text note shown to the user (e.g. "Z2 bike 60 min"). */
  skipNote?: string;
}

/**
 * Switch the user to a different Wendler 5/3/1 template. Creates a NEW
 * program with one block seeded from the template, then activates that
 * block. The user's previous program + blocks are NOT deleted or marked
 * complete — they stay around as history. The schedule's activeBlockId
 * + cursor flip to the new block so /day, /program, NextUpCard all pick
 * up the change.
 *
 * `templateId` must reference an entry in the `WENDLER_TEMPLATES` catalog
 * exported from packages/domain — the parser rejects unknown ids.
 *
 * `programName` defaults to the template name; `blockName` defaults to
 * the template name (e.g. "BBB Forever"). Both are optional overrides.
 *
 * Used when the AI / user wants to change methodology mid-program (e.g.
 * "my CNS is shot from Spinal Tap H.S., switch to BBB Forever until the
 * marathon"). Single-block additions to the CURRENT program go through
 * `schedule_deload` or the manual editor — switch_to_template is the
 * "new program" door.
 */
export interface SwitchToTemplateEditOp extends EditOperationBase {
  kind: 'switch_to_template';
  /** Stable id from the WENDLER_TEMPLATES catalog. */
  templateId: string;
  /** Optional override for the new program's name. */
  programName?: string;
  /** Optional override for the seed block's name. */
  blockName?: string;
  /**
   * Optional override for the seed block's supplemental set count. Honored
   * only by multi-set supplemental templates (fsl, ssl, bbb, spinal-tap).
   * Common case: drop FSL from 5×5 to 3×5 during marathon prep.
   */
  supplementalSetsOverride?: number;
}

export type EditOperation =
  | SetTrainingMaxEditOp
  | SetBlockVolumePresetEditOp
  | TrimAssistanceEntryEditOp
  | SwapAssistanceMovementEditOp
  | AddAssistanceEntryEditOp
  | AddMovementToLibraryEditOp
  | AddCardioPlanSlotEditOp
  | RemoveCardioPlanSlotEditOp
  | RemoveAssistanceEntryEditOp
  | ScheduleDeloadEditOp
  | SkipDayInWeekEditOp
  | SwitchToTemplateEditOp;

/**
 * Per-op user decision captured in the EditProposalSheet UI before
 * apply. Modifications override the AI's proposed input field-by-field
 * (the orchestrator merges these into the op input at apply time).
 */
export interface EditOperationDecision {
  status: 'pending' | 'accepted' | 'declined';
  /**
   * Partial override of the op's input fields. Shape is the same as the
   * op kind but every field optional. Only fields the user actually
   * changed are present.
   */
  modifiedInput?: Record<string, unknown>;
}

/** Per-op apply result for the proposal's audit log. */
export type EditOperationAppliedDetail =
  | { kind: 'set_training_max'; recordId: string; previousKg?: number; newKg: number }
  | { kind: 'set_block_volume_preset'; previousPreset?: string; newPreset: string }
  | {
      kind: 'trim_assistance_entry';
      previousSets: number;
      previousReps: number;
      previousRepsMax?: number;
      newSets: number;
      newReps: number;
      newRepsMax?: number;
    }
  | {
      kind: 'swap_assistance_movement';
      previousMovementId: string;
      previousMovementName: string;
      newMovementId: string;
      newMovementName: string;
    }
  | { kind: 'add_assistance_entry'; newEntryId: string; movementName: string }
  | {
      kind: 'add_movement_to_library';
      newMovementId: string;
      movementName: string;
      /**
       * When apply detected an exact-normalized-name duplicate AFTER the
       * user accepted (parallel-sync race), it falls back to the existing
       * library movement. The orchestrator records that here so the audit
       * trail captures the soft-fallback.
       */
      reusedExistingMovementId?: string;
    }
  | { kind: 'remove_assistance_entry'; removedMovementName: string }
  | {
      kind: 'add_cardio_plan_slot';
      dayOfWeek: number;
      modality: string;
      planKind: string;
      durationMin?: number;
      notes?: string;
      /**
       * When the slot already existed (same dayOfWeek + modality
       * combo), apply is a no-op and this is set to the existing
       * slot's identity so the audit trail captures the soft-skip.
       */
      reusedExisting?: boolean;
      /** Echo of the op's appliesToWeeks input — for audit / debug. */
      appliesToWeeks?: Array<'1' | '2' | '3' | 'deload' | '7w'>;
      /** Resolved linked-block id (when linkedToActiveBlock !== false). */
      linkedBlockId?: string;
      /**
       * Resolved scope dates (when both `appliesToWeeks` was supplied
       * AND a linked block was found). Stored on the slot itself; also
       * captured here for the audit / diagnostics page.
       */
      effectiveFrom?: string;
      effectiveUntil?: string;
      /**
       * Diagnostic: explains why scope resolution was skipped when the
       * op asked for scoping. `no-applies-to-weeks` = op didn't carry
       * the list. `no-linked-block` = no uncompleted block found (or
       * `linkedToActiveBlock: false` was set).
       */
      scopeSkippedReason?:
        | 'no-applies-to-weeks'
        | 'no-linked-block'
        | 'opted-out';
    }
  | {
      kind: 'remove_cardio_plan_slot';
      dayOfWeek: number;
      modality: string;
      /** True when no matching slot existed (apply was a no-op). */
      noopReason?: 'not-found';
      /** Captured for audit so the read-only re-view shows what was removed. */
      removedKind?: string;
      removedDurationMin?: number;
      /**
       * How many matching slots were removed. >1 means duplicate
       * (dayOfWeek, modality) slots existed (pre-v434 add was
       * silently skipping rather than merging — leftover state can
       * have duplicates). Apply now removes ALL matches; this field
       * surfaces that explicitly in the audit.
       */
      removedCount?: number;
    }
  | { kind: 'schedule_deload'; newBlockId: string; sequenceIndex: number }
  | {
      kind: 'skip_day_in_week';
      dayId: string;
      dayLabel?: string;
      weeks: Array<'1' | '2' | '3' | 'deload' | '7w'>;
      skipReason: string;
      skipNote?: string;
    }
  | {
      kind: 'switch_to_template';
      /** Template id from WENDLER_TEMPLATES that was applied. */
      templateId: string;
      /** Display name of the template (echo for audit). */
      templateName: string;
      /** New Program row id created by the op. */
      newProgramId: string;
      /** Program display name as persisted. */
      newProgramName: string;
      /** First Block row id created by the op (the new active block). */
      newBlockId: string;
      /** Block display name as persisted. */
      newBlockName: string;
      /**
       * Echo of the SupplementalTemplateId actually written to the new
       * block. 'unsupported' templates downgrade to 'none' at apply time
       * (the user will get a notification explaining the fallback).
       */
      appliedSupplemental: string;
      /** Echo of the supplementalSetsOverride applied, when set. */
      appliedSupplementalSetsOverride?: number;
      /** Schedule's previous active block id, when present. For audit / undo. */
      previousActiveBlockId?: string;
    };

export type ChatActionKind =
  | 'log_injury'
  | 'propose_edit'
  | 'schedule_followup'
  | 'remember';

export type ChatActionStatus = 'pending' | 'applied' | 'dismissed';

interface ChatActionBase {
  /** Stable id (generated server-side when the action is parsed). */
  id: string;
  kind: ChatActionKind;
  /** Imperative-voice button label, ≤ 35 chars. */
  label: string;
  /** Optional one-line "why" shown alongside the button. */
  rationale?: string;
  status: ChatActionStatus;
  appliedAt?: string;
  dismissedAt?: string;
  /**
   * Set when the user undid this action via the read-only sheet's
   * "Undo" button. Implies the matching `ChatActionSnapshot` (keyed by
   * action id) was successfully restored. The chip stays `status:
   * 'applied'` so it remains visible / re-openable, but rendering paths
   * grey it out and hide the Undo button.
   */
  undoneAt?: string;
  /**
   * Audit trail set when the user applied the chip. Captures the before /
   * after state of the mutation so troubleshooting "what did the AI
   * actually do?" later is precise. Each kind records its own shape via
   * the `ChatActionApplyDetails` union. Optional — present iff
   * `status === 'applied'` AND the handler captured details.
   */
  appliedDetails?: ChatActionApplyDetails;
  /**
   * Error message if applying failed. When set the chip stays in
   * `pending` so the user can retry — the apply attempt is logged on the
   * chip for debug.
   */
  applyError?: string;
}

/**
 * Per-kind audit shape captured at apply time. Kept narrow on purpose —
 * we want enough to reconstruct the change, not the full new+old objects.
 */
export type ChatActionApplyDetails =
  | { kind: 'log_injury'; injuryId: string }
  | {
      kind: 'propose_edit';
      /** Per-op apply outcome, keyed by op.id. Successful ops only. */
      operationResults: Record<string, EditOperationAppliedDetail>;
      /** Op ids that the user declined; recorded for audit completeness. */
      declinedOperationIds: string[];
    }
  | {
      kind: 'schedule_followup';
      /** ISO timestamp the follow-up notification is due. */
      dueAt: string;
      /** Notification id that was created. */
      notificationId: string;
    }
  | {
      kind: 'remember';
      /** The aiMemories.id the memory was stored under. */
      memoryId: string;
      /** Captured for audit so re-opening the chip shows what was committed. */
      text: string;
      category: 'preference' | 'fact' | 'goal' | 'constraint' | 'context';
    };

export interface LogInjuryChatAction extends ChatActionBase {
  kind: 'log_injury';
  area: string;
  severity?: 1 | 2 | 3 | 4 | 5;
  description?: string;
  /** Library movementIds (with prefix) the user said are affected. */
  movementIds?: string[];
}

/**
 * `schedule_followup` — the AI proposes a future check-in. On accept,
 * a future-dated notification is created (Notification.dueAt) that
 * remains hidden in the inbox until its time arrives. When the user
 * eventually taps the notification, the deeplink lands them in the
 * SAME chat thread with `prompt` pre-filled as a new user message
 * that auto-sends — so the AI's next turn has the prior conversation
 * as context and can adjust based on the user's reply.
 *
 * Used by the injury coach trigger to schedule 24h / 72h / 7d
 * check-ins on adductor pain, etc. Generalises to any "I'll check
 * back in on you" pattern (post-deload feel, race recovery,
 * mid-cut weight check, …).
 */
export interface ScheduleFollowupChatAction extends ChatActionBase {
  kind: 'schedule_followup';
  /** Hours from accept until the notification fires. 1–720 (30d max). */
  inHours: number;
  /** Brief headline for the notification (≤60 chars). */
  topic: string;
  /** The user message that will auto-send when the user taps the notification. */
  prompt: string;
}

/**
 * `propose_edit` — the coordinated multi-op edit primitive. Carries a
 * plan of N operations; the UI renders the whole plan as a diff with
 * per-op accept / decline / modify, and an atomic Dexie-transaction
 * apply orchestrator commits the accepted subset all-or-nothing.
 *
 * See files/edit-proposals-design.md in the session workspace for the
 * full rationale + migration plan. Operations vocabulary is the
 * `EditOperation` discriminated union above.
 *
 * `userDecisions` is captured in the UI before apply (keyed by op.id):
 * undefined = the user hasn't reviewed the op yet; status determines
 * whether the op is included in the apply set; `modifiedInput` lets
 * the user override the AI's proposed field values per op (e.g. nudge
 * the proposed new TM from 102.5 to 105 before applying).
 */
export interface ProposeEditChatAction extends ChatActionBase {
  kind: 'propose_edit';
  /** Headline summary the proposal sheet shows above the op list. */
  headline: string;
  /** 1-2 sentence rationale for the WHOLE plan. */
  reason: string;
  /** Plan-level relative confidence. */
  confidence?: 'high' | 'medium' | 'low';
  /** The ordered list of operations the AI proposes. Immutable. */
  operations: EditOperation[];
  /**
   * User's per-op decisions (set in the UI before apply). Keyed by
   * op.id. Ops not present here are treated as `pending` and block
   * the Apply button.
   */
  userDecisions?: Record<string, EditOperationDecision>;
}

/**
 * `remember` — the AI commits a durable fact / preference / constraint
 * about the user to the persistent memory store. Surfaced as a chip
 * the user accepts (writes to `aiMemories`) or dismisses (memory
 * never persists). Once accepted, the memory is included in EVERY
 * future chat snapshot under "## Your trainer remembers" so the AI
 * has continuous context across conversations.
 *
 * Examples of what to remember:
 *  - "User prefers Z2 over interval cardio sessions."
 *  - "Lower back twinges on conventional deadlifts; uses trap-bar."
 *  - "Races aggressively — A-race targets are stretch, not safe."
 *  - "Trains 4x/week — Mon/Thu/Fri (incl. accessory)."
 *
 * What NOT to remember:
 *  - Anything transient ("user said they were tired yesterday").
 *  - Anything already captured in the schema (active block, races).
 *  - Anything the user can change themselves (they edit it in
 *    TrainingProfile / GoalNotes already).
 */
export interface RememberChatAction extends ChatActionBase {
  kind: 'remember';
  /** The fact/preference text, ≤ 200 chars. Surfaced to every prompt. */
  text: string;
  /**
   * Coarse category for grouping in the memory review UI. The AI
   * picks one; the user can re-classify on accept.
   */
  category: 'preference' | 'fact' | 'goal' | 'constraint' | 'context';
}

export type ChatAction =
  | LogInjuryChatAction
  | ProposeEditChatAction
  | ScheduleFollowupChatAction
  | RememberChatAction;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Plain-text body. Assistant messages may contain markdown. */
  content: string;
  /** ISO timestamp the message was created. */
  createdAt: string;
  /**
   * Optional pathname the user was on when sending this message. Set on the
   * first user message of a turn; assistant messages inherit it from the
   * preceding user message during prompt construction.
   */
  contextPath?: string;
  /**
   * Optional action chips emitted alongside the assistant's prose reply.
   * Persisted with the message so they survive reload + sync. Only set on
   * assistant messages.
   */
  actions?: ChatAction[];
}

export interface Chat {
  /** Stable id (nanoid). */
  id: string;
  /** ISO timestamp of conversation creation. */
  createdAt: string;
  /** ISO timestamp of last message append; drives the conversation list ordering. */
  updatedAt: string;
  /** Derived from the first user message (≤80 chars). */
  title: string;
  messages: ChatMessage[];
  /**
   * When set, an external trigger (e.g. the injury coach hook) created
   * this chat with a primed user prompt that hasn't been sent yet.
   * The /chat page detects this on mount, clears it, and fires the
   * send so the AI auto-responds without the user having to type or
   * tap anything. The string IS the message to send. Cleared to
   * `undefined` after the first send.
   */
  pendingAutoSend?: string;
  /**
   * Marker that this chat was opened by a proactive AI trigger.
   * `'injury'` — injury-coach review on injury log (v447).
   * `'daily-brief'` — daily proactive brief (v449+).
   * Used by the chat header so the conversation displays a contextual
   * label and by ensure-once gating in the trigger code (avoid double-
   * triggering the same kind on the same day).
   */
  triggerKind?: 'injury' | 'daily-brief';
}

/**
 * Before-state snapshot captured at apply-time for a `propose_edit`
 * ChatAction. One row per applied proposal, keyed by `chatActionId`.
 * Powers the "Undo this proposal" affordance in the read-only sheet.
 *
 * Storage strategy is per-table:
 *   - For each table the apply touched, we record EVERY row of that
 *     table as it existed before the transaction ran (via `rowsById`),
 *     plus the full set of row ids that existed (`presentIds`).
 *   - On undo, we put each `rowsById` entry back (bumping `updatedAt`
 *     so LWW sync wins), then delete any current rows whose id is
 *     NOT in `presentIds` (they were created by the apply — undo
 *     deletes them and writes a tombstone).
 *   - Singleton tables (cardioPlan, schedule) use `singletonRow`:
 *     `null` means the singleton didn't exist before (undo deletes
 *     it); an object means restore that exact state.
 *
 * Retention is capped at 50 most-recent snapshots; older snapshots
 * are pruned on insert. Local-only — NOT synced to peers (a peer
 * device has its own apply history).
 */
export interface ChatActionSnapshot {
  /** Matches `ChatAction.id` — one snapshot per applied proposal. */
  chatActionId: string;
  /** ISO of the apply that this snapshot precedes. */
  createdAt: string;
  /** Snapshot blob schema version, for future safe migration. */
  version: 1;
  /** Captured before-state per touched table. Tables not touched are absent. */
  tables: ChatActionSnapshotTables;
}

export interface ChatActionSnapshotTables {
  blocks?: ChatActionSnapshotTableMulti;
  programs?: ChatActionSnapshotTableMulti;
  movements?: ChatActionSnapshotTableMulti;
  trainingMaxes?: ChatActionSnapshotTableMulti;
  /** Singleton — `null` row means it didn't exist before apply. */
  cardioPlan?: { singletonRow: unknown | null };
  /** Singleton — `null` row means it didn't exist before apply. */
  schedule?: { singletonRow: unknown | null };
}

export interface ChatActionSnapshotTableMulti {
  /** All ids that existed in this table before apply. */
  presentIds: string[];
  /** Full rows keyed by id. */
  rowsById: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AI Memories (v23) — persistent facts/preferences the AI remembers
// ---------------------------------------------------------------------------
//
// Each row is one durable thing the chat AI learned about the user.
// Surfaced to EVERY chat snapshot under "## Your trainer remembers"
// so the assistant has continuous personal context across
// conversations. Created via the `remember` ChatAction kind;
// reviewed + deleted from /diagnostics → Memories.
//
// Synced across devices (LWW on updatedAt). Soft-delete via
// tombstones so a delete on one device propagates.
//
// Intentionally simple: just text + category + timestamps. No
// embedding / similarity / dedup — the AI is expected to check the
// current memory list (provided in the snapshot) before proposing a
// new `remember` op to avoid duplicates.

export type AiMemoryCategory =
  | 'preference'
  | 'fact'
  | 'goal'
  | 'constraint'
  | 'context';

export interface AiMemory {
  /** Stable id (nanoid). */
  id: string;
  /** The fact/preference text, ≤200 chars after trim. */
  text: string;
  category: AiMemoryCategory;
  /** ISO timestamp the memory was first committed. */
  createdAt: string;
  /** LWW sync timestamp. Bumped on text/category edits. */
  updatedAt: string;
  /**
   * Chat id that proposed this memory (the `remember` chip
   * originated there). Optional — manual additions via the
   * diagnostics UI omit it.
   */
  sourceChatId?: string;
  /**
   * True when the user edited the AI's proposed text before
   * accepting. Lets the audit distinguish "AI got it right" from
   * "AI got close, user fixed it".
   */
  userEdited?: boolean;
}
