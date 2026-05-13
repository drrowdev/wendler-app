/**
 * Chat context builder — produces a compact, multi-resolution snapshot of
 * the user's training data for the AI chat endpoint to ground answers in
 * real data.
 *
 * Resolution strategy:
 *   • Last 90 days  — full detail (every cardio activity, every working set,
 *                     every recovery entry)
 *   • 90d – 1 year — weekly aggregates (mileage, tonnage per lift, avg HR)
 *   • Older       — monthly aggregates + PR + race timelines
 *
 * Race results and lift PRs are always emitted verbatim regardless of age.
 *
 * Output is a stable, deterministic shape — order rows by date ascending so
 * the LLM reads chronologically. No personal-identifier text is included
 * (no addresses, no notes containing PII — the user's notes ARE included
 * because they're training-relevant; the chat endpoint is auth'd to that
 * user).
 *
 * This module is pure: same inputs always produce the same output. The
 * `now` parameter is required and explicit so tests stay deterministic.
 */

import type { TrainingProfile } from './training-profile-types';

/** Minimal cardio shape needed for the chat snapshot. */
export interface MinimalChatCardio {
  performedAt: string;
  modality: string;
  durationSec: number;
  distanceKm?: number;
  avgHrBpm?: number;
  plannedKind?: string;
}

/** Minimal set shape needed for the chat snapshot. */
export interface MinimalChatSet {
  performedAt: string;
  movementId: string;
  weightKg: number;
  reps: number;
  rpe?: number;
  skipped?: boolean;
  deletedAt?: string;
}

/** Minimal recovery entry shape. */
export interface MinimalChatRecovery {
  /** "YYYY-MM-DD". */
  id: string;
  fatigue?: number;
  soreness?: number;
  sleepHours?: number;
  bodyweightKg?: number;
}

/** Minimal training max shape. */
export interface MinimalChatTrainingMax {
  lift: string;
  trainingMaxKg: number;
  createdAt: string;
}

/** Minimal race shape. */
export interface MinimalChatRace {
  date: string;
  name: string;
  kind: string;
  priority: string;
  distanceKm?: number;
  targetTimeSec?: number;
  result?: { finishTimeSec?: number };
}

const MS_PER_DAY = 86_400_000;
const FULL_DETAIL_DAYS = 90;
const WEEKLY_DAYS = 365;

export interface ChatContextInput {
  now: Date;
  /** Lift sets across all time. Skipped + soft-deleted are filtered out internally. */
  sets: ReadonlyArray<MinimalChatSet>;
  /** Cardio sessions across all time. */
  cardio: ReadonlyArray<MinimalChatCardio>;
  /** Daily recovery entries (sleep, fatigue, soreness, bodyweight). */
  recovery: ReadonlyArray<MinimalChatRecovery>;
  /** Race calendar — past and upcoming. */
  races: ReadonlyArray<MinimalChatRace>;
  /** Training Max history (one row per write — newest wins per lift). */
  trainingMaxes: ReadonlyArray<MinimalChatTrainingMax>;
  /** Optional training profile (primary/secondary goals, phase). */
  profile?: TrainingProfile;
  /** Optional movement-id → display-name map (resolves SetRecord.movementId). */
  movementName?: Map<string, string>;
}

