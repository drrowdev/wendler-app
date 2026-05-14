import type { EquipmentType, MainLift, Movement, SeventhWeekKind, WendlerWeek } from './types';
import type { SupplementalTemplateId } from './supplemental';
import type { MainScheme } from './waves';

export type BlockKind = 'leader' | 'anchor' | 'standalone' | 'seventh-week';

/**
 * Per-block assistance-volume preset. Drives how much accessory work the
 * suggester (and human eye) expects this block to carry.
 *
 * - 'minimal'  — small amount of assistance; appropriate during cardio peaks,
 *                deload weeks, or recovery blocks where injury is flagged.
 * - 'standard' — Forever-canonical volume; the safe default for Anchors.
 * - 'high'     — Generous accessory work; the typical Leader-block setting,
 *                especially when a dedicated accessory day exists.
 */
export type AssistanceVolumePreset = 'minimal' | 'standard' | 'high';

/**
 * Explicit numeric override when none of the presets fit. Stored alongside
 * the preset string in {@link AssistanceVolume} so the suggester can read raw
 * numbers without mapping. All three numbers are *weekly* totals.
 */
export interface AssistanceVolumeCustom {
  preset: 'custom';
  /** Working reps per main-lift day across all assistance entries. */
  mainDayReps: number;
  /** Working reps on the dedicated accessory day (0 if no accessory day). */
  accessoryReps: number;
  /** Number of distinct movements on the accessory day. */
  accessoryMovements: number;
}

/**
 * Block-level assistance volume picker. Either one of the three named
 * presets or an explicit numeric breakdown via {@link AssistanceVolumeCustom}.
 */
export type AssistanceVolume = AssistanceVolumePreset | AssistanceVolumeCustom;

/**
 * Numeric resolution for each preset. Calibrated against Wendler 5/3/1
 * Forever's actual prescriptions:
 * - **minimal** = 7th-Week floor (P25 + Pl25 + SL/Core25 = 75 reps per
 *   workout). This is Wendler's lowest published assistance prescription;
 *   anything less is "essentially no accessory work". Used as the
 *   recovery floor for deload and taper.
 * - **standard** = base 5/3/1 / Leader / BBB range (≈120 reps per main
 *   day, with an accessory day around ≈300 reps across ≈10 movements).
 * - **high** = Anchor / FSL upper end (≈150 reps per main day, ≈450
 *   accessory day across ≈14 movements).
 *
 * The numeric main:accessory ratios sit around 1:3 so an accessory day
 * carries 3× the per-main-day budget, matching how Forever templates
 * tend to use the dedicated accessory day for the bulk of volume.
 */
export const ASSISTANCE_VOLUME_PRESETS: Record<AssistanceVolumePreset, AssistanceVolumeCustom> = {
  minimal: { preset: 'custom', mainDayReps: 75, accessoryReps: 225, accessoryMovements: 7 },
  standard: { preset: 'custom', mainDayReps: 120, accessoryReps: 300, accessoryMovements: 10 },
  high: { preset: 'custom', mainDayReps: 150, accessoryReps: 450, accessoryMovements: 14 },
};

/**
 * Resolve any {@link AssistanceVolume} value (string preset or custom object)
 * into the numeric breakdown the suggester will read. Pure / total — no
 * external lookups, safe to call from any layer.
 */
export function resolveAssistanceVolume(volume: AssistanceVolume): AssistanceVolumeCustom {
  if (typeof volume === 'string') return { ...ASSISTANCE_VOLUME_PRESETS[volume] };
  return { ...volume };
}

/**
 * Phase-aware preset shift for per-week assistance volume. Mirrors the
 * intent of `volumeMultiplier` (taper/peak/deload should mean less
 * accessory work) but expresses it as a chip-level shift the user can see
 * in the BlockAssistanceVolumePanel.
 *
 * Peak and taper are intentionally NOT symmetric here — they serve
 * different training purposes:
 *  - Peak (race ~15–28d out) is a sharpening phase: shed accumulated
 *    fatigue, bias toward proven movements, drop AMRAP overload. But you
 *    are still TRAINING — main intensity stays high, accessory volume
 *    drops only modestly. Demoting `standard` straight to `minimal`
 *    (the old behavior) collapsed too aggressively and conflicted with
 *    multi-mandate goal profiles (marathon-prep mandates ≥3 slots ×
 *    25-rep Wendler floor = ≥75 reps, structurally above the 50-rep
 *    `minimal` budget). Now `standard` stays `standard` in peak and only
 *    `high` demotes one tier.
 *  - Taper (race ≤14d) is a recovery phase: arrive at the start line
 *    fresh. Accessory volume drops sharply to maintenance levels. The
 *    `minimal` floor is correct.
 *
 * Mapping:
 *   - 'normal'  → unchanged
 *   - 'deload'  → 'minimal' (always)
 *   - 'taper'   → 'minimal' (race ≤14d — recovery)
 *   - 'peak'    → 'high'→'standard', 'standard'→'standard', 'minimal'→'minimal'
 *
 * Custom volumes (object form) are left unchanged — the user gave explicit
 * numbers, so don't second-guess them automatically.
 */
export function effectiveAssistanceVolumeForPhase(
  stored: AssistanceVolume,
  phase: 'normal' | 'deload' | 'taper' | 'peak',
): AssistanceVolume {
  if (typeof stored !== 'string') return stored;
  if (phase === 'normal') return stored;
  if (phase === 'deload' || phase === 'taper') return 'minimal';
  // peak: only `high` demotes one tier; `standard` stays (peak is
  // sharpening, not full taper). `minimal` stays minimal.
  if (stored === 'high') return 'standard';
  return stored;
}

/**
 * Sensible default preset based on block kind (and 7th-week variant for the
 * seventh-week kind). Used when a block has no explicit `assistanceVolume`
 * yet — the BlockPlanEditor backfills this on first render.
 *
 * Block-kind defaults mirror Wendler Forever's volume/intensity shape:
 * - **leader** → `'standard'` — Leader blocks are *volume* blocks for the
 *   main lifts (5s PRO + heavy supplemental like BBB 5×10, SSL, etc.).
 *   The supplemental work already provides substantial systemic load;
 *   stacking `high` assistance on top is over-prescription.
 * - **anchor** → `'high'` — Anchor blocks are *intensity* blocks (classic
 *   5/3/1 with AMRAP, lighter supplemental — often FSL 3–5×5 or none).
 *   The main work is shorter, so there's room for more accessory work,
 *   and Wendler often pairs anchor cycles with more accessory variety.
 * - **standalone** → `'standard'` (no leader/anchor cadence; neutral default)
 * - **7th-week** (any variant) → `'minimal'` (recovery/test cycle, quality only)
 */
