'use client';

// First-encounter toast for auto-derived phase changes — the "no silent
// automation" rule made human. Renders a one-time dismissible banner the
// FIRST time the user lands on a surface where the app has changed phase
// on their behalf (race-driven taper/peak, or block-derived deload from
// a 7th-week deload block).
//
// Persistence is per (source, phase) bucket via localStorage so each
// distinct auto-derivation surfaces exactly once. Subsequent encounters
// rely on the PhaseAutoBadge alone.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { PhaseSource } from '@wendler/domain';
import { notify } from '@/lib/notify';

type TrainingPhase = 'normal' | 'deload' | 'taper' | 'peak';

interface PhaseAutoToastProps {
  phase: TrainingPhase;
  source: PhaseSource;
  reason?: string;
}

const STORAGE_PREFIX = 'wendler:phase-auto-toast-seen:v1';

function storageKey(source: PhaseSource, phase: TrainingPhase): string {
  return `${STORAGE_PREFIX}:${source}:${phase}`;
}

export function PhaseAutoToast({ phase, source, reason }: PhaseAutoToastProps) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (source === 'manual' || phase === 'normal') {
      setDismissed(true);
      return;
    }
    const seen = localStorage.getItem(storageKey(source, phase)) === '1';
    setDismissed(seen);
    // Log the auto-shift to the notifications inbox on first encounter (the
    // same trigger that surfaces the toast). The inbox keeps a permanent
    // record so a phase shift from weeks ago is still inspectable — the
    // toast disappears the moment the user dismisses it.
    if (!seen) {
      const title =
        source === 'block'
          ? `Phase auto-shifted to deload (block-derived)`
          : `Phase auto-shifted to ${phase}${reason ? ` (${reason})` : ''}`;
      const body =
        source === 'block'
          ? `You're inside a 7th-week deload block. The assistance volume preset, AI suggester, and goal-flags layer all see this automatically.`
          : `Race calendar triggered an auto ${phase}. Volume preset and AI suggester are adjusting accordingly. Override on /goals if needed.`;
      void notify.info({
        channel: 'phase-auto',
        title,
        body,
        deepLink: { href: '/goals', label: 'Open /goals' },
        context: { source, phase, reason },
      });
    }
  }, [source, phase, reason]);

  if (dismissed) return null;
  if (source === 'manual' || phase === 'normal') return null;

  const handleDismiss = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(storageKey(source, phase), '1');
    }
    setDismissed(true);
  };

  const headline =
    source === 'block'
      ? `Auto-deload active for this block`
      : `Auto-${phase} active`;
  const body =
    source === 'block'
      ? `You're inside a 7th-week deload block, so the app has switched the training phase to deload. The assistance volume preset, AI suggester, and goal-flags layer all see this automatically — no need to flip a switch on /goals.`
      : reason
        ? `Race calendar triggered an auto ${phase} (${reason}). Volume preset and AI suggester are adjusting accordingly.`
        : `Race calendar triggered an auto ${phase}. Volume preset and AI suggester are adjusting accordingly.`;

  return (
    <div
      role="status"
      className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-base" aria-hidden="true">⚙️</div>
        <div className="flex-1 min-w-0">
          <div className="font-medium">{headline}</div>
          <div className="mt-1 text-amber-100/85 text-[12px] leading-snug">{body}</div>
          <div className="mt-2 flex items-center gap-3 text-[11px]">
            <Link
              href="/goals"
              className="rounded border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-amber-100 hover:bg-amber-500/20"
            >
              Override on /goals
            </Link>
            <button
              type="button"
              onClick={handleDismiss}
              className="text-amber-200/80 hover:text-amber-100"
            >
              Got it, don&apos;t show again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
