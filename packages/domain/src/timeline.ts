// timeline.ts — pure model builder for the /calendar?view=timeline
// macrocycle view. Takes the user's blocks + races + today + a window
// configuration and returns a structured set of week-aligned segments
// the renderer can lay out without any further date math.
//
// Domain rules baked in:
//   - Each block spans `weeksBeforeDeload` weeks (seventh-week blocks
//     are always 1 week). The kind chip ('leader' / 'anchor' /
//     'standalone' / 'seventh-week') drives the colour; for
//     seventh-week blocks we surface the variant ('tm-test' /
//     'pr-test' / 'deload') in the label.
//   - Blocks with `startedAt` are anchored to real dates. Blocks
//     without `startedAt` (planned-but-not-started, materialised by
//     /program/new + chain ahead-of-time) project forward by chaining
//     off the previous block's end date.
//   - "Today" anchors a vertical marker. Race milestones snap to the
//     week column they fall in.
//   - The time window covers EVERY known block + race, padded by
//     `paddingWeeks` on both sides — never crops a known event.

import type { ProgramBlock, BlockKind } from './blocks';
import type { SeventhWeekKind, WendlerWeek } from './types';

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
  /**
   * Active block + cursor anchor. When provided (the normal case in
   * the app), the timeline anchors the named block to today minus the
   * already-trained weeks of the current block — e.g. cursor.week=2
   * means today is in Week 2, so block startMonday = today's Monday
   * minus 1 week. Peer blocks (same programId, ordered by
   * sequenceIndex) chain off the anchor — predecessors backward,
   * successors forward. This is more reliable than the per-block
   * `startedAt` field, which is often missing or stale on legacy data.
   *
   * When omitted, falls back to the previous heuristic (each block
   * anchored by its own startedAt / completedAt date, planned blocks
   * chained off the latest-ending placed block).
   */
  anchor?: {
    activeBlockId: string;
    /** Wendler week the user is currently training (1, 2, 3, deload, or 7w). */
    cursorWeek: WendlerWeek;
  };
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

function blockWeekCount(block: Pick<ProgramBlock, 'weeksBeforeDeload' | 'kind'>): number {
  if (block.kind === 'seventh-week') return 1;
  return block.weeksBeforeDeload;
}

