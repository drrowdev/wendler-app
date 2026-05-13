'use client';

import { Sparkline } from '@/components/charts/Sparkline';

/**
 * Compact KPI tile with a delta vs. prior period and a sparkline. Used in
 * the Analytics page headline row for both strength and cardio totals.
 */
export function KpiTile({
  label,
  value,
  deltaPct,
  spark,
  color = '#3b82f6',
  emptyHint,
}: {
  label: string;
  value: string;
  deltaPct: number | null;
  spark: number[];
  color?: string;
  emptyHint?: string;
}) {
  const arrow =
    deltaPct == null ? '' : deltaPct > 0 ? '▲' : deltaPct < 0 ? '▼' : '→';
  const deltaColor =
    deltaPct == null
      ? 'text-muted'
      : Math.abs(deltaPct) < 1
        ? 'text-muted'
        : deltaPct > 0
          ? 'text-emerald-400'
          : 'text-red-400';
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className={`text-xs ${deltaColor}`}>
          {deltaPct == null
            ? (emptyHint ?? 'no prior data')
            : `${arrow} ${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(0)}%`}
        </span>
        {spark.length > 1 && (
          <div className="w-24">
            <Sparkline data={spark} color={color} />
          </div>
        )}
      </div>
    </div>
  );
}
