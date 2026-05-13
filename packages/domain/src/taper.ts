/**
 * Race taper detection.
 *
 * Two paths:
 *
 * 1. **Race-driven** (preferred). When the caller passes a `races` list, we
 *    pick the next priority A/B race and return a phased recommendation
 *    (`normal | deload-prompt | maintenance | cutoff`) with a reason string
 *    suitable for an inline tooltip. Priority C races return `normal`
 *    always — they're calendar-only.
 *
 * 2. **Goal-only fallback**. If `races` is empty/omitted, we fall back to
 *    the legacy goal-based path (`TaperPhase`) so users with a single
 *    race-time goal don't lose the existing TaperBanner behaviour.
 *
 * Phase windows (race-driven):
 *
 * | Phase            | A (marathon-style) | B (half-marathon-style) |
 * |------------------|--------------------|-------------------------|
 * | normal           | > 21d              | > 14d                   |
 * | deload-prompt    | 14–21d             | 10–14d                  |
 * | maintenance      | 5–14d              | 5–10d                   |
 * | cutoff           | 0–5d               | 0–5d                    |
 *
 * Reasoning is plain-English (no academic citations) and intended for
 * tooltips on the TaperBanner / day / session views.
 */

import type { RaceLike, RacePriorityLike } from './races';

export interface RaceGoal {
  id: string;
  title: string;
  /** Should be 'race-time'. Other kinds are ignored. */
  kind: string;
  /** ISO timestamp of the race. */
  deadline?: string;
  completedAt?: string;
}

export type TaperPhase = 'off-season' | 'build' | 'peak' | 'taper' | 'race-week' | 'race-day';

export interface TaperWindow {
  goalId: string;
  goalTitle: string;
  raceDate: string;
  daysOut: number;
  phase: TaperPhase;
  /** Suggested adjustments in plain English. */
  guidance: string[];
  /** Suggested strength volume multiplier (1.0 = normal). */
  strengthVolumeMultiplier: number;
  /** Suggested cardio volume multiplier (1.0 = normal). */
  cardioVolumeMultiplier: number;
  /** When backed by a Race row, the race id. */
  raceId?: string;
  /** When backed by a Race row, the race priority. */
  racePriority?: RacePriorityLike;
  /**
   * Race-driven sub-phase, present only when this window came from a Race row.
   * UI uses this to surface deload prompts / cutoff badges.
   */
  raceTaperPhase?: RaceTaperPhase;
  /** Plain-English "why" string for tooltip on the banner / cutoff badges. */
  reason?: string;
}

export interface TaperInputs {
  goals: RaceGoal[];
  /** Optional race calendar; if present, takes precedence over goals. */
  races?: RaceLike[];
  now?: Date;
}

/** Race-driven taper sub-phases (independent of the legacy TaperPhase enum). */
export type RaceTaperPhase = 'normal' | 'deload-prompt' | 'maintenance' | 'cutoff';

export interface RaceTaperRecommendation {
  raceId: string;
  raceName: string;
  raceDate: string;
  priority: RacePriorityLike;
  daysOut: number;
  phase: RaceTaperPhase;
  /** Plain-English "why" for tooltip / inline reason text. */
  reason: string;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / 86400000);
}

function phaseFor(daysOut: number): TaperPhase {
  if (daysOut < 0) return 'off-season';
  if (daysOut === 0) return 'race-day';
  if (daysOut <= 6) return 'race-week';
  if (daysOut <= 14) return 'taper';
  if (daysOut <= 28) return 'peak';
  if (daysOut <= 84) return 'build';
  return 'off-season';
}

