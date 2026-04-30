/**
 * Cross-domain load + recovery analysis (v0.6.0).
 *
 * No external dependencies — operates on minimal record shapes so it can be
 * unit-tested in isolation and called from both the web client and (future)
 * server-side digest jobs.
 */

export interface LoadSet {
  performedAt: string;
  weightKg: number;
  reps: number;
  rpe?: number;
  skipped?: boolean;
  deletedAt?: string;
}

export interface LoadCardio {
  performedAt: string;
  durationSec: number;
  rpe?: number;
}

export interface LoadRecovery {
  /** YYYY-MM-DD */
  id: string;
  sleepHours?: number;
  hrv?: number;
  fatigue?: number;
  soreness?: number;
}

export interface WeeklyLoad {
  /** ISO date of Monday (week start). */
  weekStart: string;
  /** Sum of weight × reps across all completed strength sets, kg. */
  strengthTonnageKg: number;
  /** Sum of cardio durations, minutes. */
  cardioMinutes: number;
  /** Number of distinct days with at least one logged session. */
  trainingDays: number;
  /** Average RPE across completed sets (undefined if none reported). */
  avgRpe?: number;
  /** Average sleep hours over the week from recovery rows (if any). */
  avgSleep?: number;
  /** Mean fatigue score 1-10. */
  avgFatigue?: number;
  /**
   * Composite stress score, 0–100. Transparent recipe:
   *   tonnage   contribution: min(50, tonnageKg / 200)
   *   cardio    contribution: min(20, cardioMinutes / 15)
   *   rpe       contribution: max(0, (avgRpe - 6) * 5)   when reported
   *   recovery  penalty:      max(0, (fatigue - 5) * 2) - max(0, (sleep - 7) * 2)
   * Higher = more accumulated stress; 80+ suggests pulling back.
   */
  stressScore: number;
}

function isoMonday(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // back to Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10);
}

function inWeek(iso: string, weekStart: string): boolean {
  const ws = new Date(weekStart + 'T00:00:00Z').getTime();
  const we = ws + 7 * 86400000;
  const t = new Date(iso).getTime();
  return t >= ws && t < we;
}

export function weeklyLoad(
  weekStart: string,
  sets: LoadSet[],
  cardio: LoadCardio[],
  recovery: LoadRecovery[],
): WeeklyLoad {
  const wkSets = sets.filter(
    (s) => !s.deletedAt && !s.skipped && inWeek(s.performedAt, weekStart),
  );
  const wkCardio = cardio.filter((c) => inWeek(c.performedAt, weekStart));
  const wkRecovery = recovery.filter((r) =>
    inWeek(r.id + 'T12:00:00Z', weekStart),
  );

  const strengthTonnageKg = wkSets.reduce((acc, s) => acc + s.weightKg * s.reps, 0);
  const cardioMinutes = wkCardio.reduce((acc, c) => acc + c.durationSec, 0) / 60;

  const days = new Set<string>();
  for (const s of wkSets) days.add(s.performedAt.slice(0, 10));
  for (const c of wkCardio) days.add(c.performedAt.slice(0, 10));
  const trainingDays = days.size;

  const rpes = wkSets.map((s) => s.rpe).filter((r): r is number => typeof r === 'number');
  const avgRpe = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : undefined;

  const sleeps = wkRecovery.map((r) => r.sleepHours).filter((v): v is number => typeof v === 'number');
  const avgSleep = sleeps.length ? sleeps.reduce((a, b) => a + b, 0) / sleeps.length : undefined;

  const fatigues = wkRecovery.map((r) => r.fatigue).filter((v): v is number => typeof v === 'number');
  const avgFatigue = fatigues.length ? fatigues.reduce((a, b) => a + b, 0) / fatigues.length : undefined;

  let score = 0;
  score += Math.min(50, strengthTonnageKg / 200);
  score += Math.min(20, cardioMinutes / 15);
  if (avgRpe !== undefined) score += Math.max(0, (avgRpe - 6) * 5);
  if (avgFatigue !== undefined) score += Math.max(0, (avgFatigue - 5) * 2);
  if (avgSleep !== undefined) score -= Math.max(0, (avgSleep - 7) * 2);
  score = Math.max(0, Math.min(100, score));

  return {
    weekStart,
    strengthTonnageKg,
    cardioMinutes,
    trainingDays,
    avgRpe,
    avgSleep,
    avgFatigue,
    stressScore: Math.round(score),
  };
}

