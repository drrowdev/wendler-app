'use client';

interface Props {
  onSkip: (reason: 'pain' | 'fatigue' | 'time' | 'equipment' | 'other') => void;
  onCancel: () => void;
}

const REASONS: { id: 'pain' | 'fatigue' | 'time' | 'equipment' | 'other'; label: string; hint: string }[] = [
  { id: 'pain', label: 'Pain / injury', hint: 'flag the lift too' },
  { id: 'fatigue', label: 'Fatigue', hint: 'cut volume, keep TM' },
  { id: 'time', label: 'Out of time', hint: 'finish later' },
  { id: 'equipment', label: 'Equipment', hint: 'rack busy, no plates' },
  { id: 'other', label: 'Other', hint: '' },
];

export function SkipMenu({ onSkip, onCancel }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Skip this set</h3>
        <p className="mt-1 text-xs text-muted">Why?</p>
        <div className="mt-3 grid gap-2">
          {REASONS.map((r) => (
            <button
              key={r.id}
              onClick={() => onSkip(r.id)}
              className="rounded-lg border border-border bg-bg p-3 text-left hover:border-accent"
            >
              <div className="font-medium">{r.label}</div>
              {r.hint && <div className="text-xs text-muted">{r.hint}</div>}
            </button>
          ))}
        </div>
        <button
          onClick={onCancel}
          className="mt-3 w-full rounded-lg bg-card py-2 ring-1 ring-border"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
