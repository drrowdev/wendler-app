'use client';

import { useState } from 'react';
import { fmtDate } from '@/lib/format';
import { useAllInjuries } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { kickSync } from '@/lib/sync';
import { deleteWithTombstones } from '@/lib/delete';
import { InjurySheet } from '@/components/injury/InjurySheet';

export default function InjuriesPage() {
  const all = useAllInjuries();
  const [showNew, setShowNew] = useState(false);

  const active = (all ?? []).filter((i) => !i.resolvedAt);
  const resolved = (all ?? []).filter((i) => !!i.resolvedAt);

  const onReopen = async (id: string) => {
    if (!confirm('Reopen this injury? Movement modifications will reactivate.')) return;
    const db = getDb();
    const inj = await db.injuries.get(id);
    if (!inj) return;
    const now = new Date().toISOString();
    await db.injuries.put({ ...inj, resolvedAt: undefined, updatedAt: now });
    kickSync();
  };

  const onDelete = async (id: string) => {
    if (!confirm('Delete this injury record permanently?')) return;
    await deleteWithTombstones('injury', [id]);
  };

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Injuries</h1>
          <p className="text-xs text-muted">
            Active limitations and history. The Coach agent reads accepted adjustments and the
            Programmer agent routes around them when generating assistance.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg"
        >
          + Log limitation
        </button>
      </header>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-200">
          Active ({active.length})
        </h2>
        {active.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-bg p-3 text-sm text-muted">
            No active limitations. 🎉
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((inj) => (
              <li
                key={inj.id}
                className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3"
              >
                <InjuryRow injury={inj} onDelete={onDelete} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          Resolved ({resolved.length})
        </h2>
        {resolved.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-bg p-3 text-sm text-muted">
            No history yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {resolved.map((inj) => (
              <li key={inj.id} className="rounded-xl border border-border bg-card p-3 opacity-90">
                <InjuryRow injury={inj} onDelete={onDelete} onReopen={onReopen} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {showNew && (
        <InjurySheet
          onSaved={() => setShowNew(false)}
          onCancel={() => setShowNew(false)}
        />
      )}
    </div>
  );
}

interface InjuryRowProps {
  injury: import('@wendler/db-schema').Injury;
  onDelete: (id: string) => void;
  onReopen?: (id: string) => void;
}

function InjuryRow({ injury, onDelete, onReopen }: InjuryRowProps) {
  const [editing, setEditing] = useState(false);
  const accepted = injury.adjustments.filter((a) => a.status === 'accepted');
  const declined = injury.adjustments.filter((a) => a.status === 'declined');

  const toggleAdjustment = async (adjId: string) => {
    const db = getDb();
    const now = new Date().toISOString();
    const adjustments = injury.adjustments.map((a) => {
      if (a.id !== adjId) return a;
      const nextStatus = a.status === 'accepted' ? 'declined' : 'accepted';
      return {
        ...a,
        status: nextStatus,
        ...(nextStatus === 'accepted'
          ? { acceptedAt: now, declinedAt: undefined }
          : { declinedAt: now, acceptedAt: undefined }),
        userEdited: true,
      };
    });
    await db.injuries.put({ ...injury, adjustments, updatedAt: now });
    kickSync();
  };

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="font-semibold capitalize">{injury.area}</div>
          <div className="text-[11px] text-muted">
            Severity {injury.severity}/5 · {fmtDate(injury.startedAt)}
            {injury.resolvedAt && <> → resolved {fmtDate(injury.resolvedAt)}</>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {!injury.resolvedAt && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className={`rounded border px-2 py-0.5 text-[11px] ${
                editing
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-muted hover:text-fg'
              }`}
            >
              {editing ? 'Done' : 'Edit adjustments'}
            </button>
          )}
          {onReopen && (
            <button
              type="button"
              onClick={() => onReopen(injury.id)}
              className="rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:text-fg"
            >
              Reopen
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(injury.id)}
            className="rounded border border-border px-2 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10"
          >
            Delete
          </button>
        </div>
      </div>
      <p className="mt-2 text-sm">{injury.description}</p>
      {injury.summary && (
        <p className="mt-1 text-[11px] italic text-muted">{injury.summary}</p>
      )}
      {editing ? (
        <ul className="mt-2 space-y-1 text-xs">
          {injury.adjustments.map((adj) => {
            const isAccepted = adj.status === 'accepted';
            return (
              <li
                key={adj.id}
                className={`flex items-start gap-2 rounded px-2 py-1.5 ${
                  isAccepted
                    ? 'bg-emerald-500/10 ring-1 ring-emerald-500/30'
                    : 'bg-bg/40 ring-1 ring-border/60'
                }`}
              >
                <button
                  type="button"
                  onClick={() => void toggleAdjustment(adj.id)}
                  aria-pressed={isAccepted}
                  title={isAccepted ? 'Tap to decline' : 'Tap to accept'}
                  className={`shrink-0 rounded border px-2 py-0.5 text-[11px] font-semibold ${
                    isAccepted
                      ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-100'
                      : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                  }`}
                >
                  {isAccepted ? '✓ Accepted' : '✕ Declined'}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-wide text-muted">
                    {adj.action.replace('-', ' ')}
                  </div>
                  <div className="mt-0.5">{adj.modification}</div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          {accepted.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs">
              {accepted.map((adj) => (
                <li key={adj.id} className="rounded bg-bg/40 px-2 py-1 ring-1 ring-border/60">
                  <span className="font-semibold text-amber-200">
                    {adj.action.replace('-', ' ')}
                  </span>
                  <span className="ml-1">{adj.modification}</span>
                </li>
              ))}
            </ul>
          )}
          {declined.length > 0 && (
            <details className="mt-2 text-[11px] text-muted">
              <summary className="cursor-pointer">{declined.length} declined</summary>
              <ul className="mt-1 space-y-0.5">
                {declined.map((adj) => (
                  <li key={adj.id} className="opacity-60">
                    {adj.action.replace('-', ' ')}: {adj.modification}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {injury.monitoringAdvice && (
        <details className="mt-2 text-[11px] text-muted">
          <summary className="cursor-pointer">Monitoring</summary>
          <p className="mt-1">{injury.monitoringAdvice}</p>
        </details>
      )}
    </div>
  );
}
