/**
 * Goal evaluation helpers (v1).
 *
 * The Goals page is the user's stated north-star surface for the app — but
 * historically it was a notepad. These helpers wire goals into Today and
 * Analytics by computing a uniform `GoalSummary` shape:
 *
 * - Hard goals (`strength-pr`, `race-time`, `body-comp`, `habit`) get a
 *   numeric `progressPct` against current data when the metric exists.
 * - Qualitative goals are display-only by default; opt-in to a
 *   `'strength-trend'` signal to render an 8-week e1RM sparkline (e.g.
 *   the "getting stronger" goal).
 *
 * The Goal interface lives in @wendler/db-schema; we accept a structural
 * subset here to avoid a domain → db-schema dep cycle.
 */
import { nextRaceWindow } from './taper';

export type GoalKindLike =
  | 'strength-pr'
  | 'race-time'
  | 'body-comp'
  | 'habit'
  | 'qualitative'
  | 'custom';

export type GoalSignalLike = 'none' | 'strength-trend';

/** Structural shape we consume — matches Goal in db-schema. */
export interface GoalLike {
  id: string;
  kind: GoalKindLike;
  title: string;
  target?: number;
  targetUnit?: string;
  deadline?: string;
  signal?: GoalSignalLike;
  /** Movement.id this strength-pr goal is anchored to (when kind === 'strength-pr'). */
  movementId?: string;
  notes?: string;
  createdAt: string;
  completedAt?: string;
}

export type GoalStatus = 'on-track' | 'close' | 'far' | 'achieved';

export interface StrengthTrend {
  /** Percentage change vs the value `weeks` ago. Positive = stronger. */
  deltaPct: number;
  direction: 'up' | 'flat' | 'down';
  /** Up to ~8 normalized values, oldest first, for sparkline rendering. */
  sparkline: number[];
  /** How many weeks the trend covers (may be < `weeks` if data is shorter). */
  weeksCovered: number;
}

export interface DeadlineInfo {
  daysOut: number;
  /** Human label e.g. "12d left", "today", "3w left", "5d overdue". */
  label: string;
}

/**
 * Uniform shape consumed by Today + Analytics. Optional fields render only
 * when present, so qualitative goals just show {label, sublabel}.
 */
export interface GoalSummary {
  goalId: string;
  kind: GoalKindLike;
  /** Always set — typically the goal title. */
  label: string;
  /** Optional secondary line (e.g. "180 / 200 kg", notes for qualitative). */
  sublabel?: string;
  /** 0..1 progress for hard goals. Omitted for qualitative. */
  progressPct?: number;
  status?: GoalStatus;
  deadline?: DeadlineInfo;
  trend?: StrengthTrend;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

export function deadlineInfo(deadline: string | undefined, now = new Date()): DeadlineInfo | undefined {
  if (!deadline) return undefined;
  const ms = new Date(deadline).getTime() - now.getTime();
  const daysOut = Math.round(ms / DAY_MS);
  let label: string;
  if (daysOut < 0) label = `${-daysOut}d overdue`;
  else if (daysOut === 0) label = 'today';
  else if (daysOut < 14) label = `${daysOut}d left`;
  else if (daysOut < 90) label = `${Math.round(daysOut / 7)}w left`;
  else label = `${Math.round(daysOut / 30)}mo left`;
  return { daysOut, label };
}

function statusFromPct(pct: number): GoalStatus {
  if (pct >= 1) return 'achieved';
  if (pct >= 0.85) return 'close';
  if (pct >= 0.5) return 'on-track';
  return 'far';
}

/* ------------------------------------------------------------------ */
/* Hard goal evaluators                                               */
/* ------------------------------------------------------------------ */

export function evaluateStrengthPrGoal(
  goal: GoalLike,
  latestE1rmKg: number | undefined,
): { progressPct: number; status: GoalStatus } | undefined {
  if (goal.kind !== 'strength-pr' || !goal.target || goal.target <= 0) return undefined;
  if (latestE1rmKg === undefined || latestE1rmKg <= 0) {
    return { progressPct: 0, status: 'far' };
  }
  const pct = Math.max(0, Math.min(1, latestE1rmKg / goal.target));
  return { progressPct: pct, status: statusFromPct(pct) };
}

export function evaluateHabitGoal(
  goal: GoalLike,
  sessionsSinceCreated: number,
): { progressPct: number; status: GoalStatus } | undefined {
  if (goal.kind !== 'habit' || !goal.target || goal.target <= 0) return undefined;
  const pct = Math.max(0, Math.min(1, sessionsSinceCreated / goal.target));
  return { progressPct: pct, status: statusFromPct(pct) };
}

export function evaluateRaceGoal(goal: GoalLike, now = new Date()) {
  if (goal.kind !== 'race-time') return undefined;
  return nextRaceWindow({ goals: [goal], now });
}

/* ------------------------------------------------------------------ */
/* Qualitative: strength trend                                        */
/* ------------------------------------------------------------------ */

export interface E1rmSample {
  /** ISO timestamp the e1RM was observed (best-set day). */
  performedAt: string;
  /** Lift identifier (used to normalize per-lift before averaging). */
  lift: string;
  e1rmKg: number;
}

/**
 * Normalize a per-lift series, then average across lifts into a single
 * weekly trend over the last `weeks` weeks. Returns deltaPct relative to
 * the oldest available point in the window.
 *
 * Normalization: each lift's series is divided by that lift's first value
 * inside the window, so heavy lifts (deadlift) don't dominate light lifts
 * (press) when averaged. Output sparkline is unitless (1.0 = baseline).
 */
export function evaluateStrengthTrend(
  samples: E1rmSample[],
  now = new Date(),
  weeks = 8,
): StrengthTrend | undefined {
  if (!samples.length) return undefined;
  const horizonMs = weeks * 7 * DAY_MS;
  const cutoff = now.getTime() - horizonMs;

  const inWindow = samples.filter((s) => new Date(s.performedAt).getTime() >= cutoff);
  if (inWindow.length < 2) return undefined;

  // Bucket by ISO week within the window.
  const byLift = new Map<string, E1rmSample[]>();
  for (const s of inWindow) {
    const arr = byLift.get(s.lift) ?? [];
    arr.push(s);
    byLift.set(s.lift, arr);
  }
  for (const arr of byLift.values()) {
    arr.sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1));
  }

  // Build weekly buckets across `weeks` slots, oldest first.
  const slotMs = 7 * DAY_MS;
  const slots: number[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const slotStart = now.getTime() - (i + 1) * slotMs;
    const slotEnd = now.getTime() - i * slotMs;
    const perLift: number[] = [];
    for (const arr of byLift.values()) {
      // best e1RM in this slot, else last carry-forward from before.
      const inSlot = arr.filter(
        (s) => new Date(s.performedAt).getTime() >= slotStart && new Date(s.performedAt).getTime() < slotEnd,
      );
      const carry = arr.filter((s) => new Date(s.performedAt).getTime() < slotEnd);
      const candidate = inSlot.length
        ? Math.max(...inSlot.map((s) => s.e1rmKg))
        : carry.length
          ? carry[carry.length - 1]!.e1rmKg
          : undefined;
      const baseline = arr[0]!.e1rmKg;
      if (candidate !== undefined && baseline > 0) {
        perLift.push(candidate / baseline);
      }
    }
    if (perLift.length) {
      slots.push(perLift.reduce((a, b) => a + b, 0) / perLift.length);
    }
  }

  if (slots.length < 2) return undefined;

  const first = slots[0]!;
  const last = slots[slots.length - 1]!;
  const deltaPct = first > 0 ? ((last - first) / first) * 100 : 0;
  let direction: StrengthTrend['direction'] = 'flat';
  if (deltaPct > 1.5) direction = 'up';
  else if (deltaPct < -1.5) direction = 'down';

  return {
    deltaPct: Math.round(deltaPct * 10) / 10,
    direction,
    sparkline: slots,
    weeksCovered: slots.length,
  };
}

