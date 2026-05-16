'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useAllCardio, useAllStrengthHr, useAllTrainingMaxRecords, useBlocks, useRaces, useRecentWorkoutDays, useRunPlan, useUpcomingWorkouts, type RecentWorkoutDay } from '@/lib/hooks';
import { liftLabel, liftLabelShort } from '@/lib/format';
import { CARDIO_EMOJI, CARDIO_SHORT, cardioFullTitle, cardioMetric } from '@/lib/cardio-display';
import { LinkActivityPicker } from '@/components/LinkActivityPicker';
import { ProgramTimeline } from '@/components/ProgramTimeline';
import type { CardioSession, StrengthHrEnrichment } from '@wendler/db-schema';
import { importedStrengthLabel, isoDayOfWeek, planEmoji, planLabel, toLocalYmd, type MainLift, type ProgramBlock, type RunPlannedKind, type UpcomingWorkout } from '@wendler/domain';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const SEVENTH_WEEK_LABEL: Record<string, string> = {
  deload: '7w · Deload',
  'tm-test': '7w · TM Test',
  'pr-test': '7w · PR Test',
};

/**
 * How far back to keep showing the dashed planned-run pill on a date that
 * was never fulfilled. Lets the user link a Strava activity that synced
 * days late, but doesn't litter the whole calendar with stale planned
 * pills from past months.
 */
const PLAN_BACKFILL_DAYS = 14;

function blockChipLabel(block: ProgramBlock | undefined): string | null {
  if (!block) return null;
  if (block.kind === 'seventh-week') {
    return SEVENTH_WEEK_LABEL[block.seventhWeekKind ?? 'deload'] ?? '7th Week';
  }
  if (block.name && block.name.trim()) return block.name.trim();
  if (block.kind === 'leader') return 'Leader';
  if (block.kind === 'anchor') return 'Anchor';
  return null;
}

function hrefFor(d: RecentWorkoutDay): string {
  if (d.blockId && d.week != null && d.dayIndex != null) {
    return `/day?blockId=${d.blockId}&week=${d.week}&day=${d.dayIndex}`;
  }
  if (d.sessions[0]) return `/session?id=${d.sessions[0].id}`;
  return '/';
}

function hrefForUpcoming(u: UpcomingWorkout): string {
  return `/day?blockId=${u.blockId}&week=${u.week}&day=${u.dayIndex}`;
}

function titleForUpcoming(u: UpcomingWorkout): string {
  if (u.label && u.label.trim()) return u.label.trim();
  if (u.mainLifts.length === 0) return 'Assistance';
  return u.mainLifts.map(liftLabel).join(' · ');
}

/**
 * Compact 2–6 char title for mobile calendar cells, where the full
 * "Overhead Press · Bench Press" gets truncated to two letters and is
 * unreadable. Falls back to the first 4 chars of the long title when
 * we don't know the lift list (e.g. accessory days, free sessions).
 */
function shortTitleForUpcoming(u: UpcomingWorkout): string {
  if (u.mainLifts.length > 0) return u.mainLifts.map(liftLabelShort).join('/');
  if (u.label && u.label.trim()) return u.label.trim().slice(0, 4);
  return 'Asst';
}

function shortTitleForRecent(w: RecentWorkoutDay): string {
  const lifts = w.sessions
    .map((s) => s.mainLift)
    .filter((l): l is MainLift => !!l);
  if (lifts.length > 0) {
    // Dedupe while preserving order so a multi-set day still reads cleanly.
    const seen = new Set<MainLift>();
    const unique: MainLift[] = [];
    for (const l of lifts) if (!seen.has(l)) { seen.add(l); unique.push(l); }
    return unique.map(liftLabelShort).join('/');
  }
  return w.title.slice(0, 4);
}

function weekLabelFor(week: UpcomingWorkout['week']): string {
  if (week === 'deload') return 'Deload';
  if (week === '7w') return '7th Week';
  return `Week ${week}`;
}

