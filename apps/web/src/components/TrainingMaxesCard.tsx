'use client';

import Link from 'next/link';
import { fmtKg, MAIN_LIFTS } from '@/lib/format';
import { useAllMainLiftMovements, useAllTrainingMaxes } from '@/lib/hooks';

/**
 * Right-rail "Training maxes" panel. Lists the four main lifts with their
 * current TM and the user-picked movement for each slot (e.g. "Trap Bar
 * Deadlift" instead of plain "Deadlift"). If every lift shares the same TM%
 * (the common case), the percentage is printed once at the bottom of the
 * card; otherwise it falls back to a per-row display so divergence is visible.
 */
export function TrainingMaxesCard() {
  const tms = useAllTrainingMaxes();
  const slotMovements = useAllMainLiftMovements();

  if (!tms || tms.size === 0) {
    return (
      <section className="rounded-2xl border border-border bg-card p-4">
        <header className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">Training maxes</h3>
          <Link href="/program/setup" className="text-xs font-medium text-accent hover:underline">
            Set up
          </Link>
        </header>
        <p className="mt-2 text-xs text-muted">Set your TM for the four main lifts to start.</p>
      </section>
    );
  }

  const percents = MAIN_LIFTS.map((l) => tms.get(l.key)?.tmPercent).filter(
    (p): p is number => typeof p === 'number',
  );
  const allSamePct = percents.length === MAIN_LIFTS.length && percents.every((p) => p === percents[0]);
  const sharedPctLabel = allSamePct && percents[0] != null ? `${Math.round(percents[0] * 100)}%` : null;

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Training maxes</h3>
        <Link href="/program/setup" className="text-xs font-medium text-accent hover:underline">
          Edit
        </Link>
      </header>
      <ul className="mt-3 divide-y divide-border/60">
        {MAIN_LIFTS.map((l) => {
          const tm = tms.get(l.key);
          const pct = tm ? Math.round(tm.tmPercent * 100) : null;
          const movement = slotMovements?.get(l.key);
          return (
            <li key={l.key} className="flex items-baseline justify-between py-2 text-sm">
              <span className="min-w-0 flex-1 pr-2">
                <span className="block truncate text-fg">
                  {movement?.name ?? l.label}
                </span>
              </span>
              <span className="flex items-baseline gap-2">
                <span className="font-mono tabular-nums text-fg">{tm ? fmtKg(tm.trainingMaxKg) : '—'}</span>
                {!sharedPctLabel && pct != null && (
                  <span className="text-[10px] text-muted">{pct}%</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {sharedPctLabel && (
        <p className="mt-2 text-[11px] text-muted">All TMs at {sharedPctLabel} of 1RM.</p>
      )}
    </section>
  );
}
