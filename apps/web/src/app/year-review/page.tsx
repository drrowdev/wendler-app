'use client';

// Year-in-review — deterministic summary of a calendar year's training.
// Reads existing analytics helpers; no LLM, no I/O beyond Dexie.
//
// Query param: ?year=2026. Default = current year.

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { pacePRs, type MinimalCardio, type MinimalSet } from '@wendler/domain';
import { useAllSets, useAllCardio, useMovements } from '@/lib/hooks';
import { liftLabel } from '@/lib/format';

export default function YearReviewWrapper() {
  return (
    <Suspense fallback={<div className="px-3 py-6 text-sm text-muted">Loading…</div>}>
      <YearReviewPage />
    </Suspense>
  );
}

function YearReviewPage() {
  const params = useSearchParams();
  const yearParam = params.get('year');
  const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear();
  const isValidYear = Number.isFinite(year) && year >= 2000 && year <= 2100;

  const sets = useAllSets();
  const cardio = useAllCardio();
  const movements = useMovements();

  const stats = useMemo(() => {
    if (!sets || !cardio || !movements || !isValidYear) return undefined;
    return computeYearStats(year, sets, cardio, movements);
  }, [sets, cardio, movements, year, isValidYear]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 md:py-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Year in review — {year}
          </h1>
          <p className="text-xs text-muted">
            Deterministic summary of your training year. No LLM, no
            inference — just what&apos;s in your logs.
          </p>
        </div>
        <nav className="flex gap-1.5 text-[11px]">
          <Link
            href={`/year-review?year=${year - 1}`}
            className="rounded-md border border-border bg-bg px-2 py-1 text-muted hover:text-fg"
          >
            ← {year - 1}
          </Link>
          {year < new Date().getFullYear() && (
            <Link
              href={`/year-review?year=${year + 1}`}
              className="rounded-md border border-border bg-bg px-2 py-1 text-muted hover:text-fg"
            >
              {year + 1} →
            </Link>
          )}
        </nav>
      </header>

      {!stats && (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted">
          Loading…
        </div>
      )}

      {stats && stats.totalSessions === 0 && stats.totalCardioMin === 0 && (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted">
          No logged training in {year}.
        </div>
      )}

      {stats && (stats.totalSessions > 0 || stats.totalCardioMin > 0) && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Strength sessions"
              value={stats.totalSessions.toString()}
              sub={`${(stats.totalSessions / 52).toFixed(1)} / week avg`}
            />
            <StatCard
              label="Total tonnage"
              value={`${Math.round(stats.totalTonnageKg / 1000)} t`}
              sub={`${stats.totalTonnageKg.toLocaleString()} kg`}
            />
            <StatCard
              label="Cardio time"
              value={fmtHrs(stats.totalCardioMin)}
              sub={`${stats.totalCardioSessions} session${stats.totalCardioSessions === 1 ? '' : 's'}`}
            />
            <StatCard
              label="Cardio km"
              value={`${Math.round(stats.totalCardioKm)} km`}
              sub={stats.runKm > 0 ? `${Math.round(stats.runKm)} km running` : '—'}
            />
          </section>

          {stats.e1rmDeltas.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
                Main lift e1RM changes
              </h2>
              <p className="mt-1 text-xs text-muted">
                Best estimated 1RM at year start vs year end. Computed from
                your AMRAP/working sets only.
              </p>
              <ul className="mt-2 space-y-1">
                {stats.e1rmDeltas.map((r) => (
                  <li
                    key={r.lift}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span className="font-medium text-fg">{liftLabel(r.lift as never)}</span>
                    <span className="tabular-nums text-muted">
                      {r.start != null ? `${Math.round(r.start)} kg` : '—'}{' '}
                      <span className="text-fg/60">→</span>{' '}
                      {r.end != null ? `${Math.round(r.end)} kg` : '—'}
                      {r.delta != null && (
                        <span
                          className={`ml-2 text-xs ${r.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
                        >
                          {r.delta >= 0 ? '+' : ''}
                          {Math.round(r.delta)} kg
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {stats.pacePrs.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
                Pace PRs (all-time bests)
              </h2>
              <ul className="mt-2 space-y-1">
                {stats.pacePrs.map((p) => (
                  <li
                    key={p.distanceM}
                    className="flex items-baseline justify-between text-sm"
                  >
                    <span className="font-medium text-fg">{labelForDistance(p.distanceM)}</span>
                    <span className="tabular-nums text-muted">{fmtMmSs(p.timeSec)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-xl border border-border bg-card p-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Top training months
            </h2>
            <ul className="mt-2 space-y-1">
              {stats.topMonths.map((m) => (
                <li
                  key={m.month}
                  className="flex items-baseline justify-between text-sm"
                >
                  <span className="font-medium text-fg">{m.month}</span>
                  <span className="text-xs tabular-nums text-muted">
                    {m.sessions} session{m.sessions === 1 ? '' : 's'} ·{' '}
                    {Math.round(m.tonnageKg / 1000)} t ·{' '}
                    {Math.round(m.cardioMin / 60)}h cardio
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums text-fg">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

interface YearStats {
  totalSessions: number;
  totalTonnageKg: number;
  totalCardioMin: number;
  totalCardioSessions: number;
  totalCardioKm: number;
  runKm: number;
  e1rmDeltas: Array<{
    lift: string;
    start: number | undefined;
    end: number | undefined;
    delta: number | null;
  }>;
  pacePrs: Array<{ distanceM: number; timeSec: number }>;
  topMonths: Array<{
    month: string;
    sessions: number;
    tonnageKg: number;
    cardioMin: number;
  }>;
}

function computeYearStats(
  year: number,
  allSets: MinimalSet[],
  allCardio: MinimalCardio[],
  allMovements: Array<{ id: string; isMainLift?: string }>,
): YearStats {
  const start = new Date(year, 0, 1).getTime();
  const end = new Date(year + 1, 0, 1).getTime();

  const inYear = <T extends { performedAt: string }>(rows: T[]): T[] =>
    rows.filter((r) => {
      const t = new Date(r.performedAt).getTime();
      return t >= start && t < end;
    });

  const setsYear = inYear(allSets);
  const cardioYear = inYear(allCardio);

  const totalTonnageKg = setsYear.reduce(
    (acc, s) => acc + (s.weightKg ?? 0) * (s.reps ?? 0),
    0,
  );
  const sessionIds = new Set(
    setsYear.map((s) => (s as { sessionId?: string }).sessionId).filter(Boolean),
  );
  const totalSessions = sessionIds.size;

  const totalCardioMin = cardioYear.reduce(
    (acc, c) => acc + (c.durationSec ?? 0) / 60,
    0,
  );
  const totalCardioSessions = cardioYear.length;
  const totalCardioKm = cardioYear.reduce(
    (acc, c) => acc + (c.distanceKm ?? 0),
    0,
  );
  const runKm = cardioYear
    .filter((c) => c.modality === 'run')
    .reduce((acc, c) => acc + (c.distanceKm ?? 0), 0);

  const mainLifts = ['squat', 'bench', 'deadlift', 'press'] as const;
  const e1rmDeltas = mainLifts.map((lift) => {
    const movs = allMovements.filter(
      (m) => (m.isMainLift as string | undefined) === lift,
    );
    const movIds = new Set(movs.map((m) => m.id));
    const setsForLift = setsYear.filter((s) => {
      const mid = (s as { movementId?: string }).movementId;
      return mid && movIds.has(mid);
    });
    if (setsForLift.length === 0) {
      return { lift, start: undefined, end: undefined, delta: null };
    }
    const startSet = setsForLift
      .slice()
      .sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1))[0]!;
    const endSet = setsForLift
      .slice()
      .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0]!;
    const e1 = (s: MinimalSet) =>
      s.weightKg && s.reps
        ? s.weightKg * (1 + Math.min(s.reps, 12) / 30)
        : undefined;
    const sVal = e1(startSet);
    const eVal = e1(endSet);
    const delta = sVal != null && eVal != null ? eVal - sVal : null;
    return { lift, start: sVal, end: eVal, delta };
  });

  const paceCardios = cardioYear.map((c) => ({
    id: (c as { id?: string }).id ?? '',
    performedAt: c.performedAt,
    bestEffortsSec: (c as { bestEffortsSec?: Record<number, number> }).bestEffortsSec,
  }));
  const prs = pacePRs(paceCardios as never).map((p) => ({
    distanceM: p.distanceM,
    timeSec: p.timeSec,
  }));

  const monthly = new Map<
    string,
    { sessions: Set<string>; tonnageKg: number; cardioMin: number }
  >();
  for (const s of setsYear) {
    const d = new Date(s.performedAt);
    const key = monthLabel(d);
    const cur =
      monthly.get(key) ?? { sessions: new Set(), tonnageKg: 0, cardioMin: 0 };
    const sid = (s as { sessionId?: string }).sessionId;
    if (sid) cur.sessions.add(sid);
    cur.tonnageKg += (s.weightKg ?? 0) * (s.reps ?? 0);
    monthly.set(key, cur);
  }
  for (const c of cardioYear) {
    const d = new Date(c.performedAt);
    const key = monthLabel(d);
    const cur =
      monthly.get(key) ?? { sessions: new Set(), tonnageKg: 0, cardioMin: 0 };
    cur.cardioMin += (c.durationSec ?? 0) / 60;
    monthly.set(key, cur);
  }
  const topMonths = Array.from(monthly.entries())
    .map(([month, v]) => ({
      month,
      sessions: v.sessions.size,
      tonnageKg: v.tonnageKg,
      cardioMin: v.cardioMin,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.tonnageKg - a.tonnageKg)
    .slice(0, 3);

  return {
    totalSessions,
    totalTonnageKg,
    totalCardioMin,
    totalCardioSessions,
    totalCardioKm,
    runKm,
    e1rmDeltas,
    pacePrs: prs,
    topMonths,
  };
}

function monthLabel(d: Date): string {
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function fmtHrs(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const hrs = min / 60;
  return `${hrs.toFixed(1)} h`;
}

function fmtMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function labelForDistance(m: number): string {
  if (m === 1000) return '1k';
  if (m === 1609) return 'Mile';
  if (m === 5000) return '5k';
  if (m === 10000) return '10k';
  if (m === 21097) return 'Half marathon';
  if (m === 42195) return 'Marathon';
  return `${m} m`;
}
