'use client';

import { useMemo } from 'react';
import { weeklyAssistanceReps, type MinimalSet } from '@wendler/domain';
import { fmtWeekBucket } from '@/lib/format';
import { BarChart } from '@/components/charts/BarChart';
import { AnalyticsCard } from './AnalyticsCard';

/**
 * Weekly assistance reps. Reps not tonnage — assistance is overwhelmingly
 * bodyweight / light DB / carries, which a tonnage chart silently zeros.
 * Pairs with the assistance suggester (Phase 5) so the user can see the
 * suggested-volume targets reflected in actual logged work.
 */
export function AssistanceVolumeCard({
  recentSets,
  weeksToShow,
}: {
  recentSets: MinimalSet[];
  weeksToShow: number;
}) {
  const series = useMemo(
    () => weeklyAssistanceReps(recentSets).slice(-weeksToShow),
    [recentSets, weeksToShow],
  );
  const data = useMemo(
    () => series.map((w) => ({ label: fmtWeekBucket(w.bucket), value: w.reps })),
    [series],
  );
  const movingAvg = useMemo(() => {
    const win = 4;
    return series.map((_, i) => {
      if (i < win - 1) return null;
      let sum = 0;
      for (let j = i - win + 1; j <= i; j++) sum += series[j]!.reps;
      return sum / win;
    });
  }, [series]);

  return (
    <AnalyticsCard title={`Assistance reps (last ${data.length} weeks)`} badge="strength">
      <BarChart
        data={data}
        formatValue={(n) => `${Math.round(n)} reps`}
        overlay={movingAvg}
        overlayLabel="4-wk avg"
      />
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-[#3b82f6]" /> Weekly reps
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-[2px] w-3 bg-[#f59e0b]" /> 4-week moving avg
        </span>
      </div>
    </AnalyticsCard>
  );
}
