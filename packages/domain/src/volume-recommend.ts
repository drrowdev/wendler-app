// Volume recommender — Phase 4 of the assistance suggester.
//
// Pure domain logic: given a block's context plus a few aggregated signals
// from the user's history, returns an AssistanceVolumePreset recommendation
// and a list of human-readable reason chips explaining which signals fired.
//
// The web layer fetches the inputs (sets, prev blocks, run plan, pain flags)
// and threads them in. This module has no Dexie / IO / React dependencies so
// it can be unit-tested in isolation.

import {
  defaultAssistanceVolumeForKind,
  type AssistanceVolumePreset,
  type AssistanceVolume,
  type BlockKind,
} from './blocks';
import type { SeventhWeekKind } from './types';

/**
 * Training-flavor tags expressing what kind of work a goal cares about.
 * **Keep in sync with `GoalFlavor` in `@wendler/db-schema`** — duplicated
 * here to avoid a circular dependency (db-schema imports from domain).
 * TypeScript will not catch a divergence; if you add a flavor in db-schema,
 * add it here too.
 */
export type GoalFlavor =
  | 'strength'
  | 'hypertrophy'
  | 'functional'
  | 'conditioning'
  | 'prehab';

/**
 * One signal that contributed to (or could have contributed to) the final
 * recommendation. `delta` is the step adjustment in preset space:
 * minimal=0, standard=1, high=2. Final preset = clamp(baseline + Σdelta, 0, 2).
 *
 * `delta: 0` means the signal was considered but had no effect — these are
 * suppressed from the UI but available for debugging.
 */
export interface RecommendReason {
  signal:
    | 'kind-default'
    | 'goal-mix'
    | 'history'
    | 'cardio-peak'
    | 'injury'
    | 'amrap-regression';
  delta: number;
  detail: string;
}

export interface VolumeRecommenderInput {
  /** The block being recommended for (kind + 7th-week variant matter). */
  block: { kind: BlockKind; seventhWeekKind?: SeventhWeekKind };
  /**
   * Effective flavors for each currently-active goal (one entry per goal).
   * Caller should resolve `goal.flavors ?? defaultFlavorsForKind(goal.kind)`
   * before passing in. Empty arrays are fine (goal exists but has no opinion).
   */
  activeGoalFlavors: ReadonlyArray<ReadonlyArray<GoalFlavor>>;
  /**
   * Most-recent-first list of completed same-kind blocks, with their
   * recorded `assistanceVolume`. Only the first 2 are used for the history
   * signal — older blocks are ignored.
   */
  prevSameKindBlocks?: ReadonlyArray<{ assistanceVolume?: AssistanceVolume }>;
  /**
   * True when the block falls inside (or right next to) a cardio peak —
   * marathon prep peak weeks, race week of an A-race, etc. The web layer
   * computes this from the run plan + race calendar.
   */
  cardioPeakActive?: boolean;
  /**
   * Maximum severity (1–5) of any pain flag raised within the previous
   * block's window. 0 / undefined means no flag.
   */
  injurySeverityMax?: number;
  /**
   * True when AMRAP rep counts trended *down* across cycles in the previous
   * block — a regression signal worth a step-down. Caller computes.
   */
  amrapTrendingDown?: boolean;
}

export interface VolumeRecommendation {
  preset: AssistanceVolumePreset;
  /** Only signals that actually moved the needle (delta !== 0) plus the baseline. */
  reasons: RecommendReason[];
}

const PRESET_ORDER: AssistanceVolumePreset[] = ['minimal', 'standard', 'high'];

function presetIndex(p: AssistanceVolumePreset): number {
  return PRESET_ORDER.indexOf(p);
}

function clampPreset(idx: number): AssistanceVolumePreset {
  if (idx < 0) return 'minimal';
  if (idx > 2) return 'high';
  return PRESET_ORDER[idx]!;
}

/** Resolve a stored AssistanceVolume to its preset bucket for history math. */
function bucketOf(v: AssistanceVolume | undefined): AssistanceVolumePreset | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  // Custom values: bucket by mainDayReps thresholds matching the preset
  // table in blocks.ts (75 / 120 / 150). Midpoints used as cutoffs.
  if (v.mainDayReps <= 95) return 'minimal';
  if (v.mainDayReps <= 135) return 'standard';
  return 'high';
}

/**
 * Aggregate goal flavors → step delta. Strength / conditioning bias *down*
 * (less assistance volume), hypertrophy / functional bias *up*. Prehab is
 * neutral — it changes the slot composition, not the volume.
 *
 * Computed as a weighted score over all active-goal flavors, then collapsed
 * into {-1, 0, +1}. Threshold of ±3 prevents balanced 2-3 goal setups from
 * being trimmed when one strength goal naturally tips the count slightly.
 */
