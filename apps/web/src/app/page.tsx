'use client';

import Link from 'next/link';
import { MAIN_LIFTS, fmtDate, fmtKg, liftLabel } from '@/lib/format';
import { useAllTrainingMaxes, useSessionsRecent } from '@/lib/hooks';
import { TaperBanner } from '@/components/TaperBanner';

export default function Home() {
  const tms = useAllTrainingMaxes();
  const sessions = useSessionsRecent(5);
  const hasTms = tms && tms.size > 0;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Today</h1>
          <p className="text-sm text-muted">{fmtDate(new Date().toISOString())}</p>
        </div>
        <Link
          href="/program/setup"
          className="rounded-lg bg-card px-3 py-2 text-sm ring-1 ring-border hover:ring-accent"
        >
          {hasTms ? 'Edit TMs' : 'Set up TMs'}
        </Link>
      </header>

      <TaperBanner />

      {!hasTms ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-center">
          <h2 className="text-lg font-semibold">Welcome.</h2>
          <p className="mt-2 text-sm text-muted">
            Set your Training Max for the four main lifts to start logging sessions.
          </p>
          <Link
            href="/program/setup"
            className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 font-semibold text-bg"
          >
            Set up
          </Link>
        </div>
      ) : (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Training Maxes</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {MAIN_LIFTS.map((l) => {
              const tm = tms?.get(l.key);
              return (
                <Link
                  key={l.key}
                  href={`/session?lift=${l.key}&week=1`}
                  className="rounded-xl border border-border bg-card p-3 transition hover:border-accent"
                >
                  <div className="text-xs uppercase tracking-wide text-muted">{l.label}</div>
                  <div className="mt-1 text-2xl font-semibold">
                    {tm ? fmtKg(tm.trainingMaxKg) : '—'}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {tm ? `TM @ ${(tm.tmPercent * 100).toFixed(0)}%` : 'not set'}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Quick start</h2>
        <p className="text-sm text-muted">Pick a lift and a week to start logging:</p>
        <div className="grid gap-2">
          {MAIN_LIFTS.map((l) => (
            <div
              key={l.key}
              className="flex items-center justify-between rounded-xl border border-border bg-card p-3"
            >
              <div className="font-medium">{liftLabel(l.key)}</div>
              <div className="flex gap-1">
                {[1, 2, 3].map((w) => (
                  <Link
                    key={w}
                    href={`/session?lift=${l.key}&week=${w}`}
                    className="rounded bg-bg px-3 py-1 text-sm ring-1 ring-border hover:ring-accent"
                  >
                    W{w}
                  </Link>
                ))}
                <Link
                  href={`/session?lift=${l.key}&week=deload`}
                  className="rounded bg-bg px-3 py-1 text-sm ring-1 ring-border hover:ring-accent"
                >
                  D
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {sessions && sessions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Recent sessions</h2>
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/session?id=${s.id}`}
                  className="flex items-center justify-between rounded-xl border border-border bg-card p-3 hover:border-accent"
                >
                  <span className="font-medium">
                    {s.mainLift ? liftLabel(s.mainLift) : 'Session'}
                    {s.week && (
                      <span className="ml-2 text-xs text-muted">
                        {s.week === 'deload' ? 'Deload' : `Week ${s.week}`}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted">{fmtDate(s.performedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
