'use client';

import { useMemo, useState } from 'react';
import { CARDIO_ACCENT, STRENGTH_ACCENT, type MinimalSet } from '@wendler/domain';
import {
  useAllCardio,
  useAllMainLiftMovements,
  useAllSets,
  useAllTrainingMaxesList,
  useMovements,
  useRecentWorkoutDays,
  useRunPlan,
} from '@/lib/hooks';

import { ActiveGoalsCard } from '@/components/ActiveGoalsCard';

import { AnalyticsCard } from '@/components/analytics/AnalyticsCard';
import { KpiTile } from '@/components/analytics/KpiTile';
import { WeeklyTonnageCard } from '@/components/analytics/WeeklyTonnageCard';
import { AssistanceVolumeCard } from '@/components/analytics/AssistanceVolumeCard';
import { PushPullBalanceCard } from '@/components/analytics/PushPullBalanceCard';
import { MuscleHeatmapCard } from '@/components/analytics/MuscleHeatmapCard';
import { OneRmHistoryCard } from '@/components/analytics/OneRmHistoryCard';
import { CardioVolumeCard } from '@/components/analytics/CardioVolumeCard';
import { HrZonesCard } from '@/components/analytics/HrZonesCard';
import { PacePrsCard } from '@/components/analytics/PacePrsCard';
import { RunPlanAdherenceCard } from '@/components/analytics/RunPlanAdherenceCard';
import { TrainingCalendarCard } from '@/components/analytics/TrainingCalendarCard';

type Mode = 'all' | 'strength' | 'cardio';