export interface ChatContextSummary {
  generatedAt: string;
  profile?: {
    primaryGoal: string;
    secondaryGoals: string[];
    phase: string;
  };
  currentTms: Array<{ lift: string; kg: number }>;
  /** Last 90 days, daily resolution. */
  recent: {
    cardio: Array<{
      date: string;
      modality: string;
      distanceKm?: number;
      durationMin: number;
      avgHrBpm?: number;
      pacePerKm?: string;
      plannedKind?: string;
    }>;
    strengthSessions: Array<{
      date: string;
      sets: number;
      tonnageKg: number;
      lifts: string[];
      avgRpe?: number;
    }>;
    recovery: Array<{ date: string; fatigue?: number; soreness?: number; sleepH?: number; bodyweightKg?: number }>;
  };
  /** 90d – 1y weekly buckets. */
  weekly: Array<{
    weekStart: string;
    runKm: number;
    bikeKm: number;
    cardioMin: number;
    strengthSets: number;
    strengthTonnageKg: number;
    avgFatigue?: number;
  }>;
  /** Older than 1y, monthly buckets. */
  monthly: Array<{
    month: string; // YYYY-MM
    runKm: number;
    cardioMin: number;
    strengthSets: number;
    strengthTonnageKg: number;
  }>;
  /** All races, oldest first. Completed races include a result field. */
  raceTimeline: Array<{
    date: string;
    name: string;
    kind: string;
    priority: string;
    distanceKm?: number;
    targetTimeSec?: number;
    resultTimeSec?: number;
    status: 'upcoming' | 'completed' | 'past';
  }>;
  /** Strength PR timeline (one row per highest TM per lift, oldest → newest). */
  prTimeline: Array<{ date: string; lift: string; kg: number }>;
}

function ymd(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

function ymdLocal(iso: string): string {
  return iso.slice(0, 10);
}

function yearMonth(iso: string): string {
  return iso.slice(0, 7);
}

function isoWeekStart(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - diff);
  return ymd(d);
}

