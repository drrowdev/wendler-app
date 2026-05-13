/**
 * Four-axis training profile derivation, compatibility matrix, phase
 * interaction matrix, and legacy migration.
 *
 * The schema lives in `training-profile-types.ts`. This module is the
 * functional core: it turns a `TrainingProfile` + race calendar into
 * the legacy `GoalFlags` shape that the suggester / prompt builder /
 * validator already consume — keeping their internals unchanged.
 *
 * Design notes:
 * - The blockPhase × secondary-goal interaction is data, not procedural code,
 *   so it's readable + testable.
 * - All decisions here are deterministic; nothing depends on the LLM.
 */
import type {
  Constraint,
  PrimaryGoal,
  SecondaryGoal,
  TrainingPhase,
  TrainingProfile,
} from './training-profile-types';
import type { GoalFlags } from './goal-flags';
import { phaseDirectiveString } from './profile-directives';
import type { RaceLike } from './races';
import { computeEffectiveGoalFlags } from './taper';
import type { BlockKind } from './blocks';
import type { SeventhWeekKind } from './types';

// ---------------------------------------------------------------------------
// Compatibility matrix (primary × secondary)
// ---------------------------------------------------------------------------

export type CompatLevel = 'recommended' | 'compatible' | 'expensive' | 'redundant';

interface CompatCell {
  level: CompatLevel;
  warning: string;
}

const COMPAT: Record<PrimaryGoal, Record<SecondaryGoal, CompatCell>> = {
  'marathon-prep': {
    'real-life-strength':  { level: 'compatible',  warning: '' },
    'functional-movement': { level: 'compatible',  warning: '' },
    'isolation-emphasis':  {
      level: 'expensive',
      warning:
        'Heavy isolation volume competes with running recovery — consider activating this after your target race.',
    },
  },
  'strength': {
    'real-life-strength':  { level: 'recommended', warning: '' },
    'functional-movement': { level: 'compatible',  warning: '' },
    'isolation-emphasis':  { level: 'compatible',  warning: '' },
  },
  'hypertrophy': {
    'real-life-strength':  { level: 'compatible',  warning: '' },
    'functional-movement': { level: 'compatible',  warning: '' },
    'isolation-emphasis':  {
      level: 'redundant',
      warning:
        'Isolation emphasis is largely redundant when your primary goal is hypertrophy — your assistance already biases isolation. Free up the slot for something complementary like functional movement.',
    },
  },
  'balanced-development': {
    'real-life-strength':  { level: 'compatible',  warning: '' },
    'functional-movement': { level: 'recommended', warning: '' },
    'isolation-emphasis':  { level: 'compatible',  warning: '' },
  },
};

export interface CompatibilityWarning {
  primary: PrimaryGoal;
  secondary: SecondaryGoal;
  level: 'expensive' | 'redundant';
  message: string;
}

