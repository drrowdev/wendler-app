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
  height = 160,
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
  const padX = 40;
  const padY = 20;
  const width = 600;
  const xRange = maxX - minX || 1;
  const yRange = maxY - minY || 1;
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
      preserveAspectRatio="none"
      className="h-40 w-full"
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
            x={padX - 4}
            y={yAt(t) + 3}
            fontSize="10"
            textAnchor="end"
            fill="currentColor"
            fillOpacity="0.6"
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
