'use client';

interface Slice {
  label: string;
  value: number;
  color: string;
}

interface Props {
  data: Slice[];
  size?: number;
  formatValue?: (n: number) => string;
}

export function Donut({ data, size = 160, formatValue = (n) => n.toFixed(0) }: Props) {
  const total = data.reduce((acc, s) => acc + s.value, 0);
  if (total === 0) {
    return <p className="text-sm text-muted">No data yet.</p>;
  }
  const r = size / 2;
  const inner = r * 0.6;
  let angle = -Math.PI / 2;
  const arcs = data
    .filter((d) => d.value > 0)
    .map((d) => {
      const fraction = d.value / total;
      const start = angle;
      const end = angle + fraction * Math.PI * 2;
      angle = end;
      const large = end - start > Math.PI ? 1 : 0;
      const x1 = r + r * Math.cos(start);
      const y1 = r + r * Math.sin(start);
      const x2 = r + r * Math.cos(end);
      const y2 = r + r * Math.sin(end);
      const x3 = r + inner * Math.cos(end);
      const y3 = r + inner * Math.sin(end);
      const x4 = r + inner * Math.cos(start);
      const y4 = r + inner * Math.sin(start);
      const path = [
        `M ${x1} ${y1}`,
        `A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`,
        `L ${x3} ${y3}`,
        `A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4}`,
        'Z',
      ].join(' ');
      return { path, ...d, fraction };
    });

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        {arcs.map((a) => (
          <path key={a.label} d={a.path} fill={a.color}>
            <title>
              {a.label}: {formatValue(a.value)} ({(a.fraction * 100).toFixed(0)}%)
            </title>
          </path>
        ))}
      </svg>
      <ul className="space-y-1 text-sm">
        {arcs.map((a) => (
          <li key={a.label} className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: a.color }}
            />
            <span className="text-muted">{a.label}</span>
            <span className="font-mono text-fg">{formatValue(a.value)}</span>
            <span className="text-muted">({(a.fraction * 100).toFixed(0)}%)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
