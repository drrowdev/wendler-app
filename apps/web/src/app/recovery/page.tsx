'use client';

import { useMemo, useState } from 'react';
import {
  banister,
  cardioMuscleImpact,
  dailyLoadSeries,
  type MuscleGroup,
} from '@wendler/domain';
import { useAllCardio, useAllSets, useMovements, useRecoveryEntry } from '@/lib/hooks';
import { upsertRecoveryEntry } from '@/lib/recovery';

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

export default function RecoveryPage() {
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

// ---------------------------------------------------------------------------
// Today's readiness form — bodyweight + fatigue + soreness manual entries.
// Bodyweight feeds the `effectiveLoadKg` helper (Pull-Up + vest analytics);
// fatigue/soreness feed the load.ts stress score. Persists to the
// RecoveryEntry singleton-per-day keyed by today's local date.
// ---------------------------------------------------------------------------

function TodayReadinessForm() {
  const entry = useRecoveryEntry();
  const [bwInput, setBwInput] = useState<string>('');
  const [savedMsg, setSavedMsg] = useState<string>('');

  const displayedBw = entry?.bodyweightKg;

  const onSubmitBw = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(bwInput.replace(',', '.'));
    if (!Number.isFinite(val) || val <= 0 || val > 500) return;
    await upsertRecoveryEntry({ bodyweightKg: val });
    setBwInput('');
    setSavedMsg('Saved');
    setTimeout(() => setSavedMsg(''), 1500);
  };

  const clearBw = async () => {
    await upsertRecoveryEntry({ bodyweightKg: undefined });
    setSavedMsg('Cleared');
    setTimeout(() => setSavedMsg(''), 1500);
  };

  const setFatigue = async (val: number) => {
    await upsertRecoveryEntry({ fatigue: val });
  };

  const setSoreness = async (val: number) => {
    await upsertRecoveryEntry({ soreness: val });
  };

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-3">
      <header>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Today
        </h2>
        <p className="text-xs text-muted">
          Bodyweight + readiness. Bodyweight powers effective-load analytics on
          weighted bodyweight movements (pull-ups, dips). Fatigue and soreness
          feed the stress score.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border/60 bg-bg/40 p-3">
          <div className="flex items-baseline justify-between">
            <label className="text-xs font-medium uppercase tracking-wide text-muted">
              Bodyweight
            </label>
            {displayedBw != null && (
              <span className="text-[10px] text-muted">{savedMsg}</span>
            )}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-fg">
              {displayedBw != null ? displayedBw.toFixed(1) : '—'}
            </span>
            <span className="text-sm text-muted">kg</span>
          </div>
          <form onSubmit={onSubmitBw} className="mt-2 flex flex-wrap gap-1.5">
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min="30"
              max="300"
              value={bwInput}
              onChange={(e) => setBwInput(e.target.value)}
              placeholder={displayedBw != null ? 'Update…' : 'e.g. 80.5'}
              className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-sm tabular-nums text-fg focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={!bwInput.trim()}
              className="rounded-md border border-accent/60 bg-accent/15 px-3 py-1 text-xs font-medium text-accent disabled:opacity-40"
            >
              Save
            </button>
            {displayedBw != null && (
              <button
                type="button"
                onClick={() => void clearBw()}
                className="rounded-md border border-border bg-bg px-3 py-1 text-xs text-muted hover:text-fg"
              >
                Clear
              </button>
            )}
          </form>
        </div>

        <div className="rounded-md border border-border/60 bg-bg/40 p-3">
          <ReadinessScale
            label="Fatigue"
            hint="1 fresh · 10 wrecked"
            value={entry?.fatigue}
            onChange={(v) => void setFatigue(v)}
          />
          <div className="mt-3">
            <ReadinessScale
              label="Soreness"
              hint="1 none · 10 severe"
              value={entry?.soreness}
              onChange={(v) => void setSoreness(v)}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function ReadinessScale({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value?: number;
  onChange: (val: number) => void;
}) {
  // Render 5 buttons mapped to (1, 3, 5, 7, 9) on the 1-10 scale so the
  // UI stays simple while the schema keeps its existing 1-10 precision.
  const buckets: { label: string; val: number }[] = [
    { label: '1', val: 1 },
    { label: '2', val: 3 },
    { label: '3', val: 5 },
    { label: '4', val: 7 },
    { label: '5', val: 9 },
  ];
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          {label}
        </span>
        <span className="text-[10px] text-muted">{hint}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-5 gap-1">
        {buckets.map((b) => {
          const active = value === b.val;
          return (
            <button
              key={b.val}
              type="button"
              onClick={() => onChange(b.val)}
              className={`rounded-md px-2 py-1.5 text-sm font-medium tabular-nums ring-1 transition-colors ${
                active
                  ? 'bg-accent text-bg ring-accent'
                  : 'bg-bg text-muted ring-border hover:text-fg'
              }`}
              aria-label={`${label} ${b.label} of 5`}
            >
              {b.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
