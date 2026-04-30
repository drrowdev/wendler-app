'use client';

interface Props {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  /** Compact rendering (smaller buttons). */
  compact?: boolean;
}

const RPE_VALUES: { v: number; label: string }[] = [
  { v: 6, label: '6' },
  { v: 6.5, label: '6.5' },
  { v: 7, label: '7' },
  { v: 7.5, label: '7.5' },
  { v: 8, label: '8' },
  { v: 8.5, label: '8.5' },
  { v: 9, label: '9' },
  { v: 9.5, label: '9.5' },
  { v: 10, label: '10' },
];

const RPE_HINTS: Record<number, string> = {
  6: 'easy, 4+ reps left',
  7: '3 reps left',
  8: '2 reps left',
  9: '1 rep left',
  10: 'maximal — no more reps',
};

export function RpeButtons({ value, onChange, compact }: Props) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted">RPE</span>
        {value != null && RPE_HINTS[Math.floor(value)] && (
          <span className="text-xs text-muted">{RPE_HINTS[Math.floor(value)]}</span>
        )}
      </div>
      <div className={`mt-1 grid grid-cols-9 gap-1 ${compact ? '' : 'sm:gap-2'}`}>
        {RPE_VALUES.map((r) => {
          const sel = value === r.v;
          return (
            <button
              key={r.v}
              type="button"
              onClick={() => onChange(sel ? undefined : r.v)}
              className={`rounded-md py-1.5 text-xs font-semibold tabular-nums ring-1 transition active:scale-95 ${
                sel
                  ? 'bg-accent text-bg ring-accent'
                  : 'bg-card text-muted ring-border hover:text-fg'
              }`}
              aria-pressed={sel}
            >
              {r.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
