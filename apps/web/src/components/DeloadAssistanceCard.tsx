'use client';

// DeloadAssistanceCard — surfaces a recommended deload-assistance strategy
// at the top of /day on the deload week, before the user has locked in a
// choice for that block. Mirrors WelcomeBackCard styling.

import { useState } from 'react';
import type {
  DeloadScalingPlan,
  DeloadScalingResult,
  DeloadStrategy,
} from '@wendler/domain';
import { applyDeloadChoice } from '@/lib/deload';

interface Props {
  blockId: string;
  result: DeloadScalingResult;
}

const STRATEGY_LABEL: Record<DeloadStrategy, string> = {
  'volume-half': 'Halve volume',
  'intensity-cut': 'Cut loads ~30%',
  'bodyweight-only': 'Bodyweight only',
  'mobility-recovery': 'Mobility / recovery',
  'skip-assistance': 'Skip assistance',
};

const CONFIDENCE_LABEL: Record<DeloadScalingPlan['confidence'], string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export function DeloadAssistanceCard({ blockId, result }: Props) {
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [working, setWorking] = useState(false);
  const [activePlan, setActivePlan] = useState<DeloadScalingPlan>(result.primary);

  const onApply = async () => {
    setWorking(true);
    try {
      await applyDeloadChoice(blockId, activePlan.strategy);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="rounded-2xl border border-sky-400/40 bg-sky-500/5 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-sky-300">
            Deload assistance
          </div>
          <div className="mt-0.5 text-base font-semibold">
            {activePlan.headline}
          </div>
        </div>
        <div className="text-xs text-muted">
          {CONFIDENCE_LABEL[activePlan.confidence]}
        </div>
      </div>

      <p className="mt-2 text-sm leading-snug text-muted">{activePlan.rationale}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={onApply}
          disabled={working}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
        >
          Apply {STRATEGY_LABEL[activePlan.strategy]}
        </button>
        {result.alternatives.length > 0 && (
          <button
            onClick={() => setShowAlternatives((v) => !v)}
            className="rounded-lg bg-bg px-3 py-2 text-sm ring-1 ring-border"
          >
            {showAlternatives ? 'Hide alternatives' : 'Show alternatives'}
          </button>
        )}
      </div>

      {showAlternatives && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div className="text-xs uppercase tracking-wide text-muted">
            Alternatives
          </div>
          {result.alternatives.map((alt) => (
            <button
              key={alt.strategy}
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