export function defaultAssistanceVolumeForKind(
  kind: BlockKind,
  seventhWeekKind?: SeventhWeekKind,
): AssistanceVolumePreset {
  if (kind === 'seventh-week') return 'minimal';
  if (kind === 'leader') return 'standard';
  if (kind === 'anchor') return 'high';
  return 'standard';
}

/**
 * Per-block deload-assistance scaling pick. Defined in `deload-scaling.ts`;
 * declared inline here as a string union to avoid a cycle (deload-scaling
 * imports types from this file). Keep in sync with `DeloadStrategy` in
 * deload-scaling.ts — TypeScript will not catch a divergence.
 */
type DeloadStrategy =
  | 'volume-half'
  | 'intensity-cut'
  | 'bodyweight-only'
  | 'mobility-recovery'
  | 'skip-assistance';

export interface ProgramBlock {
  id: string;
  name: string;
  kind: BlockKind;
  /**
   * For kind === 'seventh-week' blocks, which 7th-week variant. Required for
   * seventh-week blocks; ignored for other kinds.
   */
  seventhWeekKind?: SeventhWeekKind;
  /** Number of training weeks before deload. Wendler standard: 3. */
  weeksBeforeDeload: number;
  /** Whether the block ends with a deload week. Anchors usually have no deload. */
  includesDeload: boolean;
  supplementalTemplate: SupplementalTemplateId;
  /**
   * Main-work scheme. Default 'classic-531' (5/3/1+ with AMRAP top set).
   * Common Leader choice: '5s-pro'. Optional for backwards compat with v0 blocks.
   */
  mainScheme?: MainScheme;
  /**
   * Optional per-lift TM% override. If unset for a lift, falls back to the user's defaultTmPercent.
   * Wendler convention: Leader 85%, Anchor 85-90% (lifts may use different values).
   */
  tmPercentByLift?: Partial<Record<MainLift, number>>;
  /** ISO date the block started. */
  startedAt?: string;
  /** ISO date the block was completed. */
  completedAt?: string;
  createdAt: string;
  /** ID of the parent program (if part of a multi-block program). */
  programId?: string;
  /** 0-based position within the program. */
  sequenceIndex?: number;
  /**
   * Optional assistance plan: per-day defaults + optional per-week overrides.
   * See AssistancePlan / resolveAssistance for shape and resolution rules.
   *
   * @deprecated Prefer `plan.days[i].assistance` + `plan.assistanceOverrides`.
   * Kept for backward compat with v1 blocks; `derivePlan()` migrates this
   * legacy shape into the new model on the fly.
   */
  assistance?: AssistancePlan;
  /**
   * Per-block training-day plan. When set, this is the source of truth for
   * the block's day structure — the global ProgramSchedule.dayOrder is only a
   * default for newly-created blocks. Missing on legacy blocks; use
   * `effectivePlan(block, fallbackDayOrder, fallbackLiftsPerDay)` to read.
   */
  plan?: BlockPlan;
  /**
   * Optional per-block override for the number of supplemental sets. When set,
   * applies to every day in the block unless that day has its own
   * `supplementalSetsOverride`. Only honored by multi-set templates
   * (fsl, ssl, bbb, spinal-tap). E.g. drop FSL from 5×5 to 3×5 for a
   * marathon-prep block to leave more for cardio.
   */
  supplementalSetsOverride?: number;
  /**
   * ISO timestamp of the last mutation. Bumped on any write so the sync engine
   * can detect plan/assistance edits that don't change createdAt/startedAt/
   * completedAt. Optional for backwards compat with v1 blocks.
   */
  updatedAt?: string;
  /**
   * Records which deload-scaling strategy was applied (if any) to the
   * block's deload week. Set when the user accepts a recommendation from
   * `recommendDeloadScaling`. When set, the deload-scaling card on `/day`
   * stays hidden so we don't re-prompt. Reset by the block editor's
   * "Reset & re-recommend" action. Additive optional field — no migration.
   */
  deloadScalingChoice?: DeloadStrategy;
  /**
   * Block-level assistance-volume picker. Drives how much accessory work the
   * suggester proposes (and gives the user a quick manual lever). Either a
   * named preset ('minimal' | 'standard' | 'high') or an explicit numeric
   * breakdown via {@link AssistanceVolumeCustom}. When absent, callers should
   * fall back to {@link defaultAssistanceVolumeForKind}. Additive optional
   * field — old blocks round-trip without migration.
   */
  assistanceVolume?: AssistanceVolume;
  /**
   * Per-block override for available equipment. When set, the assistance
   * suggester filters movement candidates to those matching one of the
   * listed equipment types. When undefined, falls back to the parent
   * Program's `availableEquipment`. When both are undefined, no equipment
   * filter is applied (back-compat with pre-equipment data).
   */
  availableEquipment?: EquipmentType[];
}

/**
 * A user-defined training program: a planned sequence of blocks
 * (e.g. Leader, Leader, Anchor per Wendler 5/3/1 Forever).
 * Blocks reference back via `programId`.
 */
export interface Program {
  id: string;
  name: string;
  createdAt: string;
  /** ISO date the user marked the program complete (all blocks done). */
  completedAt?: string;
  /** ISO timestamp of the last mutation; bumped on rename. */
  updatedAt?: string;
  /**
   * Default available equipment for blocks in this program. Each block can
   * override via {@link ProgramBlock.availableEquipment}. When undefined, the
   * suggester applies no equipment filter.
   */
  availableEquipment?: EquipmentType[];
}

/**
 * The 4-day rotation: which lift is trained on which day-of-rotation (0..3).
 * Wendler Forever default: Press, Deadlift, Bench, Squat.
 */
export const DEFAULT_DAY_ORDER: MainLift[] = ['press', 'deadlift', 'bench', 'squat'];