export default function CalendarPage() {
  // High limit so the whole month is covered. useRecentWorkoutDays already
  // groups per-lift sessions into one entry per workout-day.
  const days = useRecentWorkoutDays(9999);
  const upcoming = useUpcomingWorkouts({ horizonDays: 90, maxItems: 48 });
  const blocks = useBlocks();
  const allCardio = useAllCardio();
  const allImportedStrength = useAllStrengthHr();
  const runPlan = useRunPlan();
  const races = useRaces();
  const trainingMaxes = useAllTrainingMaxRecords();
  const router = useRouter();
  const params = useSearchParams();
  // View toggle persisted in the URL so reloads + deep-links keep the
  // chosen mode. Default 'calendar' — the month-grid is the existing
  // primary view; 'timeline' is the new horizontal macrocycle view.
  const viewParam = params.get('view');
  const view: 'calendar' | 'timeline' = viewParam === 'timeline' ? 'timeline' : 'calendar';
  const setView = (next: 'calendar' | 'timeline') => {
    const sp = new URLSearchParams(params.toString());
    if (next === 'calendar') sp.delete('view');
    else sp.set('view', next);
    const qs = sp.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  };
  const blockById = useMemo(() => {
    const m = new Map<string, ProgramBlock>();
    for (const b of blocks ?? []) m.set(b.id, b);
    return m;
  }, [blocks]);
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [linkTarget, setLinkTarget] = useState<{ slotDate: string; slotKind: RunPlannedKind } | null>(null);
  // Visual filter for the month grid. 'all' shows every event class;
  // 'strength' hides cardio (logged + planned + fulfilled-elsewhere);
  // 'cardio' hides strength (logged + upcoming + Strava-imported).
  const [filter, setFilter] = useState<'all' | 'strength' | 'cardio'>('all');
  const showStrength = filter !== 'cardio';
  const showCardio = filter !== 'strength';
  // ISO dates that the user has clicked "+N" on. Expanded cells render the
  // full list of strength workouts / upcoming / cardio / imported instead of
  // capping at 2-3 entries. Click again to collapse.
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const toggleExpanded = (iso: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  };

  const byDay = useMemo(() => {
    const m = new Map<string, RecentWorkoutDay[]>();
    for (const d of days ?? []) {
      const iso = d.latestPerformedAt.slice(0, 10);
      const arr = m.get(iso) ?? [];
      arr.push(d);
      m.set(iso, arr);
    }
    return m;
  }, [days]);

  // Suppress projected workouts that already have a logged session on the
  // same date — the user already started/finished it, so the projection is
  // outdated.
  const upcomingByDay = useMemo(() => {
    const m = new Map<string, UpcomingWorkout[]>();
    for (const u of upcoming) {
      if (byDay.has(u.date)) continue;
      const arr = m.get(u.date) ?? [];
      arr.push(u);
      m.set(u.date, arr);
    }
    return m;
  }, [upcoming, byDay]);

  const cardioByDay = useMemo(() => {
    const m = new Map<string, CardioSession[]>();
    for (const c of allCardio ?? []) {
      const iso = c.performedAt.slice(0, 10);
      const arr = m.get(iso) ?? [];
      arr.push(c);
      m.set(iso, arr);
    }
    // Earliest first within a day so the order matches a visual timeline.
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1));
    }
    return m;
  }, [allCardio]);

  // ISO dates of planned slots that have already been fulfilled by a
  // manually-linked off-day activity. Used to suppress the dashed planned
  // pill on the original slot date once the user has linked yesterday's /
  // tomorrow's run via the picker.
  const planFulfilledByDay = useMemo(() => {
    const s = new Set<string>();
    for (const c of allCardio ?? []) {
      if (c.planScheduledDate) s.add(c.planScheduledDate);
    }
    return s;
  }, [allCardio]);

  // Imported strength HR enrichments grouped by ISO day. Same accent as
  // Wendler strength sessions (violet) so the user gets one visual story
  // per day, with an "Imported" label to differentiate the source.
  const importedStrengthByDay = useMemo(() => {
    const m = new Map<string, StrengthHrEnrichment[]>();
    for (const h of allImportedStrength ?? []) {
      const iso = h.performedAt.slice(0, 10);
      const arr = m.get(iso) ?? [];
      arr.push(h);
      m.set(iso, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1));
    }
    return m;
  }, [allImportedStrength]);

  // Plan → by-day projection. For each non-rest slot, every visible date
  // (today onward) whose ISO day-of-week matches that slot gets an
  // "upcoming run" pill, unless an actual cardio session already exists
  // on that date.
  const planByDayOfWeek = useMemo(() => {
    const m = new Map<number, RunPlannedKind>();
    for (const s of runPlan?.slots ?? []) {
      if (s.kind !== 'rest') m.set(s.dayOfWeek, s.kind);
    }
    return m;
  }, [runPlan]);

  const grid = useMemo(() => {
    const first = new Date(year, month, 1);
    const firstWeekday = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: { date: Date | null; iso: string | null }[] = [];
    for (let i = 0; i < firstWeekday; i++) cells.push({ date: null, iso: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ date, iso });
    }
    while (cells.length % 7 !== 0) cells.push({ date: null, iso: null });
    return cells;
  }, [year, month]);

  const goPrev = () => {
    if (month === 0) { setMonth(11); setYear(year - 1); }
    else setMonth(month - 1);
  };
  const goNext = () => {
    if (month === 11) { setMonth(0); setYear(year + 1); }
    else setMonth(month + 1);
  };
  const goToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth());
  };

  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const backfillStartIso = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - PLAN_BACKFILL_DAYS);
    return toLocalYmd(d);
  }, [todayIso]); // eslint-disable-line react-hooks/exhaustive-deps

  const monthStats = useMemo(() => {
    const cells = grid.filter((c) => c.iso !== null);
    let completed = 0;
    let inProgress = 0;
    let upcomingCount = 0;
    let cardio = 0;
    let upcomingCardio = 0;
    let importedStrength = 0;
    for (const c of cells) {
      const ws = byDay.get(c.iso!) ?? [];
      const cs = cardioByDay.get(c.iso!) ?? [];
      const imp = importedStrengthByDay.get(c.iso!) ?? [];
      // A linked off-day activity counts as cardio on the planned date too,
      // so the month tally honestly reflects "did I do my planned runs?".
      if (cs.length > 0 || planFulfilledByDay.has(c.iso!)) cardio += 1;
      else if (
        c.date &&
        c.iso! >= todayIso &&
        planByDayOfWeek.has(isoDayOfWeek(c.date))
      ) {
        upcomingCardio += 1;
      }
      // Count days with imported strength enrichments separately so the
      // user can see at a glance how many extra "off-app" strength
      // sessions hit this month (typically gymnastics / crossfit /
      // open-gym lifting that has no Wendler counterpart).
      if (imp.length > 0 && ws.length === 0) importedStrength += 1;
      if (ws.length === 0) {
        if ((upcomingByDay.get(c.iso!) ?? []).length > 0) upcomingCount += 1;
        continue;
      }
      // A day is "completed" if any workout on it was marked complete; otherwise
      // it's "in progress". Mutually exclusive — a completed day is no longer
      // counted under in-progress (previously double-counted as "started").
      if (ws.some((w) => w.completed)) completed += 1;
      else inProgress += 1;
    }
    return { inProgress, completed, upcoming: upcomingCount, cardio, upcomingCardio, importedStrength };
  }, [grid, byDay, upcomingByDay, cardioByDay, importedStrengthByDay, planByDayOfWeek, planFulfilledByDay, todayIso]);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Calendar</h1>
        {view === 'calendar' && (
          <button onClick={goToday} className="rounded-lg bg-card px-3 py-1 text-sm ring-1 ring-border">
            Today
          </button>
        )}
      </header>

      <div
        role="tablist"
        aria-label="Calendar view mode"
        className="flex w-fit gap-1 rounded-lg border border-border bg-card p-0.5 text-xs"
      >
        {(['calendar', 'timeline'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={`rounded-md px-3 py-1 font-medium capitalize transition ${
              view === v
                ? 'bg-accent/15 text-accent'
                : 'text-muted hover:text-fg'
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      {view === 'timeline' && (
        <ProgramTimeline
          blocks={blocks ?? []}
          races={races ?? []}
          trainingMaxes={trainingMaxes ?? []}
          today={today}
        />
      )}

      {view === 'calendar' && (
        <>
          <div className="flex items-center justify-between gap-2">
            <button onClick={goPrev} className="rounded-lg bg-card px-3 py-1 ring-1 ring-border" aria-label="Previous month">◀</button>
            <h2 className="text-lg font-semibold">{MONTHS[month]} {year}</h2>
            <button onClick={goNext} className="rounded-lg bg-card px-3 py-1 ring-1 ring-border" aria-label="Next month">▶</button>
          </div>

          <div role="tablist" aria-label="Filter calendar by event type" className="flex w-fit gap-1 rounded-lg border border-border bg-card p-0.5 text-xs">
            {(['all', 'strength', 'cardio'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={filter === v}
                onClick={() => setFilter(v)}
                className={`rounded-md px-3 py-1 font-medium capitalize transition ${
                  filter === v
                    ? 'bg-accent/15 text-accent'
                    : 'text-muted hover:text-fg'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-border bg-card p-2">
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted">
              {WEEKDAYS.map((w) => <div key={w} className="py-1">{w}</div>)}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {grid.map((c, i) => {
            if (!c.date) return <div key={i} className="min-h-[80px] md:min-h-[104px]" />;
            const ws = showStrength ? (byDay.get(c.iso!) ?? []) : [];
            const ups = showStrength && ws.length === 0 ? upcomingByDay.get(c.iso!) ?? [] : [];
            const cs = showCardio ? (cardioByDay.get(c.iso!) ?? []) : [];
            const imp = showStrength ? (importedStrengthByDay.get(c.iso!) ?? []) : [];
            const plannedRun: RunPlannedKind | null =
              showCardio &&
              cs.length === 0 &&
              c.date &&
              c.iso! >= backfillStartIso &&
              !planFulfilledByDay.has(c.iso!)
                ? planByDayOfWeek.get(isoDayOfWeek(c.date)) ?? null
                : null;
            const plannedRunIsPast = plannedRun !== null && c.iso! < todayIso;
            const isToday = c.iso === todayIso;
            // Slot was scheduled for this date but the user fulfilled it
            // with a run on a different day (linked via the picker). Tiny
            // chip so the user can see the slot was honored.
            const fulfilledElsewhere =
              showCardio &&
              cs.length === 0 &&
              c.date &&
              planByDayOfWeek.has(isoDayOfWeek(c.date)) &&
              planFulfilledByDay.has(c.iso!);
            const hasContent =
              ws.length > 0 ||
              ups.length > 0 ||
              cs.length > 0 ||
              imp.length > 0 ||
              plannedRun !== null ||
              fulfilledElsewhere;
            return (
              <div
                key={i}
                className={`flex min-h-[80px] flex-col rounded-lg border p-1 text-xs md:min-h-[104px] ${
                  isToday
                    ? 'border-accent bg-accent/10'
                    : hasContent
                      ? 'border-border bg-bg'
                      : 'border-border/60 bg-bg/40'
                }`}
              >
                <span className={`text-[11px] leading-none ${isToday ? 'font-bold text-accent' : 'text-muted'}`}>
                  {c.date.getDate()}
                </span>
                {(() => {
                  const expanded = expandedDays.has(c.iso!);
                  const wsLimit = expanded ? ws.length : 3;
                  const upsLimit = expanded ? ups.length : 3;
                  const csLimit = expanded ? cs.length : 2;
                  const impLimit = expanded ? imp.length : 2;
                  const overflow =
                    Math.max(0, ws.length - 3) +
                    Math.max(0, ups.length - 3) +
                    Math.max(0, cs.length - 2) +
                    Math.max(0, imp.length - 2);
                  return (<>
                {ws.length > 0 && (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {ws.slice(0, wsLimit).map((w) => {
                      const cls = w.completed
                        ? 'border-violet-700/50 bg-violet-900/30 text-violet-200'
                        : 'border-amber-600/50 bg-amber-900/30 text-amber-200';
                      // When a Strava strength HR row matches this day, fold its
                      // duration + avg HR into the existing strength chip's
                      // tooltip instead of rendering a separate "Imported" pill
                      // (would read as double-counting). The first chip carries
                      // the enrichment since the day-grouping is already 1:N.
                      const enrich = imp[0];
                      const enrichSuffix = enrich
                        ? ` · Strava ${Math.round(enrich.durationSec / 60)} min${
                            enrich.avgHrBpm ? ` · ${enrich.avgHrBpm} bpm` : ''
                          }`
                        : '';
                      const fullTitle = `${w.title}${w.weekLabel ? ` · ${w.weekLabel}` : ''}${w.completed ? ' ✓' : ' (in progress)'}${enrichSuffix}`;
                      const shortTitle = shortTitleForRecent(w);
                      const linkedElsewhere =
                        !!w.planScheduledDate && w.planScheduledDate !== c.iso!;
                      return (
                        <Link
                          key={w.key}
                          href={hrefFor(w)}
                          title={
                            linkedElsewhere
                              ? `${fullTitle} · ↗ planned ${w.planScheduledDate}`
                              : fullTitle
                          }
                          className={`truncate rounded border px-1.5 py-0.5 text-[11px] font-medium leading-tight md:text-xs ${cls}`}
                        >
                          {w.completed ? '✓ ' : '… '}
                          <span className="md:hidden">{shortTitle}</span>
                          <span className="hidden md:inline">{w.title}</span>
                          {linkedElsewhere && (
                            <span className="ml-1 text-[10px] text-muted" aria-hidden>
                              ↗
                            </span>
                          )}
                        </Link>
                      );
                    })}
                    {ws.length > 3 && !expanded && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(c.iso!)}
                        className="text-left text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                        title="Show all entries on this day"
                      >
                        +{ws.length - 3}
                      </button>
                    )}
                  </div>
                )}
                {ws.length === 0 && ups.length > 0 && (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {ups.slice(0, upsLimit).map((u, idx) => {
                      const t = titleForUpcoming(u);
                      const tShort = shortTitleForUpcoming(u);
                      const block = blockById.get(u.blockId);
                      const chip = blockChipLabel(block);
                      const wk = weekLabelFor(u.week);
                      // For seventh-week blocks the chip already encodes the
                      // variant (e.g. "7w · Deload"), so appending the week
                      // label produces redundant text like "7w · Deload · Deload"
                      // or "7w · Deload · 7th Week". Drop the wk segment in
                      // that case and let the chip stand on its own.
                      const isSeventhWeekBlock = block?.kind === 'seventh-week';
                      const subLine = isSeventhWeekBlock
                        ? (chip ?? wk)
                        : chip
                          ? `${chip} · ${wk}`
                          : wk;
                      const fullTitle = `Upcoming · ${t} · ${subLine}`;
                      return (
                        <Link
                          key={`${u.blockId}-${u.week}-${u.dayIndex}-${idx}`}
                          href={hrefForUpcoming(u)}
                          title={fullTitle}
                          className="flex flex-col gap-px truncate rounded border border-dashed border-violet-500/60 px-1.5 py-0.5 text-[11px] font-medium leading-tight text-violet-300/90 md:text-xs"
                        >
                          <span className="truncate">
                            ◌ <span className="md:hidden">{tShort}</span>
                            <span className="hidden md:inline">{t}</span>
                          </span>
                          <span className="hidden truncate text-[10px] font-normal text-muted md:inline md:text-[11px]">
                            {subLine}
                          </span>
                        </Link>
                      );
                    })}
                    {ups.length > 3 && !expanded && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(c.iso!)}
                        className="text-left text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                        title="Show all entries on this day"
                      >
                        +{ups.length - 3}
                      </button>
                    )}
                  </div>
                )}
                {cs.length > 0 && (
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    {cs.slice(0, csLimit).map((cardio) => {
                      const metric = cardioMetric(cardio);
                      const emoji = CARDIO_EMOJI[cardio.modality];
                      return (
                        <Link
                          key={cardio.id}
                          href="/cardio"
                          title={cardioFullTitle(cardio)}
                          className="truncate rounded border border-sky-700/50 bg-sky-900/30 px-1.5 py-0.5 text-[11px] font-medium leading-tight text-sky-200 md:text-xs"
                        >
                          <span aria-hidden>{emoji}</span>{' '}
                          <span className="md:hidden">{metric}</span>
                          <span className="hidden md:inline">{CARDIO_SHORT[cardio.modality]} · {metric}</span>
                        </Link>
                      );
                    })}
                    {cs.length > 2 && !expanded && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(c.iso!)}
                        className="text-left text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                        title="Show all entries on this day"
                      >
                        +{cs.length - 2}
                      </button>
                    )}
                  </div>
                )}
                {imp.length > 0 && ws.length === 0 && (
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    {imp.slice(0, impLimit).map((h) => {
                      const sport = importedStrengthLabel(h.sport);
                      const minutes = Math.round(h.durationSec / 60);
                      const fullTitle = `Imported · ${sport} · ${minutes} min${
                        h.avgHrBpm ? ` · avg ${h.avgHrBpm} bpm` : ''
                      }`;
                      return (
                        <span
                          key={h.id}
                          title={fullTitle}
                          className="truncate rounded border border-violet-800/40 bg-violet-950/30 px-1.5 py-0.5 text-[11px] font-medium leading-tight text-violet-200/70 md:text-xs"
                        >
                          <span aria-hidden>🏋️</span>{' '}
                          <span className="md:hidden">{minutes}m</span>
                          <span className="hidden md:inline">{sport} · {minutes} min</span>
                        </span>
                      );
                    })}
                    {imp.length > 2 && !expanded && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(c.iso!)}
                        className="text-left text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                        title="Show all entries on this day"
                      >
                        +{imp.length - 2}
                      </button>
                    )}
                  </div>
                )}
                {plannedRun && (
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => setLinkTarget({ slotDate: c.iso!, slotKind: plannedRun })}
                      title={
                        plannedRunIsPast
                          ? `Unfulfilled · ${planLabel(plannedRun)} run — link an activity`
                          : `Planned · ${planLabel(plannedRun)} run — tap to link an activity`
                      }
                      className={`flex items-center gap-1 truncate rounded border border-dashed px-1.5 py-0.5 text-left text-[11px] font-medium leading-tight md:text-xs ${
                        plannedRunIsPast
                          ? 'border-rose-400/50 bg-transparent text-rose-300/70'
                          : 'border-sky-400/70 bg-transparent text-sky-300/80'
                      }`}
                    >
                      <span aria-hidden>{plannedRunIsPast ? '!' : '◌'}</span>
                      <span aria-hidden>{planEmoji(plannedRun)}</span>
                      <span className="md:hidden">Run</span>
                      <span className="hidden truncate md:inline">{planLabel(plannedRun)}</span>
                    </button>
                  </div>
                )}
                {fulfilledElsewhere && (
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    <Link
                      href="/cardio"
                      title="Slot fulfilled by a linked off-day run"
                      className="flex items-center gap-1 truncate rounded border border-sky-700/40 bg-sky-900/20 px-1.5 py-0.5 text-[11px] font-medium leading-tight text-sky-300/80 md:text-xs"
                    >
                      <span aria-hidden>✓</span>
                      <span className="md:hidden">Linked</span>
                      <span className="hidden truncate md:inline">Linked run</span>
                    </Link>
                  </div>
                )}
                {expanded && overflow > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleExpanded(c.iso!)}
                    className="mt-0.5 text-left text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                    title="Collapse"
                  >
                    Show less
                  </button>
                )}
                </>);
                })()}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted">This month</span>
          <span className="text-right">
            <span className="font-mono text-fg">{monthStats.completed}</span> completed ·{' '}
            <span className="font-mono text-fg">{monthStats.inProgress}</span> in progress ·{' '}
            <span className="font-mono text-fg">{monthStats.upcoming}</span> upcoming ·{' '}
            <span className="font-mono text-fg">{monthStats.cardio}</span> cardio ·{' '}
            <span className="font-mono text-fg">{monthStats.importedStrength}</span> imported ·{' '}
            <span className="font-mono text-fg">{monthStats.upcomingCardio}</span> planned runs
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded border border-violet-700/50 bg-violet-900/30" />
            Strength · done
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded border border-dashed border-violet-500/60" />
            Strength · planned
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded border border-sky-700/50 bg-sky-900/30" />
            Cardio · done
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded border border-dashed border-sky-400/70 bg-transparent" />
            Cardio · planned
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded border border-dashed border-rose-400/50 bg-transparent" />
            Past unfulfilled — tap to link
          </span>
          <span className="text-muted/70">· Strava badge on event = imported</span>
        </div>
      </div>
        </>
      )}
      {linkTarget && (
        <LinkActivityPicker
          slotDate={linkTarget.slotDate}
          slotKind={linkTarget.slotKind}
          onClose={() => setLinkTarget(null)}
        />
      )}
    </div>
  );
}