function goalMixDelta(
  flavorsByGoal: ReadonlyArray<ReadonlyArray<GoalFlavor>>,
): { delta: number; detail: string } {
  let down = 0;
  let up = 0;
  for (const flavors of flavorsByGoal) {
    for (const f of flavors) {
      if (f === 'strength' || f === 'conditioning') down += 1;
      else if (f === 'hypertrophy' || f === 'functional') up += 1;
    }
  }
  const net = up - down;
  // Threshold ±2 (was ±3): callers now dedup flavors across goals before
  // calling, so the maximum possible range is ±2 (strength+conditioning vs
  // hypertrophy+functional). ±3 would never trigger.
  if (net >= 2) {
    return {
      delta: 1,
      detail:
        'Your active goals lean strongly toward hypertrophy / functional work, which thrive on more accessory reps — bumped volume up.',
    };
  }
  if (net <= -2) {
    return {
      delta: -1,
      detail:
        'Your active goals lean strongly toward strength / conditioning, so less accessory volume leaves more energy for heavy lifts and cardio — bumped volume down.',
    };
  }
  return { delta: 0, detail: 'Balanced goal mix — no change' };
}

/**
 * History signal: if the user's last 2 same-kind blocks both used the same
 * preset bucket, anchor toward that. Otherwise no contribution — recent
 * history is mixed and we let the other signals decide.
 *
 * Returns the *target* preset directly (not a delta) when history is
 * decisive, otherwise null. Caller treats a decisive history as overriding
 * the kind default.
 */
function historyAnchor(
  prev: ReadonlyArray<{ assistanceVolume?: AssistanceVolume }> | undefined,
): { preset: AssistanceVolumePreset; detail: string } | null {
  if (!prev || prev.length < 2) return null;
  const a = bucketOf(prev[0]?.assistanceVolume);
  const b = bucketOf(prev[1]?.assistanceVolume);
  if (!a || !b) return null;
  if (a !== b) return null;
  return {
    preset: a,
    detail: `Your last 2 ${a === 'minimal' ? 'minimal-volume' : a === 'high' ? 'high-volume' : 'standard-volume'} blocks went well — sticking with "${a}" for consistency.`,
  };
}

/**
 * Main entry point. Pure / total. See module header for shape & semantics.
 */
export function recommendAssistanceVolume(
  input: VolumeRecommenderInput,
): VolumeRecommendation {
  const reasons: RecommendReason[] = [];

  // Baseline from block kind.
  const kindDefault = defaultAssistanceVolumeForKind(
    input.block.kind,
    input.block.seventhWeekKind,
  );

  // History anchor takes precedence over kind default when decisive.
  const anchor = historyAnchor(input.prevSameKindBlocks);
  let baseline: AssistanceVolumePreset;
  if (anchor) {
    baseline = anchor.preset;
    reasons.push({ signal: 'history', delta: 0, detail: anchor.detail });
  } else {
    baseline = kindDefault;
    const kindBlurb: Record<BlockKind, string> = {
      leader: 'Leader blocks build base volume — starting at',
      anchor: 'Anchor blocks emphasize heavier triples and PRs — starting at',
      standalone: 'Standalone blocks balance work and recovery — starting at',
      'seventh-week': '7th-week / deload blocks keep assistance light — starting at',
    };
    reasons.push({
      signal: 'kind-default',
      delta: 0,
      detail: `${kindBlurb[input.block.kind]} "${kindDefault}".`,
    });
  }

  let idx = presetIndex(baseline);

  // Goal-mix delta (skipped for 7th-week — assistance is fixed minimal there).
  if (input.block.kind !== 'seventh-week' && input.activeGoalFlavors.length > 0) {
    const gm = goalMixDelta(input.activeGoalFlavors);
    if (gm.delta !== 0) {
      idx += gm.delta;
      reasons.push({ signal: 'goal-mix', delta: gm.delta, detail: gm.detail });
    }
  }

  // Cardio peak: shrink one step.
  if (input.cardioPeakActive) {
    idx -= 1;
    reasons.push({
      signal: 'cardio-peak',
      delta: -1,
      detail:
        'You\'re in a cardio peak (marathon prep / race week) — less accessory work leaves more in the tank for running.',
    });
  }

  // Injury signal: −1 for moderate (≥2), −2 for severe (≥4).
  const sev = input.injurySeverityMax ?? 0;
  if (sev >= 4) {
    idx -= 2;
    reasons.push({
      signal: 'injury',
      delta: -2,
      detail: `You logged a severe pain flag (severity ${sev}/5) last block — cutting accessory volume back significantly to give the area time to settle.`,
    });
  } else if (sev >= 2) {
    idx -= 1;
    reasons.push({
      signal: 'injury',
      delta: -1,
      detail: `You logged a pain flag (severity ${sev}/5) last block — easing off accessory volume so it doesn't flare up again.`,
    });
  }

  // AMRAP regression: −1.
  if (input.amrapTrendingDown) {
    idx -= 1;
    reasons.push({
      signal: 'amrap-regression',
      delta: -1,
      detail:
        'Your AMRAP reps trended down last block — that often signals accumulated fatigue, so dialing accessory volume back to help main lifts recover.',
    });
  }

  return { preset: clampPreset(idx), reasons };
}
