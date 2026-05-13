'use client';

// Amber inline badge that surfaces auto-derived training phase changes.
// Renders ONLY when the phase was auto-derived (phaseSource === 'race' or
// 'block') AND the phase is non-normal. Tooltip on hover explains the
// reason; click navigates to /goals where the user can override via the
// manual phase switch.
//
// This implements the "no silent automation" UX rule: whenever the app
// changes phase on the user's behalf, there is a visible signal.

import Link from 'next/link';
import type { PhaseSource } from '@wendler/domain';

type TrainingPhase = 'normal' | 'deload' | 'taper' | 'peak';

interface PhaseAutoBadgeProps {
  phase: TrainingPhase;
  source: PhaseSource;
  /** Short human-readable reason, e.g. "7th-week deload block" or "A-race in 9 days". */
  reason?: string;
  /** Extra Tailwind classes for the wrapping span (e.g. margin tweaks). */
  className?: string;
}

const PHASE_LABEL: Record<TrainingPhase, string> = {
  normal: 'normal',
  deload: 'deload',
  taper: 'taper',
  peak: 'peak',
};

export function PhaseAutoBadge({
  phase,
  source,
  reason,
  className,
}: PhaseAutoBadgeProps) {
  if (source === 'manual') return null;
  if (phase === 'normal') return null;

  const title = reason
    ? `Auto-derived from ${source === 'block' ? 'your active block' : 'your race calendar'}: ${reason}. Override on /goals.`
    : `Auto-derived from ${source === 'block' ? 'your active block' : 'your race calendar'}. Override on /goals.`;

  return (
    <Link
      href="/goals"
      title={title}
      className={[
        'inline-flex items-center gap-1 rounded-md',
        'border border-amber-500/50 bg-amber-500/10',
        'px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide',
        'text-amber-300 hover:bg-amber-500/20 hover:text-amber-200',
        'transition-colors',
        className ?? '',
      ].join(' ')}
      aria-label={title}
    >
      <span aria-hidden="true">●</span>
      <span>Auto · {PHASE_LABEL[phase]}</span>
    </Link>
  );
}