/**
 * A single training day in the program schedule. `mainLifts` may be empty —
 * an empty array marks an **accessory day** (assistance/conditioning only,
 * no main lift, no supplemental, no warmup). `label` is an optional override
 * for the day's display name; falls back to "Day N" or auto-from-lifts.
 */
export interface ScheduleDay {
  mainLifts: MainLift[];
  label?: string;
  /**
   * Optional weekday this day is scheduled on. 0=Mon … 6=Sun (ISO-ish).
   * When set, the Today hero can render relative copy ("Today", "Tomorrow",
   * "In N days", "Overdue"). When unset, the day's `label` is parsed for an
   * English weekday name as a fallback. Both null = no relative scheduling.
   */
  weekday?: number;
}

/**
 * Normalize a schedule's `dayGroups` to the `ScheduleDay[]` shape. Tolerates
 * the legacy `MainLift[][]` representation (each inner array becomes a
 * label-less ScheduleDay). Empty days are preserved — they're meaningful as
 * accessory days. Returns `undefined` when input is `undefined` so callers
 * can detect "no explicit grouping" and fall back to auto-grouping.
 */
export function normalizeScheduleDays(
  input: ScheduleDay[] | MainLift[][] | undefined,
): ScheduleDay[] | undefined {
  if (!input) return undefined;
  if (input.length === 0) return [];
  // Legacy shape: each entry is a MainLift[] (array, not object).
  if (Array.isArray(input[0])) {
    return (input as MainLift[][]).map((g) => ({ mainLifts: [...g] }));
  }
  // Already in ScheduleDay shape.
  return (input as ScheduleDay[]).map((d) => ({
    mainLifts: [...(d.mainLifts ?? [])],
    ...(d.label !== undefined ? { label: d.label } : {}),
    ...(typeof d.weekday === 'number' ? { weekday: d.weekday } : {}),
  }));
}

export interface ProgramSchedule {
  /** Always 'singleton'. */
  id: 'singleton';
  dayOrder: MainLift[];
  /**
   * How many lifts are trained per training day. Default 1 (one lift per session,
   * dayOrder.length sessions/week). Set to 2 to pair lifts (Spinal Tap-style 2x/week).
   * Determines `groupDays(dayOrder, liftsPerDay)` chunks when `dayGroups` is unset.
   */
  liftsPerDay?: number;
  /**
   * Explicit per-day training plan. When set, this overrides the
   * dayOrder + liftsPerDay auto-grouping and becomes the source of truth
   * for how many training days/week and which lifts go on each day.
   *
   * A `ScheduleDay` with `mainLifts: []` is an **accessory day**: a training
   * day with no main lift, no supplemental, no warmup — just assistance /
   * conditioning.
   *
   * For backwards compatibility this field also accepts the legacy
   * `MainLift[][]` shape; `normalizeScheduleDays()` upgrades it on read.
   */
  dayGroups?: ScheduleDay[] | MainLift[][];
  /** Active block ID, if any. */
  activeBlockId?: string;
  /**
   * Default supplemental template for every block. Source of truth — when
   * changed, propagated to all live blocks via the Training schedule panel.
   * Falls back to 'fsl' when undefined for back-compat with pre-existing data.
   */
  supplementalTemplate?: SupplementalTemplateId;
  /**
   * Default override for the supplemental set count. `undefined` = use the
   * template's default (e.g. FSL = 5). Propagated to all live blocks.
   */
  supplementalSetsOverride?: number;
  /**
   * Cursor pointing at the next pending day group. `groupIndex` indexes into
   * `effectiveScheduleDays(schedule)` (i.e., per-day, not per-main-lift).
   * Advances by one when all main lifts in the current group have been logged
   * for the current (blockId, week). Accessory days (empty mainLifts) are
   * advanced explicitly via the day card's "Mark complete" action.
   *
   * Migrated from the legacy `dayIndex` shape on read; see
   * `migrateScheduleCursor()` in apps/web/src/lib/db.ts.
   */
  cursor?: {
    blockId: string;
    week: WendlerWeek;
    groupIndex: number; // 0..(effectiveScheduleDays(schedule).length - 1)
  };
  updatedAt: string;
}

/**
 * Group dayOrder into training-day chunks of `liftsPerDay` lifts each.
 * E.g. dayOrder=[press,deadlift,bench,squat], liftsPerDay=2
 *   → [[press,deadlift],[bench,squat]]
 */
export function groupDays(dayOrder: MainLift[], liftsPerDay = 1): MainLift[][] {
  const n = Math.max(1, Math.floor(liftsPerDay));
  const out: MainLift[][] = [];
  for (let i = 0; i < dayOrder.length; i += n) {
    out.push(dayOrder.slice(i, i + n));
  }
  return out;
}

/**
 * Resolve the effective per-day lift groupings for a schedule:
 * explicit `dayGroups` (preserving accessory days with empty `mainLifts`)
 * → auto-grouped from dayOrder.
 *
 * Returns the legacy `MainLift[][]` shape for back-compat with all current
 * call sites. For label-aware reads, use `effectiveScheduleDays()`.
 */
export function effectiveDayGroups(
  schedule: Pick<ProgramSchedule, 'dayGroups' | 'dayOrder' | 'liftsPerDay'>,
): MainLift[][] {
  return effectiveScheduleDays(schedule).map((d) => d.mainLifts);
}

/**
 * Same as `effectiveDayGroups` but returns the full `ScheduleDay[]` shape
 * (with optional labels). Preserves accessory days (empty mainLifts).
 */
export function effectiveScheduleDays(
  schedule: Pick<ProgramSchedule, 'dayGroups' | 'dayOrder' | 'liftsPerDay'>,
): ScheduleDay[] {
  const explicit = normalizeScheduleDays(schedule.dayGroups);
  if (explicit && explicit.length > 0) return explicit;
  return groupDays(schedule.dayOrder, schedule.liftsPerDay ?? 1).map((g) => ({
    mainLifts: g,
  }));
}

/** Day-group index (0-based) containing the per-lift dayIndex. */
export function dayGroupIndex(dayIndex: number, liftsPerDay = 1): number {
  return Math.floor(dayIndex / Math.max(1, Math.floor(liftsPerDay)));
}

/**
 * The week the cursor should start on when activating a block. Normal blocks
 * start at week 1; 7th-week protocol blocks (which contain only one week)
 * start at '7w'.
 */
