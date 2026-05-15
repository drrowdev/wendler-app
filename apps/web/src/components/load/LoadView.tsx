'use client';

import { useMemo } from 'react';
import {
  banister,
  currentWeekStart,
  dailyLoadSeries,
  deloadSuggestion,
  dynamicCardioCap,
  previousWeekStarts,
  weeklyLoad,
  type WeeklyLoad,
} from '@wendler/domain';
import { useAllCardio, useAllRecovery, useAllSets, useAllSessions, useAllStrengthHr } from '@/lib/hooks';
import { BarChart } from '@/components/charts/BarChart';
import { TaperBanner } from '@/components/TaperBanner';
import { fmtDate, fmtDayMonth } from '@/lib/format';

const RECO_STYLES: Record<string, { label: string; tone: string }> = {
  continue: { label: '✅ Keep training', tone: 'border-green-500/40 bg-green-500/10' },
  'deload-soon': { label: '🟡 Deload soon', tone: 'border-yellow-500/40 bg-yellow-500/10' },
  'deload-now': { label: '🔴 Deload now', tone: 'border-red-500/40 bg-red-500/10' },
};

// Stretch the daily series 90 days back so the 42-day CTL EWA has room to settle.
const BANISTER_WINDOW_DAYS = 90;

function tsbTone(tsb: number): string {
  if (tsb >= 0) return 'border-green-500/40 bg-green-500/10';
  if (tsb >= -15) return 'border-yellow-500/40 bg-yellow-500/10';
  if (tsb >= -30) return 'border-orange-500/40 bg-orange-500/10';
  return 'border-red-500/40 bg-red-500/10';
}

function acwrTone(acwr: number | null): string {
  if (acwr === null) return 'border-border bg-card';
  if (acwr >= 0.8 && acwr <= 1.3) return 'border-green-500/40 bg-green-500/10';
  if (acwr > 1.5) return 'border-red-500/40 bg-red-500/10';
  if (acwr > 1.3) return 'border-yellow-500/40 bg-yellow-500/10';
  // Low end is detraining / returning — not an injury-risk state. The
  // deload engine doesn't fire any reason for low ACWR, so we shouldn't
  // signal "danger" red here; use a calm blue accent instead.
  if (acwr < 0.5) return 'border-sky-500/40 bg-sky-500/10';
  return 'border-border bg-card';
}

