'use client';

// Client-side weekly-review workflow.
//
// Gathers raw signals from IndexedDB for the requested week (default: the
// most recent COMPLETED Monday-Sunday), builds the Periodizer + Summarizer
// user prompts, posts to /api/workflows/weeklyReview, and persists the
// result in the weeklyReviews Dexie table for offline rendering.

import { nanoid } from 'nanoid';
import {
  PeriodizerAgent,
  SummarizerAgent,
  type AgentResponse,
} from '@wendler/domain';
import type {
  WeeklyReview,
  WeeklyReviewSection,
  WeeklyReviewVerdict,
} from '@wendler/db-schema';
import { authFetch } from './auth';
import { getDb } from './db';
import { kickSync } from './sync';

export interface WeeklyReviewApiResult {
  weekStart: string;
  weekEnd: string;
  periodizer: PeriodizerAgent.PeriodizerResponse;
  summary: SummarizerAgent.SummarizerResponse;
}

/**
 * Return the Monday (00:00 local) of the week containing the given date.
 * Treats Monday as start-of-week (Wendler convention; matches the rest of
 * the app's date math).
 */
function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun..6=Sat. Convert to 0=Mon..6=Sun.
  const dow = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - dow);
  return out;
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Default week to summarise: the most recent COMPLETED Mon-Sun. If today
 * is Monday, that's the week that just ended yesterday-Sunday.
 */
function defaultWeekWindow(now: Date = new Date()): { weekStart: string; weekEnd: string } {
  const thisWeekStart = startOfWeek(now);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(lastWeekStart);
  lastWeekEnd.setDate(lastWeekEnd.getDate() + 6);
  return { weekStart: ymdLocal(lastWeekStart), weekEnd: ymdLocal(lastWeekEnd) };
}

async function buildPeriodizerPromptFromDb(opts: {
  weekStart: string;
  weekEnd: string;
}): Promise<string> {
  const db = getDb();
  const today = ymdLocal(new Date());
  const [settings, blocks, races, userProfile, recovery, injuries] = await Promise.all([
    db.settings.get('singleton'),
    db.blocks.toArray(),
    db.races.toArray(),
    db.userProfile.get('singleton'),
    db.recovery.toArray(),
    db.injuries.toArray(),
  ]);
  void settings;

  const activeBlock = blocks.find((b) => !b.completedAt);
  const recentRecovery = recovery
    .filter((r) => r.id >= opts.weekStart)
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .slice(0, 14)
    .map((r) => ({
      date: r.id,
      fatigue: r.fatigue,
      soreness: r.soreness,
      sleepH: r.sleepHours,
    }));

  const upcomingRaces = races
    .filter((r) => !r.completedAt && r.date >= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, 6)
    .map((r) => ({
      name: r.name,
      date: r.date,
      distanceKm: r.distanceKm,
      priority: r.priority as 'A' | 'B' | 'C' | undefined,
    }));

  const activeLimitations = injuries
    .filter((i) => !i.deletedAt && !i.resolvedAt)
    .map((i) => ({
      area: i.area,
      severity: i.severity,
      summary: i.summary,
    }));

  return PeriodizerAgent.buildPeriodizerPrompt({
    question: `Verdict for the just-ended week (${opts.weekStart} → ${opts.weekEnd}). Should this user deload, continue, taper, ramp-up, TM-test, or extend? Cite the signal that drove the verdict.`,
    today,
    activeBlock: activeBlock
      ? {
          name: activeBlock.name,
          kind: activeBlock.kind,
          blockLengthWeeks: activeBlock.weeksBeforeDeload,
          startedAt: activeBlock.startedAt,
        }
      : undefined,
    upcomingRaces,
    recentRecovery,
    activeLimitations,
    userProfile: userProfile
      ? {
          ageYears: userProfile.dateOfBirth ? ageFromDob(userProfile.dateOfBirth) : undefined,
          sex: userProfile.sex,
          trainingExperience: userProfile.trainingExperience,
          yearsLifting: userProfile.yearsLifting,
          yearsRunning: userProfile.yearsRunning,
        }
      : undefined,
  }).userPrompt;
}

