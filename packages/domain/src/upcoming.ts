import type { MainLift, WendlerWeek } from './types';
import type { ProgramBlock, ProgramSchedule } from './blocks';
import {
  advanceCursor,
  effectivePlan,
  effectiveScheduleDays,
  initialCursorWeek,
  resolveDayWeekday,
} from './blocks';

/**
 * A future workout projected onto a calendar date by walking the schedule
 * cursor forward one day at a time and assigning each weekday-anchored day
 * to the next matching calendar weekday.
 *
 * Days without a resolvable weekday (no explicit `weekday`, no parseable
 * label) are skipped — there's no way to anchor them in time.
 */
export interface UpcomingWorkout {
  /** Local-time ISO date `yyyy-mm-dd` the workout is projected to land on. */
  date: string;
  blockId: string;
  week: WendlerWeek;
  /** Day-group index into `effectiveScheduleDays(schedule)`. */
  dayIndex: number;
  /** BlockDay.id. Stable across reorders. */
  dayId: string;
  /** Day label, if any (e.g. "Monday — Heavy"). */
  label?: string;
  /** Resolved weekday: 0=Mon … 6=Sun. */
  weekday: number;
  /** Main lifts trained on this day. Empty array = pure assistance day. */
  mainLifts: MainLift[];
}

interface ProjectOpts {
  /** Don't project beyond this many days from `fromDate`. Default 60. */
  horizonDays?: number;
  /** Hard cap on returned items. Default 24. */
  maxItems?: number;
  /**
   * Subsequent blocks (in program order, after `block`) to chain onto once
   * the active block ends. Lets the calendar reach beyond the current block
   * into the rest of the program. Defaults to none.
   */
  subsequentBlocks?: readonly ProgramBlock[];
  /**
   * Inferred weekday (0=Mon..6=Sun) for plan days that have no explicit
   * `weekday` and whose label can't be parsed. Keyed by `groupIndex` into
   * `effectiveScheduleDays(schedule)`. Typical use: derive from the user's
   * past completed sessions on each `dayIndex`. Without this, label-less
   * days are silently skipped, which is the usual cause of "Monday is
   * missing" symptoms in the calendar projection.
   */
  weekdayByGroupIndex?: ReadonlyMap<number, number>;
  /**
   * If true (the default), days that still have no weekday after explicit /
   * label / hint resolution fall back to a standard Wendler weekly pattern
   * keyed off the number of training days per week (1→Mon; 2→Mon/Thu;
   * 3→Mon/Wed/Fri; 4→Mon/Tue/Thu/Fri; 5→Mon/Tue/Wed/Thu/Fri; 6→Mon..Sat).
   * Set to false to keep the legacy silent-skip behaviour.
   */
  fillMissingWeekdays?: boolean;
  /**
   * Set of `${blockId}|${week}|${dayIndex}|${date}` keys whose planned
   * slot has been claimed by an off-day logged workout (via
   * SessionRecord.planScheduledDate). When a projected slot's key is
   * in the set, suppress it from the upcoming list — the work is done,
   * just on a different calendar date.
   */
  fulfilledKeys?: ReadonlySet<string>;
}

/**
 * Build a stable key for marking a planned strength slot as fulfilled
 * by an off-day logged workout. Combine block + week + dayIndex + date
 * so we never confuse week-1 Monday with week-2 Monday or one block's
 * day-0 with another's.
 */
export function dayGroupFulfilledKey(
  blockId: string,
  week: WendlerWeek,
  dayIndex: number,
  plannedDate: string,
): string {
  return `${blockId}|${week}|${dayIndex}|${plannedDate}`;
}

/**
 * Whether a logged workout-day can be linked to a planned slot. Same
 * block, same week, same dayIndex — strength linking never crosses
 * lifts (Press↔Press only) or weeks.
 */
export function isStrengthLinkable(
  workout: { blockId: string; week: WendlerWeek; dayIndex: number },
  slot: { blockId: string; week: WendlerWeek; dayIndex: number },
): boolean {
  return (
    workout.blockId === slot.blockId &&
    workout.week === slot.week &&
    workout.dayIndex === slot.dayIndex
  );
}

/**
 * Standard weekly distribution of training days for a given count, used as
 * the last-resort fallback when a day has no weekday set anywhere. Mirrors
 * the templates Wendler suggests (and what most users intuitively pick).
 */
const DEFAULT_WEEKLY_PATTERN: Record<number, readonly number[]> = {
  1: [0],
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
  7: [0, 1, 2, 3, 4, 5, 6],
};

/** Convert JS getDay() (0=Sun..6=Sat) to ISO-ish weekday (0=Mon..6=Sun). */
function jsDayToIsoWeekday(jsDay: number): number {
  return (jsDay + 6) % 7;
}

function toLocalIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Find the next date >= `from` whose weekday equals `targetIsoWeekday`. */
function nextDateOnWeekday(from: Date, targetIsoWeekday: number): Date {
  const fromWeekday = jsDayToIsoWeekday(from.getDay());
  const offset = (targetIsoWeekday - fromWeekday + 7) % 7;
  return addDays(from, offset);
}

