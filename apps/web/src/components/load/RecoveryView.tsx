'use client';

import { useMemo } from 'react';
import {
  banister,
  cardioMuscleImpact,
  dailyLoadSeries,
  type MuscleGroup,
} from '@wendler/domain';
import { useAllCardio, useAllSets, useMovements } from '@/lib/hooks';

// Stretch the daily series 90 days back so the 42-day CTL EWA has room to settle.
const BANISTER_WINDOW_DAYS = 90;

const MUSCLE_LABELS: Record<MuscleGroup, string> = {
  quads: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  chest: 'Chest',
  back: 'Back',
  lats: 'Lats',
  traps: 'Traps',
  shoulders: 'Shoulders',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  core: 'Core',
  obliques: 'Obliques',
  erectors: 'Erectors',
};

function tsbTone(tsb: number): string {
  if (tsb >= 0) return 'border-green-500/40 bg-green-500/10';
  if (tsb >= -15) return 'border-yellow-500/40 bg-yellow-500/10';
  if (tsb >= -30) return 'border-orange-500/40 bg-orange-500/10';
  return 'border-red-500/40 bg-red-500/10';
}

function freshnessTone(daysSince: number): string {
  if (daysSince >= 4) return 'border-green-500/40 bg-green-500/10';
  if (daysSince >= 2) return 'border-yellow-500/40 bg-yellow-500/10';
  return 'border-red-500/40 bg-red-500/10';
}

function fmtDays(daysSince: number | null): string {
  if (daysSince === null) return 'never';
  if (daysSince === 0) return 'today';
  if (daysSince === 1) return '1 day ago';
  return `${daysSince} days ago`;
}

/**
 * Number of calendar days between two ISO timestamps, in local timezone.
 * Returns 0 when both fall on today's date, 1 for yesterday → today, etc.
 *
 * Distinct from `Math.floor((now − last) / 86400000)` which measures
 * *elapsed* hours floored to days — a workout from yesterday 21:00 viewed
 * at today 10:00 is ~13h elapsed → floor(0.55)=0, mislabeled as "today".
 * Calendar-day diff treats both as their own date strings and counts days
 * between them in the user's local timezone, so the freshness label
 * matches user intuition.
 */
function calendarDaysBetween(now: Date, last: Date): number {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}

