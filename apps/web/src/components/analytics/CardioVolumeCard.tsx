'use client';

import { useMemo, useState } from 'react';
import {
  CARDIO_MODALITIES,
  CARDIO_MODALITY_COLORS,
  weeklyCardio,
  type MinimalCardio,
} from '@wendler/domain';
import { fmtWeekBucket } from '@/lib/format';
import { StackedBarChart } from '@/components/charts/StackedBarChart';
import { AnalyticsCard } from './AnalyticsCard';

const MODALITY_LABEL: Record<(typeof CARDIO_MODALITIES)[number], string> = {
  run: 'Run',
  bike: 'Bike',
  swim: 'Swim',
  row: 'Row',
  walk: 'Walk',
  padel: 'Padel',
  other: 'Other',
};

/**
 * Weekly cardio volume stacked by modality. Toggle between minutes and
 * kilometres — both are useful (km undercounts swims/strength-bias rides;
 * minutes overcounts walks).
 */
export function CardioVolumeCard({
  recentCardio,
  weeksToShow,
}: {
  recentCardio: MinimalCardio[];
  weeksToShow: number;
}) {
  const [unit, setUnit] = useState<'minutes' | 'km'>('minutes');

  const weekly = useMemo(
    () => weeklyCardio(recentCardio).slice(-weeksToShow),
    [recentCardio, weeksToShow],
  );

  // 4-week trailing moving average over total volume in the chosen unit.
  // Computed across the visible window only, so the trend reflects what
  // the user is looking at.
  const trend = useMemo(() => {
    const totals = weekly.map((w) => (unit === 'minutes' ? w.totalMinutes : w.totalKm));
    const out: number[] = [];
    for (let i = 0; i < totals.length; i++) {
      const start = Math.max(0, i - 3);
      const slice = totals.slice(start, i + 1);
      out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    return out;
  }, [weekly, unit]);

  const modalitiesPresent = useMemo(() => {
    const present = new Set<(typeof CARDIO_MODALITIES)[number]>();
    for (const w of weekly) {
      const map = unit === 'minutes' ? w.minutesByModality : w.kmByModality;
      for (const k of Object.keys(map) as (typeof CARDIO_MODALITIES)[number][]) {
        if ((map[k] ?? 0) > 0) present.add(k);
      }
    }
    return CARDIO_MODALITIES.filter((m) => present.has(m));
  }, [weekly, unit]);

  if (weekly.length === 0) {
    return (
      <AnalyticsCard title="Weekly cardio volume" badge="cardio">
        <p className="text-sm text-muted">
          No cardio in this window. Log a session on /cardio or connect Strava.
        </p>
      </AnalyticsCard>
    );
  }

  return (
    <AnalyticsCard
      title={`Weekly cardio volume (last ${weekly.length} weeks)`}
      badge="cardio"
      subtitle={`Stacked by modality · ${unit}`}
    >
      <div className="-mt-1 mb-2 flex items-center justify-end">
        <div className="inline-flex rounded-md border border-border bg-bg p-0.5 text-xs">
          {(['minutes', 'km'] as const).map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => setUnit(u)}
              className={`rounded px-2 py-0.5 ${
                unit === u ? 'bg-accent text-bg' : 'text-muted hover:text-fg'
              }`}
            >
              {u}
            </button>
          ))}
        </div>
      </div>
      <StackedBarChart
        data={weekly.map((w) => ({
          label: fmtWeekBucket(w.bucket),
          values: Object.fromEntries(
            CARDIO_MODALITIES.map((m) => [
              m,
              unit === 'minutes' ? (w.minutesByModality[m] ?? 0) : (w.kmByModality[m] ?? 0),
            ]),
          ),
        }))}
        series={CARDIO_MODALITIES.map((m) => ({
          key: m,
          label: MODALITY_LABEL[m],
          color: CARDIO_MODALITY_COLORS[m],
        }))}
        asPercent={false}
        showTotals
        formatValue={(n) =>
          unit === 'minutes' ? `${Math.round(n)} min` : `${n.toFixed(1)} km`
        }
        formatTotal={(n) =>
          unit === 'minutes' ? `${Math.round(n)} min` : `${n.toFixed(1)} km`
        }
        trend={trend}
        trendColor="#f59e0b"
        trendLabel="4-week avg"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-[2px] w-3 bg-[#f59e0b]" /> 4-week avg
        </span>
        {modalitiesPresent.map((m) => (
          <span key={m} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-3 rounded-sm"
              style={{ background: CARDIO_MODALITY_COLORS[m] }}
            />{' '}
            {MODALITY_LABEL[m]}
          </span>
        ))}
      </div>
    </AnalyticsCard>
  );
}