export function LoadView() {
  const sets = useAllSets();
  const sessions = useAllSessions();
  const cardio = useAllCardio();
  const recovery = useAllRecovery();
  const strengthHr = useAllStrengthHr();

  const cardioCap = useMemo(
    () => dynamicCardioCap(cardio ?? [], new Date(), 6),
    [cardio],
  );

  const weeks = useMemo(() => {
    const starts = previousWeekStarts(new Date(), 8);
    return starts.map((ws) =>
      weeklyLoad(ws, sets ?? [], cardio ?? [], recovery ?? [], {
        cardioCap,
        strengthHrEnrichments: strengthHr ?? [],
      }),
    );
  }, [sets, cardio, recovery, cardioCap, strengthHr]);

  const ban = useMemo(() => {
    const today = new Date();
    const fromMs = today.getTime() - (BANISTER_WINDOW_DAYS - 1) * 86400000;
    const from = new Date(fromMs).toISOString().slice(0, 10);
    const to = today.toISOString().slice(0, 10);
    // Combine cardio and Strava strength-HR enrichments — both contribute
    // HR-zone-weighted minutes to daily load. The strength activities
    // themselves aren't in `cardio` (they're enrichments-only), so without
    // this union the Banister CTL/ATL/TSB would understate heavy lifting weeks.
    const dailyCardio = [...(cardio ?? []), ...(strengthHr ?? [])];
    const series = dailyLoadSeries(from, to, sets ?? [], dailyCardio);
    return banister(series);
  }, [sets, cardio, strengthHr]);

  const lastDeload = useMemo(() => {
    const deloads = (sessions ?? [])
      .map((s) => ({ s, ts: s.workoutCompletedAt ?? s.completedAt }))
      .filter((x) => x.s.week === 'deload' && !!x.ts);
    if (deloads.length === 0) return undefined;
    return deloads.sort((a, b) => (a.ts! < b.ts! ? 1 : -1))[0]?.ts;
  }, [sessions]);

  const reco = useMemo(() => {
    // Pass the last ~14 days of sets so the deload engine can detect
    // consecutive high-RPE streaks that weekly averages would smooth away.
    const cutoff = Date.now() - 14 * 86400000;
    const recentSets = (sets ?? []).filter(
      (s) => new Date(s.performedAt).getTime() >= cutoff,
    );
    return deloadSuggestion({
      recentWeeks: weeks,
      lastDeloadAt: lastDeload,
      recentSets,
      banister: ban,
    });
  }, [weeks, lastDeload, sets, ban]);

  const thisWeekStart = currentWeekStart();
  const thisWeek = weeks.find((w) => w.weekStart === thisWeekStart);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Load &amp; Recovery</h1>
        <p className="text-sm text-muted">
          Banister fitness/fatigue/form (CTL/ATL/TSB) plus a weekly stress score combining strength tonnage, cardio time, RPE, fatigue and sleep. Deload urgency is driven by TSB, ACWR, RPE streaks, and absolute thresholds; the personal weekly stress range is shown for context.
        </p>
      </header>

      <TaperBanner expanded />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Form &amp; load (Banister model)
        </h2>
        <div className={`relative rounded-lg border p-4 text-center ${tsbTone(ban.tsb)}`}>
          <InfoTip text="Training Stress Balance — your current 'form'. CTL minus ATL. Positive = fresh and ready, negative = accumulating fatigue. Roughly: 0 to +15 fresh · 0 to −15 productive training · −15 to −30 high fatigue · below −30 overreaching." />
          <div className="text-xs uppercase tracking-wide text-muted">Form (TSB)</div>
          <div className="text-3xl font-bold">{ban.tsb.toFixed(0)}</div>
          <div className="text-xs text-muted">fitness − fatigue</div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="Fitness (CTL)"
            value={ban.ctl.toFixed(1)}
            info="Chronic Training Load — exponentially-weighted 42-day average of daily training load. Represents your long-term fitness; rises slowly as you train consistently."
          />
          <Stat
            label="Fatigue (ATL)"
            value={ban.atl.toFixed(1)}
            info="Acute Training Load — exponentially-weighted 7-day average of daily training load. Represents short-term fatigue; rises quickly after hard sessions and decays in a few days of rest."
          />
          <div
            className={`relative rounded-lg border p-3 text-center ${acwrTone(ban.acwrRolling)}`}
          >
            <InfoTip text="ACWR — uncoupled rolling window. Acute = mean load over the last 7 days; chronic = mean load over the 28 days BEFORE that (no overlap). Validated against Gabbett's thresholds: sweet spot 0.8–1.3 (green), 1.3–1.5 = caution (yellow), > 1.5 = injury-risk spike (red), < 0.5 = detraining/returning." />
            <div className="text-xs text-muted">ACWR</div>
            <div className="text-lg font-semibold">
              {ban.acwrRolling === null ? '—' : ban.acwrRolling.toFixed(2)}
            </div>
          </div>
        </div>
      </section>

      <section
        className={`rounded-lg border p-4 ${RECO_STYLES[reco.recommendation]?.tone ?? ''}`}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">
            {RECO_STYLES[reco.recommendation]?.label}
          </h2>
          <span className="text-xs text-muted">
            confidence {Math.round(reco.confidence * 100)}%
          </span>
        </div>
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-sm">
          {reco.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {ban.coldStart && (
          <p className="mt-2 text-xs text-muted">
            Cold start — TSB-based signals warming up. Need 14+ days of logged load before fitness/fatigue/form become reliable.
          </p>
        )}
        {reco.baseline ? (
          <p className="mt-2 text-xs text-muted">
            Personal stress range (display only): {Math.round(reco.baseline.meanStress)} ± {Math.round(reco.baseline.sdStress)} over {reco.baseline.weeks} prior week{reco.baseline.weeks === 1 ? '' : 's'}
            {reco.baseline.meanRpe !== undefined && (
              <> · RPE {reco.baseline.meanRpe.toFixed(1)}</>
            )}
            .
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted">
            Building your personal stress range — needs at least 2 trained weeks of history.
          </p>
        )}
      </section>

      {thisWeek && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            This week ({fmtDate(thisWeek.weekStart)})
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Stress score"
              value={thisWeek.stressScore.toString()}
              info="Composite weekly stress (0–100+) blending strength tonnage, cardio time, average RPE, fatigue and sleep. Used together with TSB and ACWR to drive the deload recommendation."
            />
            <Stat
              label="Tonnage"
              value={`${Math.round(thisWeek.strengthTonnageKg).toLocaleString()} kg`}
            />
            <Stat
              label="Weighted (IF²)"
              value={`${Math.round(thisWeek.weightedTonnageKg).toLocaleString()} kg`}
              info="Tonnage weighted by Intensity Factor squared (load ÷ e1RM)². Heavy near-max sets count for much more than light back-off sets, so this reflects neuromuscular stress better than raw tonnage."
            />
            <Stat label="Cardio" value={`${Math.round(thisWeek.cardioMinutes)} min`} />
            <Stat label="Days" value={`${thisWeek.trainingDays}`} />
            {thisWeek.avgRpe !== undefined && (
              <Stat label="Avg RPE" value={thisWeek.avgRpe.toFixed(1)} />
            )}
            {thisWeek.avgSleep !== undefined && (
              <Stat label="Avg sleep" value={`${thisWeek.avgSleep.toFixed(1)} h`} />
            )}
            {thisWeek.avgFatigue !== undefined && (
              <Stat label="Avg fatigue" value={thisWeek.avgFatigue.toFixed(1)} />
            )}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Stress score (last 8 weeks)
        </h2>
        <div className="rounded-lg border border-border bg-card p-3">
          <BarChart
            data={weeks.map((w: WeeklyLoad) => ({
              label: fmtDayMonth(w.weekStart),
              value: w.stressScore,
            }))}
            height={180}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Tonnage by week (kg)
        </h2>
        <div className="rounded-lg border border-border bg-card p-3">
          <BarChart
            data={weeks.map((w: WeeklyLoad) => ({
              label: fmtDayMonth(w.weekStart),
              value: Math.round(w.strengthTonnageKg),
            }))}
            height={180}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Cardio minutes by week
        </h2>
        <div className="rounded-lg border border-border bg-card p-3">
          <BarChart
            data={weeks.map((w: WeeklyLoad) => ({
              label: fmtDayMonth(w.weekStart),
              value: Math.round(w.cardioMinutes),
            }))}
            height={140}
          />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, info }: { label: string; value: string; info?: string }) {
  return (
    <div className="relative rounded-lg border border-border bg-card p-3 text-center">
      {info && <InfoTip text={info} />}
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="group absolute right-1.5 top-1.5 z-10">
      <button
        type="button"
        aria-label="What is this?"
        title={text}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-border bg-card/80 text-[10px] font-bold leading-none text-muted hover:text-foreground"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-5 z-20 hidden w-56 rounded-md border border-border bg-card p-2 text-left text-[11px] font-normal leading-snug text-foreground shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}
