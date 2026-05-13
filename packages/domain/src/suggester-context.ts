// Suggester Context — pure derivation of everything the AI suggester and
// its deterministic fallback need to share: phase + volume + directives +
// profile context + environmental signals. Extracted from
// `apps/web/src/components/SuggestAssistanceForBlock.tsx` in v281 to give
// both code paths a single source of truth, replacing a 150-LOC inline
// memo whose drift risk was the highest-value structural concern in the
// v278 architecture review.
//
// Pure: same input → same output. Threaded `now: Date` parameter (defaults
// to `new Date()`) so per-week derivation can answer "what phase will this
// week land in?" rather than always "what phase is it right now?"
//
// Consumes (web/Dexie reads happen in the component):
//   - block (kind, seventhWeekKind, programId, weeksBeforeDeload, name, …)
//   - settings (goalFlags, goalNotes, trainingProfile)
//   - upcomingRaces, programs, runPlan, goals, days, movements
//   - blockFirstSessionDate (Date | null) for per-week anchoring
//   - weekScope (1 | 2 | 3 | 'deload' | '7w')
//
// Returns:
//   - All inputs `buildAssistancePrompt()` needs
//   - All inputs the deterministic fallback (`suggestAssistance()`) needs
//   - phase + phaseSource so the UI can render the "Auto · phase" badge
//   - phasePresetShift so the UI/prompt can surface the preset auto-shift

import {
  type GoalFlags,
  DEFAULT_GOAL_FLAGS,
} from './goal-flags';
import { computeEffectiveGoalFlags } from './taper';
import {
  deriveGoalFlags,
  type PhaseSource,
} from './training-profile';
import type { TrainingProfile, TrainingPhase } from './training-profile-types';
import type { RaceLike } from './races';
import {
  computeLongRunDays,
  defaultAssistanceVolumeForKind,
  effectiveAssistanceVolumeForPhase,
  resolveAssistanceVolume,
  weekStartDate,
  type AssistanceVolume,
  type AssistanceVolumeCustom,
  type AssistanceVolumePreset,
  type BlockDay,
  type BlockKind,
} from './blocks';
import { resolveAvailableEquipment } from './equipment-presets';
import {
  computeCardioFatigueShift,
  type CardioFatigueShift,
  type CardioModality,
  type MinimalCardio,
} from './cardio-analytics';
import type { EquipmentType, Movement, SeventhWeekKind, WendlerWeek } from './types';
import type { GoalFlavor } from './volume-recommend';

// ---------------------------------------------------------------------------
// Input shapes — structural, not Dexie-bound. Keep these minimal so tests
// and non-React callers don't have to construct full Dexie records.
// ---------------------------------------------------------------------------

/**
 * Minimal block shape needed for suggester-context derivation. Maps 1:1
 * onto `ProgramBlock` fields actually read; nothing else.
 */
export interface SuggesterBlock {
  kind: BlockKind;
  seventhWeekKind?: SeventhWeekKind;
  programId?: string;
  weeksBeforeDeload: number;
  name?: string;
  assistanceVolume?: AssistanceVolume;
  availableEquipment?: EquipmentType[];
}

/**
 * Minimal settings shape: just the three fields the suggester reads.
 * Pass `undefined` when the user has no stored settings yet.
 */
export interface SuggesterSettings {
  goalFlags?: GoalFlags;
  goalNotes?: string;
  trainingProfile?: TrainingProfile;
}

/**
 * Minimal program shape needed for available-equipment fallback. The
 * suggester reads `availableEquipment` from the parent program when the
 * block hasn't pinned its own.
 */
export interface SuggesterProgram {
  id: string;
  availableEquipment?: EquipmentType[];
}

/**
 * Minimal goal shape: flavors and completion state.
 */
export interface SuggesterGoal {
  completedAt?: string;
  flavors?: readonly string[];
  /** Used to fall back to a default flavor when `flavors` is unset. */
  kind: 'strength-pr' | 'race-time' | 'body-comp' | 'habit' | 'qualitative' | 'custom';
}

export type SuggesterRunPlanSlot = { dayOfWeek: number; kind: string };

