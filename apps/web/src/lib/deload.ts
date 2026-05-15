'use client';

// Deload-assistance helpers — wires the pure `recommendDeloadScaling` and
// `applyDeloadScaling` from @wendler/domain to live Dexie data.

import { useMemo } from 'react';
import {
  applyDeloadScaling,
  effectivePlan,
  recommendDeloadScaling,
  type DeloadScalingResult,
  type DeloadStrategy,
  type MainLift,
  type Movement,
  type ProgramBlock,
  type WendlerWeek,
} from '@wendler/domain';
import type { Race, RecoveryEntry, WellnessFlag } from '@wendler/db-schema';
import { getDb } from './db';
import {
  useActiveWellnessFlag,
  useUndismissedReturnIllness,
} from './wellness';
import {
  useAllRecovery,
  useAllSets,
  useMovements,
  useSchedule,
  useUpcomingRaces,
} from './hooks';

/**
 * Returns the recommendation for a deload week's assistance, or null when
 * we shouldn't prompt: not the deload week, the block already has a choice
 * locked in, or the block hasn't been resolved yet.
 */
export function useDeloadScalingPrompt(
  block: ProgramBlock | undefined,
  week: WendlerWeek | null,
): DeloadScalingResult | null {
  const sets = useAllSets();
  const races = useUpcomingRaces();
  const recovery = useAllRecovery();
  const movements = useMovements();
  const activeIllness = useActiveWellnessFlag();
  const recentlyRecovered = useUndismissedReturnIllness();

  return useMemo(() => {
    if (!block || week !== 'deload') return null;
    if (block.deloadScalingChoice) return null;

    const mainLiftMovementIds: Partial<Record<MainLift, string>> = {};
    for (const mv of (movements as Movement[] | undefined) ?? []) {
      const lift = mv.isMainLift;
      if (lift && !mainLiftMovementIds[lift]) {
        mainLiftMovementIds[lift] = mv.id;
      }
    }

    const recoveryRecent = ((recovery as RecoveryEntry[] | undefined) ?? [])
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(-7)
      .map((r) => ({ date: r.id, fatigue: r.fatigue, hrv: r.hrv }));

    const upcomingRaces = ((races as Race[] | undefined) ?? []).map((r) => ({
      date: r.date,
      priority: r.priority,
    }));

    return recommendDeloadScaling({
      sets: ((sets ?? []) as Array<{
        movementId: string;
        performedAt: string;
        weightKg: number;
        reps: number;
        kind: 'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance';
        isAmrap?: boolean;
        skipped?: boolean;
        deletedAt?: string;
        sessionId?: string;
        percentOfTm?: number;
        trainingMaxKgAtTime?: number;
      }>).map((s) => ({
        movementId: s.movementId,
        performedAt: s.performedAt,
        weightKg: s.weightKg,
        reps: s.reps,
        kind: s.kind,
        isAmrap: s.isAmrap,
        skipped: s.skipped,
        deletedAt: s.deletedAt,
        sessionId: s.sessionId,
        // Forwarded for lastAmrapPerformance's week-aware floor inference
        // (v348). Without these, the function falls back to absolute-rep
        // thresholds and systematically under-classifies Wk2/Wk3 AMRAPs.
        percentOfTm: s.percentOfTm,
        trainingMaxKgAtTime: s.trainingMaxKgAtTime,
      })),
      mainLiftMovementIds,
      upcomingRaces,
      recoveryRecent,
      activeIllness: activeIllness
        ? {
            severity: activeIllness.severity,
            startedAt: activeIllness.startedAt,
          }
        : undefined,
      recentlyRecoveredIllness:
        recentlyRecovered && recentlyRecovered.recoveredAt
          ? {
              severity: recentlyRecovered.severity,
              startedAt: recentlyRecovered.startedAt,
              recoveredAt: recentlyRecovered.recoveredAt,
            }
          : undefined,
    });
  }, [block, week, sets, races, recovery, movements, activeIllness, recentlyRecovered]);
}

/**
 * Persist the user's chosen strategy for `blockId`'s deload week:
 * 1. Materialize the effective plan (resolving the legacy `assistance` shape
 *    when the block has no `plan` yet).
 * 2. Run `applyDeloadScaling` to build the new override map.
 * 3. Write `block.plan.assistanceOverrides` and `block.deloadScalingChoice`.
 */
export async function applyDeloadChoice(
  blockId: string,
  strategy: DeloadStrategy,
): Promise<void> {
  const db = getDb();
  const block = await db.blocks.get(blockId);
  if (!block) return;

  const schedule = await db.schedule.get('singleton');
  const plan =
    block.plan ??
    (schedule
      ? effectivePlan(block, schedule)
      : effectivePlan(block, ['press', 'deadlift', 'bench', 'squat']));
  if (!plan) return;

  const nextOverrides = applyDeloadScaling(plan, strategy);
  const now = new Date().toISOString();
  await db.blocks.update(blockId, {
    plan: { ...plan, assistanceOverrides: nextOverrides },
    deloadScalingChoice: strategy,
    updatedAt: now,
  });
  // Log to the inbox so the auto-recommendation has a paper trail — the
  // DeloadAssistanceCard's rationale otherwise disappears when the block is
  // closed.
  const { notify } = await import('./notify');
  await notify.info({
    channel: 'recovery',
    title: `Deload strategy applied: ${strategy.replace(/-/g, ' ')}`,
    body: `Deload-week assistance was scaled using the "${strategy}" strategy for ${block.name ?? 'this block'}.`,
    deepLink: { href: `/program/block?id=${blockId}`, label: `Open ${block.name ?? 'block'}` },
    context: { blockId, strategy },
  });
}

/** Clears `deloadScalingChoice` AND wipes the deload-row overrides so the prompt re-fires. */
export async function resetDeloadChoice(blockId: string): Promise<void> {
  const db = getDb();
  const block = await db.blocks.get(blockId);
  if (!block) return;
  const overrides = block.plan?.assistanceOverrides ?? {};
  const cleaned: Record<string, typeof overrides[string]> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!k.startsWith('deload|')) cleaned[k] = v;
  }
  const now = new Date().toISOString();
  await db.blocks.update(blockId, {
    ...(block.plan ? { plan: { ...block.plan, assistanceOverrides: cleaned } } : {}),
    deloadScalingChoice: undefined,
    updatedAt: now,
  });
}
