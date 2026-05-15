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

import { Suspense, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { effectiveLoadKg, epley1RM } from '@wendler/domain';
import type { SetRecord } from '@wendler/db-schema';
import { fmtDate, fmtKg } from '@/lib/format';
import { getDb } from '@/lib/db';
import { useAllRecovery, useSetsForMovement } from '@/lib/hooks';
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
  const recovery = useAllRecovery();

  // Movement classification — drives whether we factor bodyweight into the
  // effective load. `equipment === 'bodyweight'` covers pull-ups, dips,
  // push-ups, planks, etc.; `externallyLoadable` (e.g. weighted pull-up
  // with a belt) keeps the user's logged weight ON TOP of bodyweight.
  const isBodyweight = movement?.equipment === 'bodyweight';
  const isExternallyLoadable = !!movement?.externallyLoadable;

  // Sorted bodyweight timeline from recovery entries (id == YYYY-MM-DD).
  // For each set we look up the most recent bodyweight on-or-before the
  // set's calendar day; falls back to the latest known bodyweight.
  const bodyweightTimeline = useMemo(() => {
    const out: { date: string; kg: number }[] = [];
    for (const r of recovery ?? []) {
      if (r.bodyweightKg && r.bodyweightKg > 0) {
        out.push({ date: r.id, kg: r.bodyweightKg });
      }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
  }, [recovery]);
  const latestBodyweight = bodyweightTimeline.length > 0
    ? bodyweightTimeline[bodyweightTimeline.length - 1]!.kg
    : undefined;
  const bodyweightOn = useCallback(
    (iso: string): number | undefined => {
      if (bodyweightTimeline.length === 0) return undefined;
      const d = ymd(iso);
      // Linear scan from newest is fine — bodyweight log is small.
      for (let i = bodyweightTimeline.length - 1; i >= 0; i -= 1) {
        if (bodyweightTimeline[i]!.date <= d) return bodyweightTimeline[i]!.kg;
      }
      return latestBodyweight;
    },
    [bodyweightTimeline, latestBodyweight],
  );

  // Effective load per set: weightKg unless this is a bodyweight movement,
  // in which case effectiveLoadKg from the domain adds bodyweight (or only
  // counts bodyweight for non-loadable BW work). Returns undefined when
  // we can't compute it (BW movement, no recorded bodyweight) so callers
  // can fall back gracefully instead of showing "0 kg".
  const effectiveKg = useCallback(
    (s: SetRecord): number | undefined => {
      if (!isBodyweight) return s.weightKg;
      const bw = bodyweightOn(s.performedAt);
      if (bw == null && s.weightKg <= 0) return undefined;
      return effectiveLoadKg({
        weightKg: s.weightKg,
        bodyweightKg: bw,
        isBodyweight,
        isExternallyLoadable,
      });
    },
    [isBodyweight, isExternallyLoadable, bodyweightOn],
  );

  // Filter out warm-up sets (they distort tonnage and the top-set chart) and
  // anything skipped or tombstoned. Sort oldest → newest for chart math.
  const sets: SetRecord[] = useMemo(() => {
    return ((allSets ?? []) as SetRecord[])
      .filter((s) => !s.deletedAt && !s.skipped && s.kind !== 'warmup')
      .filter((s) => s.weightKg >= 0 && s.reps > 0)
      .sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1));
  }, [allSets]);

  // True when this movement's e1RM/tonnage stats can be meaningfully
  // expressed in kg — main lifts and externally-loadable BW movements
  // with at least one bodyweight reading available. For non-loadable
  // pure-bodyweight movements with no recorded BW, we surface reps-only
  // metrics so the page doesn't lie with "0 kg" tiles.
  const canComputeLoadKg =
    !isBodyweight || bodyweightTimeline.length > 0 || sets.some((s) => s.weightKg > 0);

  // ---------- aggregations ----------------------------------------------
  // Top set per workout day (best e1RM on effective load). Used for the
  // strength-trend line.
  const topSetByDay = useMemo(() => {
    const map = new Map<string, { set: SetRecord; e1rm: number; loadKg: number }>();
    for (const s of sets) {
      const load = effectiveKg(s);
      if (load == null || load <= 0) continue;
      const e1 = epley1RM(load, s.reps);
      const key = ymd(s.performedAt);
      const existing = map.get(key);
      if (!existing || e1 > existing.e1rm) {
        map.set(key, { set: s, e1rm: e1, loadKg: load });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.set.performedAt < b.set.performedAt ? -1 : 1,
    );
  }, [sets, effectiveKg]);

  // Heaviest single set by effective load (ties broken by reps).
  const heaviestSet = useMemo(() => {
    let best: { set: SetRecord; loadKg: number } | undefined;
    for (const s of sets) {
      const load = effectiveKg(s);
      if (load == null || load <= 0) continue;
      if (!best) {
        best = { set: s, loadKg: load };
        continue;
      }
      if (load > best.loadKg) best = { set: s, loadKg: load };
      else if (load === best.loadKg && s.reps > best.set.reps) best = { set: s, loadKg: load };
    }
    return best;
  }, [sets, effectiveKg]);

  // Best e1RM ever (effective load).
  const bestE1Rm = useMemo(() => {
    let best = 0;
    let bestSet: SetRecord | undefined;
    let bestLoad = 0;
    for (const s of sets) {
      const load = effectiveKg(s);
      if (load == null || load <= 0) continue;
      const e1 = epley1RM(load, s.reps);
      if (e1 > best) {
        best = e1;
        bestSet = s;
        bestLoad = load;
      }
    }
    return bestSet ? { set: bestSet, e1rm: best, loadKg: bestLoad } : undefined;
  }, [sets, effectiveKg]);

  // Best volume day (max Σ effectiveLoad × reps within one calendar day).
  // Best rep day is also tracked for bodyweight-only movements with no BW
  // recorded — when we can't compute kg, reps are the meaningful axis.
  const bestVolumeDay = useMemo(() => {
    const byDay = new Map<string, { volume: number; dateIso: string; setCount: number }>();
    for (const s of sets) {
      const load = effectiveKg(s);
      if (load == null || load <= 0) continue;
      const key = ymd(s.performedAt);
      const v = load * s.reps;
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
  }, [sets, effectiveKg]);

  const bestRepDay = useMemo(() => {
    const byDay = new Map<string, { reps: number; dateIso: string; setCount: number }>();
    for (const s of sets) {
      const key = ymd(s.performedAt);
      const cur = byDay.get(key);
      if (cur) {
        cur.reps += s.reps;
        cur.setCount += 1;
      } else {
        byDay.set(key, { reps: s.reps, dateIso: s.performedAt, setCount: 1 });
      }
    }
    let best: { reps: number; dateIso: string; setCount: number } | undefined;
    for (const v of byDay.values()) {
      if (!best || v.reps > best.reps) best = v;
    }
    return best;
  }, [sets]);

  // Weekly tonnage; last 26 ISO weeks for legibility.
  const weeklyTonnage = useMemo(() => {
    if (sets.length === 0) return [] as { label: string; value: number }[];
    const map = new Map<string, number>();
    for (const s of sets) {
      const load = effectiveKg(s);
      if (load == null || load <= 0) continue;
      const key = isoWeekBucket(s.performedAt);
      map.set(key, (map.get(key) ?? 0) + load * s.reps);
    }
    if (map.size === 0) return [];
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
  }, [sets, effectiveKg]);

  // Weekly total reps — the meaningful axis for bodyweight-only movements
  // with no recorded bodyweight (or as a complement on loaded movements).
  const weeklyReps = useMemo(() => {
    if (sets.length === 0) return [] as { label: string; value: number }[];
    const map = new Map<string, number>();
    for (const s of sets) {
      const key = isoWeekBucket(s.performedAt);
      map.set(key, (map.get(key) ?? 0) + s.reps);
    }
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
        volume: arr.reduce((acc, s) => {
          const load = effectiveKg(s);
          return acc + (load == null ? 0 : load * s.reps);
        }, 0),
      }));
  }, [sets, effectiveKg]);

  // ---------- render ----------------------------------------------------
  if (!id) return <div className="text-sm text-muted">Missing movement id.</div>;
  if (!movement) return <div className="text-sm text-muted">Loading…</div>;

  const totalReps = sets.reduce((acc, s) => acc + s.reps, 0);
  const totalVolume = sets.reduce((acc, s) => {
    const load = effectiveKg(s);
    return acc + (load == null ? 0 : load * s.reps);
  }, 0);

  const chartPoints: LineChartPoint[] = topSetByDay.map((d) => ({
    x: new Date(d.set.performedAt).getTime(),
    y: d.e1rm,
    label: `${fmtDate(d.set.performedAt)} · e1RM ${fmtKg(d.e1rm)} (${fmtKg(d.loadKg)} × ${d.set.reps})`,
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
          {/* Bodyweight notice -------------------------------------------- */}
          {isBodyweight && bodyweightTimeline.length === 0 && (
            <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              Log your bodyweight on{' '}
              <Link href="/profile" className="underline">Profile</Link> to
              get e1RM and tonnage stats for this bodyweight movement. Until
              then we only show reps and set counts.
            </section>
          )}
          {/* Summary tiles ------------------------------------------------ */}
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile
              label="Heaviest set"
              value={
                heaviestSet
                  ? `${fmtKg(heaviestSet.loadKg)} × ${heaviestSet.set.reps}`
                  : canComputeLoadKg
                    ? '—'
                    : 'BW'
              }
              sub={heaviestSet ? fmtDate(heaviestSet.set.performedAt) : undefined}
            />
            {canComputeLoadKg ? (
              <StatTile
                label="Best e1RM"
                value={bestE1Rm ? fmtKg(bestE1Rm.e1rm) : '—'}
                sub={
                  bestE1Rm
                    ? `${fmtKg(bestE1Rm.loadKg)} × ${bestE1Rm.set.reps} · ${fmtDate(bestE1Rm.set.performedAt)}`
                    : undefined
                }
              />
            ) : (
              <StatTile
                label="Best rep day"
                value={bestRepDay ? `${bestRepDay.reps} reps` : '—'}
                sub={
                  bestRepDay
                    ? `${bestRepDay.setCount} sets · ${fmtDate(bestRepDay.dateIso)}`
                    : undefined
                }
              />
            )}
            {canComputeLoadKg ? (
              <StatTile
                label="Best volume day"
                value={
                  bestVolumeDay ? `${Math.round(bestVolumeDay.volume).toLocaleString()} kg` : '—'
                }
                sub={
                  bestVolumeDay
                    ? `${bestVolumeDay.setCount} sets · ${fmtDate(bestVolumeDay.dateIso)}`
                    : undefined
                }
              />
            ) : (
              <StatTile
                label="Avg reps / set"
                value={
                  sets.length > 0
                    ? `${(totalReps / sets.length).toFixed(1)}`
                    : '—'
                }
                sub={`${sets.length} sets logged`}
              />
            )}
            <StatTile
              label="All-time"
              value={`${sets.length} sets`}
              sub={
                canComputeLoadKg
                  ? `${totalReps.toLocaleString()} reps · ${Math.round(totalVolume).toLocaleString()} kg`
                  : `${totalReps.toLocaleString()} reps`
              }
            />
          </section>

          {/* Strength trend ---------------------------------------------- */}
          {canComputeLoadKg && chartPoints.length > 0 && (
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="mb-1 text-sm font-semibold">Top-set e1RM over time</h2>
              <p className="mb-3 text-xs text-muted">
                Best estimated 1RM per workout day (Epley: weight × (1 + reps ÷ 30)).
                Each point is the top set you logged that day.
                {isBodyweight && ' Bodyweight is included in the effective load.'}
              </p>
              <LineChart
                data={chartPoints}
                color="#10b981"
                yLabel="kg"
                formatY={(n) => `${Math.round(n)} kg`}
              />
            </section>
          )}

          {/* Weekly tonnage ---------------------------------------------- */}
          {canComputeLoadKg && weeklyTonnage.length > 1 && (
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="mb-1 text-sm font-semibold">Weekly tonnage</h2>
              <p className="mb-3 text-xs text-muted">
                Total weight moved per ISO week (Σ weight × reps), last {weeklyTonnage.length} weeks.
                {isBodyweight && ' Bodyweight is included in the effective load.'}
              </p>
              <BarChart
                data={weeklyTonnage}
                color="#6366f1"
                formatValue={(n) => `${Math.round(n).toLocaleString()} kg`}
              />
            </section>
          )}

          {/* Weekly reps (BW-only fallback OR companion chart) ----------- */}
          {!canComputeLoadKg && weeklyReps.length > 1 && (
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="mb-1 text-sm font-semibold">Weekly reps</h2>
              <p className="mb-3 text-xs text-muted">
                Total reps per ISO week, last {weeklyReps.length} weeks.
              </p>
              <BarChart
                data={weeklyReps}
                color="#6366f1"
                formatValue={(n) => `${Math.round(n).toLocaleString()} reps`}
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
                      {day.sets.length} sets
                      {canComputeLoadKg && day.volume > 0
                        ? ` · ${Math.round(day.volume).toLocaleString()} kg`
                        : ''}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {day.sets.map((s, i) => {
                      const load = effectiveKg(s);
                      const showE1Rm = load != null && load > 0;
                      return (
                        <li
                          key={s.id}
                          className="flex items-center gap-2 rounded bg-bg/40 px-2 py-1 text-xs ring-1 ring-border/60"
                        >
                          <span className="w-6 shrink-0 text-muted">#{i + 1}</span>
                          <span className="flex-1 font-mono tabular-nums">
                            {isBodyweight
                              ? s.weightKg > 0
                                ? `BW + ${fmtKg(s.weightKg)}`
                                : 'BW'
                              : s.weightKg > 0
                                ? fmtKg(s.weightKg)
                                : 'BW'}{' '}
                            × {s.reps}
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
                          {showE1Rm && (
                            <span className="text-[10px] tabular-nums text-muted">
                              e1RM {fmtKg(epley1RM(load!, s.reps))}
                            </span>
                          )}
                        </li>
                      );
                    })}
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
