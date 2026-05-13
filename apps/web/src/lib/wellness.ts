'use client';

// Wellness data plumbing — adds hooks and helpers around the `wellness`
// Dexie table introduced in schema v13. Pure UI/state code lives here so
// /day stays readable; the recommendation logic lives in the pure
// `recommendReturnPlan` function in @wendler/domain.

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import {
  recommendReturnPlan,
  type BlockPhase,
  type IllnessSignal,
  type MainLift,
  type ReturnPlanInput,
  type ReturnPlanResult,
  type WendlerWeek,
} from '@wendler/domain';
import type {
  Movement,
  ProgramBlock,
  RecoveryEntry,
  Race,
  WellnessFlag,
  WellnessSeverity,
} from '@wendler/db-schema';
import { getDb } from './db';
import { useAllRecovery, useAllSets, useUpcomingRaces } from './hooks';

const todayIso = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Live query: the active (unrecovered, undeleted) illness if any. */
export function useActiveWellnessFlag(): WellnessFlag | undefined {
  return useLiveQuery(async () => {
    const all = await getDb().wellness.toArray();
    return all
      .filter((w) => !w.deletedAt && !w.recoveredAt && w.kind === 'illness')
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  }, []);
}

/**
 * Live query: the most recently recovered illness whose recommendation has
 * not yet been dismissed and whose recoveredAt is within the last 14 days.
 * The 14-day window prevents very old illnesses from popping the card after
 * a long sync gap.
 */
export function useUndismissedReturnIllness(): WellnessFlag | undefined {
  return useLiveQuery(async () => {
    const all = await getDb().wellness.toArray();
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 14);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return all
      .filter(
        (w) =>
          !w.deletedAt &&
          w.kind === 'illness' &&
          !!w.recoveredAt &&
          !w.recommendationDismissedAt &&
          w.recoveredAt >= cutoffIso,
      )
      .sort((a, b) => (a.recoveredAt! < b.recoveredAt! ? 1 : -1))[0];
  }, []);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function startIllness(input: {
  severity: WellnessSeverity;
  startedAt?: string;
  notes?: string;
}): Promise<WellnessFlag> {
  const now = new Date().toISOString();
  const row: WellnessFlag = {
    id: nanoid(),
    kind: 'illness',
    severity: input.severity,
    startedAt: input.startedAt ?? todayIso(),
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().wellness.put(row);
  return row;
}

export async function markRecovered(id: string, recoveredAt = todayIso()): Promise<void> {
  const now = new Date().toISOString();
  await getDb().wellness.update(id, { recoveredAt, updatedAt: now });
}

export async function dismissReturnPlan(id: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb().wellness.update(id, {
    recommendationDismissedAt: now,
    updatedAt: now,
  });
}

export async function updateIllness(
  id: string,
  patch: Partial<Pick<WellnessFlag, 'severity' | 'startedAt' | 'notes'>>,
): Promise<void> {
  const now = new Date().toISOString();
  await getDb().wellness.update(id, { ...patch, updatedAt: now });
}

// ---------------------------------------------------------------------------
// Return plan assembly
// ---------------------------------------------------------------------------

function blockPhaseFor(block: ProgramBlock | undefined, week: WendlerWeek | null): BlockPhase {
  if (!block) return 'standard';
  if (block.kind === 'seventh-week') return 'seventh-week';
  if (week === 'deload') return 'deload';
  // We don't currently track meet-prep as a block kind; the A-race override
  // in the recommender covers that case via upcomingRaces.
  return 'standard';
}

/**
 * Assembles a ReturnPlanInput from live Dexie data and runs the
 * recommender. Returns null when there's no recovered, undismissed
 * illness, or when we don't yet have enough block context.
 */
export function useReturnPlan(args: {
  block: ProgramBlock | undefined;
  week: WendlerWeek | null;
  cycleNumber: number;
  movements: Movement[] | undefined;
}): { illness: WellnessFlag; result: ReturnPlanResult } | null {
  const illness = useUndismissedReturnIllness();
  const sets = useAllSets();
  const races = useUpcomingRaces();
  const recovery = useAllRecovery();

  return useMemo(() => {
    if (!illness || !illness.recoveredAt) return null;
    if (!args.block || !args.week) return null;

    const mainLiftMovementIds: Partial<Record<MainLift, string>> = {};
    for (const mv of args.movements ?? []) {
      const lift = mv.isMainLift;
      if (lift && !mainLiftMovementIds[lift]) {
        mainLiftMovementIds[lift] = mv.id;
      }
    }

    const recoveredAt = illness.recoveredAt;
    const cutoff = new Date(recoveredAt + 'T00:00:00Z');
    cutoff.setUTCDate(cutoff.getUTCDate() - 3);
    const since = cutoff.toISOString().slice(0, 10);
    const recoveryAfter = (recovery as RecoveryEntry[] | undefined)
      ?.filter((r) => r.id >= recoveredAt)
      .map((r) => ({ date: r.id, fatigue: r.fatigue, hrv: r.hrv })) ?? [];

    const upcomingRaces = (races as Race[] | undefined)?.map((r) => ({
      date: r.date,
      priority: r.priority,
    })) ?? [];

    const illnessSig: IllnessSignal = {
      severity: illness.severity,
      startedAt: illness.startedAt,
      recoveredAt,
    };

    const reqInput: ReturnPlanInput = {
      illness: illnessSig,
      blockState: {
        cycleNumber: args.cycleNumber,
        week: args.week,
        phase: blockPhaseFor(args.block, args.week),
      },
      sets: (sets ?? []).map((s) => ({
        movementId: s.movementId,
        performedAt: s.performedAt,
        weightKg: s.weightKg,
        reps: s.reps,
        kind: s.kind,
        isAmrap: s.isAmrap,
        skipped: s.skipped,
        deletedAt: s.deletedAt,
        sessionId: s.sessionId,
      })),
      mainLiftMovementIds,
      upcomingRaces,
      recoveryAfter,
      // pain flags can be threaded through later; the recommender treats
      // missing data as "no signal" rather than "no pain".
      painFlags: [],
    };

    const result = recommendReturnPlan(reqInput);
    if (!result) return null;
    // Suppress `since` lint — we may use it for tighter recovery scoping later.
    void since;
    return { illness, result };
  }, [illness, args.block, args.week, args.cycleNumber, args.movements, sets, races, recovery]);
}