export default function StatsPage() {
  const setsRaw = useAllSets();
  const cardioRaw = useAllCardio();
  const workoutDays = useRecentWorkoutDays(9999);
  const tms = useAllTrainingMaxesList();
  const movements = useMovements();
  const slotMovements = useAllMainLiftMovements();
  const plan = useRunPlan();

  const [mode, setMode] = useState<Mode>('all');
  const [windowDays, setWindowDays] = useState(180);

  // ── Windowing (current vs prior period) ────────────────────────────────
  const sinceIso = useMemo(
    () => new Date(Date.now() - windowDays * 86400_000).toISOString(),
    [windowDays],
  );
  const priorSinceIso = useMemo(
    () => new Date(Date.now() - windowDays * 2 * 86400_000).toISOString(),
    [windowDays],
  );

  const sets = useMemo<MinimalSet[]>(
    () => (setsRaw ?? []).map((s) => ({ ...s }) as MinimalSet),
    [setsRaw],
  );
  const recentSets = useMemo(
    () => sets.filter((s) => s.performedAt >= sinceIso),
    [sets, sinceIso],
  );
  const priorSets = useMemo(
    () => sets.filter((s) => s.performedAt >= priorSinceIso && s.performedAt < sinceIso),
    [sets, priorSinceIso, sinceIso],
  );

  const cardio = useMemo(() => cardioRaw ?? [], [cardioRaw]);
  const recentCardio = useMemo(
    () => cardio.filter((c) => c.performedAt >= sinceIso),
    [cardio, sinceIso],
  );
  const priorCardio = useMemo(
    () => cardio.filter((c) => c.performedAt >= priorSinceIso && c.performedAt < sinceIso),
    [cardio, priorSinceIso, sinceIso],
  );

  // Number of weeks of history to chart, derived from the global window.
  // Capped so a 30-day window still has a reasonable bar count and a 1-year
  // window doesn't overwhelm the layout.
  const weeksToShow = useMemo(
    () => Math.min(Math.max(Math.round(windowDays / 7), 6), 52),
    [windowDays],
  );

  // ── Headline KPIs ──────────────────────────────────────────────────────
  const totalSessions = workoutDays?.filter((d) => d.completed).length ?? 0;

  const totalTonnage = recentSets
    .filter((s) => !s.skipped && !s.deletedAt && s.weightKg > 0 && s.reps > 0)
    .reduce((acc, s) => acc + s.weightKg * s.reps, 0);
  const priorTonnage = priorSets
    .filter((s) => !s.skipped && !s.deletedAt && s.weightKg > 0 && s.reps > 0)
    .reduce((acc, s) => acc + s.weightKg * s.reps, 0);
  const tonnageDeltaPct =
    priorTonnage > 0 ? ((totalTonnage - priorTonnage) / priorTonnage) * 100 : null;

  const cardioTotalSec = recentCardio.reduce((a, c) => a + c.durationSec, 0);
  const priorCardioSec = priorCardio.reduce((a, c) => a + c.durationSec, 0);
  const cardioTimeDeltaPct =
    priorCardioSec > 0
      ? ((cardioTotalSec - priorCardioSec) / priorCardioSec) * 100
      : null;

  const cardioTotalKm = recentCardio.reduce((a, c) => a + (c.distanceKm ?? 0), 0);
  const priorCardioKm = priorCardio.reduce((a, c) => a + (c.distanceKm ?? 0), 0);
  const cardioKmDeltaPct =
    priorCardioKm > 0
      ? ((cardioTotalKm - priorCardioKm) / priorCardioKm) * 100
      : null;

  // Sparklines: trailing weeks for each KPI.
  const tonnageSpark = useMemo(() => {
    // Bucket by ISO week directly off the windowed sets.
    const map = new Map<string, number>();
    for (const s of recentSets) {
      if (s.skipped || s.deletedAt || s.weightKg <= 0 || s.reps <= 0) continue;
      const wk = s.performedAt.slice(0, 10); // simple per-day; enough for sparkline
      map.set(wk, (map.get(wk) ?? 0) + s.weightKg * s.reps);
    }
    return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
  }, [recentSets]);

  const cardioTimeSpark = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of recentCardio) {
      const day = c.performedAt.slice(0, 10);
      map.set(day, (map.get(day) ?? 0) + c.durationSec / 60);
    }
    return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
  }, [recentCardio]);

  const cardioKmSpark = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of recentCardio) {
      if (!c.distanceKm) continue;
      const day = c.performedAt.slice(0, 10);
      map.set(day, (map.get(day) ?? 0) + c.distanceKm);
    }
    return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
  }, [recentCardio]);

  // ── Strength session dates for the cross-domain calendar ──────────────
  const strengthDates = useMemo(
    () =>
      (workoutDays ?? [])
        .filter((d) => d.completed)
        .map((d) => d.latestPerformedAt),
    [workoutDays],
  );

  // ── KPI visibility per mode ───────────────────────────────────────────
  const showStrength = mode === 'all' || mode === 'strength';
  const showCardio = mode === 'all' || mode === 'cardio';

  function fmtTotalTime(totalSec: number) {
    const totalMin = Math.round(totalSec / 60);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-xs text-muted">
            One view across strength and cardio. Cards adapt to the window and mode.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ModeSwitcher mode={mode} setMode={setMode} />
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="rounded-lg border border-border bg-card px-2 py-1 text-sm"
            aria-label="Time window"
          >
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>6 months</option>
            <option value={365}>1 year</option>
            <option value={3650}>All time</option>
          </select>
        </div>
      </header>

      {/* Headline KPI row — adapts to mode */}
      <section
        className={`grid gap-3 ${
          mode === 'all'
            ? 'grid-cols-2 sm:grid-cols-4'
            : 'grid-cols-2'
        }`}
      >
        {showStrength && (
          <>
            <KpiTile
              label="Workouts"
              value={String(totalSessions)}
              deltaPct={null}
              spark={[]}
              emptyHint="all-time"
            />
            <KpiTile
              label={`Tonnage · ${windowDays}d`}
              value={`${(totalTonnage / 1000).toFixed(1)} t`}
              deltaPct={tonnageDeltaPct}
              spark={tonnageSpark}
              color={STRENGTH_ACCENT}
            />
          </>
        )}
        {showCardio && (
          <>
            <KpiTile
              label={`Cardio time · ${windowDays}d`}
              value={fmtTotalTime(cardioTotalSec)}
              deltaPct={cardioTimeDeltaPct}
              spark={cardioTimeSpark}
              color={CARDIO_ACCENT}
            />
            <KpiTile
              label={`Distance · ${windowDays}d`}
              value={`${cardioTotalKm.toFixed(1)} km`}
              deltaPct={cardioKmDeltaPct}
              spark={cardioKmSpark}
              color={CARDIO_ACCENT}
            />
          </>
        )}
      </section>

      <ActiveGoalsCard expanded heading="Goals" />

      {/* Strength cards. In 'all' mode the combined Training calendar is
          slotted between push/pull balance and the muscle heatmap so the
          page reads top-to-bottom: KPIs → tonnage → balance → calendar →
          heatmap → 1RMs → cardio. */}
      {showStrength && (
        <>
          <WeeklyTonnageCard recentSets={recentSets} weeksToShow={weeksToShow} />
          <AssistanceVolumeCard recentSets={recentSets} weeksToShow={weeksToShow} />
          <PushPullBalanceCard
            recentSets={recentSets}
            priorSets={priorSets}
            movements={movements}
            weeksToShow={weeksToShow}
            windowDays={windowDays}
          />
          {mode === 'all' && (
            <TrainingCalendarCard
              strengthDates={strengthDates}
              cardio={recentCardio}
              weeks={20}
              cellSize={26}
            />
          )}
          <MuscleHeatmapCard recentSets={recentSets} movements={movements} />
          <OneRmHistoryCard tms={tms} slotMovements={slotMovements} />
        </>
      )}

      {/* Cardio cards */}
      {showCardio && (
        <>
          <CardioVolumeCard recentCardio={recentCardio} weeksToShow={weeksToShow} />
          <HrZonesCard recentCardio={recentCardio} />
          <PacePrsCard recentCardio={recentCardio} />
          <RunPlanAdherenceCard recentCardio={recentCardio} plan={plan} weeks={8} />
        </>
      )}

      {!showStrength && !showCardio && (
        <AnalyticsCard title="Nothing to show">
          <p className="text-sm text-muted">Pick a mode above to see analytics.</p>
        </AnalyticsCard>
      )}
    </div>
  );
}

function ModeSwitcher({
  mode,
  setMode,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
}) {
  const opts: { id: Mode; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'strength', label: 'Strength' },
    { id: 'cardio', label: 'Cardio' },
  ];
  return (
    <div
      role="tablist"
      aria-label="Analytics mode"
      className="inline-flex rounded-lg border border-border bg-card p-0.5 text-sm"
    >
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={mode === o.id}
          onClick={() => setMode(o.id)}
          className={`rounded-md px-2.5 py-1 transition-colors ${
            mode === o.id
              ? 'bg-accent text-bg'
              : 'text-muted hover:text-fg'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
