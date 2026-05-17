'use client';

/**
 * Modal picker for linking a single cardio activity to a planned slot whose
 * day-of-week didn't match the activity's actual day.
 *
 * Triggered from the activity row in /cardio (the "Link to slot…" button on
 * a run). Lists planned non-rest slots in the lookback window that aren't
 * already fulfilled by another cardio. Sorted by proximity to the activity.
 *
 * The complementary direction — picking an *activity* for a planned slot —
 * lives in LinkActivityPicker (opened from the calendar planned-pill).
 */

import { useMemo, useState } from 'react';
import { useAllCardio, useRunPlan } from '@/lib/hooks';
import { linkActivityToSlot, setManualPlanKind } from '@/lib/runPlan';
import {
  isoDayOfWeek,
  planEmoji,
  planLabel,
  toLocalYmd,
  type RunPlannedKind,
} from '@wendler/domain';
import type { CardioSession } from '@wendler/db-schema';

interface Props {
  cardio: CardioSession;
  onClose: () => void;
}

const LOOKBACK_DAYS = 21;
const LOOKAHEAD_DAYS = 7;

interface SlotCandidate {
  ymd: string;
  kind: RunPlannedKind;
  dateLabel: string;
  offsetLabel: string;
  fulfilledByOtherId?: string;
}

function fmtDateLabel(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const wd = date.toLocaleDateString('fi-FI', { weekday: 'short' });
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

export function LinkSlotPicker({ cardio, onClose }: Props) {
  const plan = useRunPlan();
  const all = useAllCardio();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const performedYmd = toLocalYmd(new Date(cardio.performedAt));

  const candidates = useMemo<SlotCandidate[]>(() => {
    const slots = plan?.slots ?? [];
    if (slots.length === 0) return [];
    const today = new Date();
    const out: SlotCandidate[] = [];
    for (let offset = -LOOKBACK_DAYS; offset <= LOOKAHEAD_DAYS; offset++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12, 0, 0);
      const dow = isoDayOfWeek(d);
      const slot = slots.find((s) => s.dayOfWeek === dow);
      if (!slot || slot.kind === 'rest') continue;
      const ymd = toLocalYmd(d);
      const claim = (all ?? []).find(
        (c) => c.id !== cardio.id && c.planScheduledDate === ymd,
      );
      out.push({
        ymd,
        kind: slot.kind,
        dateLabel: fmtDateLabel(ymd),
        offsetLabel:
          ymd === performedYmd
            ? 'same day'
            : `${Math.abs(diffDays(ymd, performedYmd))} day${
                Math.abs(diffDays(ymd, performedYmd)) === 1 ? '' : 's'
              } ${ymd > performedYmd ? 'after' : 'before'} run`,
        fulfilledByOtherId: claim?.id,
      });
    }
    out.sort((a, b) => {
      const aDist = Math.abs(diffDays(a.ymd, performedYmd));
      const bDist = Math.abs(diffDays(b.ymd, performedYmd));
      if (aDist !== bDist) return aDist - bDist;
      return a.ymd < b.ymd ? -1 : 1;
    });
    return out;
  }, [plan, all, cardio.id, performedYmd]);

  async function pick(slot: SlotCandidate) {
    setBusy(true);
    setError(null);
    try {
      await linkActivityToSlot(cardio.id, slot.ymd, slot.kind);
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
      await setManualPlanKind(cardio.id, null);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const slotsConfigured = (plan?.slots?.length ?? 0) > 0;
  const isLinked = !!cardio.planScheduledDate;

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
          <h3 className="text-lg font-semibold">Link to planned slot</h3>
          <p className="mt-1 text-xs text-muted">
            Run on <span className="text-fg">{fmtDateLabel(performedYmd)}</span>{' '}
            — pick which planned slot it fulfilled.
          </p>
        </header>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {!slotsConfigured ? (
            <p className="px-2 py-6 text-center text-sm text-muted">
              No weekly run plan configured yet. Set one up under Cardio →
              Plan.
            </p>
          ) : candidates.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted">
              No planned slots in the last {LOOKBACK_DAYS} days.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {candidates.map((s) => {
                const claimed = !!s.fulfilledByOtherId;
                const sameAsCurrent =
                  cardio.planScheduledDate === s.ymd &&
                  cardio.plannedKind === s.kind;
                return (
                  <li
                    key={s.ymd}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg/40 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {s.dateLabel}
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">
                          {planEmoji(s.kind)} {planLabel(s.kind)}
                        </span>
                        <span className="rounded bg-muted/10 px-1.5 py-0.5 text-[10px] font-normal text-muted">
                          {s.offsetLabel}
                        </span>
                        {claimed && (
                          <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-300 ring-1 ring-rose-500/30">
                            already linked
                          </span>
                        )}
                        {sameAsCurrent && (
                          <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 ring-1 ring-sky-500/30">
                            current
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => pick(s)}
                      disabled={busy || claimed || sameAsCurrent}
                      className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
                    >
                      {busy ? '…' : sameAsCurrent ? 'Linked' : 'Link'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error && (
            <p className="mt-2 px-2 text-xs text-rose-400">{error}</p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          {isLinked ? (
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
      </div>
    </div>
  );
}

function diffDays(a: string, b: string) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}
