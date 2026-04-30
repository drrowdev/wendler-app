'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { liftLabel } from '@/lib/format';
import { useAllSessions } from '@/lib/hooks';
import type { MainLift } from '@wendler/db-schema';

const LIFT_COLORS: Record<MainLift, string> = {
  squat: 'bg-emerald-500',
  bench: 'bg-blue-500',
  deadlift: 'bg-amber-500',
  press: 'bg-red-500',
};

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default function CalendarPage() {
  const sessions = useAllSessions();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  const byDay = useMemo(() => {
    const m = new Map<string, NonNullable<typeof sessions>>();
    for (const s of sessions ?? []) {
      const day = s.performedAt.slice(0, 10);
      const arr = m.get(day) ?? [];
      arr.push(s);
      m.set(day, arr);
    }
    return m;
  }, [sessions]);

  const grid = useMemo(() => {
    const first = new Date(year, month, 1);
    const firstWeekday = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: { date: Date | null; iso: string | null }[] = [];
    for (let i = 0; i < firstWeekday; i++) cells.push({ date: null, iso: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ date, iso });
    }
    while (cells.length % 7 !== 0) cells.push({ date: null, iso: null });
    return cells;
  }, [year, month]);

  const goPrev = () => {
    if (month === 0) { setMonth(11); setYear(year - 1); }
    else setMonth(month - 1);
  };
  const goNext = () => {
    if (month === 11) { setMonth(0); setYear(year + 1); }
    else setMonth(month + 1);
  };
  const goToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth());
  };

  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const monthStats = useMemo(() => {
    const days = grid.filter((c) => c.iso !== null);
    let completed = 0;
    let started = 0;
    for (const c of days) {
      const ss = byDay.get(c.iso!) ?? [];
      if (ss.length > 0) started += 1;
      if (ss.some((s) => s.completedAt)) completed += 1;
    }
    return { started, completed };
  }, [grid, byDay]);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Calendar</h1>
        <button onClick={goToday} className="rounded-lg bg-card px-3 py-1 text-sm ring-1 ring-border">
          Today
        </button>
      </header>

      <div className="flex items-center justify-between">
        <button onClick={goPrev} className="rounded-lg bg-card px-3 py-1 ring-1 ring-border" aria-label="Previous month">◀</button>
        <h2 className="text-lg font-semibold">{MONTHS[month]} {year}</h2>
        <button onClick={goNext} className="rounded-lg bg-card px-3 py-1 ring-1 ring-border" aria-label="Next month">▶</button>
      </div>

      <div className="rounded-xl border border-border bg-card p-2">
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted">
          {WEEKDAYS.map((w) => <div key={w} className="py-1">{w}</div>)}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {grid.map((c, i) => {
            if (!c.date) return <div key={i} className="aspect-square" />;
            const ss = byDay.get(c.iso!) ?? [];
            const isToday = c.iso === todayIso;
            return (
              <div
                key={i}
                className={`relative flex aspect-square flex-col items-center justify-center rounded-lg border p-1 text-xs ${
                  isToday ? 'border-accent bg-accent/10'
                    : ss.length > 0 ? 'border-border bg-bg'
                    : 'border-transparent'
                }`}
              >
                <span className={isToday ? 'font-bold text-accent' : 'text-fg'}>
                  {c.date.getDate()}
                </span>
                {ss.length > 0 && (
                  <div className="mt-0.5 flex gap-0.5">
                    {ss.slice(0, 4).map((s) => (
                      <Link
                        key={s.id}
                        href={`/session?id=${s.id}`}
                        title={`${s.mainLift ? liftLabel(s.mainLift) : 'Session'}${s.completedAt ? ' ✓' : ''}`}
                        className={`block h-1.5 w-1.5 rounded-full ${
                          s.mainLift ? LIFT_COLORS[s.mainLift] : 'bg-muted'
                        } ${!s.completedAt ? 'opacity-50' : ''}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted">This month</span>
          <span>
            <span className="font-mono text-fg">{monthStats.completed}</span> completed ·{' '}
            <span className="font-mono text-fg">{monthStats.started}</span> started
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          {(['squat', 'bench', 'deadlift', 'press'] as MainLift[]).map((l) => (
            <span key={l} className="flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${LIFT_COLORS[l]}`} />
              {liftLabel(l)}
            </span>
          ))}
          <span className="flex items-center gap-1 text-muted">(faded = not completed)</span>
        </div>
      </div>
    </div>
  );
}