export function initialCursorWeek(
  block: Pick<ProgramBlock, 'kind'>,
): WendlerWeek {
  return block.kind === 'seventh-week' ? '7w' : 1;
}

/**
 * Total sessions in a block: dayOrder × (weeksBeforeDeload + (includesDeload ? 1 : 0)).
 */
export function totalSessionsInBlock(block: ProgramBlock, dayOrder: MainLift[]): number {
  const weeks = block.weeksBeforeDeload + (block.includesDeload ? 1 : 0);
  return weeks * dayOrder.length;
}

/**
 * Approximate the calendar start date of a given week within a block, so
 * downstream logic (e.g. per-week phase auto-derivation in the assistance
 * suggester) can ask "what date will this week land on?".
 *
 * Each Wendler week is treated as one calendar week (7 days) starting from
/**
 * Calendar start date of `weekScope` within a block, anchored to `anchor`
 * (the date training actually begins, NOT necessarily when the block was
 * activated). Pass the first session date of the block, falling back to "now"
 * if no sessions have been logged yet — that way activating a block in
 * advance doesn't skew phase auto-derivation.
 *
 * Mapping (relative to `anchor`):
 *   - week 1   → +0 days
 *   - week 2   → +7 days
 *   - week 3   → +14 days
 *   - 'deload' → +(weeksBeforeDeload * 7) days
 *   - '7w'     → undefined (a 7th-week block is a separate one-week block;
 *                its own `startedAt` is the right reference, not this helper)
 *
 * Returns undefined when the anchor is missing/unparseable or the scope is
 * '7w'.
 */
export function weekStartDate(
  anchor: Date | string | null | undefined,
  weeksBeforeDeload: number,
  weekScope: WendlerWeek,
): Date | undefined {
  if (weekScope === '7w') return undefined;
  if (!anchor) return undefined;
  const start = anchor instanceof Date ? new Date(anchor.getTime()) : new Date(anchor);
  if (Number.isNaN(start.getTime())) return undefined;
  const offsetDays = weekScope === 'deload' ? weeksBeforeDeload * 7 : (weekScope - 1) * 7;
  return new Date(start.getTime() + offsetDays * 86400000);
}

/**
 * Advance the cursor by one day group. Returns null when the block is complete.
 * `numGroups` is the number of training days per week, i.e.
 * `effectiveScheduleDays(schedule).length`.
 */
export function advanceCursor(
  cursor: { week: WendlerWeek; groupIndex: number },
  block: Pick<ProgramBlock, 'includesDeload'>,
  numGroups: number,
): { week: WendlerWeek; groupIndex: number } | null {
  const nextGroup = cursor.groupIndex + 1;
  if (nextGroup < numGroups) {
    return { week: cursor.week, groupIndex: nextGroup };
  }
  // Wrap to next week
  const weekOrder: WendlerWeek[] = [1, 2, 3];
  if (block.includesDeload) weekOrder.push('deload');
  const idx = weekOrder.indexOf(cursor.week);
  // Unrecognized weeks (e.g. '7w' on a seventh-week block) have no successor —
  // a 7th-week block contains only the '7w' week, so completing the last day
  // group ends the block.
  if (idx === -1 || idx === weekOrder.length - 1) return null;
  const nextWeek = weekOrder[idx + 1]!;
  return { week: nextWeek, groupIndex: 0 };
}

/**
 * Resolve the TM% for a lift in a given block, falling back to a default.
 */
export function tmPercentForLift(
  block: ProgramBlock,
  lift: MainLift,
  defaultTmPercent: number,
): number {
  return block.tmPercentByLift?.[lift] ?? defaultTmPercent;
}

// --- Assistance work ------------------------------------------------------
//
// Wendler 5/3/1 prescribes a small set of assistance categories per training
// day (Push / Pull / Single-leg / Core / Accessory). Each entry is a movement
// + sets/reps prescription (no fixed weight — the user picks load at the bar).
// Time-based prescriptions (e.g. "3×30 sec each side") store the seconds
// count in `reps` and set `unit: 'sec'`.

export type AssistanceCategory =
  | 'push'
  | 'pull'
  | 'single-leg'
  | 'core'
  | 'carry'
  | 'accessory'
  | 'other';

export const ASSISTANCE_CATEGORIES: { id: AssistanceCategory; label: string }[] = [
  { id: 'push', label: 'Push' },
  { id: 'pull', label: 'Pull' },
  { id: 'single-leg', label: 'Single-leg' },
  { id: 'core', label: 'Core' },
  { id: 'carry', label: 'Carry' },
  { id: 'accessory', label: 'Accessory' },
  { id: 'other', label: 'Other' },
];

export type AssistanceUnit = 'reps' | 'sec' | 'each-side' | 'each-arm' | 'each-leg';

export interface AssistanceEntry {
  id: string;
  category: AssistanceCategory;
  /** Optional reference to a Movement; when unset, movementName stands alone. */
  movementId?: string;
  /** Display name; always required so we can render even when movementId is missing. */
  movementName: string;
  sets: number;
  /** Target reps (or seconds when unit==='sec'). For ranges, this is the minimum. */
  reps: number;
  /** Optional max reps for ranges like "3×8–10". */
  repsMax?: number;
  unit?: AssistanceUnit;
  /**
   * When true, the entry is flagged AMRAP — every set logged for it is
   * treated as as-many-reps-as-possible. The user picks which set(s) to take
   * to failure. Wendler convention; rendered with a trailing "+" in
   * prescriptions ("3×8+", "3×8-10+").
   */
  isAmrap?: boolean;
  /** Free-text load hint shown next to the prescription ("heavy", "bodyweight", "light"). */
  loadHint?: string;
  notes?: string;
  /**
   * Optional one-line "why this movement" string written by the assistance
   * suggester (Phase 5/6). Surfaced as a small ✨ chip in the row so the user
   * can see the rationale even after the suggestion panel is dismissed.
   * Cleared when the user edits movement or prescription manually — it would
   * no longer accurately describe the entry.
   */
  suggestionRationale?: string;
}

/**
 * Per-block assistance plan. Stored on ProgramBlock.assistance.
 *
 * `perDay` keys on the day-group index (0,1,2,…) — same numbering used by
 * `groupDays`. `perWeekDay` overrides the default for a specific week+day,
 * keyed as `${week}|${dayGroupIndex}` (e.g. `1|0`, `deload|2`).
 */
