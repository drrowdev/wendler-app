'use client';

import { useState } from 'react';
import { fmtDate } from '@/lib/format';
import { useAllInjuries } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { kickSync } from '@/lib/sync';
import { deleteWithTombstones } from '@/lib/delete';
import { InjurySheet } from '@/components/injury/InjurySheet';
import type { Injury, ProgramBlock } from '@wendler/db-schema';
import { resolveDayAssistance, type WendlerWeek } from '@wendler/domain';

const ACTION_LABEL: Record<string, string> = {
  skip: 'Skip',
  'reduce-load': 'Reduce load',
  'reduce-range': 'Reduce range',
  'modify-execution': 'Modify execution',
  monitor: 'Monitor',
};
const ACTION_TONE: Record<string, string> = {
  skip: 'border-rose-500/50 bg-rose-500/15 text-rose-200',
  'reduce-load': 'border-amber-500/50 bg-amber-500/15 text-amber-200',
  'reduce-range': 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  'modify-execution': 'border-sky-500/50 bg-sky-500/15 text-sky-200',
  monitor: 'border-violet-500/40 bg-violet-500/10 text-violet-200',
};

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
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Injuries</h1>
          <p className="max-w-2xl text-sm text-muted">
            Active limitations and history. The Coach agent reads accepted adjustments
            and the Programmer agent routes around them when generating assistance.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg shadow-sm"
        >
          + Log limitation
        </button>
      </header>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-200">
          Active ({active.length})
        </h2>
        {active.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-bg/40 p-4 text-sm text-muted">
            No active limitations. 🎉
          </p>
        ) : (
          <ul className="space-y-3">
            {active.map((inj) => (
              <li key={inj.id}>
                <InjuryRow injury={inj} onDelete={onDelete} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Resolved ({resolved.length})
        </h2>
        {resolved.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-bg/40 p-4 text-sm text-muted">
            No history yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {resolved.map((inj) => (
              <li key={inj.id}>
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
  injury: Injury;
  onDelete: (id: string) => void;
  onReopen?: (id: string) => void;
}

function InjuryRow({ injury, onDelete, onReopen }: InjuryRowProps) {
  const [editing, setEditing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | undefined>();
  const isActive = !injury.resolvedAt;

  const toggleAdjustment = async (adjId: string) => {
    const db = getDb();
    const now = new Date().toISOString();
    const adjustments = injury.adjustments.map((a) => {
      if (a.id !== adjId) return a;
      const nextStatus: 'accepted' | 'declined' =
        a.status === 'accepted' ? 'declined' : 'accepted';
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

  // Compute planned skip-swaps without applying them. Returns the list of
  // proposed (source → target × affected entries) tuples so a preview can
  // render before any write. Returns null if nothing to do.
  const buildSkipPlan = async (): Promise<
    | null
    | {
        block: ProgramBlock;
        plans: Array<{
          sourceId: string;
          sourceName: string;
          targetId: string;
          targetName: string;
          affected: Array<{
            dayId: string;
            dayLabel: string;
            entryId: string;
            sets: number;
            reps: number;
            repsMax?: number;
            unit?: string;
          }>;
        }>;
        emptyReason?: string;
      }
  > => {
    const db = getDb();
    const blocks = await db.blocks.toArray();
    const active = blocks.find((b) => !b.completedAt);
    if (!active || !active.plan) return null;
    const skipAdjustments = injury.adjustments.filter(
      (a) => a.status === 'accepted' && a.action === 'skip',
    );
    if (skipAdjustments.length === 0) {
      return { block: active, plans: [], emptyReason: 'No accepted skip adjustments.' };
    }
    const movements = await db.movements.toArray();
    const byId = new Map(movements.map((m) => [m.id, m] as const));
    const plans: Array<{
      sourceId: string;
      sourceName: string;
      targetId: string;
      targetName: string;
      affected: Array<{
        dayId: string;
        dayLabel: string;
        entryId: string;
        sets: number;
        reps: number;
        repsMax?: number;
        unit?: string;
      }>;
    }> = [];
    for (const adj of skipAdjustments) {
      const source = byId.get(adj.movementId);
      if (!source) continue;
      const candidates = movements.filter(
        (m) =>
          m.id !== source.id &&
          m.pattern === source.pattern &&
          !m.primaryMuscles.some((pm) => source.primaryMuscles.includes(pm)),
      );
      const pick =
        candidates.find((m) => m.equipment === 'bodyweight') ?? candidates[0];
      if (!pick) continue;
      const affected: Array<{
        dayId: string;
        dayLabel: string;
        entryId: string;
        sets: number;
        reps: number;
        repsMax?: number;
        unit?: string;
      }> = [];
      // Union all weeks' assistance entries for each day, dedup by entryId.
      // Post-v21 the canonical store is per (week, day) so the iteration
      // covers every scheduled instance of the movement.
      const planLocal = active.plan!;
      const weeks: WendlerWeek[] =
        active.kind === 'seventh-week' ? ['7w'] : [1, 2, 3, 'deload'];
      planLocal.days.forEach((d, di) => {
        const seen = new Set<string>();
        for (const wk of weeks) {
          for (const e of resolveDayAssistance(planLocal, wk, d.id)) {
            if (e.movementId !== source.id) continue;
            if (seen.has(e.id)) continue;
            seen.add(e.id);
            affected.push({
              dayId: d.id,
              dayLabel: d.label?.trim() || `Day ${di + 1}`,
              entryId: e.id,
              sets: e.sets,
              reps: e.reps,
              repsMax: e.repsMax,
              unit: e.unit,
            });
          }
        }
      });
      if (affected.length === 0) continue;
      plans.push({
        sourceId: source.id,
        sourceName: source.name,
        targetId: pick.id,
        targetName: pick.name,
        affected,
      });
    }
    return { block: active, plans };
  };

  const [previewPlan, setPreviewPlan] = useState<
    null | Awaited<ReturnType<typeof buildSkipPlan>>
  >(null);

  const openPreview = async () => {
    setApplyMsg(undefined);
    const plan = await buildSkipPlan();
    if (!plan) {
      setApplyMsg('No active block with a plan found.');
      return;
    }
    if (plan.plans.length === 0) {
      setApplyMsg(
        plan.emptyReason ??
          'Accepted skip-adjustments don\'t match anything in your active block plan.',
      );
      return;
    }
    setPreviewPlan(plan);
  };

  const confirmApply = async () => {
    if (!previewPlan) return;
    setApplying(true);
    try {
      const db = getDb();
      let block: ProgramBlock = previewPlan.block;
      let swapsCount = 0;
      for (const p of previewPlan.plans) {
        const plan = block.plan!;
        // Iterate per-week canonical store, swap any entry whose
        // movementId matches the source. Post-v21 there is no base to
        // mutate; the per-week store IS the data.
        const overrides = plan.assistanceOverrides ?? {};
        const nextOverrides: Record<string, typeof overrides[string]> = {};
        for (const [key, entries] of Object.entries(overrides)) {
          nextOverrides[key] = entries.map((e) => {
            if (e.movementId !== p.sourceId) return e;
            swapsCount += 1;
            return { ...e, movementId: p.targetId, movementName: p.targetName };
          });
        }
        block = {
          ...block,
          plan: { ...plan, assistanceOverrides: nextOverrides },
        };
      }
      await db.blocks.put({ ...block, updatedAt: new Date().toISOString() });
      kickSync();
      setApplyMsg(
        `Applied ${swapsCount} swap${swapsCount === 1 ? '' : 's'} to block "${previewPlan.block.name}".`,
      );
      setPreviewPlan(null);
    } finally {
      setApplying(false);
    }
  };

  const acceptedCount = injury.adjustments.filter((a) => a.status === 'accepted').length;
  const hasSkipAccepted = injury.adjustments.some(
    (a) => a.status === 'accepted' && a.action === 'skip',
  );

  return (
    <article
      className={`rounded-2xl border p-4 sm:p-5 ${
        isActive
          ? 'border-amber-500/40 bg-amber-500/[0.04]'
          : 'border-border bg-card opacity-90'
      }`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-xl font-bold capitalize">{injury.area}</h3>
            <span className="rounded bg-bg/60 px-2 py-0.5 text-xs font-semibold text-fg/80 ring-1 ring-border">
              Severity {injury.severity}/5
            </span>
            <span className="text-xs text-muted">
              Started {fmtDate(injury.startedAt)}
              {injury.resolvedAt && <> · Resolved {fmtDate(injury.resolvedAt)}</>}
            </span>
          </div>
          <p className="mt-2 text-base leading-relaxed text-fg">{injury.description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {isActive && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                editing
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-bg/40 text-muted hover:text-fg'
              }`}
            >
              {editing ? 'Done editing' : 'Edit'}
            </button>
          )}
          {onReopen && (
            <button
              type="button"
              onClick={() => onReopen(injury.id)}
              className="rounded-lg border border-border bg-bg/40 px-3 py-1.5 text-xs font-medium text-muted hover:text-fg"
            >
              Reopen
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(injury.id)}
            className="rounded-lg border border-border bg-bg/40 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10"
          >
            Delete
          </button>
        </div>
      </header>

      {injury.summary && (
        <details className="mt-3 text-sm text-muted">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide">
            Coach analysis
          </summary>
          <p className="mt-2 leading-relaxed">{injury.summary}</p>
        </details>
      )}

      <div className="mt-4 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Adjustments ({acceptedCount} of {injury.adjustments.length} active)
          </h4>
          {isActive && hasSkipAccepted && (
            <button
              type="button"
              onClick={() => void openPreview()}
              disabled={applying}
              className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-200 hover:bg-sky-500/15 disabled:opacity-50"
            >
              {applying ? 'Applying…' : 'Preview & apply skips'}
            </button>
          )}
        </div>
        {applyMsg && (
          <p className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-200">
            {applyMsg}
          </p>
        )}
        {previewPlan && previewPlan.plans.length > 0 && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h5 className="text-sm font-semibold text-emerald-200">
                Preview — {previewPlan.plans.reduce((n, p) => n + p.affected.length, 0)} entry
                {previewPlan.plans.reduce((n, p) => n + p.affected.length, 0) === 1 ? '' : 'ies'} will change
              </h5>
              <button
                type="button"
                onClick={() => setPreviewPlan(null)}
                className="text-xs text-muted hover:text-fg"
              >
                Cancel
              </button>
            </div>
            <p className="mb-3 text-[11px] text-muted">
              Same-pattern, primary-muscle-disjoint substitutions in block &quot;
              {previewPlan.block.name}&quot;. Sets × reps preserved.
            </p>
            <ul className="space-y-3">
              {previewPlan.plans.map((p) => (
                <li key={p.sourceId} className="rounded-lg border border-border bg-bg/40 p-3 text-xs">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold">{p.sourceName}</span>
                    <span aria-hidden className="text-muted">→</span>
                    <span className="font-semibold text-emerald-200">{p.targetName}</span>
                  </div>
                  <ul className="mt-2 space-y-1 text-[11px] text-muted">
                    {p.affected.map((a, i) => (
                      <li key={i} className="flex items-baseline gap-2">
                        <span className="rounded bg-bg/60 px-1.5 py-0.5 ring-1 ring-border">
                          {a.dayLabel}
                        </span>
                        <span className="tabular-nums">
                          {a.sets}×{a.repsMax != null ? `${a.reps}-${a.repsMax}` : a.reps}
                          {a.unit === 'sec' ? ' sec' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPreviewPlan(null)}
                className="rounded-lg border border-border bg-bg/40 px-3 py-1.5 text-xs hover:bg-bg/60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmApply()}
                disabled={applying}
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-50"
              >
                {applying ? 'Applying…' : 'Apply these swaps'}
              </button>
            </div>
          </div>
        )}
        <ul className="space-y-2">
          {injury.adjustments.map((adj) => {
            const isAccepted = adj.status === 'accepted';
            const actionLabel = ACTION_LABEL[adj.action] ?? adj.action;
            const actionTone = ACTION_TONE[adj.action] ?? 'border-border bg-bg/40 text-muted';
            return (
              <li
                key={adj.id}
                className={`flex items-start gap-3 rounded-xl border p-3 ${
                  isAccepted
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : 'border-border/60 bg-bg/30 opacity-70'
                }`}
              >
                {editing ? (
                  <button
                    type="button"
                    onClick={() => void toggleAdjustment(adj.id)}
                    aria-pressed={isAccepted}
                    title={isAccepted ? 'Tap to decline' : 'Tap to accept'}
                    className={`mt-0.5 shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                      isAccepted
                        ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-100'
                        : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                    }`}
                  >
                    {isAccepted ? '✓ Accepted' : '✕ Declined'}
                  </button>
                ) : (
                  <span
                    className={`mt-0.5 shrink-0 rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                      isAccepted
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                        : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                    }`}
                  >
                    {isAccepted ? '✓ Accepted' : '✕ Declined'}
                  </span>
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <span
                    className={`inline-block rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${actionTone}`}
                  >
                    {actionLabel}
                  </span>
                  <p className="text-sm leading-relaxed">{adj.modification}</p>
                  {adj.reasoning && (
                    <p className="text-xs italic text-muted">{adj.reasoning}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {injury.monitoringAdvice && (
        <details className="mt-4 rounded-lg border border-border bg-bg/30 p-3 text-sm">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
            Monitoring advice
          </summary>
          <p className="mt-2 leading-relaxed text-muted">{injury.monitoringAdvice}</p>
        </details>
      )}

      {injury.consultRecommended && (
        <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <div className="font-semibold text-amber-200">⚠ PT consult recommended</div>
          {injury.consultReason && (
            <p className="mt-1 text-xs text-amber-100/90">{injury.consultReason}</p>
          )}
        </div>
      )}
    </article>
  );
}