function pacePerKm(distanceKm: number | undefined, durationSec: number): string | undefined {
  if (!distanceKm || distanceKm < 0.05) return undefined;
  const secPerKm = durationSec / distanceKm;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setIsValid(s: MinimalChatSet): boolean {
  return !s.skipped && !s.deletedAt && s.weightKg > 0 && s.reps > 0;
}

function setTonnage(s: MinimalChatSet): number {
  return s.weightKg * s.reps;
}

/** Build a structured chat context summary from training data. */
export function buildChatContext(input: ChatContextInput): ChatContextSummary {
  const nowMs = input.now.getTime();
  const detailCutoff = new Date(nowMs - FULL_DETAIL_DAYS * MS_PER_DAY).toISOString();
  const weeklyCutoff = new Date(nowMs - WEEKLY_DAYS * MS_PER_DAY).toISOString();

  const validSets = input.sets.filter(setIsValid);

  // ── Current TMs ──────────────────────────────────────────────────────────
  const tmByLift = new Map<string, MinimalChatTrainingMax>();
  for (const tm of input.trainingMaxes) {
    const prev = tmByLift.get(tm.lift);
    if (!prev || tm.createdAt > prev.createdAt) tmByLift.set(tm.lift, tm);
  }
  const currentTms = Array.from(tmByLift.entries())
    .map(([lift, tm]) => ({ lift, kg: tm.trainingMaxKg }))
    .sort((a, b) => a.lift.localeCompare(b.lift));

  // ── PR timeline (one row per highest TM ever set, per lift) ──────────────
  const prByLift = new Map<string, MinimalChatTrainingMax>();
  for (const tm of input.trainingMaxes) {
    const prev = prByLift.get(tm.lift);
    if (!prev || tm.trainingMaxKg > prev.trainingMaxKg) prByLift.set(tm.lift, tm);
  }
  const prTimeline = Array.from(prByLift.entries())
    .map(([lift, tm]) => ({ date: ymdLocal(tm.createdAt), lift, kg: tm.trainingMaxKg }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // ── Recent cardio (last 90d, full detail) ────────────────────────────────
  const recentCardio = input.cardio
    .filter((c) => c.performedAt >= detailCutoff)
    .sort((a, b) => a.performedAt.localeCompare(b.performedAt))
    .map((c) => ({
      date: ymdLocal(c.performedAt),
      modality: c.modality,
      distanceKm: c.distanceKm,
      durationMin: Math.round(c.durationSec / 60),
      avgHrBpm: c.avgHrBpm,
      pacePerKm: pacePerKm(c.distanceKm, c.durationSec),
      plannedKind: c.plannedKind,
    }));

  // ── Recent strength (last 90d, grouped per day) ──────────────────────────
  const strengthByDay = new Map<string, { sets: number; tonnage: number; lifts: Set<string>; rpes: number[] }>();
  for (const s of validSets) {
    if (s.performedAt < detailCutoff) continue;
    const d = ymdLocal(s.performedAt);
    let bucket = strengthByDay.get(d);
    if (!bucket) {
      bucket = { sets: 0, tonnage: 0, lifts: new Set(), rpes: [] };
      strengthByDay.set(d, bucket);
    }
    bucket.sets += 1;
    bucket.tonnage += setTonnage(s);
    const liftName = input.movementName?.get(s.movementId) ?? s.movementId;
    bucket.lifts.add(liftName);
    if (typeof s.rpe === 'number') bucket.rpes.push(s.rpe);
  }
  const recentStrength = Array.from(strengthByDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => ({
      date,
      sets: b.sets,
      tonnageKg: Math.round(b.tonnage),
      lifts: Array.from(b.lifts).sort(),
      avgRpe: b.rpes.length ? Number((b.rpes.reduce((a, c) => a + c, 0) / b.rpes.length).toFixed(1)) : undefined,
    }));

  // ── Recent recovery ──────────────────────────────────────────────────────
  const recentRecovery = input.recovery
    .filter((r) => r.id >= ymd(new Date(nowMs - FULL_DETAIL_DAYS * MS_PER_DAY)))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({
      date: r.id,
      fatigue: r.fatigue,
      soreness: r.soreness,
      sleepH: r.sleepHours,
      bodyweightKg: r.bodyweightKg,
    }));

  // ── Weekly aggregates (90d – 1y) ─────────────────────────────────────────
  type WeekBucket = {
    runKm: number;
    bikeKm: number;
    cardioMin: number;
    strengthSets: number;
    strengthTonnage: number;
    fatigues: number[];
  };
  const weekly = new Map<string, WeekBucket>();
  const emptyWeek = (): WeekBucket => ({
    runKm: 0,
    bikeKm: 0,
    cardioMin: 0,
    strengthSets: 0,
    strengthTonnage: 0,
    fatigues: [],
  });

  for (const c of input.cardio) {
    if (c.performedAt >= detailCutoff || c.performedAt < weeklyCutoff) continue;
    const wk = isoWeekStart(c.performedAt);
    const b = weekly.get(wk) ?? emptyWeek();
    if (c.modality === 'run') b.runKm += c.distanceKm ?? 0;
    if (c.modality === 'bike') b.bikeKm += c.distanceKm ?? 0;
    b.cardioMin += c.durationSec / 60;
    weekly.set(wk, b);
  }
  for (const s of validSets) {
    if (s.performedAt >= detailCutoff || s.performedAt < weeklyCutoff) continue;
    const wk = isoWeekStart(s.performedAt);
    const b = weekly.get(wk) ?? emptyWeek();
    b.strengthSets += 1;
    b.strengthTonnage += setTonnage(s);
    weekly.set(wk, b);
  }
  for (const r of input.recovery) {
    if (r.id < ymd(new Date(nowMs - WEEKLY_DAYS * MS_PER_DAY))) continue;
    if (r.id >= ymd(new Date(nowMs - FULL_DETAIL_DAYS * MS_PER_DAY))) continue;
    const wk = isoWeekStart(r.id + 'T00:00:00Z');
    const b = weekly.get(wk) ?? emptyWeek();
    if (typeof r.fatigue === 'number') b.fatigues.push(r.fatigue);
    weekly.set(wk, b);
  }
  const weeklyOut = Array.from(weekly.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, b]) => ({
      weekStart,
      runKm: Number(b.runKm.toFixed(1)),
      bikeKm: Number(b.bikeKm.toFixed(1)),
      cardioMin: Math.round(b.cardioMin),
      strengthSets: b.strengthSets,
      strengthTonnageKg: Math.round(b.strengthTonnage),
      avgFatigue: b.fatigues.length
        ? Number((b.fatigues.reduce((a, c) => a + c, 0) / b.fatigues.length).toFixed(1))
        : undefined,
    }));

  // ── Monthly aggregates (older than 1y) ───────────────────────────────────
  type MonthBucket = { runKm: number; cardioMin: number; strengthSets: number; strengthTonnage: number };
  const monthly = new Map<string, MonthBucket>();
  const emptyMonth = (): MonthBucket => ({ runKm: 0, cardioMin: 0, strengthSets: 0, strengthTonnage: 0 });

  for (const c of input.cardio) {
    if (c.performedAt >= weeklyCutoff) continue;
    const m = yearMonth(c.performedAt);
    const b = monthly.get(m) ?? emptyMonth();
    if (c.modality === 'run') b.runKm += c.distanceKm ?? 0;
    b.cardioMin += c.durationSec / 60;
    monthly.set(m, b);
  }
  for (const s of validSets) {
    if (s.performedAt >= weeklyCutoff) continue;
    const m = yearMonth(s.performedAt);
    const b = monthly.get(m) ?? emptyMonth();
    b.strengthSets += 1;
    b.strengthTonnage += setTonnage(s);
    monthly.set(m, b);
  }
  const monthlyOut = Array.from(monthly.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, b]) => ({
      month,
      runKm: Number(b.runKm.toFixed(1)),
      cardioMin: Math.round(b.cardioMin),
      strengthSets: b.strengthSets,
      strengthTonnageKg: Math.round(b.strengthTonnage),
    }));

  // ── Race timeline (all of it, oldest first) ──────────────────────────────
  const todayIso = ymd(input.now);
  const raceTimeline = [...input.races]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      const date = ymdLocal(r.date);
      const status: 'upcoming' | 'completed' | 'past' = r.result
        ? 'completed'
        : date >= todayIso
          ? 'upcoming'
          : 'past';
      return {
        date,
        name: r.name,
        kind: r.kind,
        priority: r.priority,
        distanceKm: r.distanceKm,
        targetTimeSec: r.targetTimeSec,
        resultTimeSec: r.result?.finishTimeSec,
        status,
      };
    });

  return {
    generatedAt: input.now.toISOString(),
    profile: input.profile
      ? {
          primaryGoal: input.profile.primaryGoal,
          secondaryGoals: [...input.profile.secondaryGoals],
          phase: input.profile.trainingPhase,
        }
      : undefined,
    currentTms,
    recent: {
      cardio: recentCardio,
      strengthSessions: recentStrength,
      recovery: recentRecovery,
    },
    weekly: weeklyOut,
    monthly: monthlyOut,
    raceTimeline,
    prTimeline,
  };
}

