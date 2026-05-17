'use client';

/**
 * Modal picker for linking a logged strength workout-day to a planned
 * date that differs from where the workout's projected weekday lands.
 *
 * Triggered from the /day header chip and from Today's strength entry
 * "Link to slot…" button. Mirrors LinkSlotPicker (cardio direction A:
 * activity → slot) but for strength.
 *
 * Shows quick-pick suggestions for the workout's dayIndex within ±21
 * days plus a freeform custom date input. Bounds are not enforced
 * server-side — the user can pin to any past or future date.
 */

import { useMemo, useState } from 'react';
import { useUpcomingWorkouts } from '@/lib/hooks';
import { findClaimantOfDate, linkWorkoutDayToDate, type WorkoutDayKey } from '@/lib/strengthPlan';
import { toLocalYmd, type WendlerWeek } from '@wendler/domain';

interface Props {
  workout: WorkoutDayKey;
  /** Current planScheduledDate, if any. Used to render "current" chip + Unlink. */
  currentPlannedDate?: string;
  /** Date the workout was actually performed (YYYY-MM-DD). Used for offset labels. */
  performedYmd: string;
  onClose: () => void;
}

interface Suggestion {
  ymd: string;
  dateLabel: string;
  offsetLabel: string;
}

const WINDOW_DAYS = 21;

function fmtDateLabel(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const wd = date.toLocaleDateString('fi-FI', { weekday: 'short' });
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

function diffDays(a: string, b: string) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}

export function StrengthLinkSlotPicker({
  workout,
  currentPlannedDate,
  performedYmd,
  onClose,
}: Props) {
  // Pull upcoming workouts so we can derive the projected weekday for
  // this dayIndex; same source the calendar uses.
  const upcoming = useUpcomingWorkouts({ horizonDays: 60, maxItems: 24 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customDate, setCustomDate] = useState('');
  const [confirmConflict, setConfirmConflict] = useState<{
    date: string;
    claimant: WorkoutDayKey;
  } | null>(null);

  // Find the projected weekday (0=Mon..6=Sun) for THIS workout's
  // dayIndex by sampling upcoming entries in the same block + same
  // dayIndex. Falls back to today's weekday if nothing matches.
  const projectedWeekday = useMemo<number | null>(() => {
    const match = upcoming.find(
      (u) => u.blockId === workout.blockId && u.dayIndex === workout.dayIndex,
    );
    return match ? match.weekday : null;
  }, [upcoming, workout.blockId, workout.dayIndex]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (projectedWeekday == null) return [];
    const today = new Date();
    const out: Suggestion[] = [];
    for (let offset = -WINDOW_DAYS; offset <= WINDOW_DAYS; offset++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12, 0, 0);
      const wd = (d.getDay() + 6) % 7; // ISO Mon=0..Sun=6
      if (wd !== projectedWeekday) continue;
      const ymd = toLocalYmd(d);
      const dist = Math.abs(diffDays(ymd, performedYmd));
      const offsetLabel =
        ymd === performedYmd
          ? 'same day'
          : `${dist} day${dist === 1 ? '' : 's'} ${ymd > performedYmd ? 'after' : 'before'} workout`;
      out.push({ ymd, dateLabel: fmtDateLabel(ymd), offsetLabel });
    }
    out.sort((a, b) => Math.abs(diffDays(a.ymd, performedYmd)) - Math.abs(diffDays(b.ymd, performedYmd)));
    return out;
  }, [projectedWeekday, performedYmd]);

  async function attemptLink(date: string, force = false) {
    setBusy(true);
    setError(null);
    try {
      if (!force) {
        const claimant = await findClaimantOfDate(date);
        if (
          claimant &&
          !(
            claimant.blockId === workout.blockId &&
            claimant.week === workout.week &&
            claimant.dayIndex === workout.dayIndex
          )
        ) {
          setConfirmConflict({ date, claimant });
          setBusy(false);
          return;
        }
      } else if (confirmConflict) {
        // Clear the existing claim first.
        await linkWorkoutDayToDate(confirmConflict.claimant, null);
      }
      await linkWorkoutDayToDate(workout, date);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await linkWorkoutDayToDate(workout, null);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function pickCustom() {
    if (!customDate) return;
    void attemptLink(customDate);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-border px-4 pt-4 pb-3">
          <h3 className="text-lg font-semibold">Link to planned date</h3>
          <p className="mt-1 text-xs text-muted">
            Workout performed <span className="text-fg">{fmtDateLabel(performedYmd)}</span>
            {currentPlannedDate && currentPlannedDate !== performedYmd && (
              <>
                {' '}· currently linked to{' '}
                <span className="text-fg">{fmtDateLabel(currentPlannedDate)}</span>
              </>
            )}
          </p>
        </header>

        {confirmConflict ? (
          <div className="space-y-3 p-4">
            <p className="text-sm">
              Another workout is already linked to{' '}
              <span className="font-medium text-fg">{fmtDateLabel(confirmConflict.date)}</span>.
              Replace its claim?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmConflict(null)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => attemptLink(confirmConflict.date, true)}
                disabled={busy}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
              >
                {busy ? '…' : 'Replace'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {suggestions.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-muted">
                  No projected weekday for this slot — use a custom date below.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {suggestions.map((s) => {
                    const isCurrent = currentPlannedDate === s.ymd;
                    return (
                      <li
                        key={s.ymd}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg/40 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {s.dateLabel}
                            <span className="rounded bg-muted/10 px-1.5 py-0.5 text-[10px] font-normal text-muted">
                              {s.offsetLabel}
                            </span>
                            {isCurrent && (
                              <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 ring-1 ring-sky-500/30">
                                current
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => attemptLink(s.ymd)}
                          disabled={busy || isCurrent}
                          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
                        >
                          {isCurrent ? 'Linked' : 'Link'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="mt-3 rounded-lg border border-border bg-bg/40 p-3">
                <label className="block text-xs font-medium text-muted">
                  Custom date
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    type="date"
                    value={customDate}
                    onChange={(e) => setCustomDate(e.target.value)}
                    className="flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={pickCustom}
                    disabled={busy || !customDate}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
                  >
                    Link
                  </button>
                </div>
              </div>
              {error && <p className="mt-2 px-2 text-xs text-rose-400">{error}</p>}
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
              {currentPlannedDate ? (
                <button
                  type="button"
                  onClick={unlink}
                  disabled={busy}
                  className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-fg disabled:opacity-50"
                >
                  Unlink
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
              >
                Cancel
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

// re-export for convenience to keep type imports tight
export type { WorkoutDayKey, WendlerWeek };
