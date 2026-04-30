'use client';

import Link from 'next/link';
import { fmtDate } from '@/lib/format';
import { useActiveBlock, useAllTrainingMaxes, useBlocks, useSchedule } from '@/lib/hooks';
import { SUPPLEMENTAL_TEMPLATES } from '@wendler/domain';

export default function ProgramIndex() {
  const blocks = useBlocks();
  const active = useActiveBlock();
  const schedule = useSchedule();
  const tms = useAllTrainingMaxes();
  const hasTms = tms && tms.size > 0;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Program</h1>
          <p className="text-sm text-muted">Blocks, supplemental work, and Training Maxes.</p>
        </div>
        <Link
          href="/program/setup"
          className="rounded-lg bg-card px-3 py-2 text-sm ring-1 ring-border hover:ring-accent"
        >
          {hasTms ? 'Edit TMs' : 'Set up TMs'}
        </Link>
      </header>

      <section className="rounded-2xl border border-accent/40 bg-accent/5 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-accent">Active block</h2>
        {active ? (
          <div className="mt-2 space-y-1">
            <div className="text-xl font-semibold">{active.name}</div>
            <div className="text-sm text-muted">
              {active.kind === 'leader' ? 'Leader' : active.kind === 'anchor' ? 'Anchor' : 'Standalone'} ·{' '}
              {SUPPLEMENTAL_TEMPLATES.find((s) => s.id === active.supplementalTemplate)?.name} ·{' '}
              {active.weeksBeforeDeload} weeks{active.includesDeload ? ' + deload' : ''}
            </div>
            {schedule?.cursor && (
              <div className="text-sm">
                Next:{' '}
                <span className="font-mono text-fg">
                  {schedule.cursor.week === 'deload' ? 'Deload' : `W${schedule.cursor.week}`} ·{' '}
                  {schedule.dayOrder[schedule.cursor.dayIndex]}
                </span>
              </div>
            )}
            {active.startedAt && (
              <div className="text-xs text-muted">Started {fmtDate(active.startedAt)}</div>
            )}
          </div>
        ) : (
          <div className="mt-2">
            <p className="text-sm text-muted">No active block.</p>
            <Link
              href="/program/blocks/new"
              className="mt-2 inline-block rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg"
            >
              Start a block
            </Link>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">All blocks</h2>
          <Link
            href="/program/blocks/new"
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg"
          >
            + New block
          </Link>
        </div>
        {blocks && blocks.length > 0 ? (
          <ul className="space-y-2">
            {blocks.map((b) => (
              <li
                key={b.id}
                className="rounded-xl border border-border bg-card p-3"
              >
                <Link
                  href={`/program/block?id=${b.id}`}
                  className="flex items-center justify-between hover:text-accent"
                >
                  <div>
                    <div className="font-medium">
                      {b.name}
                      {active?.id === b.id && (
                        <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-xs font-semibold text-bg">
                          ACTIVE
                        </span>
                      )}
                      {b.completedAt && (
                        <span className="ml-2 rounded bg-card px-1.5 py-0.5 text-xs text-muted ring-1 ring-border">
                          done
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted">
                      {b.kind} ·{' '}
                      {SUPPLEMENTAL_TEMPLATES.find((s) => s.id === b.supplementalTemplate)?.name} ·{' '}
                      created {fmtDate(b.createdAt)}
                    </div>
                  </div>
                  <span className="text-xs text-muted">→</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No blocks yet.</p>
        )}
      </section>
    </div>
  );
}
