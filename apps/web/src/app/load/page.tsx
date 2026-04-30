'use client';

import { useMemo } from 'react';
import {
  currentWeekStart,
  deloadSuggestion,
  previousWeekStarts,
  weeklyLoad,
  type WeeklyLoad,
} from '@wendler/domain';
import { useAllCardio, useAllRecovery, useAllSets, useAllSessions } from '@/lib/hooks';
import { BarChart } from '@/components/charts/BarChart';

function fmtDate(id: string) {
  const [y, m, d] = id.split('-');
  return `${d}.${m}.${y}`;
}

const RECO_STYLES: Record<string, { label: string; tone: string }> = {
  continue: { label: '✅ Keep training', tone: 'border-green-500/40 bg-green-500/10' },
  'deload-soon': { label: '🟡 Deload soon', tone: 'border-yellow-500/40 bg-yellow-500/10' },
  'deload-now': { label: '🔴 Deload now', tone: 'border-red-500/40 bg-red-500/10' },
};

export default function LoadPage() {
  const sets = useAllSets();
  const sessions = useAllSessions();
  const cardio = useAllCardio();
  const recovery = useAllRecovery();

  const weeks = useMemo(() => {
    const starts = previousWeekStarts(new Date(), 8);
    return starts.map((ws) =>
      weeklyLoad(ws, sets ?? [], cardio ?? [], recovery ?? []),
    );
  }, [sets, cardio, recovery]);

  const lastDeload = useMemo(() => {
    const deloads = (sessions ?? []).filter((s) => s.week === 'deload' && s.completedAt);
    if (deloads.length === 0) return undefined;
    return deloads.sort((a, b) => (a.completedAt! < b.completedAt! ? 1 : -1))[0]?.completedAt;
  }, [sessions]);

  const reco = useMemo(
    () => deloadSuggestion({ recentWeeks: weeks, lastDeloadAt: lastDeload }),
    [weeks, lastDeload],
  );

  const thisWeekStart = currentWeekStart();
  const thisWeek = weeks.find((w) => w.weekStart === thisWeekStart);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Load &amp; Recovery</h1>
        <p className="text-sm text-muted">
          Weekly stress score combining strength tonnage, cardio time, RPE, fatigue and sleep.
        </p>
      </header>

      <section
        className={`rounded-lg border p-4 ${RECO_STYLES[reco.recommendation]?.tone ?? ''}`}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">
            {RECO_STYLES[reco.recommendation]?.label}
          </h2>
          <span className="text-xs text-muted">
            confidence {Math.round(reco.confidence * 100)}%
          </span>
        </div>
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-sm">
          {reco.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>

      {thisWeek && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            This week ({fmtDate(thisWeek.weekStart)})
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Stress score" value={thisWeek.stressScore.toString()} />
            <Stat
              label="Tonnage"
              value={`${Math.round(thisWeek.strengthTonnageKg).toLocaleString()} kg`}
            />
            <Stat label="Cardio" value={`${Math.round(thisWeek.cardioMinutes)} min`} />
            <Stat label="Days" value={`${thisWeek.trainingDays}`} />
            {thisWeek.avgRpe !== undefined && (
              <Stat label="Avg RPE" value={thisWeek.avgRpe.toFixed(1)} />
            )}
            {thisWeek.avgSleep !== undefined && (
              <Stat label="Avg sleep" value={`${thisWeek.avgSleep.toFixed(1)} h`} />
            )}
            {thisWeek.avgFatigue !== undefined && (
              <Stat label="Avg fatigue" value={thisWeek.avgFatigue.toFixed(1)} />
            )}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Stress score (last 8 weeks)
        </h2>
        <div className="rounded-lg border border-border bg-card p-3">
          <BarChart
            data={weeks.map((w: WeeklyLoad) => ({
              label: w.weekStart.slice(5),
              value: w.stressScore,
            }))}
            height={180}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Tonnage by week (kg)
        </h2>
        <div className="rounded-lg border border-border bg-card p-3">
          <BarChart
            data={weeks.map((w: WeeklyLoad) => ({
              label: w.weekStart.slice(5),
              value: Math.round(w.strengthTonnageKg),
            }))}
            height={180}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Cardio minutes by week
        </h2>
        <div className="rounded-lg border border-border bg-card p-3">
          <BarChart
            data={weeks.map((w: WeeklyLoad) => ({
              label: w.weekStart.slice(5),
              value: Math.round(w.cardioMinutes),
            }))}
            height={140}
          />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-center">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