export interface AssistancePlan {
  perDay: Record<number, AssistanceEntry[]>;
  perWeekDay?: Record<string, AssistanceEntry[]>;
}

/**
 * Resolve the assistance entries for a specific (week, dayGroupIndex):
 * per-week override → per-day default → empty.
 */
export function resolveAssistance(
  block: Pick<ProgramBlock, 'assistance'>,
  week: WendlerWeek,
  dayGroupIndex: number,
): AssistanceEntry[] {
  const plan = block.assistance;
  if (!plan) return [];
  const overrideKey = `${week}|${dayGroupIndex}`;
  const override = plan.perWeekDay?.[overrideKey];
  if (override) return override;
  return plan.perDay?.[dayGroupIndex] ?? [];
}

/**
 * Whether a (week, dayGroupIndex) cell currently has an explicit override
 * (rather than inheriting from the per-day default).
 */
export function hasAssistanceOverride(
  block: Pick<ProgramBlock, 'assistance'>,
  week: WendlerWeek,
  dayGroupIndex: number,
): boolean {
  return !!block.assistance?.perWeekDay?.[`${week}|${dayGroupIndex}`];
}

/**
 * Format an entry's prescription as a compact, reversible string.
 * Inverse of `parseAssistancePrescription`.
 *  3 sets × 10 reps              → "3×10"
 *  3 sets × 8 to 10 reps         → "3×8-10"
 *  3 sets × 30 seconds            → "3×30 sec"
 *  3 sets × 10 each leg           → "3×10 each leg"
 */
export function formatAssistancePrescription(
  entry: Pick<AssistanceEntry, 'sets' | 'reps' | 'repsMax' | 'unit' | 'isAmrap'>,
): string {
  const reps =
    entry.repsMax && entry.repsMax !== entry.reps
      ? `${entry.reps}-${entry.repsMax}`
      : String(entry.reps);
  let suffix = '';
  switch (entry.unit) {
    case 'sec':
      suffix = ' sec';
      break;
    case 'each-side':
      suffix = ' each side';
      break;
    case 'each-arm':
      suffix = ' each arm';
      break;
    case 'each-leg':
      suffix = ' each leg';
      break;
    default:
      suffix = '';
  }
  const amrap = entry.isAmrap ? '+' : '';
  return `${entry.sets}\u00d7${reps}${amrap}${suffix}`;
}

/**
 * Parse a freeform prescription string into AssistanceEntry fields. Tolerant
 * of formatting variations: "3x10", "3X10", "3 × 10", "3x8-10", "3x8–10",
 * "5 x 30 sec", "3x10 each side", "3x10ea", "3x10 ea side", "3x8 each leg".
 * Returns null if the input can't be parsed (caller should keep the prior
 * values in that case).
 */
export interface ParsedPrescription {
  sets: number;
  reps: number;
  repsMax?: number;
  unit?: 'sec' | 'each-side' | 'each-arm' | 'each-leg';
  isAmrap?: boolean;
}
export function parseAssistancePrescription(input: string): ParsedPrescription | null {
  // Normalise: lower-case, en/em dashes → ascii hyphen, × → x
  const s = input
    .toLowerCase()
    .replace(/[×✕✖]/g, 'x')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  // Match "<sets>x<reps>[-<repsMax>][+][ <unit>]"
  const m = s.match(/^(\d+)\s*x\s*(\d+)(?:\s*-\s*(\d+))?\s*(\+)?\s*(.*)$/);
  if (!m) return null;
  const sets = parseInt(m[1]!, 10);
  const reps = parseInt(m[2]!, 10);
  const repsMaxRaw = m[3] ? parseInt(m[3], 10) : undefined;
  const isAmrap = !!m[4];
  const tail = (m[5] ?? '').trim();
  if (!Number.isFinite(sets) || !Number.isFinite(reps) || sets < 1 || reps < 1) return null;
  let unit: ParsedPrescription['unit'];
  if (tail) {
    if (/^(s|sec|secs|seconds?)$/.test(tail)) unit = 'sec';
    else if (/each\s*-?\s*leg|\/leg|per\s*leg|ea\s*leg/.test(tail)) unit = 'each-leg';
    else if (/each\s*-?\s*arm|\/arm|per\s*arm|ea\s*arm/.test(tail)) unit = 'each-arm';
    else if (/each\s*-?\s*side|\/side|per\s*side|ea\s*side|^ea$|^each$/.test(tail)) unit = 'each-side';
    else return null; // unknown trailing token — refuse to misinterpret
  }
  const out: ParsedPrescription = { sets, reps };
  if (repsMaxRaw && repsMaxRaw !== reps) out.repsMax = repsMaxRaw;
  if (unit) out.unit = unit;
  if (isAmrap) out.isAmrap = true;
  return out;
}

/**
 * Format an entry's prescription as a compact label.
 * "3×10 DB Incline Bench Press"
 * "3×8–10 Chinup"
 * "3×30 sec Plank"
 * "3×10 each leg DB Single-leg RDL"
 */
export function assistanceLabel(entry: AssistanceEntry): string {
  const reps =
    entry.repsMax && entry.repsMax !== entry.reps
      ? `${entry.reps}\u2013${entry.repsMax}`
      : String(entry.reps);
  const unit = entry.unit;
  let qty: string;
  if (unit === 'sec') {
    qty = `${reps} sec`;
  } else if (unit === 'each-side' || unit === 'each-arm' || unit === 'each-leg') {
    const which = unit === 'each-side' ? 'each side' : unit === 'each-arm' ? 'each arm' : 'each leg';
    qty = `${reps} ${which}`;
  } else {
    qty = reps;
  }
  const amrap = entry.isAmrap ? '+' : '';
  return `${entry.sets}\u00d7${qty}${amrap} ${entry.movementName}`.trim();
}

/**
 * Derive the most likely AssistanceCategory for a Movement, based on its
 * movement pattern with name-keyword overrides for single-leg work (which the
 * pattern alone cannot express — a single-leg RDL is still a `hinge`).
 */
