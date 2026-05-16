/**
 * Weekly cardio plan + auto-matching against imported Strava activities.
 *
 * The user maintains a tiny recurring template ("Mon=easy, Wed=quality,
 * Sat=long") — one slot per day of week. When a run is synced from Strava
 * we match it to the slot scheduled on the same day. Strava strips most
 * planned-workout context (Runna pushes generic "Evening Run" titles), so
 * day-of-week is the only reliable signal; for the occasional schedule
 * shuffle the user can override the tag manually from the cardio list.
 *
 * Pure module — no Dexie, no React. Testable in isolation. Takes structural
 * inputs only (slots + a minimal activity shape) so it can live in `domain`
 * without importing from `db-schema`.
 */

import type { RunPlanSlot, RunPlannedKind } from './types';

export type PlanMatchConfidence = 'exact' | 'manual' | 'none';

export interface ActivityMatchInput {
  /** ISO timestamp of when the activity was performed. */
  performedAt: string;
  /** Cardio modality; only 'run' (or undefined) is matched. */
  modality?: string;
}

export const RUN_PLANNED_KINDS: { id: RunPlannedKind; label: string; emoji: string }[] = [
  { id: 'rest', label: 'Rest', emoji: '⚪' },
  { id: 'easy', label: 'Easy', emoji: '🟢' },
  { id: 'long', label: 'Long', emoji: '🔵' },
  { id: 'quality', label: 'Quality (tempo)', emoji: '🟠' },
  { id: 'intervals', label: 'Intervals', emoji: '🔥' },
  { id: 'recovery', label: 'Recovery', emoji: '🩵' },
  { id: 'race-pace', label: 'Race pace', emoji: '🏁' },
  { id: 'z2', label: 'Z2 / aerobic', emoji: '💧' },
  { id: 'cross', label: 'Cross-train', emoji: '🚴' },
];

/** Modalities surfaced in the cardio-plan editor's per-slot picker. */
export const CARDIO_MODALITIES_FOR_PICKER: Array<{
  id: 'run' | 'bike' | 'swim' | 'row' | 'walk' | 'padel' | 'other';
  label: string;
  emoji: string;
}> = [
  { id: 'run', label: 'Run', emoji: '🏃' },
  { id: 'bike', label: 'Bike', emoji: '🚴' },
  { id: 'swim', label: 'Swim', emoji: '🏊' },
  { id: 'row', label: 'Row', emoji: '🚣' },
  { id: 'walk', label: 'Walk', emoji: '🚶' },
  { id: 'padel', label: 'Padel', emoji: '🎾' },
  { id: 'other', label: 'Other', emoji: '🔁' },
];

export const RUN_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Convert a JS Date into ISO day-of-week: 0=Monday … 6=Sunday.
 * (`Date.getDay()` returns Sun=0 … Sat=6 — we shift to match European weeks.)
 */
export function isoDayOfWeek(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/**
 * Format a Date as `YYYY-MM-DD` in the local timezone. Matches the calendar
 * grid's `iso` keys so planScheduledDate values can be compared directly.
 */
export function toLocalYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Find the planned slot a completed activity belongs to. Returns `null` when
 * the activity is not a run, the plan provides no useful signal, or the day
 * is a rest day.
 *
 * Day-of-week is the only auto signal — Strava names like "Evening Run" don't
 * carry workout intent. If the user shuffles a workout to a different day
 * they can re-tag it manually from the cardio list (planMatch='manual'),
 * and the rematcher leaves manual tags alone.
 */
export function matchActivityToPlan(
  activity: ActivityMatchInput,
  slots: RunPlanSlot[] | null | undefined,
): { kind: RunPlannedKind; confidence: 'exact'; scheduledDate: string } | null {
  if (!slots || slots.length === 0) return null;
  if (activity.modality && activity.modality !== 'run') return null;

  const performed = new Date(activity.performedAt);
  const dow = isoDayOfWeek(performed);
  const todaySlot = slots.find((s) => s.dayOfWeek === dow);
  if (!todaySlot || todaySlot.kind === 'rest') return null;
  return {
    kind: todaySlot.kind,
    confidence: 'exact',
    scheduledDate: toLocalYmd(performed),
  };
}

/**
 * Whether a cardio activity *could* be linked to a planned slot, ignoring
 * its current link state. True for any run; false for non-runs (walks /
 * bikes / swims aren't on the run plan).
 *
 * The picker uses this as the broad eligibility filter and surfaces the
 * activity's current link state (auto/manual/none) as UI metadata so the
 * user can confidently relink in one step.
 */
export function isRunCandidate(c: { modality?: string }): boolean {
  return c.modality === undefined || c.modality === 'run';
}

/**
 * Whether a cardio activity is *unlinked* — i.e. eligible to be linked to a
 * slot without first detaching it from another. Used for legacy callers and
 * tests; the picker now uses {@link isRunCandidate} directly so already-linked
 * runs can be relinked in one click.
 */
export function isCardioLinkableToSlot(c: {
  modality?: string;
  planMatch?: 'exact' | 'manual' | 'none';
}): boolean {
  if (!isRunCandidate(c)) return false;
  if (c.planMatch === 'manual' || c.planMatch === 'exact') return false;
  return true;
}

export function planLabel(kind: RunPlannedKind): string {
  return RUN_PLANNED_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

export function planEmoji(kind: RunPlannedKind): string {
  return RUN_PLANNED_KINDS.find((k) => k.id === kind)?.emoji ?? '•';
}
