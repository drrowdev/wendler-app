'use client';

// ActiveLimitationsBanner — small persistent strip shown on every training
// surface (Today, Day, Program, Chat) when any active injury exists. Tap
// to open a sheet listing all active injuries with quick "Resolve".

import Link from 'next/link';
import { useState } from 'react';
import { getDb } from '@/lib/db';
import { useActiveInjuries } from '@/lib/hooks';
import { kickSync } from '@/lib/sync';

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
    active.length === 1
      ? `${active[0]!.area}`
      : `${active.length} active limitations · ${areas.join(', ')}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-xs text-amber-200 hover:bg-amber-500/15"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden>⚠</span>
          <span>
            <span className="font-semibold">{headline}</span>
            {totalAccepted > 0 && (
              <span className="ml-1 text-amber-200/70">
                · {totalAccepted} movement{totalAccepted === 1 ? '' : 's'} modified
              </span>
            )}
          </span>
        </span>
        <span className="shrink-0 text-amber-200/70">View →</span>
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
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Active limitations</h2>
          <Link
            href="/recovery/injuries"
            onClick={onClose}
            className="text-xs text-muted underline-offset-2 hover:underline"
          >
            History →
          </Link>
        </header>

        {!active || active.length === 0 ? (
          <p className="text-sm text-muted">No active limitations.</p>
        ) : (
          <ul className="space-y-3">
            {active.map((inj) => {
              const accepted = inj.adjustments.filter((a) => a.status === 'accepted');
              return (
                <li key={inj.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <div>
                      <div className="font-semibold capitalize">{inj.area}</div>
                      <div className="text-[11px] text-muted">
                        Severity {inj.severity}/5 · started {inj.startedAt.slice(0, 10)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onResolve(inj.id)}
                      className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20"
                    >
                      Mark resolved
                    </button>
                  </div>
                  {inj.summary && (
                    <p className="mt-2 text-xs italic text-muted">{inj.summary}</p>
                  )}
                  {accepted.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs">
                      {accepted.map((adj) => (
                        <li key={adj.id} className="rounded bg-bg/60 px-2 py-1 ring-1 ring-border/60">
                          <span className="font-semibold text-amber-200">
                            {adj.action.replace('-', ' ')}
                          </span>
                          <span className="ml-1">{adj.modification}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {inj.consultRecommended && (
                    <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                      ⚠ PT consult recommended: {inj.consultReason}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