export function categoryFromMovement(
  movement: Pick<Movement, 'name' | 'pattern'>,
): AssistanceCategory {
  const lower = movement.name.toLowerCase();
  const singleLegKeywords = [
    'lunge',
    'split squat',
    'bulgarian',
    'step-up',
    'step up',
    'pistol',
    'single-leg',
    'single leg',
    'one-leg',
    'one leg',
    'skater',
    'shrimp squat',
  ];
  if (singleLegKeywords.some((kw) => lower.includes(kw))) return 'single-leg';

  switch (movement.pattern) {
    case 'push-horizontal':
    case 'push-vertical':
      return 'push';
    case 'pull-horizontal':
    case 'pull-vertical':
      return 'pull';
    case 'core':
      return 'core';
    case 'squat':
    case 'hinge':
      return 'accessory';
    case 'carry':
      return 'carry';
    default:
      return 'other';
  }
}

// --- BlockPlan: per-block day structure ----------------------------------
//
// Replaces the implicit "dayOrder × liftsPerDay" derivation from the global
// ProgramSchedule. Each block carries its own list of training days, each
// with its own main lifts (0..N), optional supplemental override, and inline
// assistance entries. Per-week overrides are keyed by stable dayId so
// reordering days doesn't scramble them.

export interface BlockDay {
  /** Stable across reorders. Used in `assistanceOverrides` keys. */
  id: string;
  /** Optional user-facing label; falls back to "Day N" or auto-from-lifts. */
  label?: string;
  /** Main lifts trained on this day. Empty array = pure assistance day. */
  mainLifts: MainLift[];
  /** Per-day supplemental override; falls back to `block.supplementalTemplate`. */
  supplementalTemplate?: SupplementalTemplateId;
  /** Per-day override for supplemental set count; falls back to `block.supplementalSetsOverride`. */
  supplementalSetsOverride?: number;
  /** Inline assistance entries for this day (per-day default). */
  assistance: AssistanceEntry[];
  /**
   * Per-lift override that flags specific main-set indices (0-based) as AMRAP.
   * Lets users force an AMRAP set in 5s PRO blocks, or stack extra AMRAPs in
   * classic 5/3/1. Indices outside the main-set count are ignored.
   * Example: `{ press: [2] }` makes Press's top set AMRAP for this day only.
   */
  amrapMainSetIndices?: Partial<Record<MainLift, number[]>>;
  /**
   * Optional weekday this day is scheduled on. 0=Mon … 6=Sun.
   * Falls back to the schedule's ScheduleDay.weekday when unset, then to
   * parsing the day's `label` for an English weekday name. See
   * `resolveDayWeekday()`.
   */
  weekday?: number;
}

export interface BlockPlan {
  days: BlockDay[];
  /** Per-week override of assistance, keyed `${week}|${dayId}`. */
  assistanceOverrides?: Record<string, AssistanceEntry[]>;
}

/**
 * Materialize a BlockPlan from a legacy block (no `plan` field).
 *
 * Two overloads:
 *
 *  - `derivePlan(block, schedule)` — preferred. Uses `effectiveScheduleDays`
 *    so accessory days (empty mainLifts) and per-day labels propagate into
 *    the materialized plan.
 *  - `derivePlan(block, dayOrder, liftsPerDay?)` — legacy. Uses flat dayOrder
 *    grouping and cannot represent accessory days.
 *
 * Stable dayIds are generated as `legacy:${dayGroupIndex}` so subsequent
 * saves can match existing per-week overrides.
 */
export function derivePlan(
  block: Pick<ProgramBlock, 'assistance'>,
  schedule: Pick<ProgramSchedule, 'dayGroups' | 'dayOrder' | 'liftsPerDay'>,
): BlockPlan;
export function derivePlan(
  block: Pick<ProgramBlock, 'assistance'>,
  fallbackDayOrder: MainLift[],
  fallbackLiftsPerDay?: number,
): BlockPlan;
export function derivePlan(
  block: Pick<ProgramBlock, 'assistance'>,
  scheduleOrDayOrder:
    | Pick<ProgramSchedule, 'dayGroups' | 'dayOrder' | 'liftsPerDay'>
    | MainLift[],
  fallbackLiftsPerDay = 1,
): BlockPlan {
  let scheduleDays: ScheduleDay[];
  if (Array.isArray(scheduleOrDayOrder)) {
    scheduleDays = groupDays(scheduleOrDayOrder, fallbackLiftsPerDay).map((g) => ({
      mainLifts: g,
    }));
  } else {
    scheduleDays = effectiveScheduleDays(scheduleOrDayOrder);
  }
  const days: BlockDay[] = scheduleDays.map((sd, di) => ({
    id: `legacy:${di}`,
    ...(sd.label ? { label: sd.label } : {}),
    mainLifts: sd.mainLifts,
    assistance: block.assistance?.perDay?.[di] ?? [],
  }));
  // Migrate per-week overrides keyed by index → keyed by legacy dayId.
  let overrides: Record<string, AssistanceEntry[]> | undefined;
  if (block.assistance?.perWeekDay) {
    overrides = {};
    for (const [k, v] of Object.entries(block.assistance.perWeekDay)) {
      const [week, idxStr] = k.split('|');
      if (week === undefined || idxStr === undefined) continue;
      overrides[`${week}|legacy:${idxStr}`] = v;
    }
  }
  return { days, assistanceOverrides: overrides };
}

/**
 * Read the effective plan for a block: explicit `block.plan` if set,
 * otherwise derived from the schedule (preferred) or legacy dayOrder.
 */
