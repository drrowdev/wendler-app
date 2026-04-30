'use client';

interface BarItem {
  label: string;
  value: number;
}

interface Props {
  data: BarItem[];
  height?: number;
  color?: string;
  formatValue?: (n: number) => string;
}

export function BarChart({
  data,
  height = 160,
  color = '#3b82f6',
  formatValue = (n) => n.toFixed(0),
}: Props) {
  if (data.length === 0) {
    return <p className="text-sm text-muted">No data yet.</p>;
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  const width = 600;
  const padX = 24;
  const padTop = 16;
  const padBottom = 28;
  const innerW = width - padX * 2;
  const barW = innerW / data.length;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-40 w-full"
      role="img"
      aria-label="bar chart"
    >
      {data.map((d, i) => {
        const h = (d.value / max) * (height - padTop - padBottom) || 0;
        const x = padX + i * barW + barW * 0.15;
        const w = barW * 0.7;
        const y = height - padBottom - h;
        return (
          <g key={d.label + i}>
            <rect x={x} y={y} width={w} height={h} fill={color} rx={2}>
              <title>
                {d.label}: {formatValue(d.value)}
              </title>
            </rect>
            <text
              x={x + w / 2}
              y={height - padBottom + 12}
              fontSize="9"
              textAnchor="middle"
              fill="currentColor"
              fillOpacity="0.6"
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
