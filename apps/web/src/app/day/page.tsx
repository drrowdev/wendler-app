'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { nanoid } from 'nanoid';
import {
  SEVENTH_WEEK_VARIANTS,
  buildMainSets,
  buildSupplementalSets,
  buildWarmupSets,
  effectivePlan,
  groupDays,
  resolveAssistance,
  resolveDayAssistance,
  type AssistanceEntry,
  type PrescribedSet,
  type ProgramBlock,
  type SupplementalTemplateId,
  type MainScheme,
  type WendlerWeek,
} from '@wendler/domain';
import type { MainLift, ProgramSchedule, SetRecord } from '@wendler/db-schema';
import { fmtKg, liftLabel } from '@/lib/format';
import { completeDayWorkout } from '@/lib/completeDayWorkout';
import { useDaySessionRow } from '@/lib/useDaySessionRow';
import {
  useAllSessions,
  useBlock,
  useCurrentTrainingMax,
  useMainLiftMovement,
  useRecentPainFlag,
  useSchedule,
  useSetsForMovement,
  useSetsForSession,
  useSettings,
} from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { deleteWithTombstones } from '@/lib/delete';
import { ensureNotificationPermission, RestTimer } from '@/components/RestTimer';
import { StrengthLinkSlotPicker } from '@/components/StrengthLinkSlotPicker';
import {
  LiftFocusView,
} from '@/components/LiftFocusView';
import { findExisting } from '@/components/SessionParts';
import { AssistanceTrack } from '@/components/AssistanceTrack';
import { PreLiftingWarmup } from '@/components/PreLiftingWarmup';
import { AmrapAnalysis } from '@/components/AmrapAnalysis';
import { PainFlagModal, type PainFlagValue } from '@/components/PainFlagModal';
import { WellnessSheet } from '@/components/WellnessSheet';
import { InjurySheet } from '@/components/injury/InjurySheet';
import { WelcomeBackCard } from '@/components/WelcomeBackCard';
import { DeloadAssistanceCard } from '@/components/DeloadAssistanceCard';
import { VolumeRecommendationBanner } from '@/components/VolumeRecommendationBanner';
import {
  useActiveWellnessFlag,
  useReturnPlan,
  markRecovered,
} from '@/lib/wellness';
import { useDeloadScalingPrompt } from '@/lib/deload';
import { useMovements } from '@/lib/hooks';
import { PreWorkoutCheckIn } from '@/components/PreWorkoutCheckIn';
import { ActiveLimitationsBanner } from '@/components/injury/ActiveLimitationsBanner';

export default function DayPageWrapper() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <DayPage />
    </Suspense>
  );
}

function fmtPlannedDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const wd = date.toLocaleDateString('fi-FI', { weekday: 'short' });
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

interface RestState {
  seconds: number;
  label: string;
  startId: number;
}