function guidanceFor(phase: TaperPhase): {
  guidance: string[];
  strengthVolumeMultiplier: number;
  cardioVolumeMultiplier: number;
} {
  switch (phase) {
    case 'race-day':
      return {
        guidance: [
          'Race day. No training. Eat, hydrate, warm up, race.',
        ],
        strengthVolumeMultiplier: 0,
        cardioVolumeMultiplier: 0,
      };
    case 'race-week':
      return {
        guidance: [
          'Final week. Cut strength volume ~50%; keep top sets short and crisp (no AMRAPs).',
          'Reduce cardio mileage 30–50%; keep a few short race-pace efforts.',
          'Prioritize sleep and carbs the last 3 days. Skip novel exercises.',
        ],
        strengthVolumeMultiplier: 0.5,
        cardioVolumeMultiplier: 0.6,
      };
    case 'taper':
      return {
        guidance: [
          'Taper window. Drop assistance work to a single set; keep main lifts at prescribed weight, fewer reps.',
          'Trim long cardio by ~25%; maintain intensity, lose volume.',
          'Stop adding load. Confidence > stimulus from here.',
        ],
        strengthVolumeMultiplier: 0.7,
        cardioVolumeMultiplier: 0.75,
      };
    case 'peak':
      return {
        guidance: [
          'Peak block. Push intensity but skip new PR attempts on barbell lifts.',
          'Long runs should approach goal-pace specificity.',
          'Lock in technique — no experimentation.',
        ],
        strengthVolumeMultiplier: 0.9,
        cardioVolumeMultiplier: 1.0,
      };
    case 'build':
      return {
        guidance: [
          'Build phase. Train normally; prioritise the supportive modality (lifting OR cardio).',
          'Keep 1–2 hard cardio sessions and 2–3 lifting sessions per week.',
        ],
        strengthVolumeMultiplier: 1.0,
        cardioVolumeMultiplier: 1.0,
      };
    case 'off-season':
    default:
      return {
        guidance: [
          'Off-season. Strength is the priority — build a bigger engine to peak from later.',
        ],
        strengthVolumeMultiplier: 1.0,
        cardioVolumeMultiplier: 1.0,
      };
  }
}

/**
 * Compute the race-driven taper phase for a single race.
 *
 * Priority C always returns 'normal' — these are calendar-only races.
 * Past races (>1d ago) also return 'normal'.
 */
export function taperRecommendation(
  race: RaceLike,
  now: Date = new Date(),
): RaceTaperRecommendation {
  const date = new Date(race.date);
  const daysOut = Math.max(0, daysBetween(now, date));
  const past = daysBetween(now, date) < -1;
  const base: RaceTaperRecommendation = {
    raceId: race.id,
    raceName: race.name,
    raceDate: race.date,
    priority: race.priority,
    daysOut,
    phase: 'normal',
    reason: '',
  };
  if (past || race.completedAt) return { ...base, reason: 'Race is in the past.' };
  if (race.priority === 'C') {
    return { ...base, reason: 'Priority C race — calendar only, no taper.' };
  }
  const isMarathonStyle = race.priority === 'A';
  const days = daysOut;

  if (days <= 5) {
    return {
      ...base,
      phase: 'cutoff',
      reason:
        days <= 0
          ? 'Race day. No lifting — fuel, warm up, race.'
          : `Race in ${days} day${days === 1 ? '' : 's'}. Lifting this close offers no upside and adds fatigue. Mobility and easy movement only.`,
    };
  }

  if (isMarathonStyle) {
    if (days <= 14) {
      return {
        ...base,
        phase: 'maintenance',
        reason: `Marathon in ${days} days. Light/familiar lifts only — same movements at low load, no AMRAPs. Volume should already be down from the deload.`,
      };
    }
    if (days <= 21) {
      return {
        ...base,
        phase: 'deload-prompt',
        reason: `Marathon in ${days} days. Insert a deload now so the final 2 weeks land in light/maintenance mode — peak performance window for endurance is roughly 10–21 days after pulling load.`,
      };
    }
    return { ...base, reason: `${days} days to marathon — train normally.` };
  }

  // Priority B (half-marathon-style)
  if (days <= 10) {
    return {
      ...base,
      phase: 'maintenance',
      reason: `Half in ${days} days. One light session at most, familiar movements only — heavy lifting now blunts race-day legs.`,
    };
  }
  if (days <= 14) {
    return {
      ...base,
      phase: 'deload-prompt',
      reason: `Half in ${days} days. Insert a deload now — at this distance the deload itself becomes your taper.`,
    };
  }
  return { ...base, reason: `${days} days to race — train normally.` };
}

/** Pick the soonest non-completed A/B race today or in the future. */
function pickNextRace(races: readonly RaceLike[], now: Date): RaceLike | undefined {
  const candidates = races
    .filter((r) => !r.completedAt && (r.priority === 'A' || r.priority === 'B'))
    .map((r) => ({ r, t: new Date(r.date).getTime() }))
    .filter((x) => Number.isFinite(x.t) && daysBetween(now, new Date(x.t)) >= -1)
    .sort((a, b) => a.t - b.t);
  return candidates[0]?.r;
}

