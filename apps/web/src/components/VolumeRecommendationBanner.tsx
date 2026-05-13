'use client';

// In-block banner that appears when signals shift mid-block (e.g. you cross
// into a race taper, log a pain flag, AMRAP regression detected) and the
// recommended assistance volume no longer matches what's stored on the block.
//
// Two actions: Apply (writes the recommended preset to the block) or Dismiss
// (persists a per-block per-recommendation flag in localStorage so we don't
// nag every session). Re-fires automatically if the recommendation later
// shifts to a *different* preset.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProgramBlock } from '@wendler/db-schema';
import type { AssistanceVolumePreset } from '@wendler/domain';
import { useVolumeRecommendation } from '@/lib/useVolumeRecommendation';
import { getDb } from '@/lib/db';

interface Props {
  block: ProgramBlock;
}

function dismissKey(blockId: string, preset: AssistanceVolumePreset): string {
  return `vol-rec-dismissed:${blockId}:${preset}`;
}

function bucketOfStored(v: ProgramBlock['assistanceVolume']): AssistanceVolumePreset | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v.mainDayReps <= 80) return 'minimal';
  if (v.mainDayReps <= 135) return 'standard';
  return 'high';
}

export function VolumeRecommendationBanner({ block }: Props) {
  const recommendation = useVolumeRecommendation(block);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  const recommendedPreset = recommendation?.preset;

  useEffect(() => {
    if (!recommendedPreset || typeof window === 'undefined') {
      setDismissed(false);
      return;
    }
    setDismissed(window.localStorage.getItem(dismissKey(block.id, recommendedPreset)) === '1');
  }, [block.id, recommendedPreset]);

  if (!recommendation || !recommendedPreset) return null;

  const storedBucket = bucketOfStored(block.assistanceVolume);
  // Only nag when the user has explicitly chosen something AND it differs
  // from the recommendation. If they've left it blank, the editor already
  // shows the recommendation as the effective value.
  if (!storedBucket) return null;
  if (storedBucket === recommendedPreset) return null;

  // Only surface when an *adjustment* signal (cardio-peak, injury, amrap,
  // history with a different preset) is what's driving the change. A bare
  // kind-default mismatch isn't worth a banner.
  const adjustmentSignals = recommendation.reasons.filter(
    (r) => r.signal === 'cardio-peak' || r.signal === 'injury' || r.signal === 'amrap-regression',
  );
  if (adjustmentSignals.length === 0) return null;

  if (dismissed) return null;

  const apply = async () => {
    setBusy(true);
    try {
      await getDb().blocks.update(block.id, {
        assistanceVolume: recommendedPreset,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(dismissKey(block.id, recommendedPreset), '1');
    }
    setDismissed(true);
  };

  const headline =
    adjustmentSignals[0]!.signal === 'cardio-peak'
      ? "You've entered race taper"
      : adjustmentSignals[0]!.signal === 'injury'
        ? 'Pain flag from last block'
        : 'AMRAP reps trending down';

  return (
    <section className="rounded-lg border border-sky-400/50 bg-sky-500/10 px-4 py-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-sky-200">⚙ {headline}</h2>
        <span className="text-xs text-sky-300/80">block volume</span>
      </div>
      <p className="mt-1 text-sky-100">
        Recommend dropping accessory volume from{' '}
        <strong className="text-fg">{storedBucket}</strong> to{' '}
        <strong className="text-fg">{recommendedPreset}</strong> for the rest of this block.
      </p>
      <ul className="mt-2 space-y-0.5 text-[11px] text-sky-100/90">
        {adjustmentSignals.map((r, i) => (
          <li key={i} className="flex items-baseline gap-1.5">
            <span className="text-sky-300/80">·</span>
            <span>{r.detail}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={busy}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
        >
          {busy ? 'Applying…' : `Apply ${recommendedPreset}`}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:text-fg"
        >
          Keep {storedBucket}
        </button>
        <Link
          href={`/program/block?id=${block.id}`}
          className="ml-auto text-xs text-sky-300/80 underline hover:text-fg"
        >
          Edit block →
        </Link>
      </div>
    </section>
  );
}