export function currentWeekStart(now: Date = new Date()): string {
  return isoMonday(now);
}

export function previousWeekStarts(now: Date = new Date(), count: number): string[] {
  const out: string[] = [];
  const monday = new Date(isoMonday(now) + 'T00:00:00Z');
  for (let i = 0; i < count; i += 1) {
    const d = new Date(monday.getTime() - i * 7 * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Deload suggestion engine
// ---------------------------------------------------------------------------

export type DeloadRecommendation = 'continue' | 'deload-soon' | 'deload-now';

export interface DeloadSuggestion {
  recommendation: DeloadRecommendation;
  reasons: string[];
  /** 0..1 confidence in the recommendation. */
  confidence: number;
}

export interface DeloadInputs {
  /** Last few weekly load summaries, oldest first, most recent last. */
  recentWeeks: WeeklyLoad[];
  /** ISO date of the last completed deload session, if any. */
  lastDeloadAt?: string;
  /** Today's date (defaults to now). */
  now?: Date;
}

const HIGH_RPE = 8.5;
const VERY_HIGH_RPE = 9.2;
const HIGH_FATIGUE = 7;
const LOW_SLEEP = 6;
const HIGH_STRESS = 75;
const VERY_HIGH_STRESS = 90;
const WEEKS_BETWEEN_DELOADS_SOFT = 4;
const WEEKS_BETWEEN_DELOADS_HARD = 6;

export function deloadSuggestion(input: DeloadInputs): DeloadSuggestion {
  const reasons: string[] = [];
  let urgency = 0; // 0..3: 0=continue, 1=deload-soon, 2-3=deload-now

  const last = input.recentWeeks[input.recentWeeks.length - 1];
  const prev = input.recentWeeks[input.recentWeeks.length - 2];

  if (last) {
    if (last.avgRpe !== undefined && last.avgRpe >= VERY_HIGH_RPE) {
      reasons.push(`Last week's average RPE was ${last.avgRpe.toFixed(1)} — very high.`);
      urgency += 2;
    } else if (last.avgRpe !== undefined && last.avgRpe >= HIGH_RPE) {
      reasons.push(`Average RPE rising (${last.avgRpe.toFixed(1)}).`);
      urgency += 1;
    }
    if (last.avgFatigue !== undefined && last.avgFatigue >= HIGH_FATIGUE) {
      reasons.push(`Subjective fatigue averaging ${last.avgFatigue.toFixed(1)}/10.`);
      urgency += 1;
    }
    if (last.avgSleep !== undefined && last.avgSleep < LOW_SLEEP) {
      reasons.push(`Sleep averaging ${last.avgSleep.toFixed(1)}h — under 6.`);
      urgency += 1;
    }
    if (last.stressScore >= VERY_HIGH_STRESS) {
      reasons.push(`Stress score ${last.stressScore} — well above threshold.`);
      urgency += 2;
    } else if (last.stressScore >= HIGH_STRESS) {
      reasons.push(`Stress score ${last.stressScore} approaching threshold.`);
      urgency += 1;
    }
  }
  if (prev && last && last.stressScore > prev.stressScore + 15) {
    reasons.push('Sharp week-over-week increase in load.');
    urgency += 1;
  }

  if (input.lastDeloadAt) {
    const ageDays = Math.floor(
      ((input.now?.getTime() ?? Date.now()) - new Date(input.lastDeloadAt).getTime()) / 86400000,
    );
    const ageWeeks = Math.floor(ageDays / 7);
    if (ageWeeks >= WEEKS_BETWEEN_DELOADS_HARD) {
      reasons.push(`${ageWeeks} weeks since last deload — overdue.`);
      urgency += 2;
    } else if (ageWeeks >= WEEKS_BETWEEN_DELOADS_SOFT) {
      reasons.push(`${ageWeeks} weeks since last deload.`);
      urgency += 1;
    }
  }

  let recommendation: DeloadRecommendation;
  if (urgency >= 3) recommendation = 'deload-now';
  else if (urgency >= 1) recommendation = 'deload-soon';
  else recommendation = 'continue';

  if (reasons.length === 0) {
    reasons.push('All indicators within normal range — keep training.');
  }
  const confidence = Math.min(1, 0.4 + 0.15 * urgency + 0.05 * input.recentWeeks.length);

  return { recommendation, reasons, confidence: Number(confidence.toFixed(2)) };
}