export function effectivePlan(
  block: Pick<ProgramBlock, 'plan' | 'assistance'>,
  schedule: Pick<ProgramSchedule, 'dayGroups' | 'dayOrder' | 'liftsPerDay'>,
): BlockPlan;
export function effectivePlan(
  block: Pick<ProgramBlock, 'plan' | 'assistance'>,
  fallbackDayOrder: MainLift[],
  fallbackLiftsPerDay?: number,
): BlockPlan;
export function effectivePlan(
  block: Pick<ProgramBlock, 'plan' | 'assistance'>,
  scheduleOrDayOrder:
    | Pick<ProgramSchedule, 'dayGroups' | 'dayOrder' | 'liftsPerDay'>
    | MainLift[],
  fallbackLiftsPerDay = 1,
): BlockPlan {
  if (block.plan) {
    // Program-level schedule day labels and weekdays take precedence over any
    // block-level value, so renaming a day or assigning it to a weekday on the
    // program detail page automatically flows into every block. The
    // block-level value is only used as a fallback when the schedule has none
    // at that index.
    if (!Array.isArray(scheduleOrDayOrder)) {
      const scheduleDays = effectiveScheduleDays(scheduleOrDayOrder);
      const needsRewrite = block.plan.days.some((d, i) => {
        const sd = scheduleDays[i];
        const scheduleLabel = sd?.label?.trim();
        const scheduleWeekday = sd?.weekday;
        if (scheduleLabel && (d.label ?? '') !== scheduleLabel) return true;
        if (typeof scheduleWeekday === 'number' && d.weekday !== scheduleWeekday) return true;
        return false;
      });
      if (!needsRewrite) return block.plan;
      return {
        ...block.plan,
        days: block.plan.days.map((d, i) => {
          const sd = scheduleDays[i];
          const scheduleLabel = sd?.label?.trim();
          const scheduleWeekday = sd?.weekday;
          let next = d;
          if (scheduleLabel) next = { ...next, label: scheduleLabel };
          if (typeof scheduleWeekday === 'number') next = { ...next, weekday: scheduleWeekday };
          return next;
        }),
      };
    }
    return block.plan;
  }
  if (Array.isArray(scheduleOrDayOrder)) {
    return derivePlan(block, scheduleOrDayOrder, fallbackLiftsPerDay);
  }
  return derivePlan(block, scheduleOrDayOrder);
}

/**
 * Resolve the assistance entries for a (week, dayId) cell:
 * per-week override → day's default → empty.
 */
export function resolveDayAssistance(
  plan: BlockPlan,
  week: WendlerWeek,
  dayId: string,
): AssistanceEntry[] {
  const override = plan.assistanceOverrides?.[`${week}|${dayId}`];
  if (override) return override;
  const day = plan.days.find((d) => d.id === dayId);
  return day?.assistance ?? [];
}

/** True iff (week, dayId) has an explicit override row. */
export function hasDayAssistanceOverride(
  plan: BlockPlan,
  week: WendlerWeek,
  dayId: string,
): boolean {
  return !!plan.assistanceOverrides?.[`${week}|${dayId}`];
}

/**
 * Default label for a day: user override → "Day N" → "Press + Bench" etc.
 */
export function dayLabel(day: BlockDay, dayIndex: number): string {
  if (day.label && day.label.trim()) return day.label.trim();
  if (day.mainLifts.length === 0) return `Day ${dayIndex + 1} · Assistance only`;
  return `Day ${dayIndex + 1}`;
}

// --- Weekday scheduling --------------------------------------------------
//
// Internal numbering: 0=Mon, 1=Tue, … 6=Sun. JS `Date.getDay()` uses
// 0=Sun..6=Sat; convert with `jsDayToWeekday()`.

/** Short label for a weekday (0=Mon..6=Sun). */
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
/** Long label for a weekday (0=Mon..6=Sun). */
export const WEEKDAY_LONG = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** Convert JS `Date.getDay()` (Sun=0..Sat=6) to internal Mon=0..Sun=6. */
export function jsDayToWeekday(jsDay: number): number {
  return ((jsDay + 6) % 7 + 7) % 7;
}

/**
 * Parse an English weekday name from a free-text label. Recognizes prefixes
 * like "Mon", "Monday", "monday", and tolerates trailing text ("Monday —
 * heavy day"). Returns 0..6 (Mon=0) or null when no weekday name is found.
 */
export function parseWeekdayFromLabel(label?: string | null): number | null {
  if (!label) return null;
  const head = label.trim().toLowerCase();
  if (!head) return null;
  // Try long names first (more specific), then short prefixes.
  for (let i = 0; i < WEEKDAY_LONG.length; i++) {
    const long = WEEKDAY_LONG[i]!.toLowerCase();
    if (head === long || head.startsWith(long + ' ') || head.startsWith(long + ',') || head.startsWith(long + '·') || head.startsWith(long + '-')) {
      return i;
    }
  }
  for (let i = 0; i < WEEKDAY_SHORT.length; i++) {
    const short = WEEKDAY_SHORT[i]!.toLowerCase();
    if (
      head === short ||
      head.startsWith(short + ' ') ||
      head.startsWith(short + ',') ||
      head.startsWith(short + '·') ||
      head.startsWith(short + '-')
    ) {
      return i;
    }
  }
  return null;
}

/**
 * Resolve the effective weekday for a day: explicit `weekday` field wins,
 * else parse the day's `label`. Returns 0..6 (Mon=0) or null.
 */
export function resolveDayWeekday(day: {
  weekday?: number | null;
  label?: string | null;
}): number | null {
  if (typeof day.weekday === 'number' && day.weekday >= 0 && day.weekday <= 6) {
    return day.weekday;
  }
  return parseWeekdayFromLabel(day.label ?? null);
}

/**
 * Given a block's days and the user's recurring run-plan slots, return the
 * indices of block days that ARE long-run days (per the user's recurring
 * run-plan). The prompt builder uses these to compute "the day BEFORE each
 * long run" (by subtracting 1 from each index) and emit the pre-long-run
 * veto directive: heavy lower-body and CNS-taxing conditioning should be
 * avoided the day before a long run.
 *
 * Returns `undefined` when the user has no long-run slots configured, or
 * no block day lines up with one. The suggester treats `undefined` as
 * "no long-run guidance needed".
 *
 * Pure — moved out of `SuggestAssistanceForBlock.tsx` in v279 because it's
 * a pure derivation that benefits from domain-package test coverage.
 */
export function computeLongRunDays(
  days: ReadonlyArray<{ weekday?: number | null; label?: string | null }>,
  slots: ReadonlyArray<{ dayOfWeek: number; kind: string }> | undefined,
): number[] | undefined {
  if (!slots || slots.length === 0) return undefined;
  const longDows = new Set(
    slots.filter((s) => s.kind === 'long').map((s) => s.dayOfWeek),
  );
  if (longDows.size === 0) return undefined;
  const out: number[] = [];
  days.forEach((d, i) => {
    const wd = resolveDayWeekday({ weekday: d.weekday, label: d.label });
    if (typeof wd === 'number' && longDows.has(wd)) out.push(i);
  });
  return out.length > 0 ? out : undefined;
}

