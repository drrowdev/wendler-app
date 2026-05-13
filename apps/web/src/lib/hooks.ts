'use client';

import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDb } from './db';
import type { MainLift, ProgramBlock, SessionRecord } from '@wendler/db-schema';
import {
  buildMainSets,
  buildSupplementalSets,
  dayLabel,
  effectivePlan,
  initialCursorWeek,
  projectUpcomingWorkouts,
  resolveDayAssistance,
  summarizeGoal,
  type MainScheme,
  type SupplementalTemplateId,
  type UpcomingWorkout,
  type WendlerWeek,
} from '@wendler/domain';

export function useSettings() {
  return useLiveQuery(() => getDb().settings.get('singleton'));
}

export function useMovements() {
  return useLiveQuery(() => getDb().movements.orderBy('name').toArray(), []);
}

export function useMainLiftMovement(lift: MainLift) {
  return useLiveQuery(async () => {
    const settings = await getDb().settings.get('singleton');
    const mappedId = settings?.mainLiftMovements?.[lift];
    if (mappedId) {
      const m = await getDb().movements.get(mappedId);
      if (m) return m;
    }
    return getDb().movements.where('isMainLift').equals(lift).first();
  }, [lift]);
}

/**
 * Resolves the currently-selected Movement for every 5/3/1 slot in one query.
 * Returns a Map keyed by MainLift. Mirrors {@link useMainLiftMovement} —
 * explicit `mainLiftMovements` mapping wins, otherwise we fall back to the
 * seeded movement carrying `isMainLift`.
 */
export function useAllMainLiftMovements() {
  return useLiveQuery(async () => {
    const db = getDb();
    const settings = await db.settings.get('singleton');
    const allMovements = await db.movements.toArray();
    const byId = new Map(allMovements.map((m) => [m.id, m]));
    const out = new Map<MainLift, (typeof allMovements)[number]>();
    const lifts: MainLift[] = ['squat', 'bench', 'deadlift', 'press'];
    for (const lift of lifts) {
      const mappedId = settings?.mainLiftMovements?.[lift];
      const mapped = mappedId ? byId.get(mappedId) : undefined;
      if (mapped) {
        out.set(lift, mapped);
        continue;
      }
      const fallback = allMovements.find((m) => m.isMainLift === lift);
      if (fallback) out.set(lift, fallback);
    }
    return out;
  });
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
    async () => {
      // Only show sessions the user has actually finished — drafts and abandoned
      // auto-created shells never appear here.
      const all = await getDb()
        .sessions.orderBy('performedAt')
        .reverse()
        .filter((s) => !!(s.workoutCompletedAt ?? s.completedAt))
        .toArray();
      return all.slice(0, limit);
    },
    [limit],
  );
}

export interface RecentWorkoutDay {
  /** Stable key: blockId|week|dayIndex (or '__loose__' bucket). */
  key: string;
  blockId?: string;
  block?: ProgramBlock;
  week?: WendlerWeek;
  dayIndex?: number;
  /** Display label, e.g. "Block 1 — Day 2 (Press + Bench)". */
  title: string;
  /** Sub-label, e.g. "Week 2" or "Deload". */
  weekLabel?: string;
  sessions: SessionRecord[];
  /** Latest performedAt across the day's sessions; used for sort + display. */
  latestPerformedAt: string;
  /** True if at least one session has work but is not yet completed. */
  inProgress: boolean;
  /** True if every session in the day is marked completed. */
  completed: boolean;
  /** Total movements prescribed for the workout (main lifts + assistance entries). */
  movementsTotal: number;
  /** Movements with at least one logged set across the day. */
  movementsLogged: number;
  /** Total prescribed sets for the workout (warm-ups + main + supplemental + assistance). */
  setsTotal: number;
  /** Logged sets across the day (excludes deleted; includes warm-ups + assistance). */
  setsLogged: number;
  /**
   * If set, this workout-day was explicitly linked to a different planned
   * date (YYYY-MM-DD). Used to render the "↗ planned <date>" badge and
   * to match the day-group against suppressed planned slots.
   */
  planScheduledDate?: string;
}

