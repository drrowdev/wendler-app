'use client';

// ActiveLimitationsBanner — persistent strip shown on every training
// surface (Today, Day, Program, Chat) when any active injury exists. Tap
// to open a sheet listing all active injuries with quick "Resolve" + the
// accepted adjustments rendered as readable chips.

import Link from 'next/link';
import { useState } from 'react';
import { getDb } from '@/lib/db';
import { useActiveInjuries } from '@/lib/hooks';
import { kickSync } from '@/lib/sync';

const ACTION_LABEL: Record<string, string> = {
  skip: 'Skip',
  'reduce-load': 'Reduce load',
  'reduce-range': 'Reduce range',
  'modify-execution': 'Modify execution',
  monitor: 'Monitor',
};

// Tone classes mirror /recovery/injuries — same vocabulary so users
// learn one chip-color contract across surfaces.
const ACTION_TONE: Record<string, string> = {
  skip: 'border-rose-500/50 bg-rose-500/15 text-rose-100',
  'reduce-load': 'border-amber-500/50 bg-amber-500/15 text-amber-100',
  'reduce-range': 'border-amber-500/40 bg-amber-500/10 text-amber-100',
  'modify-execution': 'border-sky-500/50 bg-sky-500/15 text-sky-100',
  monitor: 'border-violet-500/40 bg-violet-500/10 text-violet-100',
};

function severityTone(severity: number): string {
  if (severity >= 4) return 'bg-rose-500/20 text-rose-100 ring-rose-500/40';
  if (severity === 3) return 'bg-amber-500/20 text-amber-100 ring-amber-500/40';
  return 'bg-sky-500/20 text-sky-100 ring-sky-500/40';
}

export function ActiveLimitationsBanner() {
  const active = useActiveInjuries();
  const [open, setOpen] = useState(false);

  if (!active || active.length === 0) return null;

  const totalAccepted = active.reduce(
    (acc, inj) => acc + inj.adjustments.filter((a) => a.status === 'accepted').length,
    0,
  );
  const areas = Array.from(new Set(active.map((i) => i.area)));
  const headline =
    active.length === 1 ? active[0]!.area : `${active.length} active limitations`;
  const subline =
    active.length > 1
      ? areas.join(' · ')
      : totalAccepted > 0
        ? `${totalAccepted} movement${totalAccepted === 1 ? '' : 's'} modified`
        : 'No movement changes';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-left hover:bg-amber-500/15"
        aria-label={`${headline}: ${subline}. Tap to view details.`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="text-lg leading-none text-amber-300">⚠</span>
          <span className="min-w-0">
            <span className="block text-base font-semibold capitalize text-amber-50">
              {headline}
            </span>
            <span className="block text-sm text-amber-200/80">{subline}</span>
          </span>
        </span>
        <span className="shrink-0 text-sm font-medium text-amber-100">View →</span>
      </button>

      {open && <ActiveLimitationsSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function ActiveLimitationsSheet({ onClose }: { onClose: () => void }) {
  const active = useActiveInjuries();

  const onResolve = async (injuryId: string) => {
    if (!confirm('Mark this injury as resolved? Movement modifications will lift immediately.')) {
      return;
    }
    const db = getDb();
    const inj = await db.injuries.get(injuryId);
    if (!inj) return;
    const now = new Date().toISOString();
    await db.injuries.put({ ...inj, resolvedAt: now, updatedAt: now });
    kickSync();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-baseline justify-between gap-2">
          <h2 className="text-2xl font-semibold">Active limitations</h2>
          <Link
            href="/recovery/injuries"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-fg/80 hover:bg-bg/40 hover:text-fg"
          >
            History →
          </Link>
        </header>

        {!active || active.length === 0 ? (
          <p className="text-base text-muted">No active limitations.</p>
        ) : (
          <ul className="space-y-4">
            {active.map((inj) => {
              const accepted = inj.adjustments.filter((a) => a.status === 'accepted');
              const displayArea = inj.area;
              return (
                <li
                  key={inj.id}
                  className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <h3 className="text-xl font-semibold capitalize">{displayArea}</h3>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${severityTone(
                            inj.severity,
                          )}`}
                        >
                          Severity {inj.severity}/5
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-muted">
                        Started {inj.startedAt.slice(0, 10)}
                        {accepted.length > 0 && (
                          <span>
                            {' '}· {accepted.length} adjustment
                            {accepted.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onResolve(inj.id)}
                      className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/25"
                    >
                      Mark resolved
                    </button>
                  </div>

                  {inj.summary && (
                    <p className="mt-3 text-sm leading-relaxed text-fg/85">{inj.summary}</p>
                  )}

                  {accepted.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {accepted.map((adj) => {
                        const tone =
                          ACTION_TONE[adj.action] ?? 'border-border bg-bg/40 text-fg/80';
                        const label = ACTION_LABEL[adj.action] ?? adj.action;
                        return (
                          <li
                            key={adj.id}
                            className={`rounded-lg border px-3 py-2 text-sm leading-relaxed ${tone}`}
                          >
                            <span className="mr-2 inline-flex shrink-0 items-center rounded bg-bg/30 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide ring-1 ring-current/30">
                              {label}
                            </span>
                            <span className="text-fg/90">{adj.modification}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {inj.consultRecommended && (
                    <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-relaxed text-amber-100">
                      <div className="font-semibold text-amber-50">⚠ PT consult recommended</div>
                      <p className="mt-1 text-amber-100/90">{inj.consultReason}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg/80 hover:bg-bg/40 hover:text-fg"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