/** Strip the time component so day-diffs are purely calendar based. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Compute a relative description of when the next workout is due.
 *
 * - `targetWeekday`: 0..6 (Mon=0).
 * - `today`: reference date (typically `new Date()`).
 * - `lastCompletedAt`: optional ISO/Date of the most recent completed
 *   workout for the active block. Used to detect "you missed your last
 *   training day" — the next expected date is the next occurrence of
 *   `targetWeekday` strictly after `lastCompletedAt`'s date.
 *
 * Returns:
 *   - `kind: 'today'` when expected is today.
 *   - `kind: 'tomorrow'` when expected is +1 day.
 *   - `kind: 'in-days'` when expected is +2..+6 days.
 *   - `kind: 'overdue'` when expected is in the past.
 * `days` is the (positive) day count: 0 for today, N for in-days, N for
 * how many days overdue.
 */
export function describeNextWorkout(args: {
  targetWeekday: number;
  today: Date;
  lastCompletedAt?: Date | string | null;
}): { kind: 'today' | 'tomorrow' | 'in-days' | 'overdue'; days: number } {
  const today0 = startOfDay(args.today);
  const todayWd = jsDayToWeekday(today0.getDay());
  const target = ((args.targetWeekday % 7) + 7) % 7;

  let expected: Date;
  if (args.lastCompletedAt) {
    const last = startOfDay(
      typeof args.lastCompletedAt === 'string'
        ? new Date(args.lastCompletedAt)
        : args.lastCompletedAt,
    );
    const lastWd = jsDayToWeekday(last.getDay());
    // Next occurrence strictly after `last`. If target == lastWd, that's
    // a full week (7 days) ahead — you wouldn't train the same day again.
    const ahead = ((target - lastWd + 7) % 7) || 7;
    expected = new Date(last);
    expected.setDate(expected.getDate() + ahead);
  } else {
    // No prior session: next on/after today.
    const ahead = (target - todayWd + 7) % 7;
    expected = new Date(today0);
    expected.setDate(expected.getDate() + ahead);
  }

  const diffMs = expected.getTime() - today0.getTime();
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return { kind: 'overdue', days: -diffDays };
  if (diffDays === 0) return { kind: 'today', days: 0 };
  if (diffDays === 1) return { kind: 'tomorrow', days: 1 };
  return { kind: 'in-days', days: diffDays };
}

/**
 * Resolve the effective supplemental set count for a given day:
 * day.supplementalSetsOverride → block.supplementalSetsOverride → undefined.
 * Returning `undefined` means "use the template default".
 */
export function resolveSupplementalSets(
  block: Pick<ProgramBlock, 'supplementalSetsOverride'>,
  day?: Pick<BlockDay, 'supplementalSetsOverride'> | null,
): number | undefined {
  return day?.supplementalSetsOverride ?? block.supplementalSetsOverride;
}

/**
 * Re-shape a block's plan to match a new schedule structure while preserving
 * as much per-day customization as possible:
 *
 *  - `mainLifts` is overwritten to the new groups' lifts.
 *  - `assistance`, `label`, supplemental overrides, AND the day's `id` are
 *    carried forward by index up to min(oldLen, newLen). New extra days get
 *    fresh ids; their `label` (if any) is taken from the input ScheduleDay
 *    so accessory-day labels propagate immediately.
 *  - Per-week assistance overrides keyed by a kept dayId remain valid.
 *    Overrides for dayIds that disappear are dropped.
 *
 * Three overloads:
 *
 *  - `(oldPlan, scheduleDays: ScheduleDay[], newId)` — preferred. Carries
 *    accessory-day labels into new days.
 *  - `(oldPlan, groups: MainLift[][], newId)` — legacy (no labels).
 *  - `(oldPlan, dayOrder: MainLift[], liftsPerDay, newId)` — legacy.
 */
export function regeneratePlanForSchedule(
  oldPlan: BlockPlan,
  arg2: ScheduleDay[] | MainLift[] | MainLift[][],
  arg3: number | (() => string),
  arg4?: () => string,
): BlockPlan {
  let scheduleDays: ScheduleDay[];
  let newId: () => string;
  if (typeof arg3 === 'function') {
    // (oldPlan, ScheduleDay[] | MainLift[][], newId)
    newId = arg3;
    const arr = arg2 as ScheduleDay[] | MainLift[][];
    if (arr.length === 0) {
      scheduleDays = [];
    } else if (Array.isArray((arr as MainLift[][])[0])) {
      scheduleDays = (arr as MainLift[][]).map((lifts) => ({ mainLifts: lifts }));
    } else {
      scheduleDays = arr as ScheduleDay[];
    }
  } else {
    // (oldPlan, MainLift[], liftsPerDay, newId)
    scheduleDays = groupDays(arg2 as MainLift[], arg3).map((lifts) => ({ mainLifts: lifts }));
    newId = arg4 as () => string;
  }
  const oldDays = oldPlan.days;
  const days: BlockDay[] = scheduleDays.map((sd, i) => {
    const carry = oldDays[i];
    if (carry) {
      // Keep user-customized label if present; otherwise take the schedule's.
      const label = carry.label?.trim() ? carry.label : sd.label;
      // Schedule weekday wins when present; otherwise keep block's.
      const weekday = typeof sd.weekday === 'number' ? sd.weekday : carry.weekday;
      return {
        ...carry,
        ...(label ? { label } : {}),
        ...(typeof weekday === 'number' ? { weekday } : {}),
        mainLifts: sd.mainLifts,
      };
    }
    return {
      id: newId(),
      ...(sd.label ? { label: sd.label } : {}),
      ...(typeof sd.weekday === 'number' ? { weekday: sd.weekday } : {}),
      mainLifts: sd.mainLifts,
      assistance: [],
    };
  });
  let overrides = oldPlan.assistanceOverrides;
  if (overrides) {
    const keep: Record<string, AssistanceEntry[]> = {};
    const liveIds = new Set(days.map((d) => d.id));
    for (const [k, v] of Object.entries(overrides)) {
      const dayId = k.split('|', 2)[1];
      if (dayId && liveIds.has(dayId)) keep[k] = v;
    }
    overrides = Object.keys(keep).length ? keep : undefined;
  }
  return { days, assistanceOverrides: overrides };
}

