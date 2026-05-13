'use client';

import { useMemo, useState } from 'react';
import type { MainLift, Movement, TrainingMaxRecord } from '@wendler/db-schema';
import { fmtDate, fmtKg, liftLabel, MAIN_LIFTS } from '@/lib/format';
import { LineChart } from '@/components/charts/LineChart';
import { deleteWithTombstones } from '@/lib/delete';
import { AnalyticsCard } from './AnalyticsCard';

const LIFT_COLORS: Record<MainLift, string> = {
  squat: '#10b981',
  bench: '#3b82f6',
  deadlift: '#f59e0b',
  press: '#ef4444',
};

export function OneRmHistoryCard({
  tms,
  slotMovements,
}: {
  tms: TrainingMaxRecord[] | undefined;
  slotMovements: Map<MainLift, Movement> | undefined;
}) {
  const [showEntries, setShowEntries] = useState<Partial<Record<MainLift, boolean>>>({});

  const tmHistory = useMemo(() => {
    const byLift = new Map<MainLift, TrainingMaxRecord[]>();
    if (!tms) return byLift;
    for (const tm of tms) {
      const arr = byLift.get(tm.lift) ?? [];
      arr.push(tm);
      byLift.set(tm.lift, arr);
    }
    for (const arr of byLift.values()) {
      arr.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    }
    return byLift;
  }, [tms]);

  const onDeleteTm = async (id: string, label: string) => {
    if (!confirm(`Delete this entry (${label})? This cannot be undone.`)) return;
    await deleteWithTombstones('trainingMax', [id]);
  };

  const impliedOneRm = (tm: TrainingMaxRecord) => {
    if (tm.oneRmKg && tm.oneRmKg > 0) return tm.oneRmKg;
    return tm.tmPercent > 0 ? tm.trainingMaxKg / tm.tmPercent : tm.trainingMaxKg;
  };

  return (
    <AnalyticsCard title="1RM history" badge="strength">
      <p className="-mt-1 mb-3 text-xs text-muted">
        Implied 1RM over time, derived from your Training Max
        (1RM = TM ÷ TM%). <span className="text-fg/80">Entered</span> values come from the 1RM
        you typed in <em>Settings → Set up</em>;{' '}
        <span className="text-fg/80">Estimated (e1RM)</span> values were computed from a
        top-set AMRAP you accepted on the session screen — so they&apos;re an estimate of strength,
        not a tested rep max.
      </p>
      <div className="space-y-4">
        {MAIN_LIFTS.map((l) => {
          const arr = tmHistory.get(l.key) ?? [];
          const slot = slotMovements?.get(l.key);
          const name = slot?.name ?? liftLabel(l.key);
          if (arr.length === 0) {
            return (
              <div key={l.key} className="text-sm text-muted">
                {name}: not set
              </div>
            );
          }
          const first = arr[0]!;
          const last = arr[arr.length - 1]!;
          const firstOneRm = impliedOneRm(first);
          const lastOneRm = impliedOneRm(last);
          const delta = lastOneRm - firstOneRm;
          const lastIsEstimate = last.source === 'amrap-suggestion';
          const open = !!showEntries[l.key];
          return (
            <div key={l.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{name}</span>
                <span className="flex items-baseline gap-2 text-sm">
                  <span
                    className={
                      lastIsEstimate
                        ? 'rounded border border-accent/40 px-1 text-[10px] uppercase tracking-wide text-accent'
                        : 'rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted'
                    }
                    title={
                      lastIsEstimate
                        ? 'Estimated from a top-set AMRAP'
                        : 'Entered manually in program setup'
                    }
                  >
                    {lastIsEstimate ? 'e1RM' : '1RM'}
                  </span>
                  <span className="font-mono">
                    {lastIsEstimate ? '≈' : ''}
                    {fmtKg(lastOneRm)}
                  </span>{' '}
                  <span className={delta >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    ({delta >= 0 ? '+' : ''}
                    {delta.toFixed(1)} kg)
                  </span>
                </span>
              </div>
              <LineChart
                data={arr.map((tm) => ({
                  x: new Date(tm.createdAt).getTime(),
                  y: impliedOneRm(tm),
                  label: tm.createdAt.slice(0, 10),
                }))}
                color={LIFT_COLORS[l.key]}
                height={80}
                formatY={(n) => `${n.toFixed(0)} kg`}
              />
              <button
                type="button"
                onClick={() =>
                  setShowEntries((prev) => ({ ...prev, [l.key]: !prev[l.key] }))
                }
                aria-expanded={open}
                className="mt-1 text-xs text-muted hover:text-fg"
              >
                {open ? '▾ Hide entries' : `▸ Show ${arr.length} entries`}
              </button>
              {open && (
                <ul className="mt-2 divide-y divide-border/60 rounded-lg border border-border/60 text-xs">
                  {arr
                    .slice()
                    .reverse()
                    .map((tm, idx, all) => {
                      const prev = all[idx + 1];
                      const oneRm = impliedOneRm(tm);
                      const d = prev ? oneRm - impliedOneRm(prev) : 0;
                      const isEstimate = tm.source === 'amrap-suggestion';
                      const sourceLabel = isEstimate ? 'e1RM · estimated' : '1RM · entered';
                      return (
                        <li
                          key={tm.id}
                          className="flex items-center justify-between gap-3 px-2 py-1.5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="font-mono tabular-nums text-fg">
                                {isEstimate ? '≈' : ''}
                                {fmtKg(oneRm)}
                              </span>
                              <span className="text-muted">
                                TM {fmtKg(tm.trainingMaxKg)} @{' '}
                                {Math.round(tm.tmPercent * 100)}%
                              </span>
                              {prev && (
                                <span
                                  className={
                                    d > 0
                                      ? 'text-emerald-400'
                                      : d < 0
                                        ? 'text-red-400'
                                        : 'text-muted'
                                  }
                                >
                                  {d > 0 ? '+' : ''}
                                  {d.toFixed(1)} kg
                                </span>
                              )}
                              <span
                                className={
                                  isEstimate
                                    ? 'rounded border border-accent/40 px-1 text-[10px] uppercase tracking-wide text-accent'
                                    : 'rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted'
                                }
                                title={
                                  isEstimate
                                    ? 'Estimated from a top-set AMRAP (Epley formula)'
                                    : 'Entered manually in program setup'
                                }
                              >
                                {sourceLabel}
                              </span>
                              <span className="font-mono text-muted">
                                {fmtDate(tm.createdAt)}
                              </span>
                            </div>
                            {tm.note && (
                              <div className="mt-0.5 truncate text-muted">{tm.note}</div>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              void onDeleteTm(
                                tm.id,
                                `${name} ${isEstimate ? 'e1RM ≈' : '1RM '}${fmtKg(oneRm)} on ${fmtDate(tm.createdAt)}`,
                              )
                            }
                            className="shrink-0 rounded p-1 text-muted hover:bg-red-500/10 hover:text-red-300"
                            title="Delete this entry"
                            aria-label="Delete this entry"
                          >
                            ×
                          </button>
                        </li>
                      );
                    })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </AnalyticsCard>
  );
}
