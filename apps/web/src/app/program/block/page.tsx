'use client';

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { blockCompletion, muscleVolume, type MinimalSet } from '@wendler/domain';
import type { MainLift } from '@wendler/db-schema';
import { fmtDate, liftLabel } from '@/lib/format';
import {
  useAllSessions,
  useAllSets,
  useBlock,
  useMovements,
} from '@/lib/hooks';
import { BodyMap } from '@/components/BodyMap';

export default function BlockDetailPageWrapper() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <BlockDetailPage />
    </Suspense>
  );
}

function BlockDetailPage() {
  const params = useSearchParams();
  const id = params.get('id') ?? '';
  const block = useBlock(id || undefined);
  const sessions = useAllSessions();
  const setsRaw = useAllSets();
  const movements = useMovements();

  const setsWithSession = useMemo<MinimalSet[]>(
    () => (setsRaw ?? []).map((s) => ({ ...s }) as MinimalSet),
    [setsRaw],
  );

  const summary = useMemo(() => {
    if (!sessions || !id) return null;
    return blockCompletion(id, sessions, setsWithSession);
  }, [id, sessions, setsWithSession]);

  const blockSessions = useMemo(
    () =>
      (sessions ?? [])
        .filter((s) => s.blockId === id)
        .sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1)),
    [sessions, id],
  );
  const blockSessionIds = useMemo(
    () => new Set(blockSessions.map((s) => s.id)),
    [blockSessions],
  );
  const blockSets = useMemo(
    () => (setsRaw ?? []).filter((s) => s.sessionId && blockSessionIds.has(s.sessionId)),
    [setsRaw, blockSessionIds],
  );

  const muscles = useMemo(() => {
    if (!movements) return {};
    return muscleVolume(blockSets as MinimalSet[], movements);
  }, [blockSets, movements]);

  if (!id) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">No block selected</h1>
        <Link href="/program" className="text-accent underline">Back to program</Link>
      </div>
    );
  }

  if (block === undefined || sessions === undefined) {
    return <p className="text-muted">Loading…</p>;
  }
  if (!block) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Block not found</h1>
        <Link href="/program" className="text-accent underline">Back to program</Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <Link href="/program" className="text-xs text-muted underline">← Program</Link>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{block.name}</h1>
        <p className="text-sm text-muted">
          {block.kind} · {block.weeksBeforeDeload} weeks
          {block.includesDeload ? ' + deload' : ''}
          {block.supplementalTemplate !== 'none' && ` · ${block.supplementalTemplate}`}
        </p>
      </header>

      {summary && (
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
            Completion
          </h2>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-semibold">
                {summary.sessionsCompleted} / {summary.sessionsPlanned}
              </span>
              <span className="text-sm text-muted">
                {summary.completionPercent.toFixed(0)}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-bg">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${summary.completionPercent}%` }}
              />
            </div>
            <div className="grid grid-cols-4 gap-2 pt-2 text-center text-xs">
              {(['squat', 'bench', 'deadlift', 'press'] as MainLift[]).map((l) => (
                <div key={l} className="rounded bg-bg p-2">
                  <div className="text-muted">{liftLabel(l)}</div>
                  <div className="mt-1 font-mono text-base text-fg">
                    {summary.liftCounts[l]}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between pt-2 text-xs text-muted">
              <span>
                Tonnage:{' '}
                <span className="font-mono text-fg">
                  {(summary.tonnageKg / 1000).toFixed(1)} t
                </span>
              </span>
              {summary.startedAt && (
                <span>
                  {fmtDate(summary.startedAt)} →{' '}
                  {summary.finishedAt ? fmtDate(summary.finishedAt) : 'in progress'}
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Sessions
        </h2>
        {blockSessions.length === 0 ? (
          <p className="text-sm text-muted">No sessions logged yet for this block.</p>
        ) : (
          <ul className="space-y-2">
            {blockSessions.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/session?id=${s.id}`}
                  className="flex items-center justify-between rounded-lg border border-border bg-bg p-2 text-sm hover:border-accent"
                >
                  <span>
                    <span className="font-medium">
                      {s.mainLift ? liftLabel(s.mainLift) : 'Session'}
                    </span>
                    {s.week && (
                      <span className="ml-2 text-xs text-muted">
                        {s.week === 'deload' ? 'Deload' : `Week ${s.week}`}
                      </span>
                    )}
                    {s.completedAt && <span className="ml-2 text-emerald-400">✓</span>}
                  </span>
                  <span className="text-xs text-muted">{fmtDate(s.performedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Muscle volume during this block
        </h2>
        <BodyMap volumes={muscles} />
      </section>
    </div>
  );
}