export function RecoveryView() {
  const sets = useAllSets();
  const cardio = useAllCardio();
  const movements = useMovements();

  const ban = useMemo(() => {
    const today = new Date();
    const fromMs = today.getTime() - (BANISTER_WINDOW_DAYS - 1) * 86400000;
    const from = new Date(fromMs).toISOString().slice(0, 10);
    const to = today.toISOString().slice(0, 10);
    const series = dailyLoadSeries(from, to, sets ?? [], cardio ?? []);
    return banister(series);
  }, [sets, cardio]);

  const avg7dRpe = useMemo(() => {
    const cutoff = Date.now() - 7 * 86400000;
    const rpes = (sets ?? [])
      .filter(
        (s) =>
          !s.skipped &&
          !s.deletedAt &&
          new Date(s.performedAt).getTime() >= cutoff,
      )
      .map((s) => s.rpe)
      .filter((r): r is number => typeof r === 'number');
    if (!rpes.length) return null;
    return rpes.reduce((a, b) => a + b, 0) / rpes.length;
  }, [sets]);

  const lastTrained = useMemo(() => {
    const out: Partial<Record<MuscleGroup, string>> = {};
    if (!movements || !sets) return out;
    const byMv = new Map(movements.map((m) => [m.id, m]));
    for (const s of sets) {
      if (s.skipped || s.deletedAt) continue;
      const mv = byMv.get(s.movementId);
      if (!mv) continue;
      const groups = [...mv.primaryMuscles, ...mv.secondaryMuscles];
      for (const g of groups) {
        const cur = out[g];
        if (!cur || s.performedAt > cur) out[g] = s.performedAt;
      }
    }
    // Cardio also fatigues real muscles — fold it in with the same
    // "any contact resets the clock" semantics strength uses, gated by
    // intensity + duration so a 20-min easy spin doesn't lie about glute
    // freshness.
    for (const c of cardio ?? []) {
      const impact = cardioMuscleImpact(c);
      const groups = [...impact.primary, ...impact.secondary];
      if (groups.length === 0) continue;
      for (const g of groups) {
        const cur = out[g];
        if (!cur || c.performedAt > cur) out[g] = c.performedAt;
      }
    }
    return out;
  }, [sets, movements, cardio]);

  const today = new Date();
  const muscleRows = (Object.keys(MUSCLE_LABELS) as MuscleGroup[])
    .map((g) => {
      const last = lastTrained[g];
      // Use calendar-day distance (not elapsed-ms floored to days) so a
      // workout from yesterday evening doesn't mislabel as "today". See
      // calendarDaysBetween comment above for the v303 fix.
      const days = last ? calendarDaysBetween(today, new Date(last)) : null;
      return { group: g, label: MUSCLE_LABELS[g], days };
    })
    .sort((a, b) => {
      // Untrained (never) sinks to the bottom; otherwise most recently trained first.
      if (a.days === null && b.days === null) return a.label.localeCompare(b.label);
      if (a.days === null) return 1;
      if (b.days === null) return -1;
      return a.days - b.days;
    });

  const loaded = sets !== undefined && cardio !== undefined && movements !== undefined;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Recovery</h1>
        <p className="text-sm text-muted">
          Computed from your training log. Sleep and HRV require a Garmin/Apple Health
          integration — not yet wired up.
        </p>
      </header>

      {!loaded && <p className="text-sm text-muted">Loading…</p>}

      {loaded && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className={`rounded-lg border p-3 ${tsbTone(ban.tsb)}`}>
              <div className="text-xs uppercase tracking-wide text-muted">Form (TSB)</div>
              <div className="text-2xl font-semibold">{ban.tsb.toFixed(1)}</div>
              <div className="text-xs text-muted">fitness − fatigue</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs uppercase tracking-wide text-muted">Fatigue (ATL)</div>
              <div className="text-2xl font-semibold">{ban.atl.toFixed(1)}</div>
              <div className="text-xs text-muted">7-day EWA load</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs uppercase tracking-wide text-muted">Fitness (CTL)</div>
              <div className="text-2xl font-semibold">{ban.ctl.toFixed(1)}</div>
              <div className="text-xs text-muted">42-day EWA load</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs uppercase tracking-wide text-muted">Avg RPE (7d)</div>
              <div className="text-2xl font-semibold">
                {avg7dRpe !== null ? avg7dRpe.toFixed(1) : '—'}
              </div>
              <div className="text-xs text-muted">across all logged sets</div>
            </div>
          </section>

          {ban.coldStart && (
            <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-200">
              Cold start — TSB-based signals warming up. Need 14+ days of logged load
              before fitness/fatigue/form become reliable.
            </p>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Muscle freshness
            </h2>
            <p className="text-xs text-muted">
              Days since each group was last trained — strength sets and cardio
              both count. Cardio is intensity- and modality-aware: a hard
              interval run loads quads/hamstrings/glutes/calves; padel adds
              shoulders/obliques; rowing adds lats/back/shoulders; an easy
              spin only nudges quads. Green ≥4d, yellow 2–3d, red &lt;2d.
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {muscleRows.map((r) => (
                <div
                  key={r.group}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                    r.days === null
                      ? 'border-border bg-card/40 text-muted'
                      : freshnessTone(r.days)
                  }`}
                >
                  <span>{r.label}</span>
                  <span className="font-mono text-xs">{fmtDays(r.days)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card/60 p-3 text-xs text-muted">
            <div className="font-semibold text-fg">Not yet automated</div>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              <li>Sleep hours — needs Garmin Health API or Apple Health bridge</li>
              <li>HRV (rMSSD) — needs Garmin / Oura / Whoop integration</li>
            </ul>
          </section>

          <TodayReadinessForm />
        </>
      )}
    </div>
  );
}

// Bodyweight, fatigue, and soreness inputs moved to /profile and Today
// respectively in v316. The Recovery tab is now read-only: muscle freshness
// map + recent RPE + Banister TSB + the still-not-automated sleep/HRV
// reminder. Mutations live closer to where the user lands.

function TodayReadinessForm() {
  return (
    <section className="rounded-lg border border-border bg-card p-3 text-xs text-muted">
      Bodyweight is set on the{' '}
      <a href="/profile" className="text-accent underline-offset-2 hover:underline">
        Training Profile
      </a>{' '}
      page. Fatigue + soreness check-in lives on{' '}
      <a href="/" className="text-accent underline-offset-2 hover:underline">
        Today
      </a>
      .
    </section>
  );
}

