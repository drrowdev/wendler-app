'use client';

/**
 * TrainingGoalsSection — four-axis Training Profile editor (Phase 3).
 *
 * Replaces the legacy flat `goalFlags` checkbox grid with a structured
 * editor over `settings.trainingProfile`:
 *
 *   1. Primary goal (exactly 1 of 4)
 *   2. Secondary goals (≤ MAX_SECONDARY_GOALS)
 *   3. Training phase (race-driven auto with a manual override)
 *   4. Filters (free-form hard constraints)
 *   5. Free-text notes (still persisted to `settings.goalNotes` for the LLM)
 *
 * On first mount with no profile present, runs
 * `migrateLegacyToTrainingProfile(goalFlags, goals, races)` and persists the
 * derived profile so existing users transition silently. A one-time banner
 * surfaces the auto-set primary goal (or asks the user to disambiguate when
 * the legacy state was inconclusive).
 *
 * The legacy `settings.goalFlags` field is left intact for one release as a
 * read-fallback so a downgrade does not lose state — see the deprecation
 * note on `UserSettings.goalFlags` in @wendler/db-schema.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Constraint,
  type GoalFlags,
  type PrimaryGoal,
  type SecondaryGoal,
  type TrainingPhase,
  type TrainingProfile,
  DEFAULT_GOAL_FLAGS,
  DEFAULT_TRAINING_PROFILE,
  GOAL_NOTES_MAX_LENGTH,
  MAX_SECONDARY_GOALS,
  compatibilityWarnings,
  computeEffectiveGoalFlags,
  customConstraint,
  effectiveTrainingPhaseInfo,
  migrateLegacyToTrainingProfile,
  normalizeTrainingProfile,
  secondaryEffect,
  toggleSecondaryGoal,
} from '@wendler/domain';
import { useGoals, useSettings, useUpcomingRaces, useActiveBlock } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { kickSync } from '@/lib/sync';

const PRIMARY_OPTIONS: { id: PrimaryGoal; label: string; help: string }[] = [
  {
    id: 'marathon-prep',
    label: 'Marathon prep',
    help: 'Endurance race in view. Mandates calf / hip-stability / hamstring; protects long-run quality; trims heavy lower volume.',
  },
  {
    id: 'strength',
    label: 'Strength',
    help: 'Lower reps, higher sets on compound assistance. Bias toward chins / dips / rows at 5–8 reps.',
  },
  {
    id: 'hypertrophy',
    label: 'Hypertrophy',
    help: 'Adds an extra slot per main day. Wider isolation rep ranges (12–20) for arms/shoulders/legs.',
  },
  {
    id: 'balanced-development',
    label: 'Balanced',
    help: 'Default Forever flavor — no goal-specific bias. Pair with secondaries below to flavor the block.',
  },
];

const SECONDARY_OPTIONS: { id: SecondaryGoal; label: string; help: string }[] = [
  {
    id: 'real-life-strength',
    label: 'Real-life strength',
    help: 'Owns loaded carries — farmer, suitcase, sled, sandbag bear-hug, yoke. Mandates one carry slot per week.',
  },
  {
    id: 'functional-movement',
    label: 'Functional movement',
    help: 'Single-leg + anti-rotation accessories (split squat, Pallof press, bird-dog) plus optional low-amplitude jumps/throws. Does not touch carries or bilateral barbell volume.',
  },
  {
    id: 'isolation-emphasis',
    label: 'Isolation emphasis',
    help: 'Direct biceps / triceps / lateral / leg-curl volume on top of compound work.',
  },
];

const PHASE_OPTIONS: { id: TrainingPhase; label: string; help: string }[] = [
  { id: 'normal', label: 'Normal', help: 'Standard block — all secondaries active.' },
  {
    id: 'deload',
    label: 'Deload',
    help: 'Volume ~40% down, no AMRAP. Suppresses real-life-strength and isolation; functional kept light.',
  },
  {
    id: 'taper',
    label: 'Taper',
    help: 'Pre-race fatigue management. Same suppressions as deload, but reps even lower.',
  },
  {
    id: 'peak',
    label: 'Peak',
    help: '2–3 weeks out. Suppresses all secondaries; bias toward proven picks only. Active prehab constraints get per-session emphasis.',
  },
];

// (Built-in constraint vocabulary fully removed — every constraint is
// now user-authored via the "+ Custom" input.)

function flagsAllOff(f: GoalFlags | undefined): boolean {
  if (!f) return true;
  return !f.marathon && !f.realLifeStrength && !f.bigArms && !f.deload && !f.competitionPeaking && !f.mobilityFocus;
}

function newId(): string {
  // crypto.randomUUID is not always available in older browsers; gate it.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function TrainingGoalsSection() {
  const settings = useSettings();
  const goals = useGoals();
  const upcomingRaces = useUpcomingRaces();

  const [profile, setProfile] = useState<TrainingProfile>(DEFAULT_TRAINING_PROFILE);
  const [notes, setNotes] = useState<string>('');
  const [migrationBanner, setMigrationBanner] = useState<{
    kind: 'auto' | 'ambiguous' | 'fresh';
    message: string;
  } | null>(null);
  const [showAddConstraint, setShowAddConstraint] = useState(false);
  const [customLabel, setCustomLabel] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const hydratedRef = useRef(false);
  const migratedRef = useRef(false);

  // Hydrate / migrate on first paint where settings (and, for migration,
  // goals + races) are loaded. We split the two paths so users with an
  // existing profile see their state immediately, while the migration path
  // waits for the legacy signals to land.
  useEffect(() => {
    if (!settings || hydratedRef.current) return;
    if (settings.trainingProfile) {
      hydratedRef.current = true;
      const stored = settings.trainingProfile;
      // One-shot taxonomy normalization: profiles persisted before
      // injury-prevention moved from secondary goal → filter still carry it in
      // secondaryGoals. Strip + relocate to constraints, then persist
      // silently so the migration is idempotent.
      const normalized = normalizeTrainingProfile(stored);
      if (normalized) {
        setProfile(normalized);
        void persistProfile(normalized, { silent: true });
      } else {
        setProfile(stored);
      }
      setNotes(settings.goalNotes ?? '');
      return;
    }
    // Migration path — wait for goals + races to load so we don't lose signal.
    if (goals === undefined || upcomingRaces === undefined) return;
    hydratedRef.current = true;
    setNotes(settings.goalNotes ?? '');

    if (migratedRef.current) return;
    migratedRef.current = true;
    const result = migrateLegacyToTrainingProfile({
      legacyFlags: settings.goalFlags,
      legacyGoals: goals,
      races: upcomingRaces,
    });
    setProfile(result.profile);
    void persistProfile(result.profile, { silent: true });
    if (result.profile.primaryGoalAmbiguous) {
      setMigrationBanner({ kind: 'ambiguous', message: result.reason });
    } else if (result.autoSetPrimary) {
      setMigrationBanner({ kind: 'auto', message: result.reason });
    } else if (flagsAllOff(settings.goalFlags) && (goals ?? []).length === 0) {
      setMigrationBanner({
        kind: 'fresh',
        message: 'No prior signal found — defaulted to Balanced. Pick a primary goal that fits this block.',
      });
    }
  }, [settings, goals, upcomingRaces]);

  async function persistProfile(next: TrainingProfile, opts: { silent?: boolean } = {}) {
    const current = await getDb().settings.get('singleton');
    if (!current) return;
    await getDb().settings.put({
      ...current,
      trainingProfile: { ...next, updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    });
    kickSync();
    if (!opts.silent) setSavedAt(Date.now());
  }

  async function persistNotes(value: string) {
    const current = await getDb().settings.get('singleton');
    if (!current) return;
    await getDb().settings.put({
      ...current,
      goalNotes: value,
      updatedAt: new Date().toISOString(),
    });
    kickSync();
    setSavedAt(Date.now());
  }

  function update(patch: Partial<TrainingProfile>) {
    const next: TrainingProfile = { ...profile, ...patch };
    setProfile(next);
    void persistProfile(next);
  }

  function setPrimary(p: PrimaryGoal) {
    // Note: we deliberately do NOT clear migrationBanner here. If the banner
    // exists because a race auto-set the primary, we want it to stay visible
    // after the user overrides the choice — they should still see what the
    // calendar suggested, not lose that context the moment they click away.
    // (The banner is dismissable via its × button.)
    update({ primaryGoal: p, primaryGoalAmbiguous: false });
  }

  function toggleSecondary(s: SecondaryGoal) {
    const next = toggleSecondaryGoal(profile.secondaryGoals, s, MAX_SECONDARY_GOALS);
    update({ secondaryGoals: next });
  }

  function setPhase(phase: TrainingPhase) {
    // Manual selection always pins the override on.
    update({ trainingPhase: phase, trainingPhaseManual: true });
  }

  function clearPhaseOverride() {
    update({ trainingPhase: 'normal', trainingPhaseManual: false });
  }

  function addCustomConstraint() {
    const label = customLabel.trim();
    if (!label) return;
    const c: Constraint = customConstraint(newId(), label);
    update({ constraints: [...profile.constraints, c] });
    setCustomLabel('');
    setShowAddConstraint(false);
  }

  function removeConstraint(id: string) {
    update({ constraints: profile.constraints.filter((c) => c.id !== id) });
  }

  function toggleConstraintActive(id: string) {
    update({
      constraints: profile.constraints.map((c) =>
        c.id === id ? { ...c, active: c.active === false ? true : false } : c,
      ),
    });
  }

  function startRenameConstraint(id: string, currentLabel: string) {
    setRenamingId(id);
    setRenameDraft(currentLabel);
  }

  function commitRenameConstraint() {
    if (!renamingId) return;
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setRenamingId(null);
      setRenameDraft('');
      return;
    }
    update({
      constraints: profile.constraints.map((c) =>
        c.id === renamingId ? { ...c, label: trimmed } : c,
      ),
    });
    setRenamingId(null);
    setRenameDraft('');
  }

  function cancelRenameConstraint() {
    setRenamingId(null);
    setRenameDraft('');
  }

  // Race-driven phase: compute what the auto-resolver would say (regardless of
  // whether the user has pinned a manual override), so we can surface
  // "auto would pick X" hints next to the manual selection. We also pass
  // the active block so block-derived deload (7th-week deload block) shows
  // up here as an "auto" source — same precedence as everywhere else
  // (manual > race > block > normal).
  const activeBlock = useActiveBlock();
  const autoPhaseInfo = useMemo(
    () =>
      effectiveTrainingPhaseInfo(
        { ...profile, trainingPhaseManual: false },
        upcomingRaces ?? [],
        new Date(),
        activeBlock
          ? { kind: activeBlock.kind, seventhWeekKind: activeBlock.seventhWeekKind }
          : undefined,
      ),
    [profile, upcomingRaces, activeBlock],
  );
  const autoPhase: TrainingPhase = autoPhaseInfo.phase;
  const racePeak = useMemo(() => {
    const eff = computeEffectiveGoalFlags(DEFAULT_GOAL_FLAGS, upcomingRaces ?? []);
    return eff.autoSources.competitionPeaking;
  }, [upcomingRaces]);

  // Race-driven primary suggestion. Mirrors the active-race branch in
  // `migrateLegacyToTrainingProfile`: an active A/B race => marathon-prep.
  // We re-compute this every render (not just at migration time) so the
  // "Auto · <race>" badge stays visible on the suggested primary tile even
  // after the user overrides — they should never lose sight of what the
  // calendar is suggesting, just be able to choose otherwise.
  const autoSuggestion = useMemo<{
    primary: PrimaryGoal;
    raceName: string;
    daysOut: number;
  } | null>(() => {
    const races = upcomingRaces ?? [];
    if (races.length === 0) return null;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const active = races.find((r) => {
      if (r.completedAt) return false;
      if (r.priority !== 'A' && r.priority !== 'B') return false;
      return new Date(r.date).getTime() >= now - dayMs;
    });
    if (!active) return null;
    const daysOut = Math.max(0, Math.round((new Date(active.date).getTime() - now) / dayMs));
    return { primary: 'marathon-prep', raceName: active.name, daysOut };
  }, [upcomingRaces]);

  const phaseInUse: TrainingPhase = profile.trainingPhaseManual
    ? profile.trainingPhase
    : autoPhase;

  const warnings = useMemo(() => compatibilityWarnings(profile), [profile]);
  const showSaved = savedAt !== null && Date.now() - savedAt < 2000;

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Training profile
        </h2>
        {showSaved && <span className="text-xs text-accent">Saved ✓</span>}
      </div>
      <p className="text-xs leading-snug text-muted">
        Shapes the AI assistance suggester. Phase is auto-managed from your race
        calendar; everything else is yours to set. Changes autosave.
      </p>

      {migrationBanner && (
        <div
          className={`rounded-md border px-3 py-2 text-xs ${
            migrationBanner.kind === 'ambiguous'
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
              : 'border-accent/40 bg-accent/10 text-fg'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <span>{migrationBanner.message}</span>
            <button
              type="button"
              onClick={() => setMigrationBanner(null)}
              className="shrink-0 text-muted hover:text-fg"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Primary goal */}
      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Primary goal
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {PRIMARY_OPTIONS.map((opt) => {
            const on = profile.primaryGoal === opt.id;
            const ambiguous = profile.primaryGoalAmbiguous && on;
            const isAutoSuggested = autoSuggestion?.primary === opt.id;
            const overridden = isAutoSuggested && !on;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setPrimary(opt.id)}
                className={`rounded-lg border p-3 text-left text-sm transition ${
                  on
                    ? ambiguous
                      ? 'border-amber-400 bg-amber-500/10 text-fg'
                      : 'border-accent bg-accent/20 text-fg'
                    : overridden
                      ? 'border-accent/40 bg-accent/5 text-muted hover:text-fg'
                      : 'border-border bg-bg text-muted hover:text-fg'
                }`}
                aria-pressed={on}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{opt.label}</span>
                  {ambiguous && (
                    <span className="rounded-full bg-amber-500/30 px-1.5 py-0.5 text-[9px] font-medium uppercase text-amber-100">
                      Confirm
                    </span>
                  )}
                  {isAutoSuggested && (
                    <span
                      className="rounded-full bg-accent/30 px-1.5 py-0.5 text-[9px] font-medium uppercase text-accent"
                      title={`Auto-suggested from race: ${autoSuggestion.raceName} (${autoSuggestion.daysOut === 0 ? 'today' : `${autoSuggestion.daysOut}d out`})`}
                    >
                      Auto · {autoSuggestion.raceName}
                      {autoSuggestion.daysOut === 0 ? ' (today)' : ` · ${autoSuggestion.daysOut}d`}
                      {overridden && ' · overridden'}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-muted">{opt.help}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Secondary goals */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Secondary goals
          </div>
          <div className="text-[10px] text-muted">
            Pick up to {MAX_SECONDARY_GOALS} ({profile.secondaryGoals.length}/{MAX_SECONDARY_GOALS} used)
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {SECONDARY_OPTIONS.map((opt) => {
            const on = profile.secondaryGoals.includes(opt.id);
            const atCap = profile.secondaryGoals.length >= MAX_SECONDARY_GOALS;
            const disabled = !on && atCap;
            const eff = secondaryEffect(opt.id, phaseInUse);
            const phaseBadge =
              eff === 'suppressed'
                ? { text: `Suppressed in ${phaseInUse}`, cls: 'bg-red-500/20 text-red-200' }
                : eff === 'light'
                  ? { text: `Light in ${phaseInUse}`, cls: 'bg-amber-500/20 text-amber-100' }
                  : eff === 'priority'
                    ? { text: `Priority in ${phaseInUse}`, cls: 'bg-accent/30 text-accent' }
                    : null;
            return (
              <label
                key={opt.id}
                className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
                  on
                    ? 'border-accent bg-accent/10'
                    : disabled
                      ? 'cursor-not-allowed border-border bg-bg/50 opacity-50'
                      : 'border-border bg-bg hover:border-accent/40'
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={on}
                  disabled={disabled}
                  onChange={() => toggleSecondary(opt.id)}
                />
                <span className="flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{opt.label}</span>
                    {on && phaseBadge && (
                      <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${phaseBadge.cls}`}>
                        {phaseBadge.text}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                    {opt.help}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((w) => (
              <li
                key={`${w.primary}-${w.secondary}`}
                className={`rounded-md border px-2.5 py-1.5 text-[11px] leading-snug ${
                  w.level === 'redundant'
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
                    : 'border-amber-500/30 bg-bg/60 text-muted'
                }`}
              >
                <span className="font-medium uppercase tracking-wide text-[9px] text-amber-300/90">
                  {w.level === 'redundant' ? 'Redundant' : 'Expensive'}
                </span>
                <span className="ml-1">{w.message}</span>
              </li>
            ))}
          </ul>
        )}
        {/* v1 ships a fixed Tier-2 vocabulary (4 goals) — free-text
            secondaries are explicitly out of scope so the suggester rules
            stay testable. The CTA below routes real demand into a tracked
            channel instead of silently disappearing. */}
        <p className="text-[10px] leading-snug text-muted">
          Don&apos;t see the secondary goal you want?{' '}
          <a
            href="https://github.com/drrowdev/wendler-app/issues/new?labels=enhancement,training-profile&title=Request:%20new%20secondary%20goal&body=What%20secondary%20goal%20should%20be%20added%20and%20why%20does%20it%20matter%20for%20your%20training%3F%0A%0A**Goal%20name:**%20%0A%0A**What%20it%20should%20do%20(slot%20bias,%20rep%20ranges,%20movement%20preference):**%20%0A%0A**How%20it%27s%20different%20from%20the%20existing%204:**%20"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-fg"
          >
            Request one →
          </a>
        </p>
      </div>

      {/* Phase */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Training phase
          </div>
          <div className="text-[10px] text-muted">
            {profile.trainingPhaseManual ? (
              <button
                type="button"
                onClick={clearPhaseOverride}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:text-fg"
              >
                Clear override (back to auto)
              </button>
            ) : (
              <>
                Auto · {autoPhase}
                {autoPhaseInfo.source === 'race' && racePeak
                  ? ` (${racePeak.raceName}, ${racePeak.daysOut}d)`
                  : autoPhaseInfo.source === 'block' && autoPhase === 'deload'
                    ? ' (7th-week deload block)'
                    : ''}
              </>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PHASE_OPTIONS.map((opt) => {
            const isSelected = phaseInUse === opt.id;
            const isManual = profile.trainingPhaseManual && profile.trainingPhase === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setPhase(opt.id)}
                title={opt.help}
                className={`rounded-md border px-2 py-1.5 text-xs transition ${
                  isSelected
                    ? isManual
                      ? 'border-accent bg-accent/20 text-fg'
                      : 'border-accent/60 bg-accent/10 text-fg'
                    : 'border-border bg-bg text-muted hover:text-fg'
                }`}
                aria-pressed={isSelected}
              >
                {opt.label}
                {isSelected && !isManual && <span className="ml-1 text-[9px] text-accent">auto</span>}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] leading-snug text-muted">
          The race calendar drives the phase automatically (deload / taper / peak appear as race day approaches).
          Tap one to pin a manual override.
        </p>
      </div>

      {/* Constraints */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Filters
          </div>
          <button
            type="button"
            onClick={() => setShowAddConstraint((v) => !v)}
            className="rounded border border-border px-2 py-0.5 text-[10px] text-muted hover:text-fg"
          >
            {showAddConstraint ? 'Cancel' : '+ Custom'}
          </button>
        </div>
        <p className="text-[10px] leading-snug text-muted">
          Things to <strong>avoid</strong>. Each filter is a hard exclusion the suggester must
          respect — phrase it as something you do NOT want (e.g. &ldquo;no machines&rdquo;,
          &ldquo;no overhead pressing&rdquo;, &ldquo;left hip flexor flare-up&rdquo;).
          Goal-shaped labels like &ldquo;injury prevention&rdquo; or &ldquo;strength&rdquo; will be
          read as &ldquo;exclude these movements&rdquo; — usually the opposite of what you mean.
          Click a chip to toggle active; × removes it from the list. Click the label to rename.
        </p>
        {profile.constraints.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {profile.constraints.map((c) => {
              const renaming = renamingId === c.id;
              const active = c.active !== false;
              return (
                <span
                  key={c.id}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                    active
                      ? 'border-accent/40 bg-accent/10 text-fg'
                      : 'border-border bg-transparent text-muted'
                  }`}
                >
                  {renaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitRenameConstraint}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRenameConstraint();
                        else if (e.key === 'Escape') cancelRenameConstraint();
                      }}
                      className="w-32 rounded-sm border border-border bg-bg px-1 text-[11px]"
                      aria-label="Edit constraint label"
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => toggleConstraintActive(c.id)}
                        aria-pressed={active}
                        title={active ? 'Click to deactivate' : 'Click to activate'}
                        className="hover:underline"
                      >
                        {c.label}
                      </button>
                      <button
                        type="button"
                        onClick={() => startRenameConstraint(c.id, c.label)}
                        aria-label={`Rename ${c.label}`}
                        title="Rename"
                        className="text-muted/70 hover:text-fg"
                      >
                        ✎
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => removeConstraint(c.id)}
                    className="text-muted/80 hover:text-red-300"
                    aria-label={`Remove ${c.label}`}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {showAddConstraint && (
          <div className="flex gap-2">
            <input
              autoFocus
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addCustomConstraint();
              }}
              placeholder='e.g. "no jumping" or "left hip flexor flare"'
              className="flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={addCustomConstraint}
              disabled={!customLabel.trim()}
              className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-bg disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}
      </div>

      {/* Notes */}
      <div className="space-y-1">
        <label
          htmlFor="goal-notes"
          className="block text-[11px] font-medium uppercase tracking-wide text-muted"
        >
          Notes (free-form context for the LLM)
        </label>
        <textarea
          id="goal-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, GOAL_NOTES_MAX_LENGTH))}
          onBlur={() => void persistNotes(notes)}
          maxLength={GOAL_NOTES_MAX_LENGTH}
          rows={3}
          placeholder="e.g. rehabbing left shoulder, avoid overhead above 90°; no belt this block"
          className="w-full rounded-lg border border-border bg-bg p-2 text-sm leading-snug"
        />
        <div className="flex justify-between text-[10px] text-muted">
          <span>Tighter signal than constraints — for nuance the LLM should read but not enforce.</span>
          <span>{GOAL_NOTES_MAX_LENGTH - notes.length} chars left</span>
        </div>
      </div>
    </section>
  );
}