/* ------------------------------------------------------------------ */
/* Top-level entry point                                              */
/* ------------------------------------------------------------------ */

export interface SummaryContext {
  /** Latest e1RM by lift (used for strength-pr and aggregated for trend). */
  latestE1rmByLift?: Map<string, number>;
  /** Full e1RM samples (used by strength-trend signal on qualitative goals). */
  e1rmSamples?: E1rmSample[];
  /** Count of completed sessions since each goal's createdAt. Keyed by goal id. */
  sessionsSinceCreated?: Map<string, number>;
  /**
   * For strength-pr goals, the lift the goal targets. The goals editor today
   * doesn't capture this — until it does we approximate with the lift whose
   * latest e1RM is closest to the goal target (caller decides), or pick the
   * max e1RM (caller decides). Pass undefined to fall back to max.
   */
  liftByGoalId?: Map<string, string>;
  now?: Date;
}

export function summarizeGoal(goal: GoalLike, ctx: SummaryContext = {}): GoalSummary {
  const now = ctx.now ?? new Date();
  const summary: GoalSummary = {
    goalId: goal.id,
    kind: goal.kind,
    label: goal.title,
    sublabel: goal.notes,
    deadline: deadlineInfo(goal.deadline, now),
  };

  switch (goal.kind) {
    case 'strength-pr': {
      const liftId = ctx.liftByGoalId?.get(goal.id);
      let latest: number | undefined;
      if (ctx.latestE1rmByLift) {
        latest = liftId
          ? ctx.latestE1rmByLift.get(liftId)
          : Math.max(0, ...[...ctx.latestE1rmByLift.values()]);
        if (latest === 0) latest = undefined;
      }
      const ev = evaluateStrengthPrGoal(goal, latest);
      if (ev) {
        summary.progressPct = ev.progressPct;
        summary.status = ev.status;
        if (goal.target) {
          const cur = latest !== undefined ? Math.round(latest) : '—';
          summary.sublabel = `${cur} / ${goal.target}${goal.targetUnit ? ' ' + goal.targetUnit : ' kg'}`;
        }
      }
      break;
    }
    case 'habit': {
      const count = ctx.sessionsSinceCreated?.get(goal.id) ?? 0;
      const ev = evaluateHabitGoal(goal, count);
      if (ev) {
        summary.progressPct = ev.progressPct;
        summary.status = ev.status;
        if (goal.target) {
          summary.sublabel = `${count} / ${goal.target}${goal.targetUnit ? ' ' + goal.targetUnit : ''}`;
        }
      }
      break;
    }
    case 'race-time': {
      // Race goals already drive the TaperBanner. Show countdown only here.
      // sublabel falls back to notes if no deadline.
      if (summary.deadline) {
        summary.sublabel = `Race in ${summary.deadline.label}`;
      }
      break;
    }
    case 'qualitative': {
      const sig = goal.signal ?? 'none';
      if (sig === 'strength-trend' && ctx.e1rmSamples?.length) {
        const trend = evaluateStrengthTrend(ctx.e1rmSamples, now);
        if (trend) summary.trend = trend;
      }
      // sublabel stays as notes (set above).
      break;
    }
    case 'body-comp':
    case 'custom':
    default:
      // body-comp needs a bodyweight log (deferred). custom is freeform.
      break;
  }

  return summary;
}