function ageFromDob(dobIso: string): number | undefined {
  const dob = new Date(dobIso);
  if (Number.isNaN(dob.valueOf())) return undefined;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

async function buildSummarizerPromptFromDb(opts: {
  weekStart: string;
  weekEnd: string;
}): Promise<string> {
  const db = getDb();
  const [sessions, sets, cardio, recovery, blocks, injuries] = await Promise.all([
    db.sessions.toArray(),
    db.sets.toArray(),
    db.cardio.toArray(),
    db.recovery.toArray(),
    db.blocks.toArray(),
    db.injuries.toArray(),
  ]);

  const inWeek = (iso: string) =>
    iso.slice(0, 10) >= opts.weekStart && iso.slice(0, 10) <= opts.weekEnd;

  const weekSessions = sessions.filter((s) => inWeek(s.performedAt));
  const weekSets = sets.filter((s) => !s.deletedAt && inWeek(s.performedAt));
  const weekCardio = cardio.filter((c) => inWeek(c.performedAt));
  const weekRecovery = recovery.filter((r) => inWeek(r.id));

  const tonnageKg = weekSets.reduce((acc, s) => acc + (s.weightKg ?? 0) * (s.reps ?? 0), 0);

  // Top set per main lift: highest e1RM-proxy = weight × (1 + reps/30)
  const topByLift = new Map<string, { weightKg: number; reps: number; score: number }>();
  for (const s of weekSets) {
    if (s.kind !== 'main' || !s.weightKg || !s.reps) continue;
    const score = s.weightKg * (1 + s.reps / 30);
    const movement = s.movementId;
    const existing = topByLift.get(movement);
    if (!existing || score > existing.score) {
      topByLift.set(movement, { weightKg: s.weightKg, reps: s.reps, score });
    }
  }
  const movementsById = new Map(
    (await db.movements.toArray()).map((m) => [m.id, m] as const),
  );
  const topSets = Array.from(topByLift.entries())
    .map(([movementId, v]) => ({
      lift: movementsById.get(movementId)?.name ?? movementId,
      weightKg: v.weightKg,
      reps: v.reps,
    }))
    .slice(0, 5);

  const runKm = weekCardio
    .filter((c) => c.modality === 'run')
    .reduce((acc, c) => acc + (c.distanceKm ?? 0), 0);
  const bikeKm = weekCardio
    .filter((c) => c.modality === 'bike')
    .reduce((acc, c) => acc + (c.distanceKm ?? 0), 0);
  const cardioMin = weekCardio.reduce(
    (acc, c) => acc + (c.durationSec ?? 0) / 60,
    0,
  );
  const longestRunKm = Math.max(
    0,
    ...weekCardio.filter((c) => c.modality === 'run').map((c) => c.distanceKm ?? 0),
  );

  const recoveryEntryCount = weekRecovery.length;
  const fatigueValues = weekRecovery.map((r) => r.fatigue).filter((v): v is number => v != null);
  const sorenessValues = weekRecovery
    .map((r) => r.soreness)
    .filter((v): v is number => v != null);
  const sleepValues = weekRecovery
    .map((r) => r.sleepHours)
    .filter((v): v is number => v != null);
  const avg = (xs: number[]) =>
    xs.length === 0 ? undefined : xs.reduce((a, c) => a + c, 0) / xs.length;

  const activeBlock = blocks.find((b) => !b.completedAt);

  const activeInjuries = injuries.filter((i) => !i.deletedAt && !i.resolvedAt);
  const coachLimitations = activeInjuries.length
    ? {
        activeCount: activeInjuries.length,
        summary: activeInjuries
          .map((i) => `- ${i.area} (severity ${i.severity}/5)${i.summary ? `: ${i.summary}` : ''}`)
          .join('\n'),
      }
    : undefined;

  return SummarizerAgent.buildSummarizerPrompt({
    weekStart: opts.weekStart,
    weekEnd: opts.weekEnd,
    rawSignals: {
      sessions: weekSessions.length,
      sets: weekSets.length,
      tonnageKg,
      topSets,
      cardio: {
        runKm,
        bikeKm,
        cardioMin,
        longestRunKm,
      },
      recovery: {
        avgFatigue: avg(fatigueValues),
        avgSoreness: avg(sorenessValues),
        avgSleepH: avg(sleepValues),
        entryCount: recoveryEntryCount,
      },
      activeBlock: activeBlock
        ? {
            name: activeBlock.name,
            kind: activeBlock.kind,
            blockLengthWeeks: activeBlock.weeksBeforeDeload,
          }
        : undefined,
    },
    coachLimitations,
  }).userPrompt + '\n\n<!-- PERIODIZER_INPUT -->';
}

/**
 * Generate (or regenerate) the weekly review for the requested window.
 * Defaults to the most-recent completed week. Persists the result to the
 * `weeklyReviews` Dexie table and returns the row.
 */
export async function generateWeeklyReview(
  windowOpt?: { weekStart: string; weekEnd: string },
): Promise<{ ok: true; review: WeeklyReview } | { ok: false; errors: string[] }> {
  const win = windowOpt ?? defaultWeekWindow();
  const [periodizerUserPrompt, summarizerUserPrompt] = await Promise.all([
    buildPeriodizerPromptFromDb(win),
    buildSummarizerPromptFromDb(win),
  ]);

  const res = await authFetch('/api/workflows/weeklyReview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      weekStart: win.weekStart,
      weekEnd: win.weekEnd,
      periodizerUserPrompt,
      summarizerUserPrompt,
    }),
  });
  if (!res.ok) {
    return { ok: false, errors: [`HTTP ${res.status}: ${res.statusText}`] };
  }
  const json = (await res.json()) as AgentResponse<WeeklyReviewApiResult>;
  if (!json.ok) {
    return { ok: false, errors: json.errors };
  }

  // Persist. Reuse an existing row for the same weekStart to keep the
  // table tidy across regenerations.
  const db = getDb();
  const existing = await db.weeklyReviews
    .filter((r) => r.weekStart === win.weekStart && !r.deletedAt)
    .first();
  const now = new Date().toISOString();
  const id = existing?.id ?? nanoid();
  const sections: WeeklyReviewSection[] = json.data.summary.sections.map((s: { heading: string; markdown: string }) => ({
    heading: s.heading,
    markdown: s.markdown,
  }));
  const review: WeeklyReview = {
    id,
    weekStart: json.data.weekStart,
    weekEnd: json.data.weekEnd,
    verdict: json.data.periodizer.verdict as WeeklyReviewVerdict,
    headline: json.data.periodizer.headline,
    sections,
    highlights: json.data.summary.highlights,
    generatedAt: now,
    updatedAt: now,
  };
  await db.weeklyReviews.put(review);
  kickSync();
  return { ok: true, review };
}