/**
 * Project the next planned workouts from the current schedule cursor onto
 * upcoming calendar dates. Returns workouts in chronological order.
 *
 * Behaviour:
 * - Iteration starts at `schedule.cursor` (week + groupIndex). If the cursor
 *   is missing or points at a different block, iteration starts at week 1,
 *   group 0 of `block`.
 * - Each day is projected onto the next calendar date that matches its
 *   resolved weekday. The date pointer then advances to the day after, so
 *   subsequent projections always land later.
 * - Days with no resolvable weekday are skipped (the date pointer stays
 *   put). The next anchor-able day fills the slot.
 * - Iteration stops at end of block, when `maxItems` are projected, or when
 *   the next projection would fall beyond `horizonDays` from `fromDate`.
 */
export function projectUpcomingWorkouts(
  block: ProgramBlock,
  schedule: ProgramSchedule,
  fromDate: Date,
  options: ProjectOpts = {},
): UpcomingWorkout[] {
  const horizonDays = options.horizonDays ?? 60;
  const maxItems = options.maxItems ?? 24;
  const subsequentBlocks = options.subsequentBlocks ?? [];
  const weekdayByGroupIndex = options.weekdayByGroupIndex;
  const fillMissingWeekdays = options.fillMissingWeekdays ?? true;
  const fulfilledKeys = options.fulfilledKeys;

  const scheduleDays = effectiveScheduleDays(schedule);
  const numGroups = scheduleDays.length;
  if (numGroups === 0) return [];

  // Normalize fromDate to local midnight so date arithmetic is stable.
  const start = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const horizonEnd = addDays(start, horizonDays);

  let activeBlock: ProgramBlock = block;
  let plan = effectivePlan(activeBlock, schedule);
  if (plan.days.length === 0) return [];

  let cursor: { week: WendlerWeek; groupIndex: number } | null =
    schedule.cursor && schedule.cursor.blockId === activeBlock.id
      ? { week: schedule.cursor.week, groupIndex: schedule.cursor.groupIndex }
      : { week: initialCursorWeek(activeBlock), groupIndex: 0 };

  function resolveWeekdays(b: ProgramBlock, p: ReturnType<typeof effectivePlan>): Map<number, number> {
    const resolved = new Map<number, number>();
    for (let g = 0; g < numGroups; g++) {
      const planDay = p.days[g];
      const scheduleDay = scheduleDays[g];
      let wd = resolveDayWeekday({
        weekday:
          (planDay && typeof planDay.weekday === 'number'
            ? planDay.weekday
            : undefined) ?? scheduleDay?.weekday,
        label: planDay?.label ?? scheduleDay?.label,
      });
      if (typeof wd !== 'number' && weekdayByGroupIndex) {
        const hint = weekdayByGroupIndex.get(g);
        if (typeof hint === 'number' && hint >= 0 && hint <= 6) wd = hint;
      }
      if (typeof wd === 'number') resolved.set(g, wd);
    }
    if (fillMissingWeekdays) {
      const taken = new Set(resolved.values());
      const pattern = DEFAULT_WEEKLY_PATTERN[numGroups] ?? [];
      const available = pattern.filter((d) => !taken.has(d));
      let cursorIntoAvailable = 0;
      for (let g = 0; g < numGroups; g++) {
        if (resolved.has(g)) continue;
        const next = available[cursorIntoAvailable++];
        if (typeof next === 'number') resolved.set(g, next);
      }
    }
    return resolved;
  }

  let resolvedByGroup = resolveWeekdays(activeBlock, plan);

  let pointer = start;
  const out: UpcomingWorkout[] = [];
  const queue: ProgramBlock[] = [...subsequentBlocks];

  while (out.length < maxItems) {
    if (!cursor) {
      const next = queue.shift();
      if (!next) break;
      activeBlock = next;
      plan = effectivePlan(activeBlock, schedule);
      if (plan.days.length === 0) continue;
      cursor = { week: initialCursorWeek(activeBlock), groupIndex: 0 };
      resolvedByGroup = resolveWeekdays(activeBlock, plan);
    }

    const planDay = plan.days[cursor.groupIndex];
    const scheduleDay = scheduleDays[cursor.groupIndex];
    const weekday = resolvedByGroup.get(cursor.groupIndex);

    if (typeof weekday === 'number') {
      const date = nextDateOnWeekday(pointer, weekday);
      if (date > horizonEnd) break;
      const dateIso = toLocalIsoDate(date);
      const key = dayGroupFulfilledKey(activeBlock.id, cursor.week, cursor.groupIndex, dateIso);
      const isFulfilled = !!fulfilledKeys?.has(key);
      if (!isFulfilled) {
        out.push({
          date: dateIso,
          blockId: activeBlock.id,
          week: cursor.week,
          dayIndex: cursor.groupIndex,
          dayId: planDay?.id ?? `${cursor.week}-${cursor.groupIndex}`,
          label: planDay?.label ?? scheduleDay?.label,
          weekday,
          mainLifts: planDay?.mainLifts ?? scheduleDay?.mainLifts ?? [],
        });
      }
      pointer = addDays(date, 1);
    }

    cursor = advanceCursor(cursor, activeBlock, numGroups);
  }

  return out;
}