// ---------------------------------------------------------------------------
// Endurance-race taper-window classifier — moved out of the web component
// in v281. The previous location duplicated knowledge that conceptually
// belongs next to the rest of the taper/peak logic; keeping it in domain
// also makes it unit-testable.
// ---------------------------------------------------------------------------

/**
 * Per-kind windows for when an A-priority endurance race triggers the
 * "cardio peak active" environmental signal in the assistance suggester
 * (de-emphasize quad-heavy single-leg, etc.). Wider for longer races
 * because the systemic cost of tapering scales with distance.
 */
const RACE_TAPER_DAYS: Record<string, number> = {
  'half-marathon': 10,
  marathon: 21,
  ultra: 21,
  triathlon: 14,
};

/**
 * Returns true when at least one A-priority endurance race on the calendar
 * is inside its kind-specific taper window. Used by the suggester to bias
 * single-leg picks away from quad-dominant movements during the final
 * approach to a race.
 *
 * Distinct from `effectiveTrainingPhase` 'taper' — that's a 14-day window
 * across any A/B race; this is a per-discipline window only for A-priority
 * endurance events.
 */
export function isCardioPeakActive(
  races: ReadonlyArray<RaceLike>,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  for (const r of races) {
    if (r.priority !== 'A') continue;
    const k = r.kind;
    if (k !== 'half-marathon' && k !== 'marathon' && k !== 'ultra' && k !== 'triathlon') {
      continue;
    }
    const ds = (new Date(r.date).getTime() - nowMs) / 86_400_000;
    const window = RACE_TAPER_DAYS[k] ?? 14;
    if (ds >= 0 && ds <= window) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// SuggesterContext — the shared output shape.
// ---------------------------------------------------------------------------

export interface SuggesterContext {
  /** Resolved per-block volume budget (phase-adjusted; pass to prompt + fallback). */
  volume: AssistanceVolumeCustom;
  /** Days in display order, parallel to the input. */
  days: Pick<BlockDay, 'id' | 'mainLifts' | 'label'>[];
  /** Movement library to render in the prompt + fallback pool. */
  movements: Movement[];
  /** Effective goal flags (post-phase-suppression when a profile is present). */
  goalFlags: GoalFlags;
  /** Free-text user notes, trimmed (caller pastes verbatim). */
  goalNotes: string;
  /**
   * Active goal flavors, grouped per logical goal. Each unique flavor counted
   * once across all active goals — `flavorCounts` / `goalMixDelta` see each
   * flavor once even when several goals carry it.
   */
  activeGoalFlavors: GoalFlavor[][];
  /** Flat de-duplicated flavor list (prompt + fallback both read this). */
  flatFlavors: GoalFlavor[];
  /** Is an A-priority endurance race inside its taper window? */
  cardioPeakActive: boolean;
  /** Equipment available in this block (block override → program → undefined). */
  availableEquipment: EquipmentType[] | undefined;
  /** Indices of days that ARE long-run days (prompt subtracts 1 for "before"). */
  longRunDayIndices?: number[];
  /** Human-readable block label for prompt header. */
  blockLabel?: string;
  /** Block kind — surfaced to the LLM for macro framing. */
  blockKind: BlockKind;
  /** Resolved phase for the target week (after manual / race / block / fallback). */
  phase: TrainingPhase;
  /** Where the phase came from — drives the "Auto · …" badge UI. */
  phaseSource: PhaseSource;
  /**
   * When the assistance-volume preset was auto-shifted upstream (e.g.
   * `standard → minimal` on a deload week), the from/to pair so the prompt
   * can surface it explicitly. Undefined when no shift was applied (custom
   * volumes never shift; `normal` phase never shifts).
   */
  phasePresetShift?: { from: AssistanceVolumePreset; to: AssistanceVolumePreset };
  /**
   * Four-axis profile context for the LLM — only present when the user has
   * a `trainingProfile` configured. Older users without a profile get
   * `undefined` here and the legacy goal-context path drives the prompt.
   */
  trainingProfileContext?: {
    primaryGoal: string;
    secondaryGoals: string[];
    trainingPhase: TrainingPhase;
    phaseDirectives?: { secondary: string; directive: string }[];
    constraints?: { kind: string; label: string }[];
  };
  /**
   * Compound-cut guard: when phase was auto-derived (race or block) to a
   * non-normal state, the preset auto-shift already cuts the rep budget,
   * so the `volumeMultiplier` directive should NOT fire on top (avoids
   * double-cutting). Manual phase keeps the multiplier for back-compat.
   */
  suppressPhaseVolumeMultiplier: boolean;
  /**
   * Recent cardio fatigue signal — small negative shift the suggester
   * applies on top of the phase-adjusted budget when the trailing 7-day
   * weighted-cardio-minutes have spiked above the 28-day rolling baseline.
   *
   *   0   — no extra cut
   *   -1  — light cut (~10% trim, +30%-to-+60% delta over baseline)
   *   -2  — heavier cut (~15-20% trim, ≥+60% delta over baseline)
   *
   * Suppressed during `deload` and `taper` phases — the budget is already
   * cut upstream there. Fires in `normal` and `peak` phases.
   */
  cardioFatigueShift: CardioFatigueShift;
  /**
   * Diagnostics for the cardio fatigue signal — surfaced in the prompt so
   * the LLM can quote real numbers in its rationale. Always present even
   * when `cardioFatigueShift === 0` so the UI / fallback can introspect.
   */
  cardioFatigue: {
    recentWeightedMin: number;
    baselineWeightedMin: number;
    deltaPct: number | null;
    /** True when the signal was computed but suppressed by the active phase. */
    suppressedByPhase: boolean;
    /**
     * Modality breakdown of the trailing 7-day weighted minutes, sorted by
     * share descending. Drives the LLM's overlap-correct trim ranking
     * (running → posterior chain; cycling → quads/glutes; swim/row →
     * lats/back). Empty when no recent cardio.
     */
    recentModalityMix: Array<{ modality: CardioModality; weightedMin: number; sharePct: number }>;
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface BuildSuggesterContextInput {
  block: SuggesterBlock;
  /** Block-day list in display order (after schedule/plan resolution). */
  days: Pick<BlockDay, 'id' | 'mainLifts' | 'label'>[];
  /** Movement library available to this block (post equipment-filter is fine). */
  movements: Movement[];
  /** User settings — `undefined` when the user has none yet. */
  settings?: SuggesterSettings;
  /** Programs collection — used to inherit availableEquipment from parent. */
  programs?: ReadonlyArray<SuggesterProgram>;
  /** Upcoming races on the calendar (any priority). */
  races?: ReadonlyArray<RaceLike>;
  /** Active recurring run-plan slots. */
  runPlan?: { slots?: ReadonlyArray<SuggesterRunPlanSlot> };
  /**
   * Recent cardio sessions (planned, unplanned, linked, unlinked — all of
   * them). At minimum the trailing 35 days; older entries are filtered out
   * internally. Drives the cardio-fatigue shift signal. Pass `undefined` or
   * `[]` when no cardio data is available; the signal will then be 0.
   */
  cardio?: ReadonlyArray<Pick<MinimalCardio, 'modality' | 'performedAt' | 'durationSec' | 'hrZoneSeconds'>>;
  /**
   * Recommended assistance-volume preset for this block, computed upstream
   * via `recommendAssistanceVolume()` from `volume-recommend.ts`. When the
   * user has NOT explicitly set `block.assistanceVolume`, this preset takes
   * precedence over `defaultAssistanceVolumeForKind` as the budget the
   * suggester generates against. Optional — omitted callers fall back to
   * the kind default (preserves the pre-v300 behavior).
   *
   * The recommendation already accounts for goal flavors, prior blocks'
   * volume, cardio-peak windows, and recent injury signals — so threading
   * it here means the LLM/fallback start from "smart default" rather than
   * "kind default" before the phase auto-shift is applied on top.
   */
  recommendedVolume?: AssistanceVolumePreset;
  /** All active goals (completed filtered inside). */
  goals?: ReadonlyArray<SuggesterGoal>;
  /**
   * Earliest `performedAt` across sessions in the block — anchor for
   * per-week phase derivation. Pass `null`/`undefined` when the block hasn't
   * started yet (the derivation falls back to `now`). String ISO-8601 is
   * accepted for convenience because Dexie/web layer typically holds dates
   * in that shape.
   */
  blockFirstSessionDate?: Date | string | null;
  /**
   * Week scope being generated for. `'7w'` skips per-week date anchoring
   * and uses `now` for phase derivation; numeric scopes and `'deload'`
   * shift `now` to the calendar start of that week.
   */
  weekScope: WendlerWeek;
  /** Reference date — threaded so per-week derivation is fully reproducible. */
  now?: Date;
  /**
   * Default flavors for a goal kind that has no explicit `flavors` field.
   * Injected from web (`@wendler/db-schema:defaultFlavorsForKind`) so this
   * function stays free of db-schema imports.
   */
  defaultFlavorsForKind: (kind: SuggesterGoal['kind']) => readonly string[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compute the shared context the AI suggester and the deterministic
 * fallback both consume. Pure / total — no I/O, no Date.now() short of
 * the optional `now` default.
 *
 * Output composition matters: every field this returns is sent to BOTH
 * code paths verbatim. Adding a new option here is the only place it
 * needs to land; the LLM call and the fallback call read it from the
 * same object, removing the v278-flagged drift seam.
 */
export function buildSuggesterContext(
  input: BuildSuggesterContextInput,
): SuggesterContext {
  const now = input.now ?? new Date();
  const {
    block,
    days,
    movements,
    settings,
    programs,
    races,
    runPlan,
    cardio,
    recommendedVolume,
    goals,
    blockFirstSessionDate,
    weekScope,
    defaultFlavorsForKind,
  } = input;

  // Volume — block override (explicit user choice) → live recommendation
  // (Phase 4: signals-driven) → kind default. The recommendation slot lets
  // the LLM/fallback generate against a "smart default" instead of the
  // hard-coded kind default whenever the user hasn't pinned a preset.
  const storedVolume: AssistanceVolume =
    block.assistanceVolume ??
    recommendedVolume ??
    defaultAssistanceVolumeForKind(block.kind, block.seventhWeekKind);

  // Active goal flavors — collapsed to a single logical-goal bucket so
  // `flavorCounts` / `goalMixDelta` count each flavor once even when
  // several goals carry it.
  const flavorSet = new Set<GoalFlavor>();
  for (const g of goals ?? []) {
    if (g.completedAt) continue;
    const fs = (g.flavors ?? defaultFlavorsForKind(g.kind)) as GoalFlavor[];
    for (const f of fs) flavorSet.add(f);
  }
  const activeGoalFlavors: GoalFlavor[][] =
    flavorSet.size > 0 ? [Array.from(flavorSet)] : [];
  const flatFlavors: GoalFlavor[] = Array.from(
    new Set(activeGoalFlavors.flat()),
  ) as GoalFlavor[];

  // Endurance-race taper-window signal.
  const cardioPeakActive = isCardioPeakActive(races ?? [], now);

  // Equipment available — block override → program → undefined.
  const program = block.programId
    ? programs?.find((p) => p.id === block.programId)
    : undefined;
  const availableEquipment = resolveAvailableEquipment(
    block.availableEquipment,
    program?.availableEquipment,
  );

  // Phase derivation. Three paths converge on `goalFlags`, `phase`,
  // `phaseSource`, and `trainingProfileContext`:
  //   (a) User has a TrainingProfile → derive flags + phase from it,
  //       anchored to the per-week target date when applicable.
  //   (b) No TrainingProfile → fall back to the legacy GoalFlags
  //       computation, with `phase: 'normal'` and `phaseSource: 'manual'`
  //       so older users see no behavior change.
  const manualFlags = settings?.goalFlags ?? DEFAULT_GOAL_FLAGS;
  let goalFlags: GoalFlags = computeEffectiveGoalFlags(
    manualFlags,
    races ?? [],
    now,
  ).effective;
  let phase: TrainingPhase = 'normal';
  let phaseSource: PhaseSource = 'manual';
  let trainingProfileContext: SuggesterContext['trainingProfileContext'];

  const trainingProfile = settings?.trainingProfile;
  if (trainingProfile) {
    // Per-week phase anchoring (see field comment).
    const anchor: Date =
      blockFirstSessionDate == null
        ? now
        : blockFirstSessionDate instanceof Date
          ? blockFirstSessionDate
          : new Date(blockFirstSessionDate);
    const targetDate =
      weekStartDate(anchor, block.weeksBeforeDeload, weekScope) ?? now;
    const derived = deriveGoalFlags(
      trainingProfile,
      races ?? [],
      targetDate,
      { kind: block.kind, seventhWeekKind: block.seventhWeekKind },
    );
    goalFlags = derived.flags;
    phase = derived.phase;
    phaseSource = derived.phaseSource;
    trainingProfileContext = {
      primaryGoal: trainingProfile.primaryGoal,
      secondaryGoals: derived.effectiveSecondaries,
      trainingPhase: derived.phase,
      phaseDirectives: derived.phaseDirectives,
      constraints: trainingProfile.constraints
        .filter((c) => c.active !== false)
        .map((c) => ({ kind: c.kind, label: c.label })),
    };
  }

  // Apply the phase-aware preset shift. The visible chip in
  // BlockAssistanceVolumePanel mirrors this shift, so what the user sees
  // is what the LLM (and fallback) gets.
  const shiftedVolume = effectiveAssistanceVolumeForPhase(storedVolume, phase);
  const volume = resolveAssistanceVolume(shiftedVolume);
  const phasePresetShift =
    typeof storedVolume === 'string' &&
    typeof shiftedVolume === 'string' &&
    storedVolume !== shiftedVolume
      ? { from: storedVolume, to: shiftedVolume }
      : undefined;

  // Compound-cut guard: when phase was auto-derived (race or block) to a
  // non-normal state, the preset auto-shift above already cuts the rep
  // budget. Adding the `volumeMultiplier` directive on top (×0.6 deload
  // / ×0.75 peak) double-cuts. Suppress the multiplier in that case —
  // the slot biases / dropAmrapOverload / preferProven side effects of
  // the deload/peak flags still fire. Manual phase keeps the multiplier
  // for back-compat with users who set the override expecting both
  // signals to apply.
  const suppressPhaseVolumeMultiplier =
    phaseSource !== 'manual' && phase !== 'normal';

  const longRunDayIndices = computeLongRunDays(
    days.map((d) => ({ label: d.label })),
    runPlan?.slots,
  );

  // Cardio fatigue signal. Suppressed during deload and taper — those phases
  // already cut the budget upstream via the preset auto-shift, and stacking
  // another cut on top would crater volume. The signal fires in `normal`
  // and `peak`: peak doesn't down-shift assistance, so the cardio cut is
  // doing fresh work — exactly when you need it most.
  const cardioFatigueRaw = computeCardioFatigueShift(cardio ?? [], now);
  const cardioFatigueSuppressedByPhase = phase === 'deload' || phase === 'taper';
  const cardioFatigueShift: CardioFatigueShift =
    cardioFatigueSuppressedByPhase ? 0 : cardioFatigueRaw.shift;

  return {
    volume,
    days,
    movements,
    goalFlags,
    goalNotes: settings?.goalNotes ?? '',
    activeGoalFlavors,
    flatFlavors,
    cardioPeakActive,
    availableEquipment,
    longRunDayIndices,
    blockLabel: block.name ?? undefined,
    blockKind: block.kind,
    phase,
    phaseSource,
    phasePresetShift,
    trainingProfileContext,
    suppressPhaseVolumeMultiplier,
    cardioFatigueShift,
    cardioFatigue: {
      recentWeightedMin: cardioFatigueRaw.recentWeightedMin,
      baselineWeightedMin: cardioFatigueRaw.baselineWeightedMin,
      deltaPct: cardioFatigueRaw.deltaPct,
      suppressedByPhase: cardioFatigueSuppressedByPhase && cardioFatigueRaw.shift !== 0,
      recentModalityMix: cardioFatigueRaw.recentModalityMix,
    },
  };
}
