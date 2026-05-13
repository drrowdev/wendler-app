'use client';

import { useMemo } from 'react';
import { useAllCardio, useAllSessions, useRunPlan, useUpcomingWorkouts } from '@/lib/hooks';
import { isoDayOfWeek } from '@wendler/domain';

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function startOfIsoWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  // ISO week: Monday = 1, Sunday = 7. JS getDay: Sun = 0.
  const day = out.getDay() || 7;
  if (day !== 1) out.setDate(out.getDate() - (day - 1));
  return out;
}

function isSameYmd(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

type Glyph =
  | { kind: 'done-strength' }
  | { kind: 'done-cardio' }
  | { kind: 'planned-strength' }
  | { kind: 'planned-cardio' };

/**
 * Right-rail "This week" widget. Shows Mon–Sun rows summarising what
 * happened (or is planned) on each day. Each day cell can render up to
 * two glyphs side-by-side:
 *   - violet "S" — a strength session was completed
 *   - sky "C" — a cardio session was logged
 *   - dashed violet "S" — today/future has a projected strength workout
 *   - dashed sky "C" — today/future has a planned run (per RunPlan)
 *
 * Strength = violet, cardio = sky everywhere in the app — see
 * STRENGTH_ACCENT / CARDIO_ACCENT in @wendler/domain. Today gets an
 * accent ring; past days with no activity show "–"; the footer counts
 * everything that actually happened (strength + cardio).
 */
export function ThisWeekCard() {
  const sessions = useAllSessions();
  const cardio = useAllCardio();
  const runPlan = useRunPlan();
  const upcoming = useUpcomingWorkouts({ horizonDays: 14, maxItems: 14 });
  const today = useMemo(() => new Date(), []);

  const { days, doneCount } = useMemo(() => {
    const monday = startOfIsoWeek(today);

    // Strength glyph reflects only logged Wendler workouts (sessions
    // with workoutCompletedAt set). Imported Strava strength HR is
    // intentionally excluded here -- it's an enrichment of off-app /
    // ad-hoc activity, not part of the user's scheduled program, and
    // letting it light up additional days made the week strip widen
    // unpredictably.
    const strengthDays = new Set<string>();
    if (sessions) {
      for (const s of sessions) {
        if (!s.workoutCompletedAt) continue;
        strengthDays.add(new Date(s.workoutCompletedAt).toDateString());
      }
    }

    // Cardio glyph reflects only logged cardio sessions that line up
    // with a configured RunPlan slot for that weekday. Ad-hoc / one-off
    // activities (e.g. an extra recovery walk on a rest day) don't
    // light up the "C" -- the widget answers "did I do my plan?" not
    // "did I move at all?".
    //
    // Key by `planScheduledDate` (set when an activity was manually
    // linked to a different day's slot, or auto-set to the performed
    // date for exact day-of-week matches). Falling back to the actual
    // performed date keeps pre-`planScheduledDate` records working.
    const plannedCardioDow = new Set<number>();
    for (const slot of runPlan?.slots ?? []) {
      if (slot.kind !== 'rest') plannedCardioDow.add(slot.dayOfWeek);
    }

    const cardioDays = new Set<string>();
    if (cardio) {
      for (const c of cardio) {
        // Manually-linked off-day runs: count on the planned date, not
        // the actual performance date.
        if (c.planScheduledDate) {
          // Build a Date from the YYYY-MM-DD so toDateString matches the
          // rest of the week-strip's key shape.
          const [y, m, d] = c.planScheduledDate.split('-').map(Number);
          if (y && m && d) {
            const sd = new Date(y, m - 1, d);
            cardioDays.add(sd.toDateString());
          }
          continue;
        }
        const d = new Date(c.performedAt);
        if (!plannedCardioDow.has(isoDayOfWeek(d))) continue;
        cardioDays.add(d.toDateString());
      }
    }

    const plannedStrengthYmd = new Set<string>();
    for (const u of upcoming ?? []) {
      plannedStrengthYmd.add(u.date);
    }

    let doneCount = 0;
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const isToday = isSameYmd(d, today);
      const isPast = d < today && !isToday;
      const key = d.toDateString();
      const ymdKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const doneStrength = strengthDays.has(key);
      const doneCardio = cardioDays.has(key);
      const plannedStrength =
        !doneStrength && !isPast && plannedStrengthYmd.has(ymdKey);
      const plannedCardio =
        !doneCardio && !isPast && plannedCardioDow.has(isoDayOfWeek(d));
      const glyphs: Glyph[] = [];
      if (doneStrength) glyphs.push({ kind: 'done-strength' });
      else if (plannedStrength) glyphs.push({ kind: 'planned-strength' });
      if (doneCardio) glyphs.push({ kind: 'done-cardio' });
      else if (plannedCardio) glyphs.push({ kind: 'planned-cardio' });
      if (doneStrength) doneCount += 1;
      if (doneCardio) doneCount += 1;
      return { date: d, isToday, isPast, glyphs };
    });
    return { days, doneCount };
  }, [sessions, cardio, runPlan, upcoming, today]);

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">This week</h3>
        <span className="text-xs text-muted">{doneCount} done</span>
      </header>
      <div className="mt-3 grid grid-cols-7 gap-1">
        {days.map((d, i) => {
          const showRing = d.isToday;
          return (
            <div key={i} className="flex flex-col items-center gap-1.5">
              <span
                className={`text-[10px] font-medium ${
                  d.isToday ? 'text-accent' : 'text-muted'
                }`}
              >
                {DAY_LETTERS[i]}
              </span>
              <span
                className={`flex h-7 min-w-[1.75rem] items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-semibold ${
                  showRing ? 'ring-1 ring-accent/60' : ''
                } ${
                  d.glyphs.length === 0
                    ? d.isToday
                      ? 'bg-accent/10 text-accent'
                      : d.isPast
                        ? 'bg-bg/40 text-muted/40'
                        : 'bg-bg/40 text-muted/60'
                    : 'bg-bg/40'
                }`}
                title={dayTitle(d.date, d.glyphs)}
              >
                {d.glyphs.length === 0
                  ? d.isToday
                    ? d.date.getDate()
                    : d.isPast
                      ? '–'
                      : '·'
                  : d.glyphs.map((g, gi) => <GlyphChip key={gi} g={g} />)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40">
            <span className="text-[8px] font-bold leading-none">S</span>
          </span>
          Strength
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40">
            <span className="text-[8px] font-bold leading-none">C</span>
          </span>
          Cardio
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-dashed border-violet-400/70 bg-transparent text-violet-300/80">
            <span className="text-[8px] font-bold leading-none">S</span>
          </span>
          <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-dashed border-sky-400/70 bg-transparent text-sky-300/80">
            <span className="text-[8px] font-bold leading-none">C</span>
          </span>
          Planned
        </span>
      </div>
    </section>
  );
}

function GlyphChip({ g }: { g: Glyph }) {
  if (g.kind === 'done-strength') {
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40">
        <span className="text-[9px] font-bold leading-none">S</span>
      </span>
    );
  }
  if (g.kind === 'done-cardio') {
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40">
        <span className="text-[9px] font-bold leading-none">C</span>
      </span>
    );
  }
  if (g.kind === 'planned-strength') {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-violet-400/70 bg-transparent text-violet-300/80"
      >
        <span className="text-[9px] font-bold leading-none">S</span>
      </span>
    );
  }
  // planned-cardio: dashed outline, transparent — matches the planned-run pill on /calendar
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-sky-400/70 bg-transparent text-sky-300/80"
    >
      <span className="text-[9px] font-bold leading-none">C</span>
    </span>
  );
}

function dayTitle(date: Date, glyphs: Glyph[]): string {
  const d = date.toDateString();
  if (glyphs.length === 0) return d;
  const parts = glyphs.map((g) =>
    g.kind === 'done-strength'
      ? 'Strength done'
      : g.kind === 'done-cardio'
        ? 'Cardio done'
        : g.kind === 'planned-strength'
          ? 'Strength planned'
          : 'Cardio planned',
  );
  return `${d} — ${parts.join(' · ')}`;
}