/**
 * Build the timeline model. Pure — call from React with the latest
 * Dexie reads + `new Date()`. Idempotent.
 *
 * Block-ordering rules:
 *   - Started blocks (have `startedAt`) anchor to their real Monday.
 *   - Completed blocks without `startedAt` (legacy data — older
 *     records were stamped with only `completedAt`) anchor BACKWARDS
 *     from `completedAt` by their week count, placing them in the
 *     historical past where they belong rather than chained into the
 *     future.
 *   - Truly unstarted/planned blocks (no startedAt AND no completedAt)
 *     chain in `sequenceIndex` order off the END of the most-recent
 *     placed block. Falls back to today's Monday when no started
 *     block exists.
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

  // 1. Bucket blocks by what date anchor we can use.
  //   - `started`: have startedAt → anchor forward from there.
  //   - `historicalCompleted`: missing startedAt but have completedAt
  //     → anchor backward from completedAt by week count. These are
  //     historical blocks that were stamped only with completedAt at
  //     migration time (sequenceIndex hints at order but is not a
  //     date).
  //   - `planned`: no startedAt and no completedAt → chain into the
  //     future off the last placed block.
  const started = blocks.filter((b) => !!b.startedAt);
  const historicalCompleted = blocks.filter((b) => !b.startedAt && !!b.completedAt);
  const planned = blocks.filter((b) => !b.startedAt && !b.completedAt);

  started.sort((a, b) => (a.startedAt! < b.startedAt! ? -1 : 1));
  historicalCompleted.sort((a, b) => {
    // Most-completed-recently last so they line up chronologically with
    // started blocks. If completedAt ties, fall back to sequenceIndex.
    if (a.completedAt !== b.completedAt) {
      return (a.completedAt ?? '') < (b.completedAt ?? '') ? -1 : 1;
    }
    return (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0);
  });
  planned.sort((a, b) => {
    const ai = a.sequenceIndex ?? Number.MAX_SAFE_INTEGER;
    const bi = b.sequenceIndex ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1;
  });

  interface Placed {
    block: ProgramBlock;
    startMonday: Date;
    weeks: number;
    isStarted: boolean;
  }
  const placed: Placed[] = [];

  // ANCHOR-DRIVEN PLACEMENT (preferred path) — when an anchor is
  // provided, place the active block based on the schedule cursor
  // ('we are training week N right now → block startMonday = today's
  // Monday minus (N - 1) weeks') and chain its same-program peers
  // by sequenceIndex backward and forward. This is reliable even
  // when startedAt / completedAt are missing or stale on legacy
  // blocks. Standalone blocks (no programId) AND blocks outside the
  // active program still fall through to the date-based heuristic.
  let placedIdSet: Set<string> = new Set();
  if (config.anchor) {
    const activeBlock = blocks.find((b) => b.id === config.anchor!.activeBlockId);
    if (activeBlock) {
      const cursorWeek = config.anchor.cursorWeek;
      // How many full weeks of the block are already trained.
      // Week 1 → 0; Week 2 → 1; Week 3 → 2; Deload → weeksBeforeDeload.
      // 7w block → 0 (single week).
      let weeksAlreadyIn = 0;
      if (cursorWeek === 'deload') {
        weeksAlreadyIn = activeBlock.weeksBeforeDeload;
      } else if (cursorWeek === '7w') {
        weeksAlreadyIn = 0;
      } else {
        weeksAlreadyIn = Math.max(0, (cursorWeek as 1 | 2 | 3) - 1);
      }
      const activeStartMonday = new Date(todayMonday);
      activeStartMonday.setDate(activeStartMonday.getDate() - weeksAlreadyIn * 7);
      placed.push({
        block: activeBlock,
        startMonday: activeStartMonday,
        weeks: blockWeekCount(activeBlock),
        isStarted: true,
      });
      placedIdSet.add(activeBlock.id);

      // Same-program peers, ordered by sequenceIndex.
      const peers = blocks
        .filter(
          (b) =>
            b.id !== activeBlock.id &&
            b.programId !== undefined &&
            b.programId === activeBlock.programId,
        )
        .sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
      const activeSeq = activeBlock.sequenceIndex ?? 0;
      const predecessors = peers.filter((b) => (b.sequenceIndex ?? 0) < activeSeq);
      const successors = peers.filter((b) => (b.sequenceIndex ?? 0) > activeSeq);

      // Predecessors — walk backward from active block's start.
      let cursorMonday = new Date(activeStartMonday);
      for (let i = predecessors.length - 1; i >= 0; i--) {
        const b = predecessors[i]!;
        const weeks = blockWeekCount(b);
        const start = new Date(cursorMonday);
        start.setDate(start.getDate() - weeks * 7);
        placed.push({ block: b, startMonday: start, weeks, isStarted: true });
        placedIdSet.add(b.id);
        cursorMonday = start;
      }

      // Successors — walk forward from active block's end.
      const activeEnd = new Date(activeStartMonday);
      activeEnd.setDate(activeEnd.getDate() + blockWeekCount(activeBlock) * 7);
      cursorMonday = activeEnd;
      for (const b of successors) {
        const weeks = blockWeekCount(b);
        placed.push({
          block: b,
          startMonday: new Date(cursorMonday),
          weeks,
          isStarted: false,
        });
        placedIdSet.add(b.id);
        cursorMonday = new Date(cursorMonday);
        cursorMonday.setDate(cursorMonday.getDate() + weeks * 7);
      }
    }
  }

  // FALLBACK PATH — for any block NOT placed via the anchor path
  // (standalone blocks, blocks in other programs, or when no anchor
  // was supplied): use the per-block date heuristic.
  const fallbackStarted = started.filter((b) => !placedIdSet.has(b.id));
  const fallbackHistorical = historicalCompleted.filter((b) => !placedIdSet.has(b.id));
  const fallbackPlanned = planned.filter((b) => !placedIdSet.has(b.id));
  // 2a. Historical completed blocks — anchor each backward from
  // completedAt. End up in the past where they actually were trained.
  for (const b of fallbackHistorical) {
    const weeks = blockWeekCount(b);
    const endMonday = isoMondayOf(new Date(b.completedAt!));
    const startMonday = new Date(endMonday);
    startMonday.setDate(startMonday.getDate() - weeks * 7);
    placed.push({ block: b, startMonday, weeks, isStarted: false });
  }

  // 2b. Started blocks — anchor forward from startedAt.
  for (const b of fallbackStarted) {
    placed.push({
      block: b,
      startMonday: isoMondayOf(new Date(b.startedAt!)),
      weeks: blockWeekCount(b),
      isStarted: true,
    });
  }

  // 2c. Planned blocks — chain after the latest-ending placed block,
  // or today's Monday if no anchored block exists. Process in
  // sequenceIndex order.
  let chainCursor: Date | null = null;
  for (const p of placed) {
    const end = new Date(p.startMonday);
    end.setDate(end.getDate() + p.weeks * 7);
    if (!chainCursor || end.getTime() > chainCursor.getTime()) {
      chainCursor = end;
    }
  }
  if (!chainCursor || chainCursor.getTime() < todayMonday.getTime()) {
    chainCursor = todayMonday;
  }
  for (const b of fallbackPlanned) {
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