export function nextRaceWindow(input: TaperInputs): TaperWindow | undefined {
  const now = input.now ?? new Date();

  // Race-driven path takes precedence whenever the caller has races configured.
  const race = input.races ? pickNextRace(input.races, now) : undefined;
  if (race) {
    const rec = taperRecommendation(race, now);
    // Map race phase -> legacy TaperPhase so existing UI styling keeps working.
    const phase: TaperPhase =
      rec.phase === 'cutoff'
        ? rec.daysOut === 0
          ? 'race-day'
          : 'race-week'
        : rec.phase === 'maintenance'
          ? 'taper'
          : rec.phase === 'deload-prompt'
            ? race.priority === 'A'
              ? 'peak'
              : 'taper'
            : 'build';
    const g = guidanceFor(phase);
    // For a race-driven window, prefer the reason string as the lead guidance
    // bullet — it's tailored, short, and tooltip-friendly.
    const guidance = [rec.reason, ...g.guidance.slice(0, 2)];
    return {
      goalId: race.id,
      goalTitle: race.name,
      raceDate: race.date,
      daysOut: rec.daysOut,
      phase,
      guidance,
      strengthVolumeMultiplier: g.strengthVolumeMultiplier,
      cardioVolumeMultiplier: g.cardioVolumeMultiplier,
      raceId: race.id,
      racePriority: race.priority,
      raceTaperPhase: rec.phase,
      reason: rec.reason,
    };
  }

  // Goal-only fallback (legacy behaviour).
  const races = input.goals
    .filter((g) => g.kind === 'race-time' && !g.completedAt && g.deadline)
    .map((g) => ({ g, date: new Date(g.deadline!) }))
    .filter((r) => !Number.isNaN(r.date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const upcoming = races.find((r) => daysBetween(now, r.date) >= -1);
  if (!upcoming) return undefined;

  const daysOut = Math.max(0, daysBetween(now, upcoming.date));
  const phase = phaseFor(daysOut);
  const g = guidanceFor(phase);
  return {
    goalId: upcoming.g.id,
    goalTitle: upcoming.g.title,
    raceDate: upcoming.date.toISOString(),
    daysOut,
    phase,
    ...g,
  };
}

// =====================================================================
// Race-driven proposed taper actions (option-A action panel)
// =====================================================================

export type TaperActionKind = 'insert-deload' | 'activate-competition-peaking';

export interface ProposedTaperAction {
  id: string;
  kind: TaperActionKind;
  raceId: string;
  raceName: string;
  raceDate: string;
  daysOut: number;
  phase: RaceTaperPhase;
  /** Short title shown as the action's heading (e.g. "Insert deload block now"). */
  title: string;
  /**
   * Plain-English explanation of why the app is proposing this action right
   * now. Shown inline under the title — no jargon, ready to display verbatim.
   */
  why: string;
}

/**
 * Inspect a single race and return the list of taper actions the app proposes
 * for it given the current date. Already-accepted or dismissed actions are
 * excluded so the panel doesn't re-nag.
 *
 * Phase coverage:
 * - `deload-prompt` (A: 14–21d, B: 10–14d): proposes insert-deload + activate-peaking
 * - `maintenance` (A: 5–14d, B: 5–10d): proposes activate-peaking only
 *   (deload window has passed)
 * - `normal` and `cutoff`: no proposals
 *
 * Pure function — same input → same output. Caller is responsible for fanning
 * out across the race list and rendering.
 */
export function proposedTaperActions(
  race: RaceLike,
  now: Date = new Date(),
): ProposedTaperAction[] {
  const rec = taperRecommendation(race, now);
  if (rec.phase === 'normal' || rec.phase === 'cutoff') return [];

  const actions: ProposedTaperAction[] = [];
  const state = race.taperActions;
  const deloadDecided = !!state?.insertedDeload;
  const peakingDecided = !!state?.competitionPeakingActivated;

  // Insert-deload: only at deload-prompt phase, and only if not yet decided.
  if (rec.phase === 'deload-prompt' && !deloadDecided) {
    actions.push({
      id: `${race.id}:insert-deload`,
      kind: 'insert-deload',
      raceId: race.id,
      raceName: race.name,
      raceDate: race.date,
      daysOut: rec.daysOut,
      phase: rec.phase,
      title: 'Insert a deload block now',
      why:
        race.priority === 'A'
          ? `${rec.daysOut} days out from "${race.name}". Inserting a deload now lets the final 2 weeks land in light/maintenance mode — peak performance for endurance is roughly 10–21 days after pulling load.`
          : `${rec.daysOut} days out from "${race.name}". At this distance the deload itself becomes your taper.`,
    });
  }

  // Activate competition peaking: at deload-prompt OR maintenance, until decided.
  if (
    (rec.phase === 'deload-prompt' || rec.phase === 'maintenance') &&
    !peakingDecided
  ) {
    actions.push({
      id: `${race.id}:activate-competition-peaking`,
      kind: 'activate-competition-peaking',
      raceId: race.id,
      raceName: race.name,
      raceDate: race.date,
      daysOut: rec.daysOut,
      phase: rec.phase,
      title: 'Activate "Competition peaking" goal flag',
      why: `${rec.daysOut} days out from "${race.name}". Tells the assistance suggester to bias toward proven movements, drop AMRAP overload on assistance, and reduce volume ~30% so you arrive fresh. Auto-clears after race day.`,
    });
  }

  return actions;
}

/**
 * Fan `proposedTaperActions` over the full race list. Returns proposals
 * grouped by race so the UI can render one action panel per race header.
 * Races with no current proposals are omitted.
 */
export function proposedTaperActionsByRace(
  races: readonly RaceLike[],
  now: Date = new Date(),
): { race: RaceLike; actions: ProposedTaperAction[] }[] {
  const out: { race: RaceLike; actions: ProposedTaperAction[] }[] = [];
  for (const race of races) {
    if (race.completedAt) continue;
    const actions = proposedTaperActions(race, now);
    if (actions.length > 0) out.push({ race, actions });
  }
  return out;
}

// =====================================================================
// Effective goal flags (manual + race-driven)
// =====================================================================

/**
 * Structural shape used by `computeEffectiveGoalFlags`. Mirrors the
 * `GoalFlags` type from goal-flags.ts but kept structural so we can avoid
 * a circular import (goal-flags doesn't import taper, taper doesn't import
 * goal-flags). Callers pass `settings.goalFlags`.
 */
export interface GoalFlagsLike {
  marathon: boolean;
  realLifeStrength: boolean;
  bigArms: boolean;
  deload: boolean;
  competitionPeaking: boolean;
  mobilityFocus: boolean;
}

export interface EffectiveGoalFlagsResult {
  /** Merged flags — what the suggester should treat as authoritative. */
  effective: GoalFlagsLike;
  /**
   * Per-flag provenance so UI can show "Auto · on (race in 12d)" badges.
   * Only includes entries that differ from manual or are race-driven.
   */
  autoSources: {
    competitionPeaking?: { raceId: string; raceName: string; daysOut: number };
  };
}

/**
 * Merge the user's manual goal flags with race-driven activations.
 *
 * Today only `competitionPeaking` is race-driven: it flips on when any
 * upcoming A/B race has an *accepted* `competitionPeakingActivated` action
 * AND the race date hasn't passed yet (or is the race day itself). Past
 * races stop contributing automatically — no separate cleanup needed.
 *
 * Returned `autoSources` is purely informational; the suggester uses
 * `effective` and ignores it. The UI uses `autoSources` to render badges.
 */
export function computeEffectiveGoalFlags(
  manual: GoalFlagsLike,
  races: readonly RaceLike[],
  now: Date = new Date(),
): EffectiveGoalFlagsResult {
  const effective: GoalFlagsLike = { ...manual };
  const autoSources: EffectiveGoalFlagsResult['autoSources'] = {};

  // Find the soonest upcoming A/B race that has an accepted peaking
  // activation. Past races (>1d ago) and dismissed actions are ignored.
  let bestPeaking: { race: RaceLike; daysOut: number } | undefined;
  for (const race of races) {
    if (race.completedAt) continue;
    if (race.priority !== 'A' && race.priority !== 'B') continue;
    const action = race.taperActions?.competitionPeakingActivated;
    if (!action || !('acceptedAt' in action)) continue;
    const daysOut = daysBetween(now, new Date(race.date));
    if (daysOut < -1) continue;
    if (!bestPeaking || daysOut < bestPeaking.daysOut) {
      bestPeaking = { race, daysOut };
    }
  }
  if (bestPeaking) {
    if (!effective.competitionPeaking) {
      effective.competitionPeaking = true;
      autoSources.competitionPeaking = {
        raceId: bestPeaking.race.id,
        raceName: bestPeaking.race.name,
        daysOut: Math.max(0, bestPeaking.daysOut),
      };
    }
  }

  return { effective, autoSources };
}
