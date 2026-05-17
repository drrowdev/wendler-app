'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { fmtDate } from '@/lib/format';
import {
  useActiveBlock,
  useAllStrengthHr,
  useAllTrainingMaxes,
  useBlocks,
  useCardioRecent,
  useRecentWorkoutDays,
  useSchedule,
} from '@/lib/hooks';
import { TaperBanner } from '@/components/TaperBanner';
import { ActiveLimitationsBanner } from '@/components/injury/ActiveLimitationsBanner';
import { NextUpCard } from '@/components/NextUpCard';
import { ThisWeekCard } from '@/components/ThisWeekCard';
import { TrainingMaxesCard } from '@/components/TrainingMaxesCard';
import { RecentSessionsList } from '@/components/RecentSessionsList';
import { ActiveGoalsCard } from '@/components/ActiveGoalsCard';
import { FatigueSorenessCard } from '@/components/Readiness';

function blockWeeks(b: { weeksBeforeDeload: number }): number {
  return b.weeksBeforeDeload;
}

export default function Home() {
  const tms = useAllTrainingMaxes();
  const workoutDays = useRecentWorkoutDays(8);
  const recentCardio = useCardioRecent(10);
  const allStrengthHr = useAllStrengthHr();
  const block = useActiveBlock();
  const schedule = useSchedule();
  const blocks = useBlocks();
  const hasTms = tms && tms.size > 0;
  const recentImportedStrength = useMemo(
    () =>
      [...(allStrengthHr ?? [])]
        .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))
        .slice(0, 10),
    [allStrengthHr],
  );

  // Cycle context: position of the active block within its program (used for
  // the "Week X of Y · Block name · N weeks total" headline). The right-side
  // global progress widget was removed since this header already conveys
  // where you are in the cycle.
  const cycle = useMemo(() => {
    if (!block || !blocks || !schedule?.cursor) return null;
    const siblings = (blocks ?? [])
      .filter((b) => b.programId && b.programId === block.programId)
      .slice()
      .sort(
        (a, b2) =>
          (a.sequenceIndex ?? 0) - (b2.sequenceIndex ?? 0) ||
          a.createdAt.localeCompare(b2.createdAt),
      );
    const totalWeeks = siblings.reduce((acc, b2) => acc + blockWeeks(b2), 0);
    const cursorWeek =
      schedule.cursor.week === 'deload' || schedule.cursor.week === '7w'
        ? blockWeeks(block)
        : schedule.cursor.week;
    return {
      totalWeeks,
      currentWeekInBlock: cursorWeek,
      blockTotalWeeks: blockWeeks(block),
    };
  }, [block, blocks, schedule]);

  const ongoing = workoutDays?.find((d) => d.inProgress);
  const completedDays = workoutDays?.filter((d) => !d.inProgress) ?? [];
  // Visible recent list: keep ongoing first (so it stays prominent), then
  // recently completed workouts.
  const visibleDays = ongoing ? [ongoing, ...completedDays] : completedDays;

  return (
    <div className="space-y-6">
      <header>
        <p className="font-mono text-xs text-muted">{fmtDate(new Date().toISOString())}</p>
        <h1 className="mt-0.5 text-3xl font-bold tracking-tight">Today</h1>
        {cycle && block && (
          <p className="mt-1 text-sm text-muted">
            {cycle.blockTotalWeeks > 1 && (
              <>
                Week {cycle.currentWeekInBlock} of {cycle.blockTotalWeeks}
                <span className="px-1.5 text-muted/60">·</span>
              </>
            )}
            <Link
              href={`/program/block?id=${block.id}`}
              className="text-fg hover:underline"
            >
              {block.name}
            </Link>
            {cycle.totalWeeks > 0 && (
              <>
                <span className="px-1.5 text-muted/60">·</span>
                {cycle.totalWeeks} weeks total
              </>
            )}
          </p>
        )}
      </header>

      <TaperBanner />
      <ActiveLimitationsBanner />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-6">
          {hasTms ? (
            <NextUpCard />
          ) : (
            <div className="rounded-2xl border border-border bg-card p-6 text-center">
              <h2 className="text-lg font-semibold">Welcome.</h2>
              <p className="mt-2 text-sm text-muted">
                Set your Training Max for the four main lifts to start logging sessions.
              </p>
              <Link
                href="/program/setup"
                className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 font-semibold text-bg"
              >
                Set up
              </Link>
            </div>
          )}

          {hasTms && <FatigueSorenessCard />}

          {/* Goals card moved to the right rail under Training Maxes */}
          {(visibleDays.length > 0 ||
            (recentCardio?.length ?? 0) > 0 ||
            recentImportedStrength.length > 0) && (
            <section className="space-y-3">
              <header className="flex items-baseline justify-between">
                <h2 className="text-lg font-semibold">Recent activity</h2>
                <Link href="/calendar" className="text-xs font-medium text-accent hover:underline">
                  See all
                </Link>
              </header>
              <RecentSessionsList
                days={visibleDays}
                cardio={recentCardio ?? []}
                importedStrength={recentImportedStrength}
              />
            </section>
          )}
        </div>

        {hasTms ? (
          <aside className="space-y-3">
            <ThisWeekCard />
            <TrainingMaxesCard />
            <ActiveGoalsCard />
          </aside>
        ) : (
          <aside className="space-y-3">
            <ActiveGoalsCard />
          </aside>
        )}
      </div>
    </div>
  );
}
