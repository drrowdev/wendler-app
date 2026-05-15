/**
 * Return-to-train recommender.
 *
 * After the user marks an illness recovered, this function looks at:
 *   - the illness itself (severity, duration)
 *   - where the user is in the program (cycle, week, block phase)
 *   - their recent strength trajectory (e1RM trend, AMRAP performance)
 *   - upcoming high-priority races (taper.ts territory)
 *   - any pain flags clustered around the illness window
 *
 * …and returns a single named strategy with plain-English rationale and a
 * small set of less-recommended alternatives.
 *
 * The function is intentionally **pure** and has no DB or React deps — the
 * web layer feeds it preassembled data and calls `applyReturnPlan` to
 * realize whatever the user accepts. Only the "drop TM" intent is wired
 * to actually mutate state in v1; the structural strategies (replay week,
 * restart cycle, ramp) are advisory and the user adjusts the block via
 * existing block-editor primitives. This is deliberate: silent block
 * surgery is risky, and the *recommendation* is the high-value bit.
 */

import type { MainLift, WendlerWeek } from './types';
import type { MinimalSet } from './analytics';
import { bestE1rmSeries } from './analytics';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type IllnessSeverity = 'mild' | 'moderate' | 'severe';

export interface IllnessSignal {
  severity: IllnessSeverity;
  /** ISO date "YYYY-MM-DD" the user started feeling unwell. */
  startedAt: string;
  /** ISO date "YYYY-MM-DD" the user marked recovered. Required for a return plan. */
  recoveredAt: string;
}

export type BlockPhase =
  | 'standard'         // 5/3/1 leader/anchor/standalone, mid-cycle
  | 'deload'           // deload week
  | 'seventh-week'     // 7th-week protocol
  | 'meet-prep';       // taper into A-race or PR test

export interface BlockState {
  /** Current cycle number (1-based). */
  cycleNumber: number;
  /** Current week within the cycle. */
  week: WendlerWeek;
  /** What kind of week this is — drives strategy. */
  phase: BlockPhase;
  /**
   * Days into the user's normal training week that the recovery happened
   * (0..6, Mon=0). Used to prefer "extend deload" vs. "replay week".
   * Optional — when absent, treated as mid-week.
   */
  weekDayOnReturn?: number;
}

export interface RaceSignal {
  /** ISO date "YYYY-MM-DD" of the race. */
  date: string;
  /** A | B | C — only A and B influence the recommendation. */
  priority: 'A' | 'B' | 'C';
}

export interface RecoverySignal {
  /** ISO date "YYYY-MM-DD". */
  date: string;
  fatigue?: number;  // 1 (fresh) – 10 (wrecked)
  hrv?: number;
}

export interface PainFlagSignal {
  /** ISO date "YYYY-MM-DD" the flag was set. */
  date: string;
}

