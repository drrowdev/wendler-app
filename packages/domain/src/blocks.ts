import type { MainLift, WendlerWeek } from './types';
import type { SupplementalTemplateId } from './supplemental';

export type BlockKind = 'leader' | 'anchor' | 'standalone';

export interface ProgramBlock {
  id: string;
  name: string;
  kind: BlockKind;
  /** Number of training weeks before deload. Wendler standard: 3. */
  weeksBeforeDeload: number;
  /** Whether the block ends with a deload week. Anchors usually have no deload. */
  includesDeload: boolean;
  supplementalTemplate: SupplementalTemplateId;
  /**
   * Optional per-lift TM% override. If unset for a lift, falls back to the user's defaultTmPercent.
   * Wendler convention: Leader 85%, Anchor 85-90% (lifts may use different values).
   */
  tmPercentByLift?: Partial<Record<MainLift, number>>;
  /** ISO date the block started. */
  startedAt?: string;
  /** ISO date the block was completed. */
  completedAt?: string;
  createdAt: string;
}

/**
 * The 4-day rotation: which lift is trained on which day-of-rotation (0..3).
 * Wendler Forever default: Press, Deadlift, Bench, Squat.
 */
export const DEFAULT_DAY_ORDER: MainLift[] = ['press', 'deadlift', 'bench', 'squat'];

export interface ProgramSchedule {
  /** Always 'singleton'. */
  id: 'singleton';
  dayOrder: MainLift[];
  /** Active block ID, if any. */
  activeBlockId?: string;
  /** 1-based day index within the active block (1..4 days × 3 weeks = 12 sessions per block + 4 deload). */
  cursor?: {
    blockId: string;
    week: WendlerWeek;
    dayIndex: number; // 0..(dayOrder.length - 1)
  };
  updatedAt: string;
}

/**
 * Total sessions in a block: dayOrder × (weeksBeforeDeload + (includesDeload ? 1 : 0)).
 */
export function totalSessionsInBlock(block: ProgramBlock, dayOrder: MainLift[]): number {
  const weeks = block.weeksBeforeDeload + (block.includesDeload ? 1 : 0);
  return weeks * dayOrder.length;
}

/**
 * Advance the cursor by one session. Returns null when the block is complete.
 */
export function advanceCursor(
  cursor: { week: WendlerWeek; dayIndex: number },
  block: ProgramBlock,
  dayOrder: MainLift[],
): { week: WendlerWeek; dayIndex: number } | null {
  const nextDay = cursor.dayIndex + 1;
  if (nextDay < dayOrder.length) {
    return { week: cursor.week, dayIndex: nextDay };
  }
  // Wrap to next week
  const weekOrder: WendlerWeek[] = [1, 2, 3];
  if (block.includesDeload) weekOrder.push('deload');
  const idx = weekOrder.indexOf(cursor.week);
  if (idx === -1 || idx === weekOrder.length - 1) return null;
  const nextWeek = weekOrder[idx + 1]!;
  return { week: nextWeek, dayIndex: 0 };
}

/**
 * Resolve the TM% for a lift in a given block, falling back to a default.
 */
export function tmPercentForLift(
  block: ProgramBlock,
  lift: MainLift,
  defaultTmPercent: number,
): number {
  return block.tmPercentByLift?.[lift] ?? defaultTmPercent;
}
