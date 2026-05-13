'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { liftLabel, fmtKg } from '@/lib/format';
import {
  useActiveBlock,
  useAllCardio,
  useAllMainLiftMovements,
  useAllTrainingMaxes,
  useCurrentTrainingMax,
  useMovements,
  useRunPlan,
  useSchedule,
  useSessionsRecent,
  useSettings,
} from '@/lib/hooks';
import {
  MAIN_SCHEMES,
  SUPPLEMENTAL_TEMPLATES,
  buildMainSets,
  describeNextWorkout,
  effectivePlan,
  effectiveScheduleDays,
  isoDayOfWeek,
  planEmoji,
  planLabel,
  resolveDayAssistance,
  resolveDayWeekday,
  WEEKDAY_SHORT,
  type MainLift,
  type MainScheme,
  type RunPlannedKind,
  type WendlerWeek,
} from '@wendler/domain';
import type { CardioSession } from '@wendler/db-schema';

const SCHEME_NAME = Object.fromEntries(MAIN_SCHEMES.map((s) => [s.id, s.shortName]));
const SUPPL_NAME = Object.fromEntries(SUPPLEMENTAL_TEMPLATES.map((s) => [s.id, s.name]));

function weekLabel(w: WendlerWeek): string {
  return w === 'deload' ? 'Deload' : `Week ${w}`;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ISO_DOW_SHORT = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

interface NextCardio {
  /** 0 = today, 1 = tomorrow, ..., 7 = next week same day. */
  daysUntil: number;
  date: Date;
  kind: RunPlannedKind;
}

/**
 * Find the next non-rest cardio slot from today (inclusive) over the next
 * week, skipping any day that already has a logged cardio session. Returns
 * null when the user has no run plan or has nothing scheduled in the
 * upcoming 7 days that isn't already done.
 */
function findNextCardio(
  today: Date,
  runPlan: { slots?: { dayOfWeek: number; kind: RunPlannedKind }[] } | null | undefined,
  cardio: CardioSession[] | null | undefined,
): NextCardio | null {
  const slots = runPlan?.slots ?? [];
  if (slots.length === 0) return null;
  const slotByDow = new Map<number, RunPlannedKind>();
  for (const s of slots) if (s.kind !== 'rest') slotByDow.set(s.dayOfWeek, s.kind);
  if (slotByDow.size === 0) return null;
  const cardioYmd = new Set<string>();
  for (const c of cardio ?? []) cardioYmd.add(ymd(new Date(c.performedAt)));

  for (let i = 0; i < 8; i++) {
    const d = new Date(today);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    const kind = slotByDow.get(isoDayOfWeek(d));
    if (!kind) continue;
    if (cardioYmd.has(ymd(d))) continue;
    return { daysUntil: i, date: d, kind };
  }
  return null;
}

/**
 * Convert a strength schedule descriptor into a comparable urgency number,
 * smaller = more urgent. Overdue beats today beats tomorrow beats in-N-days,
 * and "more overdue" beats "less overdue".
 */
function strengthUrgency(
  desc: { kind: 'today' | 'tomorrow' | 'in-days' | 'overdue'; days: number } | null,
): number {
  if (!desc) return Number.POSITIVE_INFINITY;
  switch (desc.kind) {
    case 'overdue':
      return -desc.days; // -1, -2, ... — more overdue is more urgent
    case 'today':
      return 0;
    case 'tomorrow':
      return 1;
    case 'in-days':
      return desc.days;
  }
}

function buildCardioEyebrow(next: NextCardio): string {
  const wdLabel = ISO_DOW_SHORT[isoDayOfWeek(next.date)] ?? '';
  if (next.daysUntil === 0) return `TODAY · ${wdLabel}`;
  if (next.daysUntil === 1) return `TOMORROW · ${wdLabel}`;
  return `IN ${next.daysUntil} DAYS · ${wdLabel}`;
}

/**
 * Build the eyebrow string for the hero based on the cursor day's scheduled
 * weekday and the most recent completed session date for the active block.
 * Returns null when the day has no resolvable weekday (so the caller can
 * fall back to the static "Up next" copy).
 */
function buildScheduleEyebrow(
  day: { weekday?: number | null; label?: string | null } | undefined,
  lastCompletedAt: string | undefined,
): string | null {
  if (!day) return null;
  const wd = resolveDayWeekday(day);
  if (wd == null) return null;
  const wdLabel = (WEEKDAY_SHORT[wd] ?? '').toUpperCase();
  const desc = describeNextWorkout({
    targetWeekday: wd,
    today: new Date(),
    lastCompletedAt: lastCompletedAt ?? null,
  });
  switch (desc.kind) {
    case 'today':
      return `TODAY · ${wdLabel}`;
    case 'tomorrow':
      return `TOMORROW · ${wdLabel}`;
    case 'in-days':
      return `IN ${desc.days} DAYS · ${wdLabel}`;
    case 'overdue':
      return `OVERDUE · ${wdLabel}`;
  }
}

/**
 * Compact cardio variant of the hero. Rendered when the next planned activity
 * is cardio (sooner than the next strength workout). No CTAs — there's no
 * "start cardio" flow in the app; cardio is logged after the fact via Strava
 * sync, so the hero is informational only.
 */
function CardioHero({ next }: { next: NextCardio }) {
  const eyebrow = buildCardioEyebrow(next);
  return (
    <section className="rounded-2xl bg-zinc-900 p-5 ring-1 ring-sky-700/40">
      <div className="space-y-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-300/80">
          {eyebrow}
        </div>
        <h2 className="flex items-center gap-2 text-3xl font-bold leading-tight tracking-tight text-white">
          <span aria-hidden>{planEmoji(next.kind)}</span>
          <span>{planLabel(next.kind)}</span>
        </h2>
        <div className="text-sm text-zinc-400">Cardio · per your run plan</div>
      </div>
    </section>
  );
}

interface Props {
  /** When true, render compact variant (used inside the block detail page). */
  compact?: boolean;
}

/**
 * "Up next" hero card on the Today page. Surfaces the next prescribed workout
 * with per-lift top-set weights, the supplemental scheme pill, an assistance
 * count, and the primary CTAs (Start workout / Preview).
 */
export function NextUpCard({ compact = false }: Props) {
  const block = useActiveBlock();
  const schedule = useSchedule();
  const settings = useSettings();
  const tms = useAllTrainingMaxes();
  const movements = useMovements();
  const slotMovements = useAllMainLiftMovements();
  const recentSessions = useSessionsRecent(40);
  const cardio = useAllCardio();
  const runPlan = useRunPlan();
  const today = useMemo(() => new Date(), []);
  const currentGroup = schedule?.cursor
    ? effectiveScheduleDays(schedule)[schedule.cursor.groupIndex]
    : undefined;
  const dayLifts: MainLift[] = currentGroup?.mainLifts ?? [];
  const lift: MainLift | undefined = dayLifts[0];
  const tmSingle = useCurrentTrainingMax(lift ?? 'squat');
  // Most recent completed session for the active block, used to detect
  // "overdue" workouts vs. the day's scheduled weekday.
  const lastCompletedAt = block
    ? recentSessions?.find((s) => s.blockId === block.id)?.performedAt
    : undefined;

  // Decide whether the next prescribed activity is strength or cardio. The
  // hero shows whichever comes sooner so the user has a single "what's next"
  // surface. Compact mode (block detail page) skips this entirely — cardio
  // doesn't belong inside a strength block view.
  const nextCardio = useMemo(
    () => findNextCardio(today, runPlan, cardio ?? null),
    [today, runPlan, cardio],
  );
  const strengthWd = currentGroup ? resolveDayWeekday(currentGroup) : null;
  const strengthDesc =
    strengthWd != null
      ? describeNextWorkout({
          targetWeekday: strengthWd,
          today,
          lastCompletedAt: lastCompletedAt ?? null,
        })
      : null;
  const cardioUrgency = nextCardio ? nextCardio.daysUntil : Number.POSITIVE_INFINITY;
  const sUrg = strengthUrgency(strengthDesc);
  if (!compact && nextCardio && cardioUrgency < sUrg) {
    return <CardioHero next={nextCardio} />;
  }

  if (!block) {
    if (compact) return null;
    return (
      <section className="rounded-2xl border border-accent/40 bg-accent/5 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-accent">Up next</h2>
        <p className="mt-2 text-sm text-muted">
          No active program. Plan a sequence of blocks to follow Wendler 5/3/1.
        </p>
        <Link
          href="/program/new"
          className="mt-3 inline-block rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg"
        >
          Start a program
        </Link>
      </section>
    );
  }

  // Accessory-only day (no main lifts on this group).
  if (schedule?.cursor && currentGroup && currentGroup.mainLifts.length === 0) {
    const week = schedule.cursor.week;
    const dayGroup = schedule.cursor.groupIndex;
    const url = `/day?blockId=${block.id}&week=${week === 'deload' ? 'deload' : week}&day=${dayGroup}`;
    const headerLabel = currentGroup.label?.trim() || 'Accessory day';
    const accessoryEyebrow =
      buildScheduleEyebrow(currentGroup, lastCompletedAt) ?? 'UP NEXT · ACCESSORY';
    return (
      <section className="rounded-2xl border border-violet-500/40 bg-violet-500/5 p-5">
        <div className="space-y-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-violet-300/80">
            {accessoryEyebrow}
          </h2>
          <div className="text-2xl font-bold tracking-tight">{headerLabel}</div>
          <div className="text-sm text-muted">
            {weekLabel(week)} · {block.name}
          </div>
          <div className="text-xs text-muted">Pure assistance / conditioning — no main lift today.</div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={url}
            className="flex-1 rounded-lg bg-violet-500 px-4 py-2.5 text-center text-sm font-semibold text-white sm:flex-none"
          >
            Start workout
          </Link>
          <Link
            href={url}
            className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm hover:border-violet-400"
          >
            Preview
          </Link>
        </div>
      </section>
    );
  }

  if (!schedule?.cursor || !lift) {
    return (
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Up next</h2>
        <p className="mt-2 text-sm text-muted">
          {block.name} is active but has no scheduled cursor. Pick a lift below to start.
        </p>
        <Link
          href={`/program/block?id=${block.id}`}
          className="mt-3 inline-block text-sm text-accent underline"
        >
          Preview
        </Link>
      </section>
    );
  }

  const week = schedule.cursor.week;
  const dayGroup = schedule.cursor.groupIndex;
  const url = `/day?blockId=${block.id}&week=${week === 'deload' ? 'deload' : week}&day=${dayGroup}`;
  const schemeName = SCHEME_NAME[block.mainScheme ?? 'classic-531'];
  const supplName =
    block.supplementalTemplate !== 'none' ? SUPPL_NAME[block.supplementalTemplate] : null;
  // Prefer the user-picked movement name (e.g. "Front Squat") over the
  // generic slot label so the hero reflects what they're actually about
  // to do today. Falls back to the slot label when no mapping exists yet.
  const liftDisplayName = (l: MainLift): string =>
    slotMovements?.get(l)?.name ?? liftLabel(l);
  const headerLabel = dayLifts.map(liftDisplayName).join(' + ');

  // Top set weight per lift on this day, and assistance count for the chip row.
  const scheme: MainScheme = block.mainScheme ?? 'classic-531';
  const plan = schedule ? effectivePlan(block, schedule) : undefined;
  const planDay = plan?.days[dayGroup];
  const liftWeights: { lift: MainLift; weightKg: number | undefined }[] = dayLifts.map((l) => {
    const tm = tms?.get(l);
    if (!tm || !settings) return { lift: l, weightKg: undefined };
    const sets = buildMainSets({
      trainingMaxKg: tm.trainingMaxKg,
      week,
      roundingKg: settings.roundingKg,
      scheme,
      amrapMainIndices: planDay?.amrapMainSetIndices?.[l],
      seventhWeekKind: block.seventhWeekKind,
    });
    const top = sets[sets.length - 1]?.weightKg;
    return { lift: l, weightKg: top };
  });
  const assistance = plan && planDay ? resolveDayAssistance(plan, week, planDay.id) : [];
  // Filter assistance entries down to ones that have either a movement or
  // free-text label so we don't show ghost rows.
  const assistanceCount = assistance.filter((e) => e.movementId || e.movementName?.trim()).length;
  const _useMovementsRef = movements; // keep hook stable in deps order
  const eyebrow =
    buildScheduleEyebrow(planDay ?? currentGroup, lastCompletedAt) ?? 'UP NEXT';

  return (
    <section className="rounded-2xl bg-zinc-900 p-5 ring-1 ring-zinc-800">
      <div className="space-y-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          {eyebrow}
        </div>
        <h2 className="text-3xl font-bold leading-tight tracking-tight text-white">
          {headerLabel}
        </h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-400">
          <span>{weekLabel(week)}</span>
          <span aria-hidden>·</span>
          <span>{block.name}</span>
          {tmSingle && (
            <>
              <span aria-hidden>·</span>
              <span>
                TM <span className="font-mono tabular-nums text-zinc-300">{tmSingle.trainingMaxKg} kg</span>
              </span>
            </>
          )}
          <span
            className="ml-1 inline-flex items-center rounded-md bg-accent/20 px-2 py-0.5 text-xs font-semibold text-accent ring-1 ring-accent/30"
            title={schemeName + (supplName ? ' + ' + supplName : '')}
          >
            {schemeName}
            {supplName ? ` + ${supplName}` : ''}
          </span>
        </div>
      </div>

      {(liftWeights.some((w) => w.weightKg) || assistanceCount > 0) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {liftWeights.map(({ lift: l, weightKg }) => (
            <span
              key={l}
              className="inline-flex items-center gap-2 rounded-lg bg-zinc-800/80 px-2.5 py-1.5 text-xs font-medium text-zinc-200 ring-1 ring-zinc-700"
            >
              {liftDisplayName(l)}
              {weightKg != null && (
                <>
                  <span className="text-zinc-500">·</span>
                  <span className="font-mono tabular-nums">{fmtKg(weightKg)}</span>
                </>
              )}
            </span>
          ))}
          {assistanceCount > 0 && (
            <span className="inline-flex items-center rounded-lg bg-zinc-800/80 px-2.5 py-1.5 text-xs font-medium text-zinc-400 ring-1 ring-zinc-700">
              + {assistanceCount} assistance
            </span>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <Link
          href={url}
          className="flex-1 rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-bg hover:bg-accent/90"
        >
          Start workout
        </Link>
        <Link
          href={url}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-200 hover:border-zinc-500"
        >
          Preview
        </Link>
      </div>
    </section>
  );
}
