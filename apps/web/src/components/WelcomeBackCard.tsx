'use client';

// WelcomeBackCard — surfaced at the top of /day on the first session after
// an illness is marked recovered. Shows the recommendation from
// `recommendReturnPlan`, lets the user accept (auto-applies any TM
// adjustment), browse alternatives, or dismiss for this episode.

import { useState } from 'react';
import { nanoid } from 'nanoid';
import type { ReturnPlan, ReturnPlanResult } from '@wendler/domain';
import type { TrainingMaxRecord, WellnessFlag } from '@wendler/db-schema';
import { dismissReturnPlan } from '@/lib/wellness';
import { useAllTrainingMaxes } from '@/lib/hooks';
import { getDb } from '@/lib/db';

interface Props {
  illness: WellnessFlag;
  result: ReturnPlanResult;
}

const STRATEGY_LABEL: Record<ReturnPlan['strategy'], string> = {
  'resume-as-scheduled': 'Resume as scheduled',
  'skip-amrap-today': 'Skip the AMRAP today',
  'replay-current-week': 'Replay this week',
  'extend-deload': 'Extend the deload',
  'restart-cycle-tm-hold': 'Restart the cycle (hold TM)',
  'restart-cycle-tm-down-5': 'Restart the cycle (drop TM 5%)',
  'reset-with-ramp': 'Ease back with a ramp week',
  'reschedule-meet': 'Reschedule the meet / race',
};

const CONFIDENCE_LABEL: Record<ReturnPlan['confidence'], string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export function WelcomeBackCard({ illness, result }: Props) {
  const tmsByLift = useAllTrainingMaxes();
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [working, setWorking] = useState(false);
  const [activePlan, setActivePlan] = useState<ReturnPlan>(result.primary);

  const applyTmDrop = async (fraction: number) => {
    if (!tmsByLift) return;
    const now = new Date().toISOString();
    const note = `Illness return adjustment (${illness.severity}, ${illness.startedAt}→${illness.recoveredAt})`;
    const writes: TrainingMaxRecord[] = [];
    for (const [lift, tm] of tmsByLift.entries()) {
      const newTm = Math.round(tm.trainingMaxKg * (1 + fraction) * 2) / 2;
      writes.push({
        id: nanoid(),
        lift,
        trainingMaxKg: newTm,
        tmPercent: tm.tmPercent,
        createdAt: now,
        source: 'manual',
        note,
      });
    }
    if (writes.length > 0) {
      await getDb().trainingMaxes.bulkAdd(writes);
    }
  };

  const onAccept = async () => {
    setWorking(true);
    try {
      if (
        activePlan.tmAdjustmentPercent !== undefined &&
        activePlan.tmAdjustmentPercent !== 0
      ) {
        await applyTmDrop(activePlan.tmAdjustmentPercent);
      }
      await dismissReturnPlan(illness.id);
    } finally {
      setWorking(false);
    }
  };

  const onDismiss = async () => {
    setWorking(true);
    try {
      await dismissReturnPlan(illness.id);
    } finally {
      setWorking(false);
    }
  };

  const isStructural =
    activePlan.tmAdjustmentPercent === undefined &&
    activePlan.strategy !== 'resume-as-scheduled' &&
    activePlan.strategy !== 'skip-amrap-today';

  return (
    <div className="rounded-2xl border border-amber-400/40 bg-amber-500/5 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-amber-300">
            Welcome back
          </div>
          <div className="mt-0.5 text-base font-semibold">
            {STRATEGY_LABEL[activePlan.strategy]}
          </div>
        </div>
        <div className="text-xs text-muted">
          {CONFIDENCE_LABEL[activePlan.confidence]}
        </div>
      </div>

      <p className="mt-2 text-sm leading-snug">{activePlan.headline}</p>
      <p className="mt-1 text-xs text-muted">{activePlan.rationale}</p>

      {activePlan.tmAdjustmentPercent !== undefined &&
        activePlan.tmAdjustmentPercent !== 0 && (
          <div className="mt-2 text-xs text-amber-200">
            Accepting will drop all training maxes by{' '}
            {Math.round(Math.abs(activePlan.tmAdjustmentPercent) * 100)}% (rounded
            to 0.5 kg).
          </div>
        )}

      {isStructural && (
        <div className="mt-2 text-xs text-muted">
          This is a block-level change. After accepting, edit the current block
          to replay or extend the week as suggested.
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={onAccept}
          disabled={working}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
        >
          {activePlan.tmAdjustmentPercent ? 'Apply TM drop' : 'Got it'}
        </button>
        {result.alternatives.length > 0 && (
          <button
            onClick={() => setShowAlternatives((v) => !v)}
            className="rounded-lg bg-bg px-3 py-2 text-sm ring-1 ring-border"
          >
            {showAlternatives ? 'Hide alternatives' : 'Show alternatives'}
          </button>
        )}
        <button
          onClick={onDismiss}
          disabled={working}
          className="rounded-lg bg-bg px-3 py-2 text-sm text-muted ring-1 ring-border disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>

      {showAlternatives && result.alternatives.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div className="text-xs uppercase tracking-wide text-muted">
            Alternatives
          </div>
          {result.alternatives.map((alt, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setActivePlan(alt);
                setShowAlternatives(false);
              }}
              className="block w-full rounded-lg bg-bg p-2 text-left ring-1 ring-border hover:ring-accent"
            >
              <div className="text-sm font-semibold">
                {STRATEGY_LABEL[alt.strategy]}
              </div>
              <div className="mt-0.5 text-xs text-muted">{alt.headline}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
