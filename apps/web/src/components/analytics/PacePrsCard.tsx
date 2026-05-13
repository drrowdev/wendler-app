'use client';

import { useMemo } from 'react';
import {
  formatDistance,
  formatPaceTime,
  pacePRs,
  RACE_DISTANCES_M,
  type MinimalCardio,
} from '@wendler/domain';
import type { CardioSession } from '@wendler/db-schema';
import { AnalyticsCard } from './AnalyticsCard';

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/**
 * Pace personal records for standard race distances (1k / mile / 5k / 10k /
 * HM / M), surfaced from the `bestEffortsSec` Strava synthesises on each run.
 */
export function PacePrsCard({
  recentCardio,
}: {
  recentCardio: (MinimalCardio & Pick<CardioSession, 'bestEffortsSec'>)[];
}) {
  const prs = useMemo(
    () =>
      pacePRs(
        recentCardio.map((c) => ({
          id: c.id,
          performedAt: c.performedAt,
          modality: c.modality,
          bestEffortsSec: c.bestEffortsSec,
        })),
      ),
    [recentCardio],
  );

  if (prs.length === 0) {
    return (
      <AnalyticsCard title="Pace personal records" badge="cardio">
        <p className="text-sm text-muted">
          No pace PRs yet. Strava activities with best-effort splits will populate
          this card.
        </p>
      </AnalyticsCard>
    );
  }

  return (
    <AnalyticsCard title="Pace personal records" badge="cardio">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {RACE_DISTANCES_M.map((d) => {
          const pr = prs.find((p) => p.distanceM === d);
          if (!pr) return null;
          return (
            <div key={d} className="rounded-lg border border-border bg-bg p-3 text-center">
              <div className="text-xs text-muted">{formatDistance(d)}</div>
              <div className="text-lg font-semibold tabular-nums">
                {formatPaceTime(pr.timeSec)}
              </div>
              <div className="text-[10px] text-muted">{formatDate(pr.performedAt)}</div>
            </div>
          );
        })}
      </div>
    </AnalyticsCard>
  );
}
