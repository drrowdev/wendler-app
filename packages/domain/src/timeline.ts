// timeline.ts — pure model builder for the /calendar?view=timeline
// macrocycle view. Takes the user's blocks + races + today + a window
// configuration and returns a structured set of week-aligned segments
// the renderer can lay out without any further date math.
//
// Domain rules baked in:
//   - Each block spans `weeksBeforeDeload + (includesDeload ? 1 : 0)`
//     weeks. The kind chip ('leader' / 'anchor' / 'standalone' /
//     'seventh-week') drives the colour; for seventh-week blocks we
//     surface the variant ('tm-test' / 'pr-test' / 'deload') in the
//     label.
//   - Blocks with `startedAt` are anchored to real dates. Blocks
//     without `startedAt` (planned-but-not-started, materialised by
//     /program/new + chain ahead-of-time) project forward by chaining
//     off the previous block's end date.
//   - "Today" anchors a vertical marker. Race milestones snap to the
//     week column they fall in.
//   - The time window covers EVERY known block + race, padded by
//     `paddingWeeks` on both sides — never crops a known event.

import type { ProgramBlock, BlockKind } from './blocks';
import type { SeventhWeekKind } from './types';

/** Minimum race shape this model needs. Mirror of db-schema's Race. */
export interface TimelineRaceInput {
  id: string;
  name: string;
  /** ISO date-time. */
  date: string;
  /** Optional — surfaces in the tooltip. */
  kind?: string;
}

export interface TimelineConfig {
  /** Today, for the current-week marker. Pass `new Date()` from the UI. */
  today: Date;
  /**
   * Weeks of padding on each end of the window. Default 2. Window is
   * always tight enough to omit irrelevant deep history / far future
   * while never cropping a known block edge or race milestone.
   */
  paddingWeeks?: number;
}

export interface TimelineWeekHeader {
  /** ISO date of the Monday starting this week. */
  weekStartIso: string;
  /** 1-7 ISO week number (e.g. for tooltip). */
  isoWeek: number;
  /** Calendar year of weekStart. */
  year: number;
  /** Compact label for the header strip (e.g. "Apr 26", "May 3"). */
  label: string;
  /** True iff this week contains `today`. */
  isCurrent: boolean;
  /** True iff this is the first week of a new month — UI can render a divider here. */
  startsNewMonth: boolean;
}

export interface TimelineBlockSegment {
  blockId: string;
  /** Display name from ProgramBlock.name. */
  name: string;
  kind: BlockKind;
  /** Variant when kind === 'seventh-week'. */
  seventhWeekKind?: SeventhWeekKind;
  /**
   * 0-based index into the week-header array where the segment starts. */
  startWeekIndex: number;
  /**
   * 0-based index of the LAST week the block occupies (inclusive). */
  endWeekIndex: number;
  /**
   * True iff `startedAt` is set on the source block (real anchor).
   * False iff the segment is projected by chaining from the previous
   * block. Projected segments render with faded fill + dotted border
   * (handled by the renderer).
   */
  isStarted: boolean;
  /**
   * True iff `completedAt` is set. Completed blocks are render-different
   * from active (slightly dimmer, no "active week" chip overlay).
   */
  isCompleted: boolean;
  /** True iff this block contains `today`. */
  isActive: boolean;
  /** Whether the block includes a deload week. UI uses this to mark the last week with a deload hatch. */
  includesDeload: boolean;
  /** Total weeks in the segment (= endWeekIndex - startWeekIndex + 1). */
  weeks: number;
  /** Same source ProgramBlock — UI passes it back on click for navigation. */
  source: ProgramBlock;
}

export interface TimelineRaceMilestone {
  raceId: string;
  name: string;
  kind?: string;
  /** ISO date of the race. */
  dateIso: string;
  /** 0-based index into week-header array (the week the race falls in). */
  weekIndex: number;
}

