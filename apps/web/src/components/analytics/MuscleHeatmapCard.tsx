'use client';

import { useMemo } from 'react';
import { muscleVolume, type MinimalSet } from '@wendler/domain';
import type { Movement } from '@wendler/db-schema';
import { BodyMap } from '@/components/BodyMap';
import { AnalyticsCard } from './AnalyticsCard';

export function MuscleHeatmapCard({
  recentSets,
  movements,
}: {
  recentSets: MinimalSet[];
  movements: Movement[] | undefined;
}) {
  const muscles = useMemo(() => {
    if (!movements) return {};
    return muscleVolume(recentSets, movements);
  }, [recentSets, movements]);

  return (
    <AnalyticsCard title="Muscle volume heatmap" badge="strength">
      <div className="mx-auto max-w-[260px]">
        <BodyMap volumes={muscles} />
      </div>
    </AnalyticsCard>
  );
}
