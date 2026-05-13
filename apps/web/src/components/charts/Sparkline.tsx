'use client';

interface Props {
  data: number[];
  height?: number;
  color?: string;
}

/** Tiny inline sparkline for at-a-glance trends inside stat cards. */
export function Sparkline({ data, height = 28, color = '#10b981' }: Props) {
  if (data.length < 2) {
    return <div className="h-7" />;
  }
  const width = 120;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const yAt = (v: number) => height - ((v - min) / range) * (height - 4) - 2;
  const path = data
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${yAt(v).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-7 w-full"
      aria-hidden="true"
    >
      <path
        d={`${path} L${width},${height} L0,${height} Z`}
        fill={color}
        fillOpacity="0.15"
      />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