export interface TimelineModel {
  weekHeaders: TimelineWeekHeader[];
  blockSegments: TimelineBlockSegment[];
  raceMilestones: TimelineRaceMilestone[];
  /** 0-based week index of today. -1 iff today is outside the window (shouldn't happen with default padding). */
  currentWeekIndex: number;
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * ISO Monday of a date — 0=Mon … 6=Sun. Mutates a copy, returns it.
 */
function isoMondayOf(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  // Date.getDay(): 0=Sun..6=Sat. ISO weekday: 0=Mon..6=Sun.
  const wd = (m.getDay() + 6) % 7;
  m.setDate(m.getDate() - wd);
  return m;
}

/** Local YYYY-MM-DD (no timezone shift, matches calendar/day rendering). */
function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** ISO week number — week 1 contains the first Thursday of the year. */
function isoWeekOf(d: Date): number {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  // Shift to Thursday of the same ISO week.
  t.setDate(t.getDate() + 4 - ((t.getDay() + 6) % 7) - 3);
  const yearStart = new Date(t.getFullYear(), 0, 4);
  yearStart.setDate(yearStart.getDate() - ((yearStart.getDay() + 6) % 7));
  return 1 + Math.round((t.getTime() - yearStart.getTime()) / MS_PER_WEEK);
}

function blockWeekCount(block: Pick<ProgramBlock, 'weeksBeforeDeload' | 'includesDeload' | 'kind'>): number {
  if (block.kind === 'seventh-week') return 1;
  return block.weeksBeforeDeload + (block.includesDeload ? 1 : 0);
}

/**
 * Build the timeline model. Pure — call from React with the latest
 * Dexie reads + `new Date()`. Idempotent.
 *
 * Block-ordering rules:
 *   - Started blocks (have `startedAt`) anchor to their real Monday.
 *   - Unstarted blocks chain in `sequenceIndex` order off the END of
 *     the most-recent block (started OR previously-chained). Falls
 *     back to today's Monday when no started block exists.
 *   - When two STARTED blocks overlap (rare — usually a sync edge case)
 *     we keep both segments at their real ranges; the renderer can
 *     stack lanes if needed. For now this model returns one flat
 *     `blockSegments` array; lane assignment is a renderer concern.
 */
export function buildTimelineModel(
  blocks: ProgramBlock[],
  races: TimelineRaceInput[],
  config: TimelineConfig,
): TimelineModel {
  const paddingWeeks = config.paddingWeeks ?? 2;
  const todayMonday = isoMondayOf(config.today);

  // 1. Sort blocks: started-first by startedAt, then unstarted by
  // sequenceIndex (falling back to createdAt for tie-break).
  const started = blocks.filter((b) => !!b.startedAt);
  const unstarted = blocks.filter((b) => !b.startedAt);
  started.sort((a, b) => (a.startedAt! < b.startedAt! ? -1 : 1));
  unstarted.sort((a, b) => {
    const ai = a.sequenceIndex ?? Number.MAX_SAFE_INTEGER;
    const bi = b.sequenceIndex ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1;
  });

  // 2. Place every block on the timeline. For unstarted blocks, chain
  // off the last cursor position (initially today's Monday OR the end
  // of the last started block — whichever is later).
  interface Placed {
    block: ProgramBlock;
    startMonday: Date;
    weeks: number;
    isStarted: boolean;
  }
  const placed: Placed[] = [];
  for (const b of started) {
    placed.push({
      block: b,
      startMonday: isoMondayOf(new Date(b.startedAt!)),
      weeks: blockWeekCount(b),
      isStarted: true,
    });
  }
  let chainCursor: Date | null = null;
  if (placed.length > 0) {
    const last = placed[placed.length - 1]!;
    chainCursor = new Date(last.startMonday);
    chainCursor.setDate(chainCursor.getDate() + last.weeks * 7);
  }
  if (!chainCursor || chainCursor.getTime() < todayMonday.getTime()) {
    chainCursor = todayMonday;
  }
  for (const b of unstarted) {
    const startMonday: Date = new Date(chainCursor);
    const weeks = blockWeekCount(b);
    placed.push({ block: b, startMonday, weeks, isStarted: false });
    chainCursor = new Date(startMonday);
    chainCursor.setDate(chainCursor.getDate() + weeks * 7);
  }

  // 3. Compute the window. Start = min(earliest block monday, earliest
  // race monday, today's monday). End = max(latest block end, latest
  // race monday, today's monday + 4 weeks if there's literally nothing
  // else). Padded on both ends.
  let windowStart = new Date(todayMonday);
  let windowEnd = new Date(todayMonday);
  windowEnd.setDate(windowEnd.getDate() + 4 * 7);
  for (const p of placed) {
    if (p.startMonday.getTime() < windowStart.getTime()) {
      windowStart = new Date(p.startMonday);
    }
    const end = new Date(p.startMonday);
    end.setDate(end.getDate() + p.weeks * 7);
    if (end.getTime() > windowEnd.getTime()) {
      windowEnd = end;
    }
  }
  for (const r of races) {
    const rm = isoMondayOf(new Date(r.date));
    if (rm.getTime() < windowStart.getTime()) windowStart = new Date(rm);
    const rEnd = new Date(rm);
    rEnd.setDate(rEnd.getDate() + 7);
    if (rEnd.getTime() > windowEnd.getTime()) windowEnd = rEnd;
  }
  windowStart.setDate(windowStart.getDate() - paddingWeeks * 7);
  windowEnd.setDate(windowEnd.getDate() + paddingWeeks * 7);

  // 4. Build week headers.
  const weekHeaders: TimelineWeekHeader[] = [];
  const todayIso = toLocalIso(config.today);
  let cur = new Date(windowStart);
  let prevMonth = -1;
  while (cur.getTime() < windowEnd.getTime()) {
    const weekStartIso = toLocalIso(cur);
    const weekEnd = new Date(cur);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const weekEndIso = toLocalIso(weekEnd);
    const isCurrent = todayIso >= weekStartIso && todayIso <= weekEndIso;
    const startsNewMonth = cur.getMonth() !== prevMonth;
    prevMonth = cur.getMonth();
    weekHeaders.push({
      weekStartIso,
      isoWeek: isoWeekOf(cur),
      year: cur.getFullYear(),
      label: cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      isCurrent,
      startsNewMonth,
    });
    cur.setDate(cur.getDate() + 7);
  }

  // 5. Resolve each placed block to its weekHeaders index range.
  const headerIndexFor = (d: Date): number => {
    const iso = toLocalIso(d);
    // weekHeaders is sorted ascending by weekStartIso. Linear scan is
    // fine — ≤ ~50 weeks typical.
    for (let i = 0; i < weekHeaders.length; i++) {
      if (weekHeaders[i]!.weekStartIso === iso) return i;
    }
    return -1;
  };
  const blockSegments: TimelineBlockSegment[] = [];
  for (const p of placed) {
    const startIdx = headerIndexFor(p.startMonday);
    if (startIdx < 0) continue; // shouldn't happen — window covers all blocks
    const endIdx = Math.min(startIdx + p.weeks - 1, weekHeaders.length - 1);
    const isActive =
      todayMonday.getTime() >= p.startMonday.getTime() &&
      todayMonday.getTime() < p.startMonday.getTime() + p.weeks * MS_PER_WEEK;
    blockSegments.push({
      blockId: p.block.id,
      name: p.block.name,
      kind: p.block.kind,
      ...(p.block.seventhWeekKind ? { seventhWeekKind: p.block.seventhWeekKind } : {}),
      startWeekIndex: startIdx,
      endWeekIndex: endIdx,
      isStarted: p.isStarted,
      isCompleted: !!p.block.completedAt,
      isActive,
      includesDeload: p.block.includesDeload,
      weeks: p.weeks,
      source: p.block,
    });
  }

  // 6. Race milestones — snap each to its week column.
  const raceMilestones: TimelineRaceMilestone[] = [];
  for (const r of races) {
    const rd = new Date(r.date);
    const rMon = isoMondayOf(rd);
    const idx = headerIndexFor(rMon);
    if (idx < 0) continue;
    raceMilestones.push({
      raceId: r.id,
      name: r.name,
      ...(r.kind ? { kind: r.kind } : {}),
      dateIso: toLocalIso(rd),
      weekIndex: idx,
    });
  }

  // 7. Today.
  let currentWeekIndex = -1;
  for (let i = 0; i < weekHeaders.length; i++) {
    if (weekHeaders[i]!.isCurrent) {
      currentWeekIndex = i;
      break;
    }
  }

  return { weekHeaders, blockSegments, raceMilestones, currentWeekIndex };
}
