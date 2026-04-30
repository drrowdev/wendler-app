'use client';

import { fmtKg } from '@/lib/format';

interface Props {
  topAmrapWeightKg: number;
  /** Reps achieved on the AMRAP. */
  amrapReps: number;
  rpe: number | undefined;
  roundingKg: number;
  onAccept: (jokerSets: { weightKg: number; reps: number }[]) => void;
  onDecline: () => void;
}

/**
 * Suggest 1-3 joker sets stepping up by 5% TM increments above the AMRAP weight.
 * Wendler's rule of thumb when the top set was easy.
 */
export function JokerPrompt({
  topAmrapWeightKg,
  amrapReps,
  rpe,
  roundingKg,
  onAccept,
  onDecline,
}: Props) {
  // 3-5% jumps; reps step down 5/3/1.
  const round = (w: number) => Math.round(w / roundingKg) * roundingKg;
  const suggestions = [
    { weightKg: round(topAmrapWeightKg * 1.05), reps: 5 },
    { weightKg: round(topAmrapWeightKg * 1.1), reps: 3 },
    { weightKg: round(topAmrapWeightKg * 1.15), reps: 1 },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-2 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onDecline}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-accent/60 bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Joker sets?</h3>
        <p className="mt-1 text-sm text-muted">
          Your AMRAP felt good (
          {amrapReps} reps{rpe != null ? `, RPE ${rpe}` : ''}). Want to push past the top set with
          ascending singles/triples? Wendler&apos;s joker rule: only if the top set was easy.
        </p>
        <div className="mt-3 space-y-2">
          {suggestions.map((s, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-lg border border-border bg-bg p-3"
            >
              <div>
                <div className="font-mono text-lg">
                  {fmtKg(s.weightKg)} × {s.reps}
                </div>
                <div className="text-xs text-muted">
                  +{((1 + 0.05 * (i + 1)) * 100 - 100).toFixed(0)}% above AMRAP
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => onAccept(suggestions)}
            className="flex-1 rounded-lg bg-accent py-2 font-semibold text-bg"
          >
            Add joker sets
          </button>
          <button
            onClick={onDecline}
            className="rounded-lg bg-bg px-3 py-2 ring-1 ring-border"
          >
            No, done
          </button>
        </div>
      </div>
    </div>
  );
}
