'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { getDb } from './db';
import type { MainLift } from '@wendler/db-schema';

export function useSettings() {
  return useLiveQuery(() => getDb().settings.get('singleton'));
}

export function useMovements() {
  return useLiveQuery(() => getDb().movements.orderBy('name').toArray(), []);
}

export function useMainLiftMovement(lift: MainLift) {
  return useLiveQuery(
    () => getDb().movements.where('isMainLift').equals(lift).first(),
    [lift],
  );
}

export function useCurrentTrainingMax(lift: MainLift) {
  return useLiveQuery(async () => {
    const all = await getDb().trainingMaxes.where('lift').equals(lift).toArray();
    if (all.length === 0) return undefined;
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  }, [lift]);
}

export function useAllTrainingMaxes() {
  return useLiveQuery(async () => {
    const all = await getDb().trainingMaxes.toArray();
    const byLift = new Map<MainLift, (typeof all)[number]>();
    for (const tm of all) {
      const cur = byLift.get(tm.lift);
      if (!cur || cur.createdAt < tm.createdAt) byLift.set(tm.lift, tm);
    }
    return byLift;
  });
}

export function useSetsForMovement(movementId: string) {
  return useLiveQuery(
    () => getDb().sets.where('movementId').equals(movementId).toArray(),
    [movementId],
  );
}

export function useSessionsRecent(limit = 10) {
  return useLiveQuery(
    () => getDb().sessions.orderBy('performedAt').reverse().limit(limit).toArray(),
    [limit],
  );
}

export function useSession(sessionId: string | undefined) {
  return useLiveQuery(
    async () => (sessionId ? await getDb().sessions.get(sessionId) : undefined),
    [sessionId],
  );
}

export function useSetsForSession(sessionId: string | undefined) {
  return useLiveQuery(
    async () =>
      sessionId
        ? await getDb().sets.where('sessionId').equals(sessionId).toArray()
        : [],
    [sessionId],
  );
}

export function useBlocks() {
  return useLiveQuery(
    () => getDb().blocks.orderBy('createdAt').reverse().toArray(),
    [],
  );
}

export function useBlock(blockId: string | undefined) {
  return useLiveQuery(
    async () => (blockId ? await getDb().blocks.get(blockId) : undefined),
    [blockId],
  );
}

export function useSchedule() {
  return useLiveQuery(() => getDb().schedule.get('singleton'));
}

export function useActiveBlock() {
  return useLiveQuery(async () => {
    const sched = await getDb().schedule.get('singleton');
    if (!sched?.activeBlockId) return undefined;
    return await getDb().blocks.get(sched.activeBlockId);
  });
}
