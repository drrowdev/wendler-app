'use client';

import { useMemo } from 'react';
import {
  planEmoji,
  planLabel,
  RUN_DAY_LABELS,
  runPlanAdherence,
  type MinimalCardio,
} from '@wendler/domain';
import type { RunPlan } from '@wendler/db-schema';
import { AnalyticsCard } from './AnalyticsCard';

/**
 * Run-plan adherence: for each non-rest slot in the user's weekly template,
 * show how many of the last N weeks contained a run tagged with that kind on
 * the matching weekday. Hidden when no plan is configured.
 */
export function RunPlanAdherenceCard({
  recentCardio,
  plan,
  weeks = 8,
}: {
  recentCardio: MinimalCardio[];
  plan: RunPlan | undefined;
  weeks?: number;
}) {
  const rows = useMemo(
    () => runPlanAdherence(recentCardio, plan?.slots, new Date(), weeks),
    [recentCardio, plan, weeks],
  );

  if (!plan?.slots?.length) {
    return (
      <AnalyticsCard title="Run-plan adherence" badge="cardio">
        <p className="text-sm text-muted">
          No weekly run plan configured.{' '}
          <a className="text-accent underline" href="/program?tab=cardio">
            Set one up
          </a>{' '}
          to see how reliably you hit each slot.
        </p>
      </AnalyticsCard>
    );
  }

  if (rows.length === 0) {
    return (
      <AnalyticsCard title="Run-plan adherence" badge="cardio">
        <p className="text-sm text-muted">
          Your plan only has rest slots. Add easy/quality/long days on{' '}
          <a className="text-accent underline" href="/program?tab=cardio">
            Program → Cardio
          </a>
          .
        </p>
      </AnalyticsCard>
    );
  }

  return (
    <AnalyticsCard
      title="Run-plan adherence"
      badge="cardio"
      subtitle={`Last ${weeks} weeks`}
    >
      <div className="space-y-2">
        {rows.map((r) => {
          const pct = r.rate * 100;
          const color = pct >= 80 ? '#22c55e' : pct >= 50 ? '#38bdf8' : '#ef4444';
          return (
            <div key={`${r.dayOfWeek}-${r.plannedKind}`} className="space-y-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted">
                  <span className="mr-1 inline-block w-8 font-mono">
                    {RUN_DAY_LABELS[r.dayOfWeek]}
                  </span>
                  {planEmoji(r.plannedKind)} {planLabel(r.plannedKind)}
                </span>
                <span className="tabular-nums text-fg">
                  {r.hitWeeks}/{r.totalWeeks}{' '}
                  <span className="text-muted">({pct.toFixed(0)}%)</span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-bg">
                <div
                  className="h-full"
                  style={{ width: `${Math.max(2, pct)}%`, backgroundColor: color }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </AnalyticsCard>
  );
}
