'use client';

import type { PlateBreakdown } from '@wendler/domain';

export function PlateView({ breakdown }: { breakdown: PlateBreakdown }) {
  if (breakdown.perSide.length === 0) {
    return (
      <span className="text-sm text-muted">
        bar only{breakdown.achievable ? '' : ` (need ${breakdown.remainderKg} kg more)`}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      {breakdown.perSide.map((p) => (
        <span
          key={p.weightKg}
          className="rounded bg-card px-2 py-1 font-mono text-xs text-fg/90 ring-1 ring-border"
          title={`${p.count} × ${p.weightKg} kg per side`}
        >
          {p.count}×{p.weightKg}
        </span>
      ))}
      {!breakdown.achievable && (
        <span className="ml-1 text-xs text-amber-400">
          short {breakdown.remainderKg.toFixed(2)} kg
        </span>
      )}
    </div>
  );
}
