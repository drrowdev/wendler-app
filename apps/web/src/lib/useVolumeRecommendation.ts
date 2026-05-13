// Hook that computes the assistance-volume recommendation for a block by
// pulling all the signals from local data (goals, prior blocks, run plan,
// races, pain flags) and feeding them into the pure domain recommender.
//
// Phase 4 of the assistance suggester. Used by BlockAssistanceVolumePanel.

import { useEffect, useMemo, useState } from 'react';
import {
  recommendAssistanceVolume,
  type GoalFlavor as DomainGoalFlavor,
  type VolumeRecommendation,
} from '@wendler/domain';
import { defaultFlavorsForKind } from '@wendler/db-schema';
import type { ProgramBlock } from '@wendler/db-schema';
import { useBlocks, useGoals, useUpcomingRaces } from './hooks';
import { getPainFlagsForBlock } from './injury-signal';

// Race-taper windows: how many days out from an A-priority endurance race
// counts as "cardio peak" (i.e. trim accessory volume to leave room for
// running). Calibrated to typical taper lengths — a half-marathon taper is
// ~7–10 days, marathon taper is 2–3 weeks, etc. Outside this window the
// athlete is still in build phase and should not have lifting volume cut.
const RACE_TAPER_DAYS: Record<string, number> = {
  'half-marathon': 10,
  marathon: 21,
  ultra: 21,
  triathlon: 14,
};

/**
 * Returns the live recommendation for the given block, or `undefined` while
 * inputs are loading. Recomputes whenever any signal changes.
 */
export function useVolumeRecommendation(
  block: ProgramBlock,
): VolumeRecommendation | undefined {
  const goals = useGoals();
  const blocks = useBlocks();
  const upcomingRaces = useUpcomingRaces();

  // Async injury signal — fetched on every prior-block change.
  const [injurySev, setInjurySev] = useState<number>(0);

  // Identify the previous block (most recent completed block, any kind) for
  // the injury-window query. We deliberately use any-kind here so a tweak
  // during a deload still influences the next Leader recommendation.
  const previousAnyKindBlock = useMemo(() => {
    if (!blocks) return undefined;
    return [...blocks]
      .filter((b) => b.id !== block.id && !!b.startedAt && !!b.completedAt)
      .sort((a, b) => (a.completedAt! < b.completedAt! ? 1 : -1))[0];
  }, [blocks, block.id]);

  useEffect(() => {
    let cancelled = false;
    if (!previousAnyKindBlock) {
      setInjurySev(0);
      return () => {
        cancelled = true;
      };
    }
    void getPainFlagsForBlock(previousAnyKindBlock).then((flags) => {
      if (cancelled) return;
      const max = flags.reduce((acc, f) => (f.severity > acc ? f.severity : acc), 0);
      setInjurySev(max);
    });
    return () => {
      cancelled = true;
    };
  }, [previousAnyKindBlock]);

  return useMemo<VolumeRecommendation | undefined>(() => {
    if (!goals || !blocks) return undefined;

    // Active goal flavors, deduped across goals: each unique flavor contributes
    // at most once. Multiple goals carrying the same emphasis (e.g. 3 strength
    // PRs all defaulting to ['strength']) represent one strategic intent, not
    // 3x — and over-counting was dragging the volume signal toward the floor.
    const flavorSet = new Set<DomainGoalFlavor>();
    for (const g of goals) {
      if (g.completedAt) continue;
      const fs = (g.flavors ?? defaultFlavorsForKind(g.kind)) as DomainGoalFlavor[];
      for (const f of fs) flavorSet.add(f);
    }
    const activeGoalFlavors: DomainGoalFlavor[][] =
      flavorSet.size > 0 ? [Array.from(flavorSet)] : [];

    // Prior same-kind blocks, most recent first.
    const prevSameKindBlocks = [...blocks]
      .filter(
        (b) =>
          b.id !== block.id &&
          b.kind === block.kind &&
          !!b.completedAt,
      )
      .sort((a, b) => (a.completedAt! < b.completedAt! ? 1 : -1))
      .slice(0, 2)
      .map((b) => ({ assistanceVolume: b.assistanceVolume }));

    // Cardio peak: an A-priority endurance race within the next 28 days.
    const now = Date.now();
    const cardioPeakActive = (upcomingRaces ?? []).some((r) => {
      if (r.priority !== 'A') return false;
      const isEndurance =
        r.kind === 'half-marathon' ||
        r.kind === 'marathon' ||
        r.kind === 'ultra' ||
        r.kind === 'triathlon';
      if (!isEndurance) return false;
      const days = (new Date(r.date).getTime() - now) / 86400000;
      const window = RACE_TAPER_DAYS[r.kind] ?? 14;
      return days >= 0 && days <= window;
    });

    return recommendAssistanceVolume({
      block: { kind: block.kind, seventhWeekKind: block.seventhWeekKind },
      activeGoalFlavors,
      prevSameKindBlocks,
      cardioPeakActive,
      injurySeverityMax: injurySev,
      // amrapTrendingDown: deferred — needs cycle-over-cycle AMRAP analysis
    });
  }, [
    goals,
    blocks,
    upcomingRaces,
    block.id,
    block.kind,
    block.seventhWeekKind,
    injurySev,
  ]);
}
