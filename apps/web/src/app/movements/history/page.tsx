'use client';

// Per-movement training history. Surfaces every set the user has logged for
// a single Movement, summarised as:
//   - Top-set e1RM chart over time (one point per workout day)
//   - All-time best set + best volume day tiles
//   - Weekly tonnage bar chart
//   - Full set log grouped by day, newest first
//
// Works for both main lifts and assistance movements — the SetRecord table
// stores everything against `movementId` regardless of `kind`.

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { epley1RM } from '@wendler/domain';
import type { SetRecord } from '@wendler/db-schema';
import { fmtDate, fmtKg } from '@/lib/format';
import { getDb } from '@/lib/db';
import { useSetsForMovement } from '@/lib/hooks';
import { LineChart, type LineChartPoint } from '@/components/charts/LineChart';
import { BarChart } from '@/components/charts/BarChart';

function ymd(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ISO week bucket "YYYY-Www" — Monday-anchored.
function isoWeekBucket(iso: string): string {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  // Shift to Thursday in the same week to lock the ISO year.
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const firstThu = new Date(d.getFullYear(), 0, 4);
  firstThu.setDate(firstThu.getDate() + 3 - ((firstThu.getDay() + 6) % 7));
  const week =
    1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function fmtWeekTick(bucket: string): string {
  // "2026-W19" → "W19". Keep ticks compact.
  const m = /-W(\d{2})$/.exec(bucket);
  return m ? `W${m[1]}` : bucket;
}

export default function MovementHistoryPageWrapper() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <MovementHistoryPage />
    </Suspense>
  );
}