function DayPage() {
  const router = useRouter();
  const params = useSearchParams();
  const blockId = params.get('blockId') ?? '';
  const weekRaw = params.get('week');
  const dayIdx = Number(params.get('day') ?? '0');
  const week: WendlerWeek | null =
    weekRaw === 'deload'
      ? 'deload'
      : weekRaw === '7w'
        ? '7w'
        : weekRaw === '1' || weekRaw === '2' || weekRaw === '3'
          ? (Number(weekRaw) as 1 | 2 | 3)
          : null;

  const block = useBlock(blockId || undefined);
  const schedule = useSchedule();
  const settings = useSettings();
  const allSessionsForDay = useAllSessions();
  const movements = useMovements();
  const activeIllness = useActiveWellnessFlag();
  const returnPlan = useReturnPlan({
    block,
    week,
    cycleNumber: 1,
    movements,
  });
  const deloadPrompt = useDeloadScalingPrompt(block, week);
  const [showWellnessSheet, setShowWellnessSheet] = useState(false);

  // True when the user has already clicked "Complete workout" for this day.
  const workoutCompleted = useMemo(() => {
    if (!allSessionsForDay || !blockId || week == null) return false;
    return allSessionsForDay.some(
      (s) =>
        s.blockId === blockId &&
        s.week === week &&
        s.dayIndex === dayIdx &&
        !!s.workoutCompletedAt,
    );
  }, [allSessionsForDay, blockId, week, dayIdx]);

  // Read-only state for the entire day page. Two triggers:
  //   1. The parent block is marked complete (was already supported).
  //   2. This specific day-group has been marked complete by the user
  //      (workoutCompletedAt stamped). Without this, completed historic
  //      sessions remained editable — set logs, RPE, notes — which is
  //      the exact "history mutates" anti-pattern the v282 snapshot was
  //      designed to prevent. Unmarking the workout (delete the day
  //      and re-log, or re-tap Complete) is the explicit escape hatch.
  const locked = !!block?.completedAt || workoutCompleted;

  // Sessions belonging to this exact day (any lift). Used both for completing
  // and for deleting all logged data for the day.
  const daySessions = useMemo(() => {
    if (!allSessionsForDay || !blockId || week == null) return [];
    return allSessionsForDay.filter(
      (s) => s.blockId === blockId && s.week === week && s.dayIndex === dayIdx,
    );
  }, [allSessionsForDay, blockId, week, dayIdx]);

  const hasAnyDayData = daySessions.length > 0;
  const [showLinkPicker, setShowLinkPicker] = useState(false);

  // Date the workout was actually performed (latest performedAt across
  // its session rows), and the planScheduledDate currently stamped on
  // any of those rows. Both are surfaced in the planned-date chip.
  const dayPerformedYmd = useMemo(() => {
    if (daySessions.length === 0) return undefined;
    const latest = daySessions.reduce<string | undefined>(
      (acc, s) => (acc && acc > s.performedAt ? acc : s.performedAt),
      undefined,
    );
    if (!latest) return undefined;
    const d = new Date(latest);
    if (Number.isNaN(d.getTime())) return undefined;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, [daySessions]);

  const dayPlannedDate = useMemo(
    () => daySessions.find((s) => !!s.planScheduledDate)?.planScheduledDate,
    [daySessions],
  );

  const deleteWorkout = async () => {
    if (!hasAnyDayData) return;
    if (
      !confirm(
        'Delete this workout and all logged sets for the day? This cannot be undone.',
      )
    ) {
      return;
    }
    const sessionIds = daySessions.map((s) => s.id);
    const setRows = await getDb()
      .sets.where('sessionId')
      .anyOf(sessionIds)
      .toArray();
    const setIds = setRows.map((s) => s.id);
    if (setIds.length > 0) {
      await deleteWithTombstones('set', setIds);
    }
    await deleteWithTombstones('session', sessionIds);

    // Rewind the schedule cursor to point back at this day so the calendar
    // and Up Next surfaces show it as the next planned workout again. The
    // cursor advances on session save, so without this the deleted day stays
    // "behind" the cursor and disappears from upcoming projections.
    if (blockId && week != null && typeof dayIdx === 'number') {
      const db = getDb();
      const schedule = await db.schedule.get('singleton');
      if (schedule) {
        const needsRewind =
          !schedule.cursor ||
          schedule.cursor.blockId !== blockId ||
          schedule.cursor.week !== week ||
          schedule.cursor.groupIndex !== dayIdx;
        if (needsRewind) {
          await db.schedule.put({
            ...schedule,
            cursor: { blockId, week, groupIndex: dayIdx },
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    router.push('/');
  };

  const completeWorkout = async () => {
    if (!blockId || week == null) {
      router.push('/');
      return;
    }
    await completeDayWorkout({ blockId, week, dayIdx });
    router.push('/');
  };

  const [rest, setRest] = useState<RestState | null>(null);

  const dayOrder = schedule?.dayOrder ?? (['press', 'deadlift', 'bench', 'squat'] as MainLift[]);
  const liftsPerDay = schedule?.liftsPerDay ?? 1;
  const plan = block ? (schedule ? effectivePlan(block, schedule) : effectivePlan(block, dayOrder, liftsPerDay)) : null;
  const planDay = plan?.days[dayIdx];
  // Prefer the per-block plan (lets a day own any combination of main lifts,
  // independent of the global schedule). Fall back to the legacy grouping for
  // unmigrated blocks where plan derivation produced no day at this index.
  const lifts: MainLift[] = planDay
    ? planDay.mainLifts
    : (groupDays(dayOrder, liftsPerDay)[dayIdx] ?? []);

  const onSetLogged = (kind: PrescribedSet['kind']) => {
    if (!settings?.autoStartRestTimer) return;
    const seconds = settings.restSecondsByKind?.[kind] ?? (kind === 'main' ? 180 : 90);
    setRest((r) => ({
      seconds,
      label: `Rest · ${kind}`,
      startId: (r?.startId ?? 0) + 1,
    }));
  };

  useEffect(() => {
    void ensureNotificationPermission();
  }, []);

  if (!week) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Day</h1>
        <p className="text-sm text-muted">Missing week. Open this day from the block plan.</p>
        {blockId && (
          <Link href={`/program/block?id=${blockId}`} className="text-sm text-accent underline">
            Back to block
          </Link>
        )}
      </div>
    );
  }

  if (!block) {
    return <p className="text-muted">Loading block…</p>;
  }

  const supplementalId: SupplementalTemplateId = block.supplementalTemplate ?? 'none';
  const isSeventhWeek = block.kind === 'seventh-week';
  const seventhWeekVariant = isSeventhWeek && block.seventhWeekKind
    ? SEVENTH_WEEK_VARIANTS[block.seventhWeekKind]
    : undefined;
  const weekLabel = seventhWeekVariant
    ? seventhWeekVariant.title
    : week === 'deload'
      ? 'Deload'
      : week === '7w'
        ? '7th Week'
        : `Week ${week}`;

  // Day header: prefer accessory-day label when no main lifts; otherwise the
  // generic "Day N" with lift count. Same layout in both cases.
  const isAccessoryDay = lifts.length === 0;
  const accessoryLabel = (planDay?.label?.trim()) || `Day ${dayIdx + 1} · Accessory`;

  return (
    <div className="space-y-6">
      <PreWorkoutCheckIn />
      <ActiveLimitationsBanner />
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {isAccessoryDay ? accessoryLabel : `Day ${dayIdx + 1}`}{' '}
            <span className="text-muted">·</span>{' '}
            <span className="text-muted">{weekLabel}</span>
          </h1>
          <p className="text-sm text-muted">
            {block.name}
            {' · '}
            {isAccessoryDay
              ? 'accessory day'
              : `${lifts.length} ${lifts.length === 1 ? 'lift' : 'lifts'}`}
          </p>
        </div>
      </header>

      {locked && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {block?.completedAt ? (
            <>
              🔒 This block is marked complete. Open the{' '}
              <Link href={`/program/block?id=${blockId}`} className="underline">
                block page
              </Link>
              {' '}and unmark complete to make changes.
            </>
          ) : (
            <>
              🔒 This workout is marked complete. Sets, RPE, and notes are read-only
              to preserve the historical record. If you need to fix a mistake,
              delete the day and re-log it from the{' '}
              <Link href="/" className="underline">
                home page
              </Link>
              .
            </>
          )}
        </div>
      )}

      {!locked && <VolumeRecommendationBanner block={block} />}

      {hasAnyDayData && blockId && week != null && dayPerformedYmd && (
        <div className="-mt-2">
          <button
            type="button"
            onClick={() => setShowLinkPicker(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg/40 px-2.5 py-1 text-xs text-muted hover:text-fg"
          >
            <span aria-hidden>📅</span>
            <span>
              {(() => {
                // Render the actual performed date (or "today" only if it
                // really IS today). Historic sessions used to render
                // "Logged for today" which was misleading when opened from
                // the recent-sessions list days later.
                const todayD = new Date();
                const todayYmd = `${todayD.getFullYear()}-${String(todayD.getMonth() + 1).padStart(2, '0')}-${String(todayD.getDate()).padStart(2, '0')}`;
                const isToday = dayPerformedYmd === todayYmd;
                const performedLabel = isToday
                  ? 'today'
                  : fmtPlannedDate(dayPerformedYmd);
                if (dayPlannedDate && dayPlannedDate !== dayPerformedYmd) {
                  return (
                    <>
                      Planned for{' '}
                      <span className="font-medium text-fg">
                        {fmtPlannedDate(dayPlannedDate)}
                      </span>
                      {' '}— change…
                    </>
                  );
                }
                return (
                  <>
                    Logged{' '}
                    <span className={isToday ? '' : 'font-medium text-fg'}>
                      {isToday ? 'for today' : `on ${performedLabel}`}
                    </span>
                    {' '}— link to a different planned date…
                  </>
                );
              })()}
            </span>
          </button>
        </div>
      )}

      {showLinkPicker && blockId && week != null && dayPerformedYmd && (
        <StrengthLinkSlotPicker
          workout={{ blockId, week, dayIndex: dayIdx }}
          currentPlannedDate={dayPlannedDate}
          performedYmd={dayPerformedYmd}
          onClose={() => setShowLinkPicker(false)}
        />
      )}

      {activeIllness && (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-500/5 p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="mr-1">🤒</span>
              <span className="font-semibold">Resting</span>
              <span className="text-muted">
                {' · '}
                {activeIllness.severity} since {activeIllness.startedAt}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowWellnessSheet(true)}
                className="rounded bg-bg px-2 py-1 text-xs ring-1 ring-border"
              >
                Edit
              </button>
              <button
                onClick={() => void markRecovered(activeIllness.id)}
                className="rounded bg-accent px-2 py-1 text-xs font-semibold text-bg"
              >
                Recovered today
              </button>
            </div>
          </div>
        </div>
      )}

      {returnPlan && (
        <WelcomeBackCard illness={returnPlan.illness} result={returnPlan.result} />
      )}

      {deloadPrompt && blockId && (
        <DeloadAssistanceCard blockId={blockId} result={deloadPrompt} />
      )}

      {!activeIllness && !returnPlan && (
        <div className="-mt-2">
          <button
            onClick={() => setShowWellnessSheet(true)}
            className="text-xs text-muted underline"
          >
            🤒 Feeling sick?
          </button>
        </div>
      )}

      {showWellnessSheet && (
        <WellnessSheet
          initial={activeIllness}
          onClose={() => setShowWellnessSheet(false)}
        />
      )}

      {seventhWeekVariant && (
        <div className="rounded-xl border border-accent/40 bg-accent/5 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-accent">
            {seventhWeekVariant.subtitle}
          </div>
          <div className="mt-1 font-mono text-[11px] text-fg/80">
            {seventhWeekVariant.wavePreview}
          </div>
          <p className="mt-2 text-sm leading-snug text-muted">
            {seventhWeekVariant.blurb}
          </p>
        </div>
      )}

      <PreLiftingWarmup
        blockId={blockId}
        week={week}
        dayGroupIndex={dayIdx}
        dayLifts={lifts}
        locked={locked}
      />

      {lifts.map((lift) => (
        <LiftTrack
          key={lift}
          lift={lift}
          week={week}
          blockId={blockId}
          supplementalId={supplementalId}
          supplementalSetsOverride={block.supplementalSetsOverride}
          mainScheme={block.mainScheme ?? 'classic-531'}
          seventhWeekKind={block.seventhWeekKind}
          amrapMainIndices={planDay?.amrapMainSetIndices?.[lift]}
          dayOrder={dayOrder}
          planDayIndex={dayIdx}
          defaultExpanded={false}
          onSetLogged={onSetLogged}
          locked={locked}
        />
      ))}

      <DayAssistanceSection
        block={block}
        week={week}
        dayGroupIndex={dayIdx}
        firstLift={lifts[0]}
        blockId={blockId}
        supplementalId={supplementalId}
        schedule={schedule}
        dayOrder={dayOrder}
        liftsPerDay={liftsPerDay}
        emptyHint={
          isAccessoryDay
            ? 'No assistance configured for this day yet. Edit the block to add exercises.'
            : undefined
        }
        onSetLogged={onSetLogged}
        locked={locked}
      />

      <DayNotesSection
        blockId={blockId}
        week={week}
        dayIdx={dayIdx}
        firstLift={lifts[0]}
        supplementalId={supplementalId}
        locked={locked}
      />
      {!locked && (
        <button
          onClick={completeWorkout}
          disabled={workoutCompleted}
          className={[
            'mt-6 w-full rounded-lg py-3 text-base font-semibold ring-1 transition-colors',
            workoutCompleted
              ? 'bg-emerald-600/20 text-emerald-200 ring-emerald-500/40'
              : 'bg-emerald-600 text-white ring-emerald-500 hover:bg-emerald-500',
          ].join(' ')}
        >
          {workoutCompleted ? '✓ Workout completed' : 'Complete workout'}
        </button>
      )}

      {hasAnyDayData && !locked && (
        <button
          onClick={deleteWorkout}
          className="mt-2 w-full rounded-lg py-2.5 text-sm font-semibold text-rose-300 ring-1 ring-rose-500/40 hover:bg-rose-500/10"
        >
          Delete workout & all logged data
        </button>
      )}

      {rest && (
        <RestTimer
          key={rest.startId}
          initialSeconds={rest.seconds}
          label={rest.label}
          onDismiss={() => setRest(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LiftTrack: one collapsible card per lift in the day, with its own session
// row (resumed if one already exists for this block+week+lift).

interface LiftTrackProps {
  lift: MainLift;
  week: WendlerWeek;
  blockId: string;
  supplementalId: SupplementalTemplateId;
  supplementalSetsOverride?: number;
  /** Main-set scheme for this block (e.g. 5s PRO suppresses AMRAPs). */
  mainScheme: MainScheme;
  /** When week === '7w', which variant. Selects the right wave. */
  seventhWeekKind?: ProgramBlock['seventhWeekKind'];
  /** Per-set AMRAP override: indices into the main-set array that are AMRAP. */
  amrapMainIndices?: number[];
  dayOrder: MainLift[];
  planDayIndex?: number;
  defaultExpanded: boolean;
  onSetLogged: (kind: PrescribedSet['kind']) => void;
  locked?: boolean;
}

function LiftTrack({
  lift,
  week,
  blockId,
  supplementalId,
  supplementalSetsOverride,
  mainScheme,
  seventhWeekKind,
  amrapMainIndices,
  dayOrder,
  planDayIndex,
  defaultExpanded,
  onSetLogged,
  locked = false,
}: LiftTrackProps) {
  const settings = useSettings();
  const tm = useCurrentTrainingMax(lift);
  const movement = useMainLiftMovement(lift);
  const movementHistory = useSetsForMovement(movement?.id ?? '');
  const painFlag = useRecentPainFlag(movement?.id);
  const [showPainFlag, setShowPainFlag] = useState(false);
  const [escalateInjury, setEscalateInjury] = useState<
    { area: string; severity: 1 | 2 | 3 | 4 | 5; description: string; movementId?: string } | undefined
  >();

  const resolvedDayIndex = planDayIndex ?? Math.max(0, dayOrder.indexOf(lift));

  // Single source of truth for this lift's session row: shared helper used
  // across all workout types. Adopts an existing row when found (e.g. one
  // PreLiftingWarmup created), merges on materialise so flags survive.
  const { sessionId, existingSession, ensureSessionRow } = useDaySessionRow({
    blockId,
    week,
    dayIdx: resolvedDayIndex,
    lift,
    supplementalTemplateId: supplementalId,
  });

  const loggedSets = useSetsForSession(sessionId ?? undefined);

  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // UI-only collapse state for the per-lift "Mark complete" button. The
  // workout-level workoutCompletedAt flag (set by the bottom Complete
  // workout button) is the only persisted completion signal; this just
  // toggles the recap view locally for the user's convenience.
  const [localCollapsed, setLocalCollapsed] = useState(false);

  // Reset edit cursor whenever the section collapses, so re-opening a completed
  // lift always shows the recap first.
  useEffect(() => {
    if (!expanded) setEditingIndex(null);
  }, [expanded]);

  // Self-heal: an existing session created before we passed planDayIndex in
  // may have a stale dayIndex (computed from dayOrder.indexOf), which puts
  // multi-lift days in the wrong Today bucket. Fix it on first sight.
  useEffect(() => {
    if (!existingSession) return;
    if (existingSession.dayIndex === resolvedDayIndex) return;
    void getDb().sessions.update(existingSession.id, { dayIndex: resolvedDayIndex });
  }, [existingSession, resolvedDayIndex]);

  const prescribed = useMemo<PrescribedSet[]>(() => {
    if (!settings || !tm) return [];
    const main = buildMainSets({
      trainingMaxKg: tm.trainingMaxKg,
      week,
      roundingKg: settings.roundingKg,
      scheme: mainScheme,
      amrapMainIndices,
      seventhWeekKind,
    });
    const topWeight = main[main.length - 1]?.weightKg ?? 0;
    const warmups = buildWarmupSets(topWeight, settings.roundingKg, {
      percents: settings.warmupPercents,
      reps: settings.warmupReps,
    });
    const supplemental = buildSupplementalSets({
      templateId: supplementalId,
      trainingMaxKg: tm.trainingMaxKg,
      week,
      roundingKg: settings.roundingKg,
      setsOverride: supplementalSetsOverride,
    });
    return [...warmups, ...main, ...supplemental];
  }, [settings, tm, week, mainScheme, amrapMainIndices, supplementalId, supplementalSetsOverride, seventhWeekKind]);

  const totalCount = prescribed.filter(
    (p) => p.kind === 'warmup' || p.kind === 'main' || p.kind === 'amrap' || p.kind === 'supplemental',
  ).length;
  // Count prescribed slots that have a logged record (slotIndex-aware), so
  // identical supplemental slots aren't collapsed into a single "done" count.
  const doneCount = prescribed.reduce((n, p, i) => {
    if (p.kind !== 'warmup' && p.kind !== 'main' && p.kind !== 'amrap' && p.kind !== 'supplemental') return n;
    return findExisting(loggedSets, prescribed, i) ? n + 1 : n;
  }, 0);
  const allDone = totalCount > 0 && doneCount >= totalCount;
  // The whole-workout completion flag (set by the bottom Complete workout
  // button) is the single source of truth for persistent completion. The
  // per-lift Mark-complete affordance is purely a local UI collapse.
  const isWorkoutCompleted = !!existingSession?.workoutCompletedAt;
  const isLocallyMarked = localCollapsed || isWorkoutCompleted;
  const inProgress = !isLocallyMarked && !allDone && doneCount > 0;
  const showRecap = (isLocallyMarked || allDone) && doneCount > 0;

  // Collapse this lift card into the recap view. UI-only — no DB write,
  // no schedule advance. Persistence happens only when the user marks
  // the whole workout complete at the bottom of /day.
  const finishLift = () => {
    setLocalCollapsed(true);
    setExpanded(false);
  };

  const unmarkLift = () => {
    setLocalCollapsed(false);
    setExpanded(true);
  };

  // Auto-collapse the moment every prescribed set is logged. Saves the user
  // from a redundant tap on Mark complete — the recap takes over on
  // re-expand. Gated by autoCollapsedRef so a transient allDone (delete
  // and re-log) doesn't keep auto-collapsing.
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (isLocallyMarked) {
      autoCollapsedRef.current = true;
      return;
    }
    if (allDone && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      finishLift();
    }
  }, [allDone, isLocallyMarked]);

  return (
    <section
      className={`rounded-2xl border ${
        isLocallyMarked || allDone ? 'border-emerald-700/60 bg-emerald-900/10' : 'border-border bg-card'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-bg/40"
      >
        <div className="flex items-baseline gap-3">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
              isLocallyMarked || allDone
                ? 'bg-emerald-600 text-white'
                : inProgress
                  ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-400/60'
                  : 'bg-bg text-muted ring-1 ring-border'
            }`}
            title={
              isLocallyMarked || allDone
                ? 'Completed'
                : inProgress
                  ? `In progress — ${doneCount}/${totalCount} sets logged`
                  : 'Not started'
            }
          >
            {isLocallyMarked || allDone
              ? '✓'
              : totalCount > 0
                ? `${doneCount}/${totalCount}`
                : '·'}
          </span>
          <div>
            <div className="text-lg font-bold tracking-tight">
              {movement?.name ?? liftLabel(lift)}
            </div>
            <div className="text-xs text-muted">
              {tm ? <>TM <span className="font-mono text-fg">{fmtKg(tm.trainingMaxKg)}</span></> : 'No TM set'}
              {totalCount > 0 && (
                <>
                  {' '}· <span className="font-mono">{doneCount}/{totalCount}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg text-muted ring-1 ring-border bg-bg"
          aria-hidden
        >
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/50 px-4 pb-4 pt-3">
          {painFlag && (
            <div className="mb-3 flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
              <span className="text-amber-300">
                ⚠ Caution: {painFlag.area} (severity {painFlag.severity}) flagged recently
              </span>
              <button
                onClick={() => setShowPainFlag(true)}
                className="rounded bg-card px-2 py-1 text-xs ring-1 ring-border"
              >
                Update
              </button>
            </div>
          )}
          {!painFlag && (
            <button
              onClick={() => setShowPainFlag(true)}
              className="mb-3 text-xs text-muted underline"
            >
              + Flag pain / injury
            </button>
          )}

          {!tm && (
            <p className="text-sm text-muted">
              No Training Max set for {liftLabel(lift)}.{' '}
              <Link href="/program/setup" className="text-accent underline">
                Set it up
              </Link>{' '}
              first.
            </p>
          )}

          {tm && settings && sessionId && (
            <>
              {showRecap && editingIndex === null ? (
                <LiftRecap
                  prescribed={prescribed}
                  loggedSets={loggedSets ?? []}
                  onEdit={(i) => setEditingIndex(i)}
                  locked={locked}
                />
              ) : (
                <LiftFocusView
                  prescribed={prescribed}
                  settings={settings}
                  sessionId={sessionId}
                  movementId={movement?.id ?? ''}
                  equipment={movement?.equipment}
                  tmAtTime={tm.trainingMaxKg}
                  history={movementHistory ?? []}
                  loggedSets={loggedSets}
                  onBeforeSave={ensureSessionRow}
                  initialIndex={editingIndex ?? undefined}
                  locked={locked}
                />
              )}

              {tm && (
                <AmrapAnalysis
                  lift={lift}
                  prescribed={prescribed}
                  logged={loggedSets ?? []}
                  currentTmKg={tm.trainingMaxKg}
                />
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                {showRecap && editingIndex !== null ? (
                  <button
                    type="button"
                    onClick={() => setEditingIndex(null)}
                    className="flex-1 rounded-lg border border-border bg-bg py-2 text-sm hover:border-accent"
                  >
                    ← Back to summary
                  </button>
                ) : isLocallyMarked ? (
                  <>
                    <div className="flex-1 rounded-lg border border-emerald-700/40 bg-emerald-900/10 py-2 text-center text-sm text-emerald-300">
                      ✓ Marked complete
                    </div>
                    {!locked && (
                      <button
                        type="button"
                        onClick={unmarkLift}
                        className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-muted hover:border-accent hover:text-fg"
                        title="Unmark this lift complete so you can keep editing"
                      >
                        Unmark
                      </button>
                    )}
                  </>
                ) : !locked ? (
                  <button
                    onClick={finishLift}
                    disabled={!doneCount}
                    className="flex-1 rounded-lg bg-accent py-2 text-sm font-semibold text-bg disabled:opacity-40"
                  >
                    Mark {liftLabel(lift)} complete
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      )}

      {showPainFlag && (
        <PainFlagModal
          initial={painFlag as PainFlagValue | undefined}
          onCancel={() => setShowPainFlag(false)}
          onSave={async (val) => {
            if (!sessionId || !movement?.id) {
              setShowPainFlag(false);
              return;
            }
            await ensureSessionRow();
            const recent = loggedSets
              ?.filter((s) => !s.deletedAt && s.movementId === movement.id)
              .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];
            if (recent) {
              await getDb().sets.put({ ...recent, painFlag: val });
            } else {
              await getDb().sets.add({
                id: nanoid(),
                sessionId,
                movementId: movement.id,
                performedAt: new Date().toISOString(),
                weightKg: 0,
                reps: 0,
                kind: 'main',
                skipped: true,
                skipReason: 'pain',
                painFlag: val,
              });
            }
            setShowPainFlag(false);
            if (val.escalate) {
              setEscalateInjury({
                area: val.area,
                severity: val.severity,
                description: val.note ?? '',
                movementId: movement.id,
              });
            }
          }}
          onClear={async () => {
            const flagged = loggedSets
              ?.filter((s) => !s.deletedAt && s.movementId === movement?.id && s.painFlag)
              .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];
            if (flagged) {
              await getDb().sets.put({ ...flagged, painFlag: undefined });
            }
            setShowPainFlag(false);
          }}
        />
      )}
      {escalateInjury && (
        <InjurySheet
          origin={escalateInjury}
          onSaved={() => setEscalateInjury(undefined)}
          onCancel={() => setEscalateInjury(undefined)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// DayAssistanceSection: assistance work for the day, logged against the FIRST
// lift's session. We resolve (or lazily create) that session id here so the
// user can log assistance even if they haven't started the main lift yet.

interface DayAssistanceSectionProps {
  block: ProgramBlock;
  week: WendlerWeek;
  dayGroupIndex: number;
  /**
   * The first main lift of the day (its session row stores this group's
   * assistance work). Omit on accessory days, in which case a session row
   * is created with no `mainLift` and looked up by (blockId, week, dayIndex).
   */
  firstLift?: MainLift;
  blockId: string;
  supplementalId: SupplementalTemplateId;
  schedule?: ProgramSchedule;
  dayOrder: MainLift[];
  liftsPerDay: number;
  /** Show an empty-state nudge when the day has no assistance configured. */
  emptyHint?: string;
  onSetLogged: (kind: PrescribedSet['kind']) => void;
  locked?: boolean;
}

function DayAssistanceSection({
  block,
  week,
  dayGroupIndex,
  firstLift,
  blockId,
  supplementalId,
  schedule,
  dayOrder,
  liftsPerDay,
  emptyHint,
  onSetLogged,
  locked = false,
}: DayAssistanceSectionProps) {
  // For multi-lift days assistance is anchored to the FIRST lift's session row;
  // on accessory / single-lift-with-no-firstLift days it lives on the
  // day-anchor row (no mainLift, keyed by dayGroupIndex). Same hook handles both.
  const dIndex = firstLift ? Math.max(0, dayOrder.indexOf(firstLift)) : dayGroupIndex;
  const { sessionId, ensureSessionRow } = useDaySessionRow({
    blockId,
    week,
    dayIdx: dIndex,
    lift: firstLift,
    supplementalTemplateId: supplementalId,
  });

  const loggedSets = useSetsForSession(sessionId ?? undefined);

  // Snapshot lookup. When the day was completed via `completeDayWorkout` in
  // v282+, ONE session row in the day-group carries `assistanceSnapshot` —
  // the prescription frozen at completion time. We prefer the snapshot over
  // the live plan so historical days don't change shape when the block
  // plan is later edited (new movements generated for Wk2 no longer
  // retroactively appear in Wk1's completed Day 1 view).
  const allSessions = useAllSessions();
  const snapshot = useMemo<AssistanceEntry[] | undefined>(() => {
    if (!allSessions) return undefined;
    for (const s of allSessions) {
      if (s.blockId !== blockId) continue;
      if (s.week !== week) continue;
      if (s.dayIndex !== dayGroupIndex) continue;
      if (s.assistanceSnapshot && s.assistanceSnapshot.length > 0) {
        return s.assistanceSnapshot;
      }
    }
    return undefined;
  }, [allSessions, blockId, week, dayGroupIndex]);

  const plan = schedule ? effectivePlan(block, schedule) : effectivePlan(block, dayOrder, liftsPerDay);
  const day = plan.days[dayGroupIndex];
  const liveEntries = day
    ? resolveDayAssistance(plan, week, day.id)
    : resolveAssistance(block, week, dayGroupIndex);
  const entries = snapshot ?? liveEntries;
  if (entries.length === 0) {
    if (!emptyHint) return null;
    return (
      <section className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-3 text-sm text-muted">
        {emptyHint}
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-card px-4 py-3">
      <AssistanceTrack
        entries={entries}
        sessionId={sessionId}
        loggedSets={loggedSets}
        onBeforeSave={ensureSessionRow}
        onLogged={() => onSetLogged('assistance')}
        locked={locked}
      />
    </section>
  );
}


// ---------------------------------------------------------------------------
// DayNotesSection: one notes blob per workout, hung off the same session row
// as DayAssistanceSection (firstLift's row, or the day-anchor row on accessory
// days). Materialises the row on first edit.

interface DayNotesSectionProps {
  blockId: string;
  week: WendlerWeek;
  dayIdx: number;
  firstLift?: MainLift;
  supplementalId: SupplementalTemplateId;
  locked?: boolean;
}

function DayNotesSection({
  blockId,
  week,
  dayIdx,
  firstLift,
  supplementalId,
  locked = false,
}: DayNotesSectionProps) {
  const { sessionId, existingSession, ensureSessionRow } = useDaySessionRow({
    blockId,
    week,
    dayIdx,
    lift: firstLift,
    supplementalTemplateId: supplementalId,
  });

  const [notes, setNotes] = useState('');
  const hydratedFor = useRef<string | null>(null);

  // Hydrate notes from the existing row once per row id, so user edits aren't
  // clobbered when the live query re-fires.
  useEffect(() => {
    if (!existingSession) return;
    if (hydratedFor.current === existingSession.id) return;
    hydratedFor.current = existingSession.id;
    setNotes(existingSession.notes ?? '');
  }, [existingSession]);

  const updateNotes = async (next: string) => {
    if (locked) return;
    setNotes(next);
    if (!sessionId) return;
    await ensureSessionRow();
    await getDb().sessions.update(sessionId, { notes: next });
  };

  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <label className="block">
        <span className="text-xs uppercase tracking-wide text-muted">Workout notes</span>
        <textarea
          value={notes}
          onChange={(e) => updateNotes(e.target.value)}
          rows={3}
          placeholder={locked ? 'No notes' : 'How did it feel? Anything to remember next time.'}
          readOnly={locked}
          disabled={locked}
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm disabled:opacity-60"
        />
      </label>
    </section>
  );
}


// ---------------------------------------------------------------------------
// LiftRecap: compact summary of all logged sets for a completed lift, with a
// pencil button per row that switches the section back into focus mode at
// that set so it can be edited.

const RECAP_KIND_LABEL: Record<PrescribedSet['kind'], string> = {
  warmup: 'Warm-up',
  main: 'Working',
  amrap: 'Working',
  supplemental: 'Supplemental',
  assistance: 'Assistance',
};

function LiftRecap({
  prescribed,
  loggedSets,
  onEdit,
  locked = false,
}: {
  prescribed: PrescribedSet[];
  loggedSets: SetRecord[];
  onEdit: (index: number) => void;
  locked?: boolean;
}) {
  return (
    <ol className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border bg-bg/40">
      {prescribed.map((set, i) => {
        const ex = findExisting(loggedSets, prescribed, i);
        const skipped = ex?.skipped;
        const label = RECAP_KIND_LABEL[set.kind];
        return (
          <li
            key={i}
            className="flex items-center gap-3 px-3 py-2.5 text-sm"
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                skipped
                  ? 'bg-amber-500/20 text-amber-300'
                  : ex
                    ? 'bg-emerald-600/30 text-emerald-200'
                    : 'bg-card text-muted ring-1 ring-border'
              }`}
              aria-hidden
            >
              {skipped ? '–' : ex ? '✓' : i + 1}
            </span>

            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-xs uppercase tracking-wide text-muted">
                  {label}
                </span>
                {set.percentOfTm && (
                  <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted ring-1 ring-border">
                    {(set.percentOfTm * 100).toFixed(0)}%
                  </span>
                )}
                {set.isAmrap && (
                  <span className="text-[11px] text-accent">AMRAP+</span>
                )}
              </div>
              <div className="mt-0.5 font-mono tabular-nums text-fg">
                {skipped ? (
                  <span className="text-amber-300">
                    Skipped{ex?.skipReason ? ` · ${ex.skipReason}` : ''}
                  </span>
                ) : ex ? (
                  <>
                    {fmtKg(ex.weightKg)} × <span className="font-bold">{ex.reps}</span>
                    {ex.rpe != null && (
                      <span className="ml-2 text-xs text-muted">RPE {ex.rpe}</span>
                    )}
                  </>
                ) : (
                  <span className="text-muted">
                    Target {fmtKg(set.weightKg)} × {set.repsLabelOverride ?? set.reps}
                  </span>
                )}
              </div>
            </div>

            {!locked && (
              <button
                type="button"
                onClick={() => onEdit(i)}
                aria-label={`Edit set ${i + 1}`}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted ring-1 ring-border bg-card hover:text-fg hover:border-accent"
              >
                ✎
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
