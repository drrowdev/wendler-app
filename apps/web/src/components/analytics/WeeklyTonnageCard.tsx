'use client';

import { useMemo } from 'react';
import { weeklyVolume, type MinimalSet } from '@wendler/domain';
import { fmtWeekBucket } from '@/lib/format';
import { BarChart } from '@/components/charts/BarChart';
import { AnalyticsCard } from './AnalyticsCard';

/**
 * Weekly tonnage bar chart with a 4-week trailing moving-average overlay.
 * Self-contained: takes a pre-windowed slice of sets and a max bar count.
 */
export function WeeklyTonnageCard({
  recentSets,
  weeksToShow,
}: {
  recentSets: MinimalSet[];
  weeksToShow: number;
}) {
  const weeklySeries = useMemo(
    () => weeklyVolume(recentSets).slice(-weeksToShow),
    [recentSets, weeksToShow],
  );
  const weekly = useMemo(
    () =>
      weeklySeries.map((w) => ({
        label: fmtWeekBucket(w.bucket),
        value: w.tonnageKg,
      })),
    [weeklySeries],
  );
  const weeklyMA = useMemo(() => {
    const window = 4;
    return weeklySeries.map((_, i) => {
      if (i < window - 1) return null;
      let sum = 0;
      for (let j = i - window + 1; j <= i; j++) sum += weeklySeries[j]!.tonnageKg;
      return sum / window;
    });
  }, [weeklySeries]);

  return (
    <AnalyticsCard
      title={`Weekly tonnage (last ${weekly.length} weeks)`}
      badge="strength"
    >
      <BarChart
        data={weekly}
        formatValue={(n) => `${(n / 1000).toFixed(1)} t`}
        overlay={weeklyMA}
        overlayLabel="4-wk avg"
      />
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-[#3b82f6]" /> Weekly
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-[2px] w-3 bg-[#f59e0b]" /> 4-week moving avg
        </span>
      </div>
    </AnalyticsCard>
  );
}