function MovementHistoryPage() {
  const router = useRouter();
  const search = useSearchParams();
  const id = search.get('id') ?? '';

  const movement = useLiveQuery(
    async () => (id ? getDb().movements.get(id) : undefined),
    [id],
  );
  const allSets = useSetsForMovement(id);

  // Filter out warm-up sets (they distort tonnage and the top-set chart) and
  // anything skipped or tombstoned. Sort oldest → newest for chart math.
  const sets: SetRecord[] = useMemo(() => {
    return ((allSets ?? []) as SetRecord[])
      .filter((s) => !s.deletedAt && !s.skipped && s.kind !== 'warmup')
      .filter((s) => s.weightKg >= 0 && s.reps > 0)
      .sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1));
  }, [allSets]);

  // ---------- aggregations ----------------------------------------------
  // Top set per workout day (best e1RM). Used for the strength-trend line.
  const topSetByDay = useMemo(() => {
    const map = new Map<string, { set: SetRecord; e1rm: number }>();
    for (const s of sets) {
      const e1 = epley1RM(s.weightKg, s.reps);
      const key = ymd(s.performedAt);
      const existing = map.get(key);
      if (!existing || e1 > existing.e1rm) {
        map.set(key, { set: s, e1rm: e1 });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.set.performedAt < b.set.performedAt ? -1 : 1,
    );
  }, [sets]);

  // All-time PR: heaviest single set (ties broken by reps).
  const heaviestSet = useMemo(() => {
    let best: SetRecord | undefined;
    for (const s of sets) {
      if (!best) {
        best = s;
        continue;
      }
      if (s.weightKg > best.weightKg) best = s;
      else if (s.weightKg === best.weightKg && s.reps > best.reps) best = s;
    }
    return best;
  }, [sets]);

  // Best e1RM ever (any set).
  const bestE1Rm = useMemo(() => {
    let best = 0;
    let bestSet: SetRecord | undefined;
    for (const s of sets) {
      const e1 = epley1RM(s.weightKg, s.reps);
      if (e1 > best) {
        best = e1;
        bestSet = s;
      }
    }
    return bestSet ? { set: bestSet, e1rm: best } : undefined;
  }, [sets]);

  // Best volume day (max Σ weight × reps within one calendar day).
  const bestVolumeDay = useMemo(() => {
    const byDay = new Map<string, { volume: number; dateIso: string; setCount: number }>();
    for (const s of sets) {
      const key = ymd(s.performedAt);
      const v = s.weightKg * s.reps;
      const cur = byDay.get(key);
      if (cur) {
        cur.volume += v;
        cur.setCount += 1;
      } else {
        byDay.set(key, { volume: v, dateIso: s.performedAt, setCount: 1 });
      }
    }
    let best: { volume: number; dateIso: string; setCount: number } | undefined;
    for (const v of byDay.values()) {
      if (!best || v.volume > best.volume) best = v;
    }
    return best;
  }, [sets]);

  // Weekly tonnage; last 26 ISO weeks for legibility.
  const weeklyTonnage = useMemo(() => {
    if (sets.length === 0) return [] as { label: string; value: number }[];
    const map = new Map<string, number>();
    for (const s of sets) {
      const key = isoWeekBucket(s.performedAt);
      map.set(key, (map.get(key) ?? 0) + s.weightKg * s.reps);
    }
    // Fill zero-weeks between first and last for continuity.
    const firstSet = sets[0]!;
    const lastSet = sets[sets.length - 1]!;
    const start = new Date(firstSet.performedAt);
    start.setHours(0, 0, 0, 0);
    const end = new Date(lastSet.performedAt);
    end.setHours(0, 0, 0, 0);
    const ordered: { label: string; value: number }[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = isoWeekBucket(cursor.toISOString());
      if (ordered.length === 0 || ordered[ordered.length - 1]!.label !== fmtWeekTick(key)) {
        ordered.push({ label: fmtWeekTick(key), value: map.get(key) ?? 0 });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return ordered.slice(-26);
  }, [sets]);

  // Day groups for the full set log (newest first).
  const setsByDayDesc = useMemo(() => {
    const map = new Map<string, SetRecord[]>();
    for (const s of sets) {
      const key = ymd(s.performedAt);
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([day, arr]) => ({
        day,
        dateIso: arr[0]!.performedAt,
        sets: arr.sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1)),
        volume: arr.reduce((acc, s) => acc + s.weightKg * s.reps, 0),
      }));
  }, [sets]);

  // ---------- render ----------------------------------------------------
  if (!id) return <div className="text-sm text-muted">Missing movement id.</div>;
  if (!movement) return <div className="text-sm text-muted">Loading…</div>;

  const totalReps = sets.reduce((acc, s) => acc + s.reps, 0);
  const totalVolume = sets.reduce((acc, s) => acc + s.weightKg * s.reps, 0);

  const chartPoints: LineChartPoint[] = topSetByDay.map((d) => ({
    x: new Date(d.set.performedAt).getTime(),
    y: d.e1rm,
    label: `${fmtDate(d.set.performedAt)} · e1RM ${fmtKg(d.e1rm)} (${fmtKg(d.set.weightKg)} × ${d.set.reps})`,
  }));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => router.back()}
            className="mb-1 text-xs text-muted hover:text-fg"
          >
            ‹ Back
          </button>
          <h1 className="truncate text-2xl font-bold tracking-tight">{movement.name}</h1>
          <p className="text-xs text-muted">
            {movement.equipment} · {movement.pattern}
            {movement.isCompound ? ' · compound' : ''}
          </p>
        </div>
        <Link
          href={`/movements/edit?id=${encodeURIComponent(id)}`}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs hover:border-accent"
        >
          Edit
        </Link>
      </header>

      {sets.length === 0 ? (
        <section className="rounded-2xl border border-border bg-card p-5 text-sm text-muted">
          No sets logged for {movement.name} yet.
        </section>
      ) : (
        <>
          {/* Summary tiles ------------------------------------------------ */}
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile
              label="Heaviest set"
              value={heaviestSet ? `${fmtKg(heaviestSet.weightKg)} × ${heaviestSet.reps}` : '—'}
              sub={heaviestSet ? fmtDate(heaviestSet.performedAt) : undefined}
            />
            <StatTile
              label="Best e1RM"
              value={bestE1Rm ? fmtKg(bestE1Rm.e1rm) : '—'}
              sub={
                bestE1Rm
                  ? `${fmtKg(bestE1Rm.set.weightKg)} × ${bestE1Rm.set.reps} · ${fmtDate(bestE1Rm.set.performedAt)}`
                  : undefined
              }
            />
            <StatTile
              label="Best volume day"
              value={bestVolumeDay ? `${Math.round(bestVolumeDay.volume).toLocaleString()} kg` : '—'}
              sub={
                bestVolumeDay
                  ? `${bestVolumeDay.setCount} sets · ${fmtDate(bestVolumeDay.dateIso)}`
                  : undefined
              }
            />
            <StatTile
              label="All-time"
              value={`${sets.length} sets`}
              sub={`${totalReps.toLocaleString()} reps · ${Math.round(totalVolume).toLocaleString()} kg`}
            />
          </section>

          {/* Strength trend ---------------------------------------------- */}
          <section className="rounded-2xl border border-border bg-card p-4">
            <h2 className="mb-1 text-sm font-semibold">Top-set e1RM over time</h2>
            <p className="mb-3 text-xs text-muted">
              Best estimated 1RM per workout day (Epley: weight × (1 + reps ÷ 30)).
              Each point is the top set you logged that day.
            </p>
            <LineChart
              data={chartPoints}
              color="#10b981"
              yLabel="kg"
              formatY={(n) => `${Math.round(n)} kg`}
            />
          </section>

          {/* Weekly tonnage ---------------------------------------------- */}
          {weeklyTonnage.length > 1 && (
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="mb-1 text-sm font-semibold">Weekly tonnage</h2>
              <p className="mb-3 text-xs text-muted">
                Total weight moved per ISO week (Σ weight × reps), last {weeklyTonnage.length} weeks.
              </p>
              <BarChart
                data={weeklyTonnage}
                color="#6366f1"
                formatValue={(n) => `${Math.round(n).toLocaleString()} kg`}
              />
            </section>
          )}

          {/* Full log ---------------------------------------------------- */}
          <section className="rounded-2xl border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Set log</h2>
            <ul className="divide-y divide-border/60">
              {setsByDayDesc.map((day) => (
                <li key={day.day} className="py-3 first:pt-0 last:pb-0">
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">{fmtDate(day.dateIso)}</span>
                    <span className="text-[11px] tabular-nums text-muted">
                      {day.sets.length} sets · {Math.round(day.volume).toLocaleString()} kg
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {day.sets.map((s, i) => (
                      <li
                        key={s.id}
                        className="flex items-center gap-2 rounded bg-bg/40 px-2 py-1 text-xs ring-1 ring-border/60"
                      >
                        <span className="w-6 shrink-0 text-muted">#{i + 1}</span>
                        <span className="flex-1 font-mono tabular-nums">
                          {s.weightKg > 0 ? fmtKg(s.weightKg) : 'BW'} × {s.reps}
                        </span>
                        {s.isAmrap && (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-amber-500/40">
                            AMRAP
                          </span>
                        )}
                        {s.kind !== 'main' && s.kind !== 'amrap' && (
                          <span className="rounded bg-bg px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted ring-1 ring-border">
                            {s.kind}
                          </span>
                        )}
                        <span className="text-[10px] tabular-nums text-muted">
                          e1RM {fmtKg(epley1RM(s.weightKg, s.reps))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-base font-bold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted">{sub}</div>}
    </div>
  );
}
