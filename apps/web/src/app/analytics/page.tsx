'use client';

import { useMemo, useState } from 'react';
import {
  bestE1rmSeries,
  muscleVolume,
  pushPullBalance,
  weeklyVolume,
  type MinimalSet,
} from '@wendler/domain';
import type { MainLift } from '@wendler/db-schema';
import { fmtKg, liftLabel, MAIN_LIFTS } from '@/lib/format';
import {
  useAllSets,
  useAllSessions,
  useAllTrainingMaxesList,
  useMovements,
} from '@/lib/hooks';
import { LineChart } from '@/components/charts/LineChart';
import { BarChart } from '@/components/charts/BarChart';
import { Donut } from '@/components/charts/Donut';
import { BodyMap } from '@/components/BodyMap';

const LIFT_COLORS: Record<MainLift, string> = {
  squat: '#10b981',
  bench: '#3b82f6',
  deadlift: '#f59e0b',
  press: '#ef4444',
};

export default function AnalyticsPage() {
  const setsRaw = useAllSets();
  const sessions = useAllSessions();
  const tms = useAllTrainingMaxesList();
  const movements = useMovements();
  const [selectedLift, setSelectedLift] = useState<MainLift>('squat');
  const [windowDays, setWindowDays] = useState(180);

  const sets = useMemo<MinimalSet[]>(
    () => (setsRaw ?? []).map((s) => ({ ...s }) as MinimalSet),
    [setsRaw],
  );

  const sinceIso = useMemo(
    () => new Date(Date.now() - windowDays * 86400_000).toISOString(),
    [windowDays],
  );
  const recentSets = useMemo(
    () => sets.filter((s) => s.performedAt >= sinceIso),
    [sets, sinceIso],
  );

  const liftMovementId = useMemo(() => {
    const mv = movements?.find((m) => m.isMainLift === selectedLift);
    return mv?.id;
  }, [movements, selectedLift]);

  const e1rmSeries = useMemo(() => {
    if (!liftMovementId) return [];
    return bestE1rmSeries(recentSets, liftMovementId).map((p) => ({
      x: new Date(p.date).getTime(),
      y: p.e1rm,
      label: p.date,
    }));
  }, [recentSets, liftMovementId]);

  const weekly = useMemo(() => {
    return weeklyVolume(recentSets)
      .slice(-12)
      .map((w) => ({ label: w.bucket.replace(/^\d{4}-/, ''), value: w.tonnageKg }));
  }, [recentSets]);

  const balance = useMemo(() => {
    if (!movements) return null;
    return pushPullBalance(recentSets, movements);
  }, [recentSets, movements]);

  const muscles = useMemo(() => {
    if (!movements) return {};
    return muscleVolume(recentSets, movements);
  }, [recentSets, movements]);

  const tmHistory = useMemo(() => {
    const byLift = new Map<MainLift, NonNullable<typeof tms>>();
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

  const totalSessions = sessions?.filter((s) => s.completedAt).length ?? 0;
  const totalTonnage = recentSets
    .filter((s) => !s.skipped && !s.deletedAt && s.weightKg > 0 && s.reps > 0)
    .reduce((acc, s) => acc + s.weightKg * s.reps, 0);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
        <select
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          className="rounded-lg border border-border bg-card px-2 py-1 text-sm"
        >
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={180}>6 months</option>
          <option value={365}>1 year</option>
          <option value={3650}>All time</option>
        </select>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <Stat label="Completed sessions" value={String(totalSessions)} />
        <Stat
          label={`Tonnage · last ${windowDays}d`}
          value={`${(totalTonnage / 1000).toFixed(1)} t`}
        />
      </section>

      <Card title="Strength trend (best e1RM per session)">
        <div className="mb-3 flex flex-wrap gap-1">
          {MAIN_LIFTS.map((l) => (
            <button
              key={l.key}
              onClick={() => setSelectedLift(l.key)}
              className={`rounded px-2 py-1 text-xs ring-1 ring-border ${
                selectedLift === l.key
                  ? 'bg-accent text-bg font-semibold'
                  : 'bg-card text-muted'
              }`}
            >
              {liftLabel(l.key)}
            </button>
          ))}
        </div>
        <LineChart
          data={e1rmSeries}
          color={LIFT_COLORS[selectedLift]}
          formatY={(n) => `${n.toFixed(0)} kg`}
        />
        {e1rmSeries.length > 1 && (
          <p className="mt-2 text-xs text-muted">
            {e1rmSeries[0]!.label} → {e1rmSeries[e1rmSeries.length - 1]!.label} ·{' '}
            {(e1rmSeries[e1rmSeries.length - 1]!.y - e1rmSeries[0]!.y).toFixed(1)} kg over period
          </p>
        )}
      </Card>

      <Card title="Weekly tonnage (last 12 weeks)">
        <BarChart data={weekly} formatValue={(n) => `${(n / 1000).toFixed(1)} t`} />
      </Card>

      {balance && balance.push + balance.pull + balance.lower + balance.core > 0 && (
        <Card title="Push / Pull / Lower / Core balance">
          <Donut
            data={[
              { label: 'Push', value: balance.push, color: '#3b82f6' },
              { label: 'Pull', value: balance.pull, color: '#10b981' },
              { label: 'Lower', value: balance.lower, color: '#f59e0b' },
              { label: 'Core', value: balance.core, color: '#a855f7' },
            ].filter((s) => s.value > 0)}
            formatValue={(n) => `${(n / 1000).toFixed(1)} t`}
          />
          {balance.pushPullRatio != null && (
            <p className="mt-3 text-sm text-muted">
              Push : Pull ratio ={' '}
              <span className="font-mono text-fg">{balance.pushPullRatio.toFixed(2)}</span>{' '}
              {balance.pushPullRatio < 0.8
                ? '· consider more pressing'
                : balance.pushPullRatio > 1.25
                  ? '· consider more pulling'
                  : '· well-balanced'}
            </p>
          )}
        </Card>
      )}

      <Card title="Muscle volume heatmap">
        <BodyMap volumes={muscles} />
      </Card>

      <Card title="Training Max history">
        <div className="space-y-3">
          {MAIN_LIFTS.map((l) => {
            const arr = tmHistory.get(l.key) ?? [];
            if (arr.length === 0) {
              return (
                <div key={l.key} className="text-sm text-muted">
                  {liftLabel(l.key)}: not set
                </div>
              );
            }
            const first = arr[0]!;
            const last = arr[arr.length - 1]!;
            const delta = last.trainingMaxKg - first.trainingMaxKg;
            return (
              <div key={l.key}>
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{liftLabel(l.key)}</span>
                  <span className="text-sm">
                    <span className="font-mono">{fmtKg(last.trainingMaxKg)}</span>{' '}
                    <span className={delta >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      ({delta >= 0 ? '+' : ''}
                      {delta.toFixed(1)} kg)
                    </span>
                  </span>
                </div>
                <LineChart
                  data={arr.map((tm) => ({
                    x: new Date(tm.createdAt).getTime(),
                    y: tm.trainingMaxKg,
                    label: tm.createdAt.slice(0, 10),
                  }))}
                  color={LIFT_COLORS[l.key]}
                  height={80}
                  formatY={(n) => `${n.toFixed(0)} kg`}
                />
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
