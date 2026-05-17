'use client';

/**
 * Modal picker for linking a previously-imported run to a planned slot
 * whose original day-of-week didn't match the activity's actual day.
 *
 * Lists the user's recent runs (last 21 days, max 20) that are eligible
 * for linking — i.e. modality === 'run' and not already manually pinned to
 * another slot. Sorted by proximity to the slot date so "the run a day off"
 * floats to the top.
 *
 * Linking writes planMatch='manual' + planScheduledDate=slotDate so the
 * planned-run pill on the original date disappears and the week strip
 * counts the slot as fulfilled. See `linkActivityToSlot` in lib/runPlan.ts.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAllCardio } from '@/lib/hooks';
import { linkActivityToSlot } from '@/lib/runPlan';
import {
  isCardioLinkableToSlot,
  planEmoji,
  planLabel,
  toLocalYmd,
  type RunPlannedKind,
} from '@wendler/domain';
import type { CardioSession } from '@wendler/db-schema';

interface Props {
  slotDate: string; // YYYY-MM-DD
  slotKind: RunPlannedKind;
  onClose: () => void;
  onLinked?: (cardioId: string) => void;
}

const LOOKBACK_DAYS = 21;
const MAX_ROWS = 20;

function fmtDate(iso: string) {
  const d = new Date(iso);
  const wd = d.toLocaleDateString('fi-FI', { weekday: 'short' });
  return `${wd} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function fmtPace(sec: number, km?: number) {
  if (!km || km <= 0) return null;
  const paceSec = sec / km;
  const m = Math.floor(paceSec / 60);
  const s = Math.round(paceSec % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

function daysBetween(a: string, b: string) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.abs(Math.round((da.getTime() - db.getTime()) / 86400000));
}

export function LinkActivityPicker({ slotDate, slotKind, onClose, onLinked }: Props) {
  const all = useAllCardio();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo<CardioSession[]>(() => {
    if (!all) return [];
    const slotMs = new Date(slotDate + 'T00:00:00').getTime();
    const cutoffMs = slotMs - LOOKBACK_DAYS * 86400000;
    const horizonMs = slotMs + LOOKBACK_DAYS * 86400000;
    const list = all.filter((c) => {
      if (!isCardioLinkableToSlot(c)) return false;
      const t = new Date(c.performedAt).getTime();
      return t >= cutoffMs && t <= horizonMs;
    });
    list.sort((a, b) => {
      const aYmd = toLocalYmd(new Date(a.performedAt));
      const bYmd = toLocalYmd(new Date(b.performedAt));
      const aDist = daysBetween(aYmd, slotDate);
      const bDist = daysBetween(bYmd, slotDate);
      if (aDist !== bDist) return aDist - bDist;
      return new Date(b.performedAt).getTime() - new Date(a.performedAt).getTime();
    });
    return list.slice(0, MAX_ROWS);
  }, [all, slotDate]);

  async function link(c: CardioSession) {
    setBusyId(c.id);
    setError(null);
    try {
      await linkActivityToSlot(c.id, slotDate, slotKind);
      onLinked?.(c.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusyId(null);
    }
  }

  const slotLabel = `${planEmoji(slotKind)} ${planLabel(slotKind)}`;
  const slotDateNice = fmtDate(slotDate + 'T12:00:00');

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
          <h3 className="text-lg font-semibold">Link activity</h3>
          <p className="mt-1 text-xs text-muted">
            Pick the run that fulfilled the {slotLabel} slot scheduled for{' '}
            <span className="text-fg">{slotDateNice}</span>.
          </p>
        </header>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {candidates.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted">
              <p>No unlinked runs in the last {LOOKBACK_DAYS} days.</p>
              <p className="mt-2">
                If a run you expected is missing, it&apos;s already attached to
                another slot. Open it from{' '}
                <Link
                  href="/cardio"
                  onClick={onClose}
                  className="text-accent underline"
                >
                  Cardio
                </Link>{' '}
                and use &ldquo;Link to slot…&rdquo; to move it.
              </p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {candidates.map((c) => {
                const ymd = toLocalYmd(new Date(c.performedAt));
                const offset = daysBetween(ymd, slotDate);
                const offsetLabel =
                  offset === 0
                    ? 'same day'
                    : `${offset} day${offset === 1 ? '' : 's'} ${ymd > slotDate ? 'after' : 'before'}`;
                const pace = fmtPace(c.durationSec, c.distanceKm);
                return (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg/40 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        🏃 {fmtDate(c.performedAt)}
                        <span className="rounded bg-muted/10 px-1.5 py-0.5 text-[10px] font-normal text-muted">
                          {offsetLabel}
                        </span>
                        {c.plannedKind && (
                          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">
                            {planEmoji(c.plannedKind)} {planLabel(c.plannedKind)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {fmtDuration(c.durationSec)}
                        {c.distanceKm !== undefined &&
                          ` · ${c.distanceKm.toFixed(2)} km`}
                        {pace && ` · ${pace}`}
                        {c.avgHrBpm !== undefined && ` · ${c.avgHrBpm} bpm`}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => link(c)}
                      disabled={busyId !== null}
                      className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
                    >
                      {busyId === c.id ? 'Linking…' : 'Link'}
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

        <footer className="flex justify-end border-t border-border px-4 py-3">
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
