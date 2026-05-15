'use client';

import { useId } from 'react';

export interface LineChartPoint {
  x: number;
  y: number;
  label?: string;
}

interface Props {
  data: LineChartPoint[];
  height?: number;
  color?: string;
  yLabel?: string;
  formatY?: (n: number) => string;
}

export function LineChart({
  data,
  height = 200,
  color = '#10b981',
  yLabel,
  formatY = (n) => n.toFixed(1),
}: Props) {
  const id = useId();
  if (data.length === 0) {
    return <p className="text-sm text-muted">No data yet.</p>;
  }
  const minX = Math.min(...data.map((d) => d.x));
  const maxX = Math.max(...data.map((d) => d.x));
  const minY = Math.min(...data.map((d) => d.y));
  const maxY = Math.max(...data.map((d) => d.y));
  // Pad the y-axis to fit the longest formatted label. ~7px per char at
  // fontSize 12; 12px breathing room either side. Without this, large
  // values (e.g. "208.5 kg") get their leading digit clipped because the
  // text-anchor is "end" at x=padX-6 and the label grows leftward into
  // negative x.
  const fontSize = 12;
  const yRangeRaw = maxY - minY || 1;
  const sampleLabels = [
    formatY(minY),
    formatY(minY + yRangeRaw / 3),
    formatY(minY + (2 * yRangeRaw) / 3),
    formatY(maxY),
  ];
  const maxLabelLen = Math.max(...sampleLabels.map((s) => s.length));
  const padX = Math.max(44, Math.ceil(maxLabelLen * (fontSize * 0.6)) + 14);
  const padY = 20;
  const width = 480;
  const xRange = maxX - minX || 1;
  const yRange = yRangeRaw;
  const xAt = (x: number) => padX + ((x - minX) / xRange) * (width - padX * 2);
  const yAt = (y: number) =>
    height - padY - ((y - minY) / yRange) * (height - padY * 2);

  const path = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(d.x).toFixed(1)},${yAt(d.y).toFixed(1)}`)
    .join(' ');

  const ticks = [0, 1 / 3, 2 / 3, 1].map((t) => minY + t * yRange);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto w-full"
      role="img"
      aria-label={yLabel ?? 'line chart'}
    >
      {ticks.map((t, i) => (
        <g key={i}>
          <line
            x1={padX}
            x2={width - padX}
            y1={yAt(t)}
            y2={yAt(t)}
            stroke="currentColor"
            strokeOpacity="0.1"
          />
          <text
            x={padX - 6}
            y={yAt(t) + 4}
            fontSize={fontSize}
            textAnchor="end"
            fill="currentColor"
            fillOpacity="0.65"
          >
            {formatY(t)}
          </text>
        </g>
      ))}
      <defs>
        <linearGradient id={`grad-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.4" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${path} L${xAt(maxX)},${height - padY} L${xAt(minX)},${height - padY} Z`}
        fill={`url(#grad-${id})`}
      />
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
      {data.map((d, i) => (
        <circle key={i} cx={xAt(d.x)} cy={yAt(d.y)} r={3} fill={color}>
          <title>
            {d.label ? `${d.label}: ` : ''}
            {formatY(d.y)}
          </title>
        </circle>
      ))}
    </svg>
  );
}
