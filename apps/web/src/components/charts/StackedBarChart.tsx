'use client';

export interface StackedSeries {
  key: string;
  label: string;
  color: string;
}

export interface StackedRow {
  label: string;
  /** key → value (absolute tonnage). Rendered as a percentage of the row total. */
  values: Record<string, number>;
}

interface Props {
  data: StackedRow[];
  series: StackedSeries[];
  height?: number;
  /** Display values as percentage of the row total (default true). */
  asPercent?: boolean;
  formatValue?: (n: number) => string;
  /** Show the row total above each bar. Ignored when asPercent is true. */
  showTotals?: boolean;
  /** Format for the always-on totals label; defaults to formatValue. */
  formatTotal?: (n: number) => string;
  /**
   * Optional trend line overlaid across the bars (e.g. moving average).
   * Length must equal data.length. Values share the same scale as the
   * bar totals (only meaningful when asPercent === false).
   */
  trend?: number[];
  trendColor?: string;
  trendLabel?: string;
}

/**
 * HTML/CSS stacked bar chart. Each bar is a flex column whose stacked segments
 * are sized as percentages of the row total (or the global max when
 * `asPercent` is false). Bars are capped at 64px so they don't stretch.
 */
export function StackedBarChart({
  data,
  series,
  height = 160,
  asPercent = true,
  formatValue = (n) => n.toFixed(0),
  showTotals = false,
  formatTotal,
  trend,
  trendColor = '#f59e0b',
  trendLabel,
}: Props) {
  if (data.length === 0) {
    return <p className="text-sm text-muted">No data yet.</p>;
  }
  const labelH = 18;
  const totalH = showTotals && !asPercent ? 14 : 0;
  const plotH = Math.max(40, height - labelH - totalH);
  const fmtTotal = formatTotal ?? formatValue;

  const totals = data.map((r) => series.reduce((acc, s) => acc + (r.values[s.key] ?? 0), 0));
  const maxBar = Math.max(...totals, 1);
  const maxTrend = trend ? Math.max(...trend, 0) : 0;
  const yMax = asPercent ? 1 : Math.max(maxBar, maxTrend);

  return (
    <div className="w-full">
      {/* Always-on totals row above each bar */}
      {showTotals && !asPercent && (
        <div
          className="flex w-full justify-around gap-1 px-1"
          style={{ height: totalH }}
        >
          {data.map((row, i) => {
            const t = totals[i] ?? 0;
            return (
              <div
                key={row.label + i}
                className="flex min-w-0 flex-1 items-end justify-center text-[10px] font-medium tabular-nums text-fg"
                style={{ maxWidth: 64 }}
              >
                {t > 0 ? fmtTotal(t) : ''}
              </div>
            );
          })}
        </div>
      )}

      <div className="relative w-full" style={{ height: plotH }}>
        <div className="absolute inset-0 flex items-end justify-around gap-1 px-1">
          {data.map((row, i) => {
            const total = totals[i] ?? 0;
            const colHeightPct = asPercent
              ? total > 0
                ? 100
                : 0
              : (total / yMax) * 100;
            return (
              <div
                key={row.label + i}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
                style={{ maxWidth: 64 }}
              >
                <div
                  className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm"
                  style={{ height: `${colHeightPct}%` }}
                >
                  {series.map((s) => {
                    const abs = row.values[s.key] ?? 0;
                    if (abs <= 0) return null;
                    const share = total > 0 ? abs / total : 0;
                    const segPct = share * 100;
                    return (
                      <div
                        key={s.key}
                        style={{ height: `${segPct}%`, background: s.color }}
                        title={`${row.label} · ${s.label}: ${formatValue(abs)}${
                          asPercent ? ` (${(share * 100).toFixed(0)}%)` : ''
                        }`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Trend overlay — drawn in SVG over the bars in a normalized
            100×100 coordinate space so the polyline stays a single clean
            line regardless of bar count. */}
        {trend && trend.length === data.length && !asPercent && (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            shapeRendering="geometricPrecision"
          >
            <polyline
              fill="none"
              stroke={trendColor}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              points={trend
                .map((v, i) => {
                  const x = ((i + 0.5) / trend.length) * 100;
                  const y = 100 - (v / yMax) * 100;
                  return `${x.toFixed(3)},${y.toFixed(3)}`;
                })
                .join(' ')}
            />
            {/* No circle markers — preserveAspectRatio="none" would
                stretch them into wide ovals at every data point. */}
          </svg>
        )}
      </div>

      <div
        className="mt-1 flex w-full justify-around gap-1 px-1"
        style={{ height: labelH }}
      >
        {data.map((row, i) => (
          <div
            key={row.label + i}
            className="flex min-w-0 flex-1 items-start justify-center truncate text-[10px] text-muted"
            style={{ maxWidth: 64 }}
          >
            {row.label}
          </div>
        ))}
      </div>
    </div>
  );
}