/**
 * Render a `ChatContextSummary` as a YAML-ish plain-text block suitable for
 * embedding inside the system prompt. Compact (no quotes on simple values)
 * but unambiguous for an LLM.
 */
export function renderChatContextAsText(ctx: ChatContextSummary): string {
  const lines: string[] = [];
  lines.push(`# Training data snapshot (generated ${ctx.generatedAt})`);

  if (ctx.profile) {
    lines.push('');
    lines.push('## Training profile');
    lines.push(`primary: ${ctx.profile.primaryGoal}`);
    lines.push(`secondary: ${ctx.profile.secondaryGoals.join(', ') || '(none)'}`);
    lines.push(`phase: ${ctx.profile.phase}`);
  }

  lines.push('');
  lines.push('## Current training maxes (kg)');
  for (const tm of ctx.currentTms) lines.push(`${tm.lift}: ${tm.kg}`);

  lines.push('');
  lines.push('## Race timeline (oldest → newest)');
  if (ctx.raceTimeline.length === 0) lines.push('(no races)');
  for (const r of ctx.raceTimeline) {
    const parts: string[] = [r.date, r.priority + ':' + r.name, r.kind];
    if (r.distanceKm != null) parts.push(`${r.distanceKm}km`);
    if (r.targetTimeSec != null) parts.push(`target ${formatHms(r.targetTimeSec)}`);
    if (r.resultTimeSec != null) parts.push(`result ${formatHms(r.resultTimeSec)}`);
    parts.push(`[${r.status}]`);
    lines.push('- ' + parts.join(' · '));
  }

  lines.push('');
  lines.push('## Lift PR timeline');
  for (const p of ctx.prTimeline) lines.push(`- ${p.date} · ${p.lift} · ${p.kg}kg`);

  lines.push('');
  lines.push(`## Recent cardio (last ${FULL_DETAIL_DAYS}d, daily)`);
  for (const c of ctx.recent.cardio) {
    const parts: string[] = [c.date, c.modality];
    if (c.distanceKm != null) parts.push(`${c.distanceKm}km`);
    parts.push(`${c.durationMin}min`);
    if (c.pacePerKm) parts.push(`${c.pacePerKm}/km`);
    if (c.avgHrBpm) parts.push(`${c.avgHrBpm}bpm`);
    if (c.plannedKind) parts.push(`plan:${c.plannedKind}`);
    lines.push('- ' + parts.join(' · '));
  }

  lines.push('');
  lines.push(`## Recent strength sessions (last ${FULL_DETAIL_DAYS}d, per-day)`);
  for (const s of ctx.recent.strengthSessions) {
    const parts = [s.date, `${s.sets} sets`, `${s.tonnageKg}kg vol`, s.lifts.slice(0, 4).join('+')];
    if (s.avgRpe != null) parts.push(`rpe ${s.avgRpe}`);
    lines.push('- ' + parts.join(' · '));
  }

  if (ctx.recent.recovery.length > 0) {
    lines.push('');
    lines.push(`## Recent recovery entries (last ${FULL_DETAIL_DAYS}d)`);
    for (const r of ctx.recent.recovery) {
      const parts = [r.date];
      if (r.fatigue != null) parts.push(`fatigue ${r.fatigue}`);
      if (r.soreness != null) parts.push(`soreness ${r.soreness}`);
      if (r.sleepH != null) parts.push(`sleep ${r.sleepH}h`);
      if (r.bodyweightKg != null) parts.push(`bw ${r.bodyweightKg}kg`);
      lines.push('- ' + parts.join(' · '));
    }
  }

  if (ctx.weekly.length > 0) {
    lines.push('');
    lines.push('## Weekly aggregates (90d–1y)');
    for (const w of ctx.weekly) {
      const parts = [w.weekStart];
      if (w.runKm > 0) parts.push(`run ${w.runKm}km`);
      if (w.bikeKm > 0) parts.push(`bike ${w.bikeKm}km`);
      if (w.cardioMin > 0) parts.push(`cardio ${w.cardioMin}min`);
      if (w.strengthSets > 0) parts.push(`${w.strengthSets} sets / ${w.strengthTonnageKg}kg`);
      if (w.avgFatigue != null) parts.push(`avg fatigue ${w.avgFatigue}`);
      lines.push('- ' + parts.join(' · '));
    }
  }

  if (ctx.monthly.length > 0) {
    lines.push('');
    lines.push('## Monthly aggregates (>1y)');
    for (const m of ctx.monthly) {
      const parts = [m.month];
      if (m.runKm > 0) parts.push(`run ${m.runKm}km`);
      if (m.cardioMin > 0) parts.push(`cardio ${m.cardioMin}min`);
      if (m.strengthSets > 0) parts.push(`${m.strengthSets} sets / ${m.strengthTonnageKg}kg`);
      lines.push('- ' + parts.join(' · '));
    }
  }

  return lines.join('\n');
}

function formatHms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec - h * 3600) / 60);
  const s = Math.round(sec - h * 3600 - m * 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