export interface ReturnPlanInput {
  illness: IllnessSignal;
  blockState: BlockState;
  /** All counted sets across the user's history. Used for e1RM trend & AMRAP analysis. */
  sets: MinimalSet[];
  /** Movement IDs that map to each main lift, for trend analysis. */
  mainLiftMovementIds?: Partial<Record<MainLift, string>>;
  /** Upcoming races (next ~6 weeks is sufficient). */
  upcomingRaces?: RaceSignal[];
  /** Recovery entries from the days right after recovery (last 0–3 days). */
  recoveryAfter?: RecoverySignal[];
  /** Pain flags during or near the illness window. */
  painFlags?: PainFlagSignal[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type ReturnStrategy =
  | 'resume-as-scheduled'
  | 'skip-amrap-today'
  | 'replay-current-week'
  | 'extend-deload'
  | 'restart-cycle-tm-hold'
  | 'restart-cycle-tm-down-5'
  | 'reset-with-ramp'
  | 'reschedule-meet';

export interface ReturnPlan {
  strategy: ReturnStrategy;
  /** Short headline (≤80 chars) suitable as a card title. */
  headline: string;
  /** Plain-English rationale referencing the signals that drove the decision. */
  rationale: string;
  /**
   * Optional automated edit to apply on accept. Only `dropTmPercent` is
   * wired in v1 — everything else is advisory and the user updates the
   * block manually via the existing editor.
   */
  tmAdjustmentPercent?: number; // e.g. -0.05 for "drop TM 5%"
  confidence: 'high' | 'medium' | 'low';
}

export interface ReturnPlanResult {
  primary: ReturnPlan;
  alternatives: ReturnPlan[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(a: string, b: string): number {
  // Both inputs are YYYY-MM-DD; using UTC midnight makes the diff DST-safe.
  const ta = Date.UTC(
    Number(a.slice(0, 4)),
    Number(a.slice(5, 7)) - 1,
    Number(a.slice(8, 10)),
  );
  const tb = Date.UTC(
    Number(b.slice(0, 4)),
    Number(b.slice(5, 7)) - 1,
    Number(b.slice(8, 10)),
  );
  return Math.round((tb - ta) / MS_PER_DAY);
}

/** Inclusive day count out (mild cold same-day = 1 day). */
export function illnessDaysOut(illness: IllnessSignal): number {
  const d = daysBetween(illness.startedAt, illness.recoveredAt);
  return Math.max(1, d + 1);
}

/**
 * Returns "rising" if the e1RM trendline over the last `weeks` weeks is
 * meaningfully positive, "flat" if borderline, "falling" if negative,
 * "unknown" with too little data. Uses simple linear regression slope on
 * best-e1rm-per-day points.
 */
export type TrendDirection = 'rising' | 'flat' | 'falling' | 'unknown';

export function e1rmTrend(
  sets: MinimalSet[],
  movementId: string,
  asOf: string,
  weeks = 6,
): TrendDirection {
  const cutoff = new Date(Date.UTC(
    Number(asOf.slice(0, 4)),
    Number(asOf.slice(5, 7)) - 1,
    Number(asOf.slice(8, 10)),
  ));
  cutoff.setUTCDate(cutoff.getUTCDate() - weeks * 7);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const series = bestE1rmSeries(sets, movementId).filter((p) => p.date >= cutoffIso);
  if (series.length < 3) return 'unknown';

  // Cadence-independent slope: regress e1RM against actual day-of-year, not
  // against the data-point index. A 2×/week lifter and a 1×/week lifter
  // making the same true progress per calendar week should both report
  // the same %/week. Before this fix, slopePerPoint was halved for a 2×
  // cadence (more points spread over the same calendar span), so the
  // ±0.6 %/week threshold fired at different actual rates of progress.
  //
  // Also require a meaningful time span (≥ 14 calendar days between
  // first and last point); 3 points clustered into a single week make
  // for a noisy slope estimate.
  const epochDays = (ymd: string): number =>
    Math.floor(new Date(`${ymd}T00:00:00Z`).getTime() / 86400000);
  const xs = series.map((p) => epochDays(p.date));
  const spanDays = xs[xs.length - 1]! - xs[0]!;
  if (spanDays < 14) return 'unknown';
  const x0 = xs[0]!;
  const xRel = xs.map((x) => x - x0);
  const ys = series.map((p) => p.e1rm);
  const meanX = xRel.reduce((a, b) => a + b, 0) / xRel.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xRel.length; i++) {
    num += (xRel[i]! - meanX) * (ys[i]! - meanY);
    den += (xRel[i]! - meanX) ** 2;
  }
  if (den === 0) return 'flat';
  const slopePerDay = num / den; // kg per calendar day
  const slopePerWeek = slopePerDay * 7;
  const pctPerWeek = (slopePerWeek / meanY) * 100;
  if (pctPerWeek > 0.6) return 'rising';
  if (pctPerWeek < -0.6) return 'falling';
  return 'flat';
}

/**
 * Compares the user's last AMRAP set on a given lift against its prescribed
 * rep count. Returns:
 *   - 'crushing' when reps_logged - reps_prescribed >= 3
 *   - 'on-target' when within ±2
 *   - 'struggling' when reps_logged - reps_prescribed <= -2
 *   - 'unknown' when no recent AMRAP can be found
 */
export type AmrapPerformance = 'crushing' | 'on-target' | 'struggling' | 'unknown';

export function lastAmrapPerformance(sets: MinimalSet[], movementId: string): AmrapPerformance {
  const amraps = sets
    .filter(
      (s) =>
        s.movementId === movementId &&
        !s.deletedAt &&
        !s.skipped &&
        s.isAmrap &&
        s.reps > 0,
    )
    .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1));
  if (amraps.length === 0) return 'unknown';
  const last = amraps[0]!;
  // Prescribed reps for AMRAP sets in 5/3/1: w1=5, w2=3, w3=1.
  // We don't know which week without more context; infer from the rep target
  // commonly set by the app via percentOfTm, but a robust shortcut is the
  // expected floor (5 for w1, 3 for w2, 1 for w3). Anything ≥ floor + 3 is
  // crushing; floor ± 2 is on-target; below floor − 2 is struggling.
  // Without explicit week metadata, fall back to absolute thresholds:
  //   ≥ 8 reps → crushing, 3–7 → on-target, ≤2 → struggling.
  if (last.reps >= 8) return 'crushing';
  if (last.reps <= 2) return 'struggling';
  return 'on-target';
}

function nextHighPriorityRace(
  illness: IllnessSignal,
  races: RaceSignal[] | undefined,
): { race: RaceSignal; weeksAway: number } | null {
  if (!races || races.length === 0) return null;
  const recoveredAt = illness.recoveredAt;
  let best: { race: RaceSignal; weeksAway: number } | null = null;
  for (const r of races) {
    if (r.priority === 'C') continue;
    const days = daysBetween(recoveredAt, r.date);
    if (days < 0) continue; // already passed
    const weeksAway = days / 7;
    if (!best || weeksAway < best.weeksAway) best = { race: r, weeksAway };
  }
  return best;
}

function painFlagsInWindow(
  illness: IllnessSignal,
  flags: PainFlagSignal[] | undefined,
): number {
  if (!flags) return 0;
  const startedAt = illness.startedAt;
  const recoveredAt = illness.recoveredAt;
  return flags.filter((f) => f.date >= startedAt && f.date <= recoveredAt).length;
}

function avgFatigue(recovery: RecoverySignal[] | undefined): number | null {
  if (!recovery || recovery.length === 0) return null;
  const vals = recovery.map((r) => r.fatigue).filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ---------------------------------------------------------------------------
// Recommendation engine
// ---------------------------------------------------------------------------

interface NamedPlan extends ReturnPlan {}

function plan(
  strategy: ReturnStrategy,
  headline: string,
  rationale: string,
  opts: { tmAdjustmentPercent?: number; confidence?: ReturnPlan['confidence'] } = {},
): NamedPlan {
  return {
    strategy,
    headline,
    rationale,
    tmAdjustmentPercent: opts.tmAdjustmentPercent,
    confidence: opts.confidence ?? 'medium',
  };
}

/**
 * Compute an aggregate trend across the user's main lifts. Used as a single
 * signal for "are they on a roll?" without the recommender having to know
 * lift-specific context.
 */
function aggregateTrend(input: ReturnPlanInput): TrendDirection {
  const ids = Object.values(input.mainLiftMovementIds ?? {}).filter(Boolean) as string[];
  if (ids.length === 0) return 'unknown';
  const trends = ids.map((id) => e1rmTrend(input.sets, id, input.illness.recoveredAt));
  const rising = trends.filter((t) => t === 'rising').length;
  const falling = trends.filter((t) => t === 'falling').length;
  if (rising > falling && rising >= 1) return 'rising';
  if (falling > rising && falling >= 1) return 'falling';
  if (trends.every((t) => t === 'unknown')) return 'unknown';
  return 'flat';
}

function aggregateAmrap(input: ReturnPlanInput): AmrapPerformance {
  const ids = Object.values(input.mainLiftMovementIds ?? {}).filter(Boolean) as string[];
  if (ids.length === 0) return 'unknown';
  const perfs = ids.map((id) => lastAmrapPerformance(input.sets, id));
  if (perfs.includes('struggling')) return 'struggling';
  if (perfs.includes('crushing') && !perfs.includes('struggling')) return 'crushing';
  if (perfs.every((p) => p === 'unknown')) return 'unknown';
  return 'on-target';
}

/**
 * Main entry point. Returns null when the illness has not yet been marked
 * recovered (caller hasn't gathered enough info).
 */
export function recommendReturnPlan(input: ReturnPlanInput): ReturnPlanResult | null {
  const { illness, blockState } = input;
  if (!illness.recoveredAt) return null;

  const daysOut = illnessDaysOut(illness);
  const severity = illness.severity;
  const trend = aggregateTrend(input);
  const amrap = aggregateAmrap(input);
  const painCount = painFlagsInWindow(illness, input.painFlags);
  const fatigue = avgFatigue(input.recoveryAfter);
  const race = nextHighPriorityRace(illness, input.upcomingRaces);

  // ---- Hard override: A-priority race within the taper window ----
  if (race && race.race.priority === 'A' && race.weeksAway <= 4) {
    const weeks = race.weeksAway.toFixed(1);
    return {
      primary: plan(
        'reschedule-meet',
        `A-race in ${weeks} weeks — rebuild taper around recovery`,
        `You have an A-priority race ${weeks} weeks out and were sick ${daysOut} day(s). ` +
          `The remaining taper is too short to absorb the loss — drop intensity to maintenance, ` +
          `keep volume light, and consider whether the race target needs to slide.`,
        { confidence: 'high' },
      ),
      alternatives: [
        plan(
          'replay-current-week',
          'Replay current week, then resume taper',
          `Less conservative: replay this week at reduced load, then continue your scheduled taper. ` +
            `Only choose this if you felt mild and the race is at the high end of the 4-week window.`,
          { confidence: 'low' },
        ),
      ],
    };
  }

  // ---- Severe always pushes to at least restart-with-TM-hold ----
  if (severity === 'severe') {
    if (daysOut >= 14) {
      return {
        primary: plan(
          'reset-with-ramp',
          `Severe illness, ${daysOut} days out — ease back with a ramp week`,
          `After ${daysOut} days down with a severe illness, jumping back into normal load ` +
            `is the fastest way to re-trigger the bug. Spend a week at 50/60/70%, then ` +
            `restart the cycle with TM dropped 10%.`,
          { tmAdjustmentPercent: -0.1, confidence: 'high' },
        ),
        alternatives: [
          plan(
            'restart-cycle-tm-down-5',
            'Restart cycle, TM −5%',
            `If energy is genuinely back, you can skip the ramp week and restart the cycle ` +
              `with TM dropped just 5%. Watch the first week's RPE carefully.`,
            { tmAdjustmentPercent: -0.05, confidence: 'low' },
          ),
        ],
      };
    }
    return {
      primary: plan(
        'restart-cycle-tm-down-5',
        `Severe illness, ${daysOut} days out — restart cycle, TM −5%`,
        `Severe symptoms (fever / body aches / gut) leave residual fatigue even after they pass. ` +
          `Restart this cycle from week 1 with TM dropped 5% — the next AMRAP will tell you ` +
          `whether to recover the lost percent next cycle or hold.`,
        { tmAdjustmentPercent: -0.05, confidence: 'high' },
      ),
      alternatives: [
        plan(
          'restart-cycle-tm-hold',
          'Restart cycle, hold TM',
          `Less conservative: restart at the same TM. Safer if you only had one or two truly bad days.`,
          { confidence: 'low' },
        ),
      ],
    };
  }

  // ---- 14+ days out (any severity) ----
  if (daysOut >= 14) {
    return {
      primary: plan(
        'reset-with-ramp',
        `${daysOut} days off — week of 50/60/70% ramp first`,
        `Two-plus weeks without lifting cost real strength. Spend one week at 50/60/70% to ` +
          `re-groove the bar path, then restart the cycle with TM dropped 5%.`,
        { tmAdjustmentPercent: -0.05, confidence: 'high' },
      ),
      alternatives: [
        plan(
          'restart-cycle-tm-down-5',
          'Skip the ramp, restart with TM −5%',
          `If you stayed active during recovery (walks, light bodyweight work), you can skip ` +
            `the ramp week.`,
          { tmAdjustmentPercent: -0.05, confidence: 'low' },
        ),
      ],
    };
  }

  // ---- 7–13 days out ----
  if (daysOut >= 7) {
    return {
      primary: plan(
        'restart-cycle-tm-down-5',
        `${daysOut} days out — restart cycle, TM −5%`,
        `A full week-plus off is enough to regress 5–8% on AMRAPs. Restart from week 1 with ` +
          `TM dropped 5% so the prescribed loads still feel ` +
          `like a 5/3/1 cycle, not a max effort.`,
        { tmAdjustmentPercent: -0.05, confidence: 'high' },
      ),
      alternatives: [
        plan(
          'restart-cycle-tm-hold',
          'Restart cycle, hold TM',
          `Hold TM if you felt mild and were getting steady walks in.`,
          { confidence: 'medium' },
        ),
      ],
    };
  }

  // ---- 5–6 days out ----
  if (daysOut >= 5) {
    return {
      primary: plan(
        'restart-cycle-tm-hold',
        `${daysOut} days out — restart cycle, hold TM`,
        `Almost a full week off — prescribed loads will still feel right, but the ` +
          `cycle's accumulated fatigue is gone. Restart from week 1 at the same TM and ` +
          `treat the first AMRAP as your read on whether you've held strength.`,
        { confidence: 'high' },
      ),
      alternatives: [
        plan(
          'replay-current-week',
          'Replay this week instead',
          `Less disruptive to the cycle if you felt mild and only missed two sessions. ` +
            `Skip AMRAP on the first day back.`,
          { confidence: 'low' },
        ),
      ],
    };
  }

  // ---- Sick during deload ----
  if (blockState.phase === 'deload') {
    return {
      primary: plan(
        'extend-deload',
        `${daysOut} day(s) sick during deload — extend deload, then resume`,
        `Deload exists to dump fatigue — being sick already did that. Skip the missed ` +
          `deload sessions, take an extra rest day or two if energy isn't quite back, then ` +
          `start the next cycle as scheduled.`,
        { confidence: 'high' },
      ),
      alternatives: [
        plan(
          'resume-as-scheduled',
          'Resume the cycle on the original date',
          `If you feel fully recovered, just start the next cycle on the day you'd planned.`,
          { confidence: 'medium' },
        ),
      ],
    };
  }

  // ---- 3–4 days out, mid-cycle ----
  if (daysOut >= 3) {
    let conf: ReturnPlan['confidence'] = 'high';
    let extraNote = '';
    if (trend === 'rising' && amrap !== 'struggling') {
      extraNote =
        ` Your e1RM was trending up before this — replaying protects that progress without ` +
        `the disruption of a full restart.`;
    } else if (amrap === 'struggling' || painCount > 0) {
      extraNote =
        ` Your last AMRAP(s) were already light or you flagged pain during the illness — ` +
        `take this week conservatively, no AMRAP, before deciding whether to push next week.`;
      conf = 'medium';
    }
    return {
      primary: plan(
        'replay-current-week',
        `${daysOut} day(s) out mid-cycle — replay this week, no AMRAP`,
        `Re-do this week at prescribed loads but cap reps at the prescribed number ` +
          `(no AMRAP). Then continue the cycle from where you'd planned to be next week.${extraNote}`,
        { confidence: conf },
      ),
      alternatives: [
        plan(
          'restart-cycle-tm-hold',
          'Restart the cycle, hold TM',
          `More conservative — useful if you're still feeling residual fatigue after the first ` +
            `working set today.`,
          { confidence: 'low' },
        ),
      ],
    };
  }

  // ---- 1–2 days out (mild/moderate) ----
  if (severity === 'mild' && daysOut <= 2) {
    if (fatigue !== null && fatigue >= 7) {
      return {
        primary: plan(
          'replay-current-week',
          'Mild but high fatigue — replay this week, no AMRAP',
          `Only 1–2 days off but post-recovery fatigue is high (${fatigue.toFixed(1)}/10). ` +
            `Replay this week without AMRAP rather than resuming straight onto a heavy day.`,
          { confidence: 'medium' },
        ),
        alternatives: [
          plan(
            'skip-amrap-today',
            'Just skip today\'s AMRAP and continue',
            `If today's first warm-up moves well, you can drop to just skipping the AMRAP ` +
              `and continuing the cycle.`,
            { confidence: 'low' },
          ),
        ],
      };
    }
    return {
      primary: plan(
        'skip-amrap-today',
        `${daysOut} day(s) mild — skip today's AMRAP, otherwise resume`,
        `A short, mild illness (head cold, sniffles) doesn't usually erode strength. ` +
          `Drop today's AMRAP set so you don't push intensity on day one back, then ` +
          `continue the cycle normally.`,
        { confidence: 'high' },
      ),
      alternatives: [
        plan(
          'resume-as-scheduled',
          'Resume exactly as planned',
          `If today's warm-ups feel snappy, you can take the AMRAP too. Stop early if rep ` +
            `quality drops.`,
          { confidence: 'medium' },
        ),
      ],
    };
  }

  // ---- 1–2 days moderate ----
  return {
    primary: plan(
      'replay-current-week',
      `${daysOut} day(s) moderate — replay this week, no AMRAP`,
      `Even short moderate illness (chest cold, body aches) leaves enough residual fatigue ` +
        `that pushing intensity day one back tends to backfire. Re-do this week at prescribed ` +
        `loads without AMRAP, then continue.`,
      { confidence: 'medium' },
    ),
    alternatives: [
      plan(
        'skip-amrap-today',
        `Skip today's AMRAP and resume`,
        `If you bounced back fast, you can drop to just skipping today's AMRAP.`,
        { confidence: 'low' },
      ),
    ],
  };
}