export function compatibilityWarnings(
  profile: Pick<TrainingProfile, 'primaryGoal' | 'secondaryGoals'>,
): CompatibilityWarning[] {
  const out: CompatibilityWarning[] = [];
  for (const sec of profile.secondaryGoals) {
    const cell = COMPAT[profile.primaryGoal][sec];
    if (cell.level === 'expensive' || cell.level === 'redundant') {
      out.push({
        primary: profile.primaryGoal,
        secondary: sec,
        level: cell.level,
        message: cell.warning,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// trainingPhase × secondary-goal interaction matrix
// ---------------------------------------------------------------------------

export type SecondaryEffect = 'active' | 'light' | 'priority' | 'suppressed';

const PHASE_X_TIER2: Record<TrainingPhase, Record<SecondaryGoal, SecondaryEffect>> = {
  'normal': {
    'real-life-strength':  'active',
    'functional-movement': 'active',
    'isolation-emphasis':  'active',
  },
  'deload': {
    'real-life-strength':  'suppressed',
    'functional-movement': 'light',
    'isolation-emphasis':  'suppressed',
  },
  'taper': {
    'real-life-strength':  'suppressed',
    'functional-movement': 'light',
    'isolation-emphasis':  'suppressed',
  },
  'peak': {
    'real-life-strength':  'suppressed',
    'functional-movement': 'suppressed',
    'isolation-emphasis':  'suppressed',
  },
};

export function secondaryEffect(secondary: SecondaryGoal, phase: TrainingPhase): SecondaryEffect {
  return PHASE_X_TIER2[phase][secondary];
}

export function effectiveSecondaryGoals(
  secondaryGoals: readonly SecondaryGoal[],
  phase: TrainingPhase,
): SecondaryGoal[] {
  return secondaryGoals.filter((s) => secondaryEffect(s, phase) !== 'suppressed');
}

/**
 * Operational prompt strings for non-'active' phase × secondary-goal cells.
 * Returns undefined for 'active' (no special directive needed) and
 * 'suppressed' (caller already filtered the goal out).
 *
 * The verbatim prompt strings live in `goal-flags.ts` next to
 * `goalsToPromptContext` — this function is a thin matrix-aware shim
 * that ensures we only emit a directive when the matrix says the cell
 * is non-active. Keeping the strings in `goal-flags.ts` means anyone
 * tuning prompt language has one file to scan.
 */
export function phaseDirective(secondary: SecondaryGoal, phase: TrainingPhase): string | undefined {
  const eff = secondaryEffect(secondary, phase);
  if (eff === 'active' || eff === 'suppressed') return undefined;
  return phaseDirectiveString(secondary, phase);
}

// ---------------------------------------------------------------------------
// Block phase resolution (race-driven auto + manual override)
// ---------------------------------------------------------------------------

/**
 * Auto-derive a TrainingPhase from a single race based on date proximity.
 * Returns undefined when the race is past or outside any auto-trigger window.
 *
 * Windows mirror the taper.ts conventions:
 *   - ≤14 days out → 'taper' (both A- and B-priority races)
 *   - A-priority, 15–28 days out → 'peak'
 *   - B-priority, 15–21 days out → 'peak'
 *   - C-priority races never auto-trigger (calendar-only).
 *
 * Honors `taperActions.competitionPeakingActivated.dismissedAt` as a hard
 * opt-out: if the user explicitly dismissed the peaking banner for that
 * race, no auto phase is returned (they said "no").
 */
function autoPhaseFromRace(
  race: RaceLike,
  asOf: Date,
): 'peak' | 'taper' | undefined {
  if (race.completedAt) return undefined;
  if (race.priority === 'C') return undefined;
  const dismissed = race.taperActions?.competitionPeakingActivated;
  if (dismissed && 'dismissedAt' in dismissed) return undefined;
  const ms = new Date(race.date).getTime() - asOf.getTime();
  const days = Math.floor(ms / 86400000);
  if (days < -1) return undefined;
  if (days <= 14) return 'taper';
  if (race.priority === 'A' && days <= 28) return 'peak';
  if (race.priority === 'B' && days <= 21) return 'peak';
  return undefined;
}

/**
 * Minimal shape of the currently-active block, used for block-derived
 * phase inference (e.g. inside a 7th-week deload block). Kept as a
 * structural pick so domain code doesn't depend on the full ProgramBlock
 * surface and tests can pass simple literals.
 */
export interface ActivePhaseBlockLike {
  kind: BlockKind;
  seventhWeekKind?: SeventhWeekKind;
}

/**
 * Where the effective training phase came from. Used by the UI to
 * decide whether to surface the "Auto · …" badge and to drive the
 * one-time first-encounter toast.
 *
 *  - `manual` — the user's stored `profile.trainingPhase` (either the
 *    explicit manual-override path, or the no-auto-signal fallback).
 *    The badge is NOT shown for this source.
 *  - `race`   — auto-derived from an upcoming A/B race (taper ≤14d,
 *    peak 15–28d A / 15–21d B).
 *  - `block`  — auto-derived because the user is inside a `seventh-week`
 *    block with `seventhWeekKind === 'deload'`.
 */
export type PhaseSource = 'manual' | 'race' | 'block';

export interface EffectivePhaseInfo {
  phase: TrainingPhase;
  source: PhaseSource;
}

/**
 * Returns the effective training phase + provenance for a given profile,
 * race calendar, and (optionally) the currently-active block.
 *
 * Resolution order (highest priority first):
 *  1. Manual override (`profile.trainingPhaseManual === true`) → return
 *     `profile.trainingPhase` verbatim, source `manual`.
 *  2. Race-derived peak/taper:
 *       a. Race-accepted `competitionPeakingActivated` banner → `peak`.
 *       b. Date-proximity: soonest A/B race in window → `peak` or `taper`.
 *  3. Block-derived deload: active block is a `seventh-week` block with
 *     `seventhWeekKind === 'deload'` → `deload`, source `block`.
 *  4. Profile fallback (`profile.trainingPhase`) → source `manual`.
 *
 * Pass a future `now` (e.g. the start date of week 3) to ask "what phase
 * will this week land in?". This is how the suggester does per-week
 * auto-derivation when generating assistance at block start.
 */
export function effectiveTrainingPhaseInfo(
  profile: TrainingProfile,
  races: readonly RaceLike[],
  now: Date = new Date(),
  activeBlock?: ActivePhaseBlockLike,
): EffectivePhaseInfo {
  // 1. Manual override — user opted out of auto-management.
  if (profile.trainingPhaseManual) {
    return { phase: profile.trainingPhase, source: 'manual' };
  }

  // 2a. Race-accepted peaking flag (existing taper integration). The
  // input flags mirror the user's stored profile so a stored `deload`
  // or `peak` doesn't get silently dropped by the merge.
  const merged = computeEffectiveGoalFlags(
    {
      marathon: false,
      realLifeStrength: false,
      bigArms: false,
      deload: profile.trainingPhase === 'deload',
      competitionPeaking: profile.trainingPhase === 'peak',
      mobilityFocus: false,
    },
    races,
    now,
  );
  if (merged.effective.competitionPeaking) {
    // Race-accepted peaking promoted the flag. If the user's stored
    // value was already `peak`, this is just a no-op preservation
    // (treat as `manual`); otherwise the race calendar drove it.
    return {
      phase: 'peak',
      source: profile.trainingPhase === 'peak' ? 'manual' : 'race',
    };
  }
  if (merged.effective.deload) {
    // The only path that promotes `deload` here is the user's stored
    // value; race-accepted peaking never sets deload. Treat as manual.
    return { phase: 'deload', source: 'manual' };
  }

  // 2b. Date-proximity race auto-derivation: soonest A/B race whose
  // proximity to `now` triggers an auto phase wins.
  let best: { phase: 'peak' | 'taper'; daysOut: number } | undefined;
  for (const race of races) {
    if (race.priority !== 'A' && race.priority !== 'B') continue;
    const auto = autoPhaseFromRace(race, now);
    if (!auto) continue;
    const daysOut = Math.max(
      0,
      Math.floor((new Date(race.date).getTime() - now.getTime()) / 86400000),
    );
    if (!best || daysOut < best.daysOut) best = { phase: auto, daysOut };
  }
  if (best) return { phase: best.phase, source: 'race' };

  // 3. Block-derived deload — active block is a 7th-week deload. This is
  // the structural deload that fires after the Wendler cadence rule has
  // already gated insertion of the 7th-week block (2 completed Leader
  // blocks → deload prompt; see `nextSeventhWeekRecommendation`). Lower
  // priority than race-driven taper/peak by design — if a race is close
  // enough to taper, that taper should drive the prompt.
  if (
    activeBlock?.kind === 'seventh-week' &&
    activeBlock.seventhWeekKind === 'deload'
  ) {
    return { phase: 'deload', source: 'block' };
  }

  // 4. Profile fallback — no auto signal. `taper` survives as a stored
  // value (kept for back-compat with the pre-source-tag behavior); any
  // other value collapses to `normal`.
  return {
    phase: profile.trainingPhase === 'taper' ? 'taper' : 'normal',
    source: 'manual',
  };
}

/**
 * Thin wrapper that returns just the phase. Preserved for the many
 * existing callers that don't need provenance. New code that wants to
 * render the "Auto · …" badge or fire the first-encounter toast should
 * call `effectiveTrainingPhaseInfo` instead.
 */
export function effectiveTrainingPhase(
  profile: TrainingProfile,
  races: readonly RaceLike[],
  now: Date = new Date(),
  activeBlock?: ActivePhaseBlockLike,
): TrainingPhase {
  return effectiveTrainingPhaseInfo(profile, races, now, activeBlock).phase;
}

// ---------------------------------------------------------------------------
// Derive GoalFlags from the four-axis profile
// ---------------------------------------------------------------------------

export interface DerivedGoalFlagsResult {
  flags: GoalFlags;
  /** Effective phase used for the derivation. */
  phase: TrainingPhase;
  /** Where the phase came from (drives the "Auto · …" badge UI). */
  phaseSource: PhaseSource;
  /** Effective secondaries (post phase suppression), in order. */
  effectiveSecondaries: SecondaryGoal[];
  /** Per-secondary phase directive string when non-active, in same order. */
  phaseDirectives: { secondary: SecondaryGoal; directive: string }[];
}

export function deriveGoalFlags(
  profile: TrainingProfile,
  races: readonly RaceLike[],
  now: Date = new Date(),
  activeBlock?: ActivePhaseBlockLike,
): DerivedGoalFlagsResult {
  const { phase, source: phaseSource } = effectiveTrainingPhaseInfo(
    profile,
    races,
    now,
    activeBlock,
  );
  const effective = effectiveSecondaryGoals(profile.secondaryGoals, phase);
  const flags: GoalFlags = {
    marathon: profile.primaryGoal === 'marathon-prep',
    realLifeStrength: effective.includes('real-life-strength'),
    bigArms: effective.includes('isolation-emphasis'),
    deload: phase === 'deload',
    competitionPeaking: phase === 'peak',
    mobilityFocus: effective.includes('functional-movement'),
  };
  const phaseDirectives: DerivedGoalFlagsResult['phaseDirectives'] = [];
  for (const sec of effective) {
    const dir = phaseDirective(sec, phase);
    if (dir) phaseDirectives.push({ secondary: sec, directive: dir });
  }
  return { flags, phase, phaseSource, effectiveSecondaries: effective, phaseDirectives };
}

// ---------------------------------------------------------------------------
// Mutation helpers (enforce caps)
// ---------------------------------------------------------------------------

/**
 * Toggle a secondary goal on/off. Returns a new array. When trying to
 * add beyond `max`, the operation is a no-op (UI is expected to disable
 * the remaining checkboxes anyway).
 */
export function toggleSecondaryGoal(
  current: readonly SecondaryGoal[],
  goal: SecondaryGoal,
  max: number,
): SecondaryGoal[] {
  const idx = current.indexOf(goal);
  if (idx >= 0) return current.filter((g) => g !== goal);
  if (current.length >= max) return [...current];
  return [...current, goal];
}

// ---------------------------------------------------------------------------
// Migration from legacy GoalFlags + Goal[] to TrainingProfile
// ---------------------------------------------------------------------------

export interface LegacyGoalLike {
  id: string;
  kind:
    | 'strength-pr'
    | 'race-time'
    | 'body-comp'
    | 'habit'
    | 'qualitative'
    | 'custom';
  completedAt?: string;
  updatedAt: string;
  title?: string;
  movementId?: string;
  flavors?: string[];
}

export interface MigrateInput {
  legacyFlags?: GoalFlags;
  legacyGoals?: readonly LegacyGoalLike[];
  races?: readonly RaceLike[];
  now?: Date;
}

export interface MigrateResult {
  profile: TrainingProfile;
  /**
   * True when the migration auto-set a primary goal with high confidence
   * (e.g. an active race exists). UI should show a dismissible
   * confirmation banner rather than a "set your primary goal" prompt.
   */
  autoSetPrimary: boolean;
  reason: string;
}

/**
 * Heuristics, in order:
 *  1. Active A/B race on calendar → primary = marathon-prep (high confidence).
 *  2. Multiple active goals of similar recency for *different* primaries
 *     (≤7d apart) → balanced-development + `primaryGoalAmbiguous`.
 *  3. Most-recent active race-time goal exists → marathon-prep.
 *  4. Active body-comp goal exists → hypertrophy.
 *  5. Active strength-pr goal exists (and no body-comp) → strength.
 *  6. Otherwise → balanced-development (no ambiguity flag — user just
 *     doesn't have strong signal yet).
 */
export function migrateLegacyToTrainingProfile(input: MigrateInput): MigrateResult {
  const now = input.now ?? new Date();
  const flags = input.legacyFlags;
  const legacyGoals = input.legacyGoals ?? [];
  const activeGoals = legacyGoals.filter((g) => !g.completedAt);

  const activeRace = (input.races ?? []).find((r) => {
    if (r.completedAt) return false;
    if (r.priority !== 'A' && r.priority !== 'B') return false;
    return new Date(r.date).getTime() >= now.getTime() - 24 * 60 * 60 * 1000;
  });

  let primaryGoal: PrimaryGoal = 'balanced-development';
  let autoSetPrimary = false;
  let reason = '';
  let primaryGoalAmbiguous = false;

  if (activeRace) {
    primaryGoal = 'marathon-prep';
    autoSetPrimary = true;
    reason = `Auto-set to marathon-prep based on your scheduled race "${activeRace.name}".`;
  } else {
    const sorted = [...activeGoals].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const race = sorted.find((g) => g.kind === 'race-time');
    const body = sorted.find((g) => g.kind === 'body-comp');
    const strength = sorted.find((g) => g.kind === 'strength-pr');

    const candidates = [race, body, strength].filter((g): g is LegacyGoalLike => !!g);
    if (candidates.length >= 2) {
      const newest = Math.max(...candidates.map((g) => new Date(g.updatedAt).getTime()));
      const closeRecent = candidates.filter(
        (g) => newest - new Date(g.updatedAt).getTime() <= 7 * 24 * 60 * 60 * 1000,
      );
      if (closeRecent.length >= 2) {
        primaryGoalAmbiguous = true;
        reason =
          'We found multiple active goals of similar recency. Pick which is your primary focus right now.';
      }
    }

    if (!primaryGoalAmbiguous) {
      if (race) {
        primaryGoal = 'marathon-prep';
        autoSetPrimary = true;
        reason = `Auto-set to marathon-prep based on your goal "${race.title ?? 'race-time'}".`;
      } else if (body) {
        primaryGoal = 'hypertrophy';
        autoSetPrimary = true;
        reason = 'Auto-set to hypertrophy based on your body-composition goal.';
      } else if (strength) {
        primaryGoal = 'strength';
        autoSetPrimary = true;
        reason = 'Auto-set to strength based on your strength PR goal.';
      }
    }
  }

  const desired: SecondaryGoal[] = [];
  if (flags?.realLifeStrength) desired.push('real-life-strength');
  if (flags?.mobilityFocus) desired.push('functional-movement');
  if (flags?.bigArms) desired.push('isolation-emphasis');
  const secondaryGoals = desired.slice(0, 2);

  // Filters are now user-authored only — there is no
  // built-in vocabulary, so legacy `prehab` flavor doesn't auto-seed
  // anything. Add an "Injury prevention" constraint manually if you want
  // prehab guidance from the suggester.
  const constraints: Constraint[] = [];

  let trainingPhase: TrainingPhase = 'normal';
  if (flags?.competitionPeaking) trainingPhase = 'peak';
  else if (flags?.deload) trainingPhase = 'deload';

  return {
    profile: {
      trainingPhase,
      primaryGoal,
      secondaryGoals,
      constraints,
      ...(primaryGoalAmbiguous ? { primaryGoalAmbiguous: true } : {}),
      updatedAt: now.toISOString(),
    },
    autoSetPrimary,
    reason,
  };
}

/**
 * Normalize a stored profile against the current primary/secondary/filter taxonomy.
 *
 * The constraint vocabulary is now fully user-authored (no built-ins),
 * so any persisted constraint with `kind !== 'custom'` is rewritten to
 * `kind: 'custom'` while the user-visible `label` is preserved verbatim.
 * Stored entries for retired kinds (`'no-machines'`, `'trap-bar-issue'`,
 * `'injury-prevention'` as a filter entry, etc.) survive as plain text.
 *
 * Also strips any legacy `'injury-prevention'` value from `secondaryGoals`
 * (it was briefly a secondary goal before being moved to filters, then removed from
 * the built-in vocabulary entirely).
 *
 * Returns `null` when no normalization was needed, otherwise a fresh profile.
 * Callers should persist the normalized profile so the migration is one-shot.
 */
export function normalizeTrainingProfile(
  profile: TrainingProfile,
  now: Date = new Date(),
): TrainingProfile | null {
  const rawSecondary = profile.secondaryGoals as readonly string[];
  const hadLegacyInjuryPrevention = rawSecondary.includes('injury-prevention');
  const hadNonCustomConstraint = profile.constraints.some(
    (c) => (c.kind as string) !== 'custom',
  );
  if (!hadLegacyInjuryPrevention && !hadNonCustomConstraint) return null;

  const cleanedSecondary = hadLegacyInjuryPrevention
    ? rawSecondary.filter((g): g is SecondaryGoal => g !== 'injury-prevention')
    : (profile.secondaryGoals as SecondaryGoal[]);

  const cleanedConstraints: Constraint[] = profile.constraints.map((c) =>
    (c.kind as string) === 'custom' ? c : { ...c, kind: 'custom' as const },
  );

  return {
    ...profile,
    secondaryGoals: cleanedSecondary,
    constraints: cleanedConstraints,
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Constraint helpers
// ---------------------------------------------------------------------------

export function customConstraint(id: string, label: string, now: Date = new Date()): Constraint {
  return { id, kind: 'custom', label, createdAt: now.toISOString(), active: true };
}
