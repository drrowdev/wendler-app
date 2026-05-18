'use client';

// Monday auto-digest — on first page load of a Monday (local timezone),
// compute a summary of the prior 7 days vs the 4-week trailing average
// and emit a single notification to the inbox. Gated by a localStorage
// key keyed by ISO week so it fires at most once per week per device.
//
// Pure data — no LLM call. Reads existing analytics helpers and queries
// Dexie directly. Falls silent when no data is available yet.

import { useEffect } from 'react';
import { weeklyLoad, weeklyCardio, type LoadSet, type MinimalCardio } from '@wendler/domain';
import { getDb } from '@/lib/db';
import { notify } from '@/lib/notify';

const FLAG_PREFIX = 'wendler:monday-digest-emitted:v6';

function isoWeekKey(d: Date): string {
  // ISO week: Thursday-aligned, year inferred from Thursday's date.
  const target = new Date(d.getTime());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = (target.getTime() - firstThursday.getTime()) / 86_400_000;
  const week = 1 + Math.round((diff - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${target.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isoMonday(d: Date): string {
  const day = (d.getDay() + 6) % 7;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
}

export function MondayDigest() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const now = new Date();
    if (now.getDay() !== 1) return; // Mondays only

    const weekKey = isoWeekKey(now);
    const flagKey = `${FLAG_PREFIX}:${weekKey}`;
    if (localStorage.getItem(flagKey) === '1') return;

    let cancelled = false;
    void (async () => {
      try {
        await maybeEmit(now);
        if (!cancelled) localStorage.setItem(flagKey, '1');
      } catch {
        // Best-effort: try again next page load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

async function maybeEmit(now: Date): Promise<void> {
  const db = getDb();

  // Window: last 7 days (ending today, Mon) vs prior 28 days.
  const dayMs = 86_400_000;
  const last7Start = new Date(now.getTime() - 7 * dayMs);
  const baselineStart = new Date(now.getTime() - 35 * dayMs);

  const allSets = await db.sets.toArray();
  const allCardio = await db.cardio.toArray();
  const allRaces = await db.races.toArray();
  const recovery = await db.recovery.toArray();
  // Strava-imported strength activities (WeightTraining, Crossfit, HIIT,
  // Workout). These never write to db.sets — only HR is captured — so
  // we must also bucket them as workout days or the count under-reports
  // anyone who logs strength on a non-Wendler platform.
  const allStrengthHr = await db.strengthHr.toArray();

  // Filter sets / cardio per window.
  const inWindow = <T extends { performedAt: string }>(
    rows: T[],
    start: Date,
    end: Date,
  ): T[] =>
    rows.filter((r) => {
      const t = new Date(r.performedAt).getTime();
      return t >= start.getTime() && t < end.getTime();
    });

  const setsLast7 = inWindow(allSets as Array<LoadSet & { performedAt: string }>, last7Start, now);
  const setsBaseline = inWindow(
    allSets as Array<LoadSet & { performedAt: string }>,
    baselineStart,
    last7Start,
  );
  const cardioLast7 = inWindow(allCardio as Array<MinimalCardio & { performedAt: string }>, last7Start, now);
  const cardioBaseline = inWindow(
    allCardio as Array<MinimalCardio & { performedAt: string }>,
    baselineStart,
    last7Start,
  );

  // Strength sessions in window. Count DISTINCT CALENDAR DAYS — the
  // user's mental model: "how many days did I lift last week?" A single
  // workout day can contain multiple session rows (Bench + Deadlift =
  // 2 rows), warm-up sets without a sessionId, AND a Strava-imported
  // strength row — all of which must collapse to one count. Bucketing
  // by local YYYY-MM-DD is the only key that works for every source.
  function dayKeyFromPerformedAt(performedAt: string | undefined): string | null {
    if (!performedAt) return null;
    const d = new Date(performedAt);
    if (!Number.isFinite(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const dayKeysLast7 = new Set<string>();
  for (const s of setsLast7 as ReadonlyArray<{ performedAt?: string }>) {
    const k = dayKeyFromPerformedAt(s.performedAt);
    if (k) dayKeysLast7.add(k);
  }
  const dayKeysBaseline = new Set<string>();
  for (const s of setsBaseline as ReadonlyArray<{ performedAt?: string }>) {
    const k = dayKeyFromPerformedAt(s.performedAt);
    if (k) dayKeysBaseline.add(k);
  }
  // Also fold Strava-imported strength sessions into the workout-day
  // count. Bucketed by the same local-date key so an imported session
  // on the same day as a Wendler workout counts once.
  for (const h of allStrengthHr) {
    const t = new Date(h.performedAt).getTime();
    if (!Number.isFinite(t)) continue;
    const k = dayKeyFromPerformedAt(h.performedAt);
    if (!k) continue;
    if (t >= last7Start.getTime() && t < now.getTime()) dayKeysLast7.add(k);
    else if (t >= baselineStart.getTime() && t < last7Start.getTime()) dayKeysBaseline.add(k);
  }
  const sessionsLast7Count = dayKeysLast7.size;
  const sessionsBaselineCount = dayKeysBaseline.size;
  const baselineWeeklyAvg = sessionsBaselineCount / 4; // 28 days → 4 weeks

  // Cardio minutes.
  const cardioMin = (rows: MinimalCardio[]) =>
    rows.reduce((acc, c) => acc + (c.durationSec ?? 0) / 60, 0);
  const last7CardioMin = cardioMin(cardioLast7);
  const baselineCardioMinPerWeek = cardioMin(cardioBaseline) / 4;

  // TSB from weeklyLoad on the most recent two windows (rough).
  const monday = isoMonday(new Date(now.getTime() - 7 * dayMs));
  const wl = weeklyLoad(
    monday,
    setsLast7 as LoadSet[],
    cardioLast7 as never,
    recovery as never,
  );

  // Next race.
  const upcoming = allRaces
    .filter((r) => !r.completedAt && new Date(r.date).getTime() > now.getTime())
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const nextRace = upcoming[0];

  // PRs would require pr-detection; skip for first iteration. (Domain has
  // it; we'd thread sets[] and movement library to compute. Defer to a
  // follow-up if the user wants it surfaced.)

  // If literally nothing happened last week, skip entirely.
  if (sessionsLast7Count === 0 && cardioLast7.length === 0) return;

  const sessionDelta =
    baselineWeeklyAvg > 0
      ? Math.round(((sessionsLast7Count - baselineWeeklyAvg) / baselineWeeklyAvg) * 100)
      : null;
  const cardioDelta =
    baselineCardioMinPerWeek > 0
      ? Math.round(((last7CardioMin - baselineCardioMinPerWeek) / baselineCardioMinPerWeek) * 100)
      : null;

  const bodyLines: string[] = [];
  bodyLines.push(
    `${sessionsLast7Count} strength session${sessionsLast7Count === 1 ? '' : 's'}` +
      (sessionDelta != null
        ? ` (${sessionDelta >= 0 ? '+' : ''}${sessionDelta}% vs 4-wk avg ${baselineWeeklyAvg.toFixed(1)}/wk)`
        : ''),
  );
  bodyLines.push(
    `${Math.round(last7CardioMin)} min cardio` +
      (cardioDelta != null
        ? ` (${cardioDelta >= 0 ? '+' : ''}${cardioDelta}% vs 4-wk avg ${Math.round(baselineCardioMinPerWeek)} min/wk)`
        : ''),
  );
  bodyLines.push(`Stress score: ${Math.round(wl.stressScore)} / 100`);
  if (nextRace) {
    const daysOut = Math.round(
      (new Date(nextRace.date).getTime() - now.getTime()) / dayMs,
    );
    bodyLines.push(
      `Next race: ${nextRace.name} in ${daysOut} day${daysOut === 1 ? '' : 's'} (${nextRace.priority}-priority)`,
    );
  }

  await notify.info({
    channel: 'system',
    title: `Last week: ${sessionsLast7Count} sessions · ${Math.round(last7CardioMin)} min cardio`,
    body: bodyLines.join('\n'),
    deepLink: { href: '/stats', label: 'Open stats' },
    context: {
      weekKey: isoWeekKey(new Date(now.getTime() - 7 * dayMs)),
      sessionsLast7: sessionsLast7Count,
      sessionsBaselineAvg: baselineWeeklyAvg,
      cardioMinLast7: last7CardioMin,
      cardioMinBaselinePerWeek: baselineCardioMinPerWeek,
      stressScore: wl.stressScore,
      nextRace: nextRace ? { name: nextRace.name, date: nextRace.date, priority: nextRace.priority } : null,
    },
  });
}