/**
 * Recent workout *days* — sessions grouped by (blockId, week, dayIndex).
 *
 * Surfaces in two states:
 *   - completed: at least one session in the day has workoutCompletedAt set
 *     (the user clicked "Complete workout" on /day)
 *   - in_progress: at least one session has logged sets but the workout has
 *     not been explicitly marked complete
 *
 * Empty / abandoned shell sessions (no completion, no logged sets) are dropped.
 * Sessions without enough metadata to group (no blockId/week) fall through as
 * single-session entries so they remain reachable.
 */
export function useRecentWorkoutDays(limit = 5) {
  return useLiveQuery(
    async () => {
      const db = getDb();
      const [allSessions, allSets, blocks, schedule, settings, allMovements] = await Promise.all([
        db.sessions.toArray(),
        db.sets.toArray(),
        db.blocks.toArray(),
        db.schedule.get('singleton'),
        db.settings.get('singleton'),
        db.movements.toArray(),
      ]);

      const setsBySession = new Map<string, number>();
      // Per-session: movementIds that have at least one logged main-lift /
      // supplemental / amrap set (i.e. evidence the lift was worked,
      // ignoring warm-ups). Used to mark a main-lift movement as "logged".
      const liftMovementsBySession = new Map<string, Set<string>>();
      // Per-session: movementIds with at least one assistance set logged.
      const assistMovementsBySession = new Map<string, Set<string>>();
      for (const s of allSets) {
        if (s.deletedAt || !s.sessionId) continue;
        setsBySession.set(s.sessionId, (setsBySession.get(s.sessionId) ?? 0) + 1);
        if (s.kind === 'assistance') {
          let bag = assistMovementsBySession.get(s.sessionId);
          if (!bag) {
            bag = new Set<string>();
            assistMovementsBySession.set(s.sessionId, bag);
          }
          bag.add(s.movementId);
        } else if (s.kind !== 'warmup') {
          let bag = liftMovementsBySession.get(s.sessionId);
          if (!bag) {
            bag = new Set<string>();
            liftMovementsBySession.set(s.sessionId, bag);
          }
          bag.add(s.movementId);
        }
      }

      const blocksById = new Map(blocks.map((b) => [b.id, b]));
      const dayOrder = (schedule?.dayOrder ?? ['press', 'deadlift', 'bench', 'squat']) as MainLift[];
      const liftsPerDay = schedule?.liftsPerDay ?? 1;

      const groups = new Map<string, RecentWorkoutDay>();

      for (const sess of allSessions) {
        const hasWork = (setsBySession.get(sess.id) ?? 0) > 0;
        const isWorkoutCompleted = !!sess.workoutCompletedAt;
        // Drop empty shells: not workout-completed AND no work logged.
        if (!isWorkoutCompleted && !hasWork) continue;

        const key =
          sess.blockId && sess.week != null && sess.dayIndex != null
            ? `${sess.blockId}|${sess.week}|${sess.dayIndex}`
            : `loose|${sess.id}`;

        let bucket = groups.get(key);
        if (!bucket) {
          const block = sess.blockId ? blocksById.get(sess.blockId) : undefined;
          let title = 'Session';
          if (block) {
            const plan =
              schedule
                ? effectivePlan(block, schedule)
                : effectivePlan(block, dayOrder, liftsPerDay);
            const di = sess.dayIndex ?? 0;
            const planDay = plan?.days[di];
            const dLabel = planDay ? dayLabel(planDay, di) : `Day ${di + 1}`;
            title = `${block.name} — ${dLabel}`;
          } else if (sess.mainLift) {
            // Last-resort label for sessions with no block context.
            title = sess.mainLift.charAt(0).toUpperCase() + sess.mainLift.slice(1);
          }
          const weekLabel =
            sess.week === 'deload'
              ? 'Deload'
              : sess.week != null
                ? `Week ${sess.week}`
                : undefined;
          bucket = {
            key,
            blockId: sess.blockId,
            block,
            week: sess.week,
            dayIndex: sess.dayIndex,
            title,
            weekLabel,
            sessions: [],
            latestPerformedAt: sess.performedAt,
            inProgress: false,
            completed: true,
            movementsTotal: 0,
            movementsLogged: 0,
            setsTotal: 0,
            setsLogged: 0,
            planScheduledDate: sess.planScheduledDate,
          };
          groups.set(key, bucket);
        }
        bucket.sessions.push(sess);
        if (sess.performedAt > bucket.latestPerformedAt) {
          bucket.latestPerformedAt = sess.performedAt;
        }
        // Fan-out is best-effort across rows; treat any row with a value
        // as authoritative for the day-group.
        if (sess.planScheduledDate && !bucket.planScheduledDate) {
          bucket.planScheduledDate = sess.planScheduledDate;
        }
      }

      const movementsById = new Map<string, (typeof allMovements)[number]>();
      for (const m of allMovements) movementsById.set(m.id, m);
      const mainLiftMovementId = (lift: MainLift): string | undefined => {
        const mapped = settings?.mainLiftMovements?.[lift];
        if (mapped && movementsById.has(mapped)) return mapped;
        return allMovements.find((m) => m.isMainLift === lift)?.id;
      };

      const out: RecentWorkoutDay[] = [];
      for (const g of groups.values()) {
        const workoutComplete = g.sessions.some((s) => !!s.workoutCompletedAt);
        g.completed = workoutComplete;
        g.inProgress = !workoutComplete;

        // Logged sets across the day's sessions (already excludes deleted).
        g.setsLogged = g.sessions.reduce(
          (n, sess) => n + (setsBySession.get(sess.id) ?? 0),
          0,
        );

        // Movement counts: main lifts on the day + assistance entries on the day.
        // A movement is "logged" when at least one non-warmup set exists for it
        // across the day's sessions.
        if (g.block && g.week != null && g.dayIndex != null) {
          const plan = schedule
            ? effectivePlan(g.block, schedule)
            : effectivePlan(g.block, dayOrder, liftsPerDay);
          const planDay = plan.days[g.dayIndex];
          const mainLiftsForDay = planDay?.mainLifts ?? [];
          const assistanceEntries = planDay
            ? resolveDayAssistance(plan, g.week, planDay.id)
            : [];
          const totalMovements = mainLiftsForDay.length + assistanceEntries.length;

          // Union of movementIds with logged work across the day's sessions.
          const liftLogged = new Set<string>();
          const assistLogged = new Set<string>();
          for (const sess of g.sessions) {
            const lm = liftMovementsBySession.get(sess.id);
            if (lm) for (const id of lm) liftLogged.add(id);
            const am = assistMovementsBySession.get(sess.id);
            if (am) for (const id of am) assistLogged.add(id);
          }

          let loggedCount = 0;
          for (const lift of mainLiftsForDay) {
            const mid = mainLiftMovementId(lift);
            if (mid && liftLogged.has(mid)) loggedCount += 1;
          }
          for (const entry of assistanceEntries) {
            if (entry.movementId && assistLogged.has(entry.movementId)) {
              loggedCount += 1;
            }
          }

          g.movementsTotal = totalMovements;
          g.movementsLogged = Math.min(loggedCount, totalMovements);

          // Prescribed set total = sum across each main lift of (warmups + main +
          // supplemental) + sum of each assistance entry's prescribed sets. We
          // don't have a real Training Max here (and don't need one — only the
          // *count* of sets matters), so we feed the builders a dummy TM.
          const supplementalId = (g.block.supplementalTemplate ?? 'none') as SupplementalTemplateId;
          const supplementalSetsOverride = g.block.supplementalSetsOverride;
          const mainScheme = (g.block.mainScheme ?? 'classic-531') as MainScheme;
          const warmupCount =
            (settings?.warmupPercents?.length ?? 0) > 0 ? settings!.warmupPercents.length : 0;
          const roundingKg = settings?.roundingKg ?? 2.5;
          let prescribedSets = 0;
          for (const lift of mainLiftsForDay) {
            try {
              const main = buildMainSets({
                trainingMaxKg: 100,
                week: g.week,
                roundingKg,
                scheme: mainScheme,
                amrapMainIndices: planDay?.amrapMainSetIndices?.[lift],
                seventhWeekKind: g.block.seventhWeekKind,
              });
              const supp = buildSupplementalSets({
                templateId: supplementalId,
                trainingMaxKg: 100,
                week: g.week,
                roundingKg,
                setsOverride: supplementalSetsOverride,
              });
              prescribedSets += warmupCount + main.length + supp.length;
            } catch {
              // Ignore bad config — partial total is still informative.
            }
          }
          for (const entry of assistanceEntries) {
            prescribedSets += entry.sets ?? 0;
          }
          g.setsTotal = prescribedSets;
        } else {
          // Fallback for sessions without enough metadata to resolve a plan.
          g.movementsTotal = g.sessions.length;
          g.movementsLogged = g.sessions.filter((s) => (setsBySession.get(s.id) ?? 0) > 0).length;
          g.setsTotal = 0;
        }

        out.push(g);
      }

      out.sort((a, b) => (a.latestPerformedAt < b.latestPerformedAt ? 1 : -1));
      return out.slice(0, limit);
    },
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

export function usePrograms() {
  return useLiveQuery(
    () => getDb().programs.orderBy('createdAt').reverse().toArray(),
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

/**
 * Returns the most recent unresolved pain flag for a movement (within the last 90 days).
 * Used to show a caution badge on the movement going forward.
 */
export function useRecentPainFlag(movementId: string | undefined) {
  return useLiveQuery(async () => {
    if (!movementId) return undefined;
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const flagged = await getDb()
      .sets.where('movementId')
      .equals(movementId)
      .filter((s) => !!s.painFlag && !s.deletedAt && s.performedAt >= since)
      .toArray();
    if (flagged.length === 0) return undefined;
    flagged.sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1));
    return flagged[0]!.painFlag;
  }, [movementId]);
}

export function useAllSets() {
  return useLiveQuery(() => getDb().sets.toArray(), []);
}

export function useAllSessions() {
  return useLiveQuery(() => getDb().sessions.toArray(), []);
}

export function useAllTrainingMaxesList() {
  return useLiveQuery(
    () => getDb().trainingMaxes.toArray(),
    [],
  );
}

// v0.6.0 — cross-domain hooks

export function useGoals() {
  return useLiveQuery(
    async () => {
      const all = await getDb().goals.toArray();
      return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    [],
  );
}

/**
 * Returns active goals (not completed) summarized through the shared
 * `summarizeGoal` domain helper. Surfaces hard goals with progress, and
 * qualitative goals as reminders (with optional 8-week strength trend
 * if `signal === 'strength-trend'`).
 *
 * Used by ActiveGoalsCard on Today and the Goals card on Analytics.
 */
export function useActiveGoalSummaries(limit = 4) {
  const goals = useGoals();
  const allSets = useAllSets();
  const allSessions = useAllSessions();
  const movements = useMovements();
  const tms = useAllTrainingMaxes();
  const settings = useSettings();

  if (!goals) return undefined;

  const active = goals.filter((g) => !g.completedAt).slice(0, limit);
  if (active.length === 0) return [];

  const sets = allSets ?? [];
  const sessions = allSessions ?? [];
  const liftByMovementId = new Map<string, MainLift>();
  for (const m of movements ?? []) {
    if (m.isMainLift) liftByMovementId.set(m.id, m.isMainLift as MainLift);
  }
  // Settings-mapped main lifts win over seeded defaults so a user who
  // remapped Squat → Front Squat in /program/setup gets their goals (and
  // e1RM samples) resolved against Front Squat sets, not Low Bar Squat.
  for (const [lift, mvId] of Object.entries(settings?.mainLiftMovements ?? {})) {
    if (mvId) liftByMovementId.set(mvId, lift as MainLift);
  }

  // e1RM samples on main lifts only (best per lift per day).
  const bestByKey = new Map<string, { performedAt: string; lift: string; e1rmKg: number }>();
  for (const s of sets) {
    const lift = liftByMovementId.get(s.movementId);
    if (!lift || s.skipped || s.deletedAt || s.weightKg <= 0 || s.reps <= 0) continue;
    if (s.kind === 'warmup') continue;
    const day = s.performedAt.slice(0, 10);
    const key = `${lift}:${day}`;
    const e1rm = s.weightKg * (1 + Math.min(s.reps, 12) / 30);
    const cur = bestByKey.get(key);
    if (!cur || e1rm > cur.e1rmKg) {
      bestByKey.set(key, { performedAt: s.performedAt, lift, e1rmKg: e1rm });
    }
  }
  const samples = [...bestByKey.values()];

  const latestE1rmByLift = new Map<string, number>();
  for (const s of samples) {
    const cur = latestE1rmByLift.get(s.lift);
    if (cur === undefined || s.e1rmKg > cur) latestE1rmByLift.set(s.lift, s.e1rmKg);
  }
  if (tms) {
    for (const [lift, tm] of tms.entries()) {
      if (!latestE1rmByLift.has(lift)) {
        latestE1rmByLift.set(lift, tm.trainingMaxKg / 0.9);
      }
    }
  }

  const sessionsSinceCreated = new Map<string, number>();
  for (const g of active) {
    if (g.kind !== 'habit') continue;
    const since = new Date(g.createdAt).getTime();
    const count = sessions.filter(
      (s) => !!s.workoutCompletedAt && new Date(s.workoutCompletedAt).getTime() >= since,
    ).length;
    sessionsSinceCreated.set(g.id, count);
  }

  // Resolve each strength-pr goal's movementId → MainLift key so the
  // summarizer compares against the right e1RM, not the highest one.
  const liftByGoalId = new Map<string, string>();
  for (const g of active) {
    if (g.kind !== 'strength-pr' || !g.movementId) continue;
    const lift = liftByMovementId.get(g.movementId);
    if (lift) liftByGoalId.set(g.id, lift);
  }

  return active.map((g) =>
    summarizeGoal(g, {
      latestE1rmByLift,
      e1rmSamples: samples,
      sessionsSinceCreated,
      liftByGoalId,
    }),
  );
}

export function useCardioRecent(limit = 50) {
  return useLiveQuery(
    () => getDb().cardio.orderBy('performedAt').reverse().limit(limit).toArray(),
    [limit],
  );
}

export function useAllCardio() {
  return useLiveQuery(() => getDb().cardio.toArray(), []);
}

export function useAllStrengthHr() {
  return useLiveQuery(() => getDb().strengthHr.toArray(), []);
}

/** All notifications, newest first. */
export function useNotifications() {
  return useLiveQuery(
    () => getDb().notifications.orderBy('createdAt').reverse().toArray(),
    [],
  );
}

/** All AI generation log rows, newest first. */
export function useAiGenerations() {
  return useLiveQuery(
    () => getDb().aiGenerations.orderBy('createdAt').reverse().toArray(),
    [],
  );
}

/**
 * Live-query the RecoveryEntry for a given date (defaults to today, in
 * local timezone). Returns undefined while loading; `null` is never used.
 */
export function useRecoveryEntry(date?: string) {
  return useLiveQuery(() => {
    const d = date ?? localYmd();
    return getDb().recovery.get(d);
  }, [date]);
}

function localYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Live-query unread notification count. Returns 0 while the query is loading
 * so the badge doesn't flash. Capped at 99+ in the UI; here we return the
 * raw number.
 */
export function useUnreadNotificationCount(): number {
  const all = useLiveQuery(() => getDb().notifications.toArray(), []);
  if (!all) return 0;
  return all.reduce((acc, n) => (n.readAt ? acc : acc + 1), 0);
}

export function useRunPlan() {
  return useLiveQuery(() => getDb().runPlan.get('singleton'), []);
}

/** All races in the calendar, newest-soonest first. */
export function useRaces() {
  return useLiveQuery(async () => {
    const all = await getDb().races.toArray();
    return all.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, []);
}

/** Upcoming races (date today or in the future, not completed). */
export function useUpcomingRaces() {
  return useLiveQuery(async () => {
    const all = await getDb().races.toArray();
    const cutoff = Date.now() - 86400000; // include race day itself
    return all
      .filter((r) => !r.completedAt && new Date(r.date).getTime() >= cutoff)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }, []);
}

/** Past or completed races, most recent first. */
export function usePastRaces() {
  return useLiveQuery(async () => {
    const all = await getDb().races.toArray();
    const cutoff = Date.now() - 86400000;
    return all
      .filter((r) => r.completedAt || new Date(r.date).getTime() < cutoff)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }, []);
}

export function useRecoveryRecent(days = 30) {
  return useLiveQuery(async () => {
    const all = await getDb().recovery.toArray();
    return all.sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, days);
  }, [days]);
}

export function useRecoveryFor(date: string) {
  return useLiveQuery(() => getDb().recovery.get(date), [date]);
}

export function useAllRecovery() {
  return useLiveQuery(() => getDb().recovery.toArray(), []);
}

export function usePushSubscription() {
  return useLiveQuery(() => getDb().pushSub.get('pushSub'), []);
}

/**
 * Returns the user's projected upcoming workouts for the active block,
 * starting from today. Days with no resolvable weekday are dropped.
 *
 * Returns an empty array when no block is active.
 */
export function useUpcomingWorkouts(
  options: { horizonDays?: number; maxItems?: number } = {},
): UpcomingWorkout[] {
  const horizonDays = options.horizonDays ?? 90;
  const maxItems = options.maxItems ?? 48;
  const result = useLiveQuery(async () => {
    const db = getDb();
    const sched = await db.schedule.get('singleton');
    if (!sched?.activeBlockId) return [];
    const activeBlock = await db.blocks.get(sched.activeBlockId);
    if (!activeBlock) return [];

    // Chain through subsequent blocks in the same program (after active),
    // ordered by sequenceIndex, so the calendar reaches beyond the current
    // block's end-of-cycle.
    let subsequentBlocks: typeof activeBlock[] = [];
    if (activeBlock.programId) {
      const programBlocks = await db.blocks
        .where('programId')
        .equals(activeBlock.programId)
        .toArray();
      const activeSeq = activeBlock.sequenceIndex ?? 0;
      subsequentBlocks = programBlocks
        .filter((b) => b.id !== activeBlock.id && (b.sequenceIndex ?? 0) > activeSeq && !b.completedAt)
        .sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
    }

    // Infer weekday per groupIndex from the user's past completed sessions
    // in this program (or all sessions if no programId). Picks the most
    // common weekday for each dayIndex. Falls back gracefully when a plan
    // day has no explicit weekday and no parseable label.
    const weekdayByGroupIndex = new Map<number, number>();
    const blockIds = new Set<string>([
      activeBlock.id,
      ...subsequentBlocks.map((b) => b.id),
    ]);
    const sessions = await db.sessions
      .where('blockId')
      .anyOf([...blockIds])
      .toArray();
    const counts = new Map<number, Map<number, number>>();
    for (const s of sessions) {
      if (typeof s.dayIndex !== 'number' || !s.performedAt) continue;
      const d = new Date(s.performedAt);
      if (Number.isNaN(d.getTime())) continue;
      const wd = (d.getDay() + 6) % 7; // ISO Mon=0..Sun=6
      const inner = counts.get(s.dayIndex) ?? new Map<number, number>();
      inner.set(wd, (inner.get(wd) ?? 0) + 1);
      counts.set(s.dayIndex, inner);
    }
    for (const [groupIndex, inner] of counts) {
      let bestWd = -1;
      let bestN = -1;
      for (const [wd, n] of inner) {
        if (n > bestN) {
          bestN = n;
          bestWd = wd;
        }
      }
      if (bestWd >= 0) weekdayByGroupIndex.set(groupIndex, bestWd);
    }

    // Self-heal a stale schedule cursor: if the cursor points at a (block,
    // week, group) but the user has zero completed sessions for that block,
    // synthesize a start-of-block cursor for projection. Persistence happens
    // separately in useScheduleCursorSelfHeal so we don't write inside a
    // useLiveQuery callback (which crashes the page).
    const sessionsForActive = sessions.filter((s) => s.blockId === activeBlock.id);
    let scheduleForProjection = sched;
    if (
      sessionsForActive.length === 0 &&
      sched.cursor &&
      sched.cursor.blockId === activeBlock.id &&
      (sched.cursor.week !== initialCursorWeek(activeBlock) ||
        sched.cursor.groupIndex !== 0)
    ) {
      scheduleForProjection = {
        ...sched,
        cursor: {
          blockId: activeBlock.id,
          week: initialCursorWeek(activeBlock),
          groupIndex: 0,
        },
      };
    }

    // Build the fulfilled-keys set from sessions where the user pinned a
    // logged workout-day to a different planned date. One key per
    // (blockId, week, dayIndex, planScheduledDate) so the projector
    // suppresses the matching planned slot.
    const fulfilledKeys = new Set<string>();
    for (const s of sessions) {
      if (
        s.planScheduledDate &&
        s.blockId &&
        s.week != null &&
        typeof s.dayIndex === 'number'
      ) {
        fulfilledKeys.add(`${s.blockId}|${s.week}|${s.dayIndex}|${s.planScheduledDate}`);
      }
    }

    return projectUpcomingWorkouts(activeBlock, scheduleForProjection, new Date(), {
      horizonDays,
      maxItems,
      subsequentBlocks,
      weekdayByGroupIndex,
      fulfilledKeys,
    });
  }, [horizonDays, maxItems]);
  return result ?? [];
}

/**
 * Detects and rewinds a stale schedule cursor for the active block. The
 * cursor advances on session save (advanceScheduleIfMatches), so deleting
 * an in-progress workout used to leave the cursor pointing past the now-
 * empty day - which made the hero card and Up Next surfaces show the wrong
 * "next workout". This hook watches for that condition (active block has
 * no sessions but cursor isn't at the start) and rewinds the persisted
 * cursor so every consumer sees the corrected state.
 *
 * Safe to mount once at the root layout; idempotent.
 */
export function useScheduleCursorSelfHeal(): void {
  const sched = useLiveQuery(() => getDb().schedule.get('singleton'));
  const activeBlock = useLiveQuery(async () => {
    if (!sched?.activeBlockId) return null;
    return (await getDb().blocks.get(sched.activeBlockId)) ?? null;
  }, [sched?.activeBlockId]);
  const sessionCount = useLiveQuery(async () => {
    if (!sched?.activeBlockId) return 0;
    return getDb().sessions.where('blockId').equals(sched.activeBlockId).count();
  }, [sched?.activeBlockId]);

  useEffect(() => {
    if (!sched || !activeBlock || sessionCount == null) return;
    if (sessionCount > 0) return;
    if (!sched.cursor || sched.cursor.blockId !== activeBlock.id) return;
    const startWeek = initialCursorWeek(activeBlock);
    if (sched.cursor.week === startWeek && sched.cursor.groupIndex === 0) return;
    void getDb().schedule.put({
      ...sched,
      cursor: { blockId: activeBlock.id, week: startWeek, groupIndex: 0 },
      updatedAt: new Date().toISOString(),
    });
  }, [sched, activeBlock, sessionCount]);
}
