'use client';

/**
 * Modal picker for the calendar's unfulfilled planned-strength chip:
 * lists recent logged workout-days that *could* fulfill this planned
 * slot (same blockId + week + dayIndex, not already linked elsewhere),
 * sorted by proximity to the slot date.
 *
 * Mirrors LinkActivityPicker (cardio direction B: slot → activity).
 */

import { useMemo, useState } from 'react';
import { useRecentWorkoutDays } from '@/lib/hooks';
import { findClaimantOfDate, linkWorkoutDayToDate } from '@/lib/strengthPlan';
import { isStrengthLinkable, toLocalYmd, type WendlerWeek } from '@wendler/domain';

interface SlotKey {
  blockId: string;
  week: WendlerWeek;
  dayIndex: number;
  date: string; // YYYY-MM-DD planned date
  label?: string;
}

interface Props {
  slot: SlotKey;
  onClose: () => void;
  onLinked?: (workoutKey: string) => void;
}

const LOOKBACK_DAYS = 21;
const LOOKAHEAD_DAYS = 7;
const MAX_ROWS = 20;

function fmtDateLabel(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const wd = date.toLocaleDateString(undefined, { weekday: 'short' });
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

function diffDays(a: string, b: string) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}

export function StrengthLinkWorkoutPicker({ slot, onClose, onLinked }: Props) {
  const recent = useRecentWorkoutDays(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmConflictDate, setConfirmConflictDate] = useState<{
    workoutKey: { blockId: string; week: WendlerWeek; dayIndex: number };
    existing: { blockId: string; week: WendlerWeek; dayIndex: number };
  } | null>(null);

  const candidates = useMemo(() => {
    if (!recent) return [];
    const slotDate = slot.date;
    return recent
      .filter(
        (d): d is typeof d & { blockId: string; week: WendlerWeek; dayIndex: number } =>
          !!d.blockId && d.week != null && typeof d.dayIndex === 'number',
      )
      .filter((d) =>
        isStrengthLinkable(
          { blockId: d.blockId, week: d.week, dayIndex: d.dayIndex },
          slot,
        ),
      )
      .filter((d) => {
        // Reachable window around the slot date.
        const performed = toLocalYmd(new Date(d.latestPerformedAt));
        const dist = diffDays(performed, slotDate);
        return dist >= -LOOKBACK_DAYS && dist <= LOOKAHEAD_DAYS;
      })
      .filter((d) => {
        // Skip those already pinned to a *different* date (their date
        // is already explicitly claimed elsewhere).
        if (!d.planScheduledDate) return true;
        return d.planScheduledDate === slotDate;
      })
      .map((d) => {
        const performed = toLocalYmd(new Date(d.latestPerformedAt));
        const dist = diffDays(performed, slotDate);
        return {
          key: d.key,
          blockId: d.blockId,
          week: d.week,
          dayIndex: d.dayIndex,
          title: d.title,
          performed,
          performedLabel: fmtDateLabel(performed),
          offsetLabel:
            performed === slotDate
              ? 'same day'
              : `${Math.abs(dist)} day${Math.abs(dist) === 1 ? '' : 's'} ${dist > 0 ? 'after' : 'before'} planned`,
          isCurrent: d.planScheduledDate === slotDate,
        };
      })
      .sort((a, b) => Math.abs(diffDays(a.performed, slotDate)) - Math.abs(diffDays(b.performed, slotDate)))
      .slice(0, MAX_ROWS);
  }, [recent, slot]);

  async function attemptLink(
    workoutKey: { blockId: string; week: WendlerWeek; dayIndex: number },
    force = false,
  ) {
    setBusy(true);
    setError(null);
    try {
      if (!force) {
        const claimant = await findClaimantOfDate(slot.date);
        if (
          claimant &&
          !(
            claimant.blockId === workoutKey.blockId &&
            claimant.week === workoutKey.week &&
            claimant.dayIndex === workoutKey.dayIndex
          )
        ) {
          setConfirmConflictDate({ workoutKey, existing: claimant });
          setBusy(false);
          return;
        }
      } else if (confirmConflictDate) {
        await linkWorkoutDayToDate(confirmConflictDate.existing, null);
      }
      await linkWorkoutDayToDate(workoutKey, slot.date);
      onLinked?.(`${workoutKey.blockId}|${workoutKey.week}|${workoutKey.dayIndex}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
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
          <h3 className="text-lg font-semibold">Link a logged workout</h3>
          <p className="mt-1 text-xs text-muted">
            Planned <span className="text-fg">{fmtDateLabel(slot.date)}</span>
            {slot.label && <> · {slot.label}</>}
          </p>
        </header>

        {confirmConflictDate ? (
          <div className="space-y-3 p-4">
            <p className="text-sm">
              Another workout is already linked to{' '}
              <span className="font-medium text-fg">{fmtDateLabel(slot.date)}</span>.
              Replace its claim?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmConflictDate(null)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => attemptLink(confirmConflictDate.workoutKey, true)}
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
              {candidates.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-muted">
                  No matching logged workouts in the last {LOOKBACK_DAYS} days.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {candidates.map((c) => (
                    <li
                      key={c.key}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg/40 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{c.title}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                          <span>{c.performedLabel}</span>
                          <span className="rounded bg-muted/10 px-1.5 py-0.5 text-[10px]">
                            {c.offsetLabel}
                          </span>
                          {c.isCurrent && (
                            <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 ring-1 ring-sky-500/30">
                              current
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          attemptLink({
                            blockId: c.blockId,
                            week: c.week,
                            dayIndex: c.dayIndex,
                          })
                        }
                        disabled={busy || c.isCurrent}
                        className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
                      >
                        {c.isCurrent ? 'Linked' : 'Link'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {error && <p className="mt-2 px-2 text-xs text-rose-400">{error}</p>}
            </div>

            <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
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
