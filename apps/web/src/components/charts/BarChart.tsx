'use client';

import { useId } from 'react';

interface BarItem {
  label: string;
  value: number;
}

interface Props {
  data: BarItem[];
  height?: number;
  color?: string;
  formatValue?: (n: number) => string;
  /**
   * Optional overlay line (e.g. moving average). Must be the same length as
   * `data`; entries with `null` are skipped.
   */
  overlay?: Array<number | null>;
  overlayColor?: string;
  overlayLabel?: string;
}

/**
 * HTML/CSS bar chart. Bars are flex columns (always crisp, never stretched);
 * the optional moving-average overlay is an absolutely-positioned SVG so it
 * tracks the bar centers regardless of container width.
 */
export function BarChart({
  data,
  height = 160,
  color = '#3b82f6',
  formatValue = (n) => n.toFixed(0),
  overlay,
  overlayColor = '#f59e0b',
  overlayLabel = 'avg',
}: Props) {
  const overlayId = useId();
  if (data.length === 0) {
    return <p className="text-sm text-muted">No data yet.</p>;
  }
  const overlayMax = overlay ? Math.max(...overlay.map((v) => v ?? 0)) : 0;
  const max = Math.max(...data.map((d) => d.value), overlayMax, 1);
  const labelH = 18; // reserved for x-axis labels
  const plotH = Math.max(40, height - labelH);

  return (
    <div className="w-full">
      <div className="relative w-full" style={{ height: plotH }}>
        <div className="absolute inset-0 flex items-end justify-around gap-1 px-1">
          {data.map((d, i) => {
            const pct = (d.value / max) * 100;
            return (
              <div
                key={d.label + i}
                className="flex h-full min-w-0 flex-1 items-end justify-center"
                style={{ maxWidth: 64 }}
              >
                <div
                  className="w-full rounded-t-sm transition-all"
                  style={{ height: `${pct}%`, background: color }}
                  title={`${d.label}: ${formatValue(d.value)}`}
                />
              </div>
            );
          })}
        </div>
        {overlay && overlay.some((v) => v != null) && (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            preserveAspectRatio="none"
            viewBox={`0 0 ${data.length} ${plotH}`}
            aria-hidden="true"
            key={overlayId}
          >
            {(() => {
              const points = overlay
                .map((v, i) => {
                  if (v == null) return null;
                  const cx = i + 0.5;
                  const cy = plotH - (v / max) * plotH;
                  return { cx, cy, v };
                })
                .filter((p): p is { cx: number; cy: number; v: number } => p != null);
              const path =
                points.length >= 2
                  ? points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx},${p.cy}`).join(' ')
                  : null;
              return (
                <>
                  {path && (
                    <path
                      d={path}
                      fill="none"
                      stroke={overlayColor}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {points.map((p, i) => (
                    <circle
                      key={i}
                      cx={p.cx}
                      cy={p.cy}
                      r={3}
                      fill={overlayColor}
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>
                        {overlayLabel}: {formatValue(p.v)}
                      </title>
                    </circle>
                  ))}
                </>
              );
            })()}
          </svg>
        )}
      </div>
      <div
        className="mt-1 flex w-full justify-around gap-1 px-1"
        style={{ height: labelH }}
      >
        {data.map((d, i) => (
          <div
            key={d.label + i}
            className="flex min-w-0 flex-1 items-start justify-center truncate text-[10px] text-muted"
            style={{ maxWidth: 64 }}
          >
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
