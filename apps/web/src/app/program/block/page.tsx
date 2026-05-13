'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  blockCompletion,
  DEFAULT_DAY_ORDER,
  DEFAULT_TRAINING_PROFILE,
  effectivePlan,
  effectiveTrainingPhaseInfo,
  initialCursorWeek,
  SUPPLEMENTAL_TEMPLATES,
  defaultSupplementalSets,
  type MinimalSet,
  type WendlerWeek,
} from '@wendler/domain';
import type { MainLift } from '@wendler/db-schema';
import { getDb } from '@/lib/db';
import { deleteWithTombstones } from '@/lib/delete';
import { fmtDate, liftLabel } from '@/lib/format';
import {
  useAllSessions,
  useAllSets,
  useBlock,
  useMovements,
  useSchedule,
  useSettings,
  useUpcomingRaces,
} from '@/lib/hooks';
import { BlockPlanEditor } from '@/components/BlockPlanEditor';
import { BlockAssistanceVolumePanel } from '@/components/BlockAssistanceVolumePanel';
import { BringMovementsButton } from '@/components/BringMovementsButton';
import { PhaseAutoBadge } from '@/components/PhaseAutoBadge';
import { PhaseAutoToast } from '@/components/PhaseAutoToast';

export default function BlockDetailPageWrapper() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <BlockDetailPage />
    </Suspense>
  );
}

function BlockDetailPage() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id') ?? '';
  const block = useBlock(id || undefined);
  const sessions = useAllSessions();
  const setsRaw = useAllSets();
  const movements = useMovements();
  const schedule = useSchedule();
  const settings = useSettings();
  const [busy, setBusy] = useState(false);

  // Week scope drives both the week tab strip AND BlockPlanEditor's per-day
  // assistance view. Persisted in the URL (`?week=`) so reloads/links keep
  // the chosen week. Default landing is Week 1 — every week is programmed
  // independently (v287: the legacy "Default" tab was removed).
  const weekParam = params.get('week');
  const weekScope: WendlerWeek = (() => {
    if (weekParam === 'deload') return 'deload';
    const n = weekParam ? parseInt(weekParam, 10) : NaN;
    if (n === 1 || n === 2 || n === 3) return n as WendlerWeek;
    return 1;
  })();

  const setWeekScope = (next: WendlerWeek) => {
    const sp = new URLSearchParams(params.toString());
    sp.set('week', next === 'deload' ? 'deload' : String(next));
    // Drop legacy focus param — block-level week scope replaces per-day focus.
    sp.delete('focus');
    sp.delete('all');
    const qs = sp.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  };

  async function handleEnd() {
    if (!block || block.completedAt) return;
    if (!confirm('Mark this block as completed? Sessions stay in your history.')) return;
    setBusy(true);
    try {
      const dbi = getDb();
      const now = new Date().toISOString();
      await dbi.blocks.update(block.id, { completedAt: now, updatedAt: now });

      // Advance the schedule's active block to the next non-completed block in
      // the same program (sorted by sequenceIndex), if this block is currently
      // active. Without this the program detail view keeps showing the
      // just-completed block as "active".
      const sched = await dbi.schedule.get('singleton');
      if (sched?.activeBlockId === block.id && block.programId) {
        const siblings = await dbi.blocks
          .where('programId')
          .equals(block.programId)
          .toArray();
        const currentSeq = block.sequenceIndex ?? 0;
        const next = siblings
          .filter((b) => b.id !== block.id && !b.completedAt)
          .sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0))
          .find((b) => (b.sequenceIndex ?? 0) > currentSeq) ??
          // No later block with a higher sequence — fall back to the earliest
          // remaining incomplete sibling so the user still has somewhere to go.
          siblings
            .filter((b) => b.id !== block.id && !b.completedAt)
            .sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0))[0];
        if (next) {
          await dbi.schedule.put({
            ...sched,
            activeBlockId: next.id,
            cursor: { blockId: next.id, week: initialCursorWeek(next), groupIndex: 0 },
            updatedAt: now,
          });
        } else {
          // No more blocks to advance to — clear the active pointer so the
          // program detail view stops calling this block "active".
          await dbi.schedule.put({
            ...sched,
            activeBlockId: undefined,
            cursor: undefined,
            updatedAt: now,
          });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleUnmarkComplete() {
    if (!block || !block.completedAt) return;
    if (
      !confirm(
        'Unmark this block as completed? It will reappear as the active block in the program if no other block is active.',
      )
    )
      return;
    setBusy(true);
    try {
      const dbi = getDb();
      const now = new Date().toISOString();
      await dbi.blocks.update(block.id, { completedAt: undefined, updatedAt: now });

      // Make this the active block again only when the program currently has
      // no active block — never silently displace a different active block
      // the user may have explicitly chosen.
      if (block.programId) {
        const sched = await dbi.schedule.get('singleton');
        if (sched && !sched.activeBlockId) {
          await dbi.schedule.put({
            ...sched,
            activeBlockId: block.id,
            cursor: { blockId: block.id, week: initialCursorWeek(block), groupIndex: 0 },
            updatedAt: now,
          });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  // (Removed: in-block deload toggle. Deload weeks are now driven entirely by
  // the 7th-Week prompt logic, which fires automatically after enough
  // consecutive training weeks.)

  const [confirmDelete, setConfirmDelete] = useState(false);

  async function performDelete(deleteHistory: boolean) {
    if (!block) return;
    setConfirmDelete(false);
    setBusy(true);
    try {
      const blockId = block.id;
      const dbi = getDb();
      const linked = await dbi.sessions.where('blockId').equals(blockId).toArray();
      if (deleteHistory) {
        const sessionIds = linked.map((s) => s.id);
        if (sessionIds.length) {
          const setIds = (
            await dbi.sets.where('sessionId').anyOf(sessionIds).primaryKeys()
          ) as string[];
          await deleteWithTombstones('set', setIds);
          await deleteWithTombstones('session', sessionIds);
        }
      } else {
        for (const s of linked) {
          await dbi.sessions.update(s.id, { blockId: undefined });
        }
      }
      await deleteWithTombstones('block', [blockId]);
      router.push(block.programId ? `/program/detail?id=${block.programId}` : '/program');
    } finally {
      setBusy(false);
    }
  }

  function handleDelete() {
    if (!block) return;
    setConfirmDelete(true);
  }

  const setsWithSession = useMemo<MinimalSet[]>(
    () => (setsRaw ?? []).map((s) => ({ ...s }) as MinimalSet),
    [setsRaw],
  );

  // Plan dimensions for the completion math. Without these we'd default to
  // 3 weeks × 4 days = 12, which is wrong for deload blocks (1 week) and for
  // any plan that doesn't have exactly 4 training days/week.
  const planDimensions = useMemo(() => {
    if (!block) return null;
    const plan = schedule
      ? effectivePlan(block, schedule)
      : effectivePlan(block, [...DEFAULT_DAY_ORDER]);
    const days = plan.days.length || 1;
    const weeks = block.kind === 'seventh-week' ? 1 : 3;
    return { weeks, days };
  }, [block, schedule]);

  const summary = useMemo(() => {
    if (!sessions || !id) return null;
    return blockCompletion(id, sessions, setsWithSession, {
      weeksPerBlock: planDimensions?.weeks,
      daysPerWeek: planDimensions?.days,
    });
  }, [id, sessions, setsWithSession, planDimensions]);

  const blockSessions = useMemo(
      () =>
        (sessions ?? [])
          .filter((s) => s.blockId === id)
          .sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1)),
      [sessions, id],
    );
  // Group session rows by workout day. Each "day" of training writes one
  // session row per main lift (so a multi-lift day produces 2 rows). The
  // Sessions list should show one entry per workout, not per lift, matching
  // how /day and Today render them. Group key prefers (week, dayIndex)
  // because that's how /day buckets a workout; legacy rows missing dayIndex
  // fall back to the calendar date so they still collapse sensibly.
  const blockWorkouts = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        week: typeof blockSessions[number]['week'];
        performedAt: string;
        sessions: typeof blockSessions;
      }
    >();
    for (const s of blockSessions) {
      const dayKey =
        s.dayIndex !== undefined && s.week !== undefined
          ? `${s.week}-${s.dayIndex}`
          : `date-${s.performedAt.slice(0, 10)}`;
      const existing = groups.get(dayKey);
      if (existing) {
        existing.sessions.push(s);
        // Keep the earliest performedAt as the workout's timestamp.
        if (s.performedAt < existing.performedAt) existing.performedAt = s.performedAt;
      } else {
        groups.set(dayKey, {
          key: dayKey,
          week: s.week,
          performedAt: s.performedAt,
          sessions: [s],
        });
      }
    }
    return [...groups.values()].sort((a, b) =>
      a.performedAt < b.performedAt ? -1 : 1,
    );
  }, [blockSessions]);

  // Phase derivation for THIS block — answers "if this block were active
  // right now, what phase would the app be in?". Drives the "Auto · …"
  // badge in the header and the first-encounter toast. Computed at the
  // top of the component (before any early return) to satisfy the
  // rules-of-hooks order; downstream JSX gates on `block` being defined.
  const upcomingRaces = useUpcomingRaces();
  const blockPhaseInfo = useMemo(() => {
    if (!block) return null;
    const profile = settings?.trainingProfile ?? DEFAULT_TRAINING_PROFILE;
    return effectiveTrainingPhaseInfo(
      profile,
      upcomingRaces ?? [],
      new Date(),
      { kind: block.kind, seventhWeekKind: block.seventhWeekKind },
    );
  }, [settings?.trainingProfile, upcomingRaces, block]);

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

  const backHref = block.programId ? `/program/detail?id=${block.programId}` : '/program';
  const backLabel = block.programId ? '← Program details' : '← Program';

  // Block-level TM% summary. Show a single value if every lift uses the same
  // %; otherwise show a range across overrides + the user default.
  const defaultPct = settings?.defaultTmPercent ?? 0.85;
  const tmSummary = (() => {
    const lifts: MainLift[] = ['squat', 'bench', 'deadlift', 'press'];
    const overrides = block.tmPercentByLift ?? {};
    const vals = lifts.map((l) => overrides[l] ?? defaultPct);
    const uniq = Array.from(new Set(vals));
    if (uniq.length === 1) return `${Math.round((uniq[0] ?? defaultPct) * 100)}%`;
    const min = Math.min(...uniq);
    const max = Math.max(...uniq);
    return `${Math.round(min * 100)}–${Math.round(max * 100)}%`;
  })();

  const supplementalTpl = SUPPLEMENTAL_TEMPLATES.find((t) => t.id === block.supplementalTemplate);
  const supplementalSets = block.supplementalSetsOverride ?? defaultSupplementalSets(block.supplementalTemplate);

  // Phase derivation result (computed above the early returns; non-null
  // here because `block` is defined). Derive the human-readable reason
  // for the badge / toast.
  const blockPhaseReason: string | undefined = (() => {
    if (!blockPhaseInfo) return undefined;
    if (blockPhaseInfo.source === 'block') return '7th-week deload block';
    if (blockPhaseInfo.source === 'race') {
      const now = Date.now();
      let soonest: { priority: 'A' | 'B'; daysOut: number } | undefined;
      for (const r of upcomingRaces ?? []) {
        if (r.completedAt) continue;
        if (r.priority !== 'A' && r.priority !== 'B') continue;
        const daysOut = Math.max(0, Math.floor((new Date(r.date).getTime() - now) / 86400000));
        if (!soonest || daysOut < soonest.daysOut) soonest = { priority: r.priority, daysOut };
      }
      if (soonest) {
        const dayWord = soonest.daysOut === 1 ? 'day' : 'days';
        return `${soonest.priority}-race in ${soonest.daysOut} ${dayWord}`;
      }
    }
    return undefined;
  })();

  return (
    <div className="space-y-5">
      <header>
        <Link href={backHref} className="text-xs text-muted underline">{backLabel}</Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">{block.name}</h1>
              <span
                className="rounded-md bg-accent/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-accent ring-1 ring-accent/40"
                title="Training-max percentage of estimated 1RM"
              >
                TM {tmSummary}
              </span>
              {schedule?.activeBlockId === block.id && !block.completedAt && (
                <span
                  className="rounded-md bg-emerald-600/15 px-2 py-0.5 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-600/60"
                  title="This block is currently active in your schedule"
                >
                  Active
                </span>
              )}
              {block.completedAt && (
                <span className="text-xs text-emerald-400">
                  · completed {fmtDate(block.completedAt)}
                </span>
              )}
              <PhaseAutoBadge
                phase={blockPhaseInfo?.phase ?? 'normal'}
                source={blockPhaseInfo?.source ?? 'manual'}
                reason={blockPhaseReason}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {!block.completedAt && (
              <button
                type="button"
                onClick={handleEnd}
                disabled={busy}
                className="rounded-md border border-emerald-600/60 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-600/10 disabled:opacity-50"
              >
                Mark block complete
              </button>
            )}
            <BlockOverflowMenu
              onDelete={handleDelete}
              onUnmarkComplete={block.completedAt ? handleUnmarkComplete : undefined}
              disabled={busy}
            />
          </div>
        </div>
      </header>

      <PhaseAutoToast
        phase={blockPhaseInfo?.phase ?? 'normal'}
        source={blockPhaseInfo?.source ?? 'manual'}
        reason={blockPhaseReason}
      />

      <BlockSettingsStrip
        kind={block.kind}
        weeks={block.weeksBeforeDeload}
        tmSummary={tmSummary}
        supplementalLabel={supplementalTpl?.name ?? block.supplementalTemplate}
        supplementalSets={supplementalSets}
      />

      <BlockWeekTabs
        block={block}
        scope={weekScope}
        onSelect={setWeekScope}
      />

      {block.completedAt ? (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          🔒 Plan editing is disabled because this block is marked complete. Use
          the menu above (···) to <span className="font-medium">unmark complete</span>{' '}
          if you need to make changes.
        </section>
      ) : (
        <>
          <BringMovementsButton block={block} schedule={schedule} />
          <BlockAssistanceVolumePanel block={block} weekScope={weekScope} />
          <BlockPlanEditor
            block={block}
            schedule={schedule}
            movements={movements}
            weekScope={weekScope}
          />
        </>
      )}

      {summary && block.completedAt && summary.sessionsCompleted === 0 ? (
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
            Completion
          </h2>
          <div className="space-y-2">
            <p className="text-sm text-fg">
              This block is marked completed on{' '}
              <span className="font-medium">{fmtDate(block.completedAt)}</span>, but
              no sessions were logged in the app for it.
            </p>
            <p className="text-xs text-muted">
              You probably trained these weeks before you started using the app —
              that&apos;s why there&apos;s no per-day breakdown to show. The block
              still counts as completed in your program timeline.
            </p>
          </div>
        </section>
      ) : (
        summary && (
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
        )
      )}

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Sessions
        </h2>
        {blockWorkouts.length === 0 ? (
          <p className="text-sm text-muted">No sessions logged yet for this block.</p>
        ) : (
          <ul className="space-y-2">
            {blockWorkouts.map((w) => {
              const sorted = [...w.sessions].sort((a, b) =>
                (a.dayIndex ?? 0) - (b.dayIndex ?? 0),
              );
              const primary = sorted[0]!;
              const lifts = sorted
                .map((s) => (s.mainLift ? liftLabel(s.mainLift) : null))
                .filter((x): x is string => !!x);
              const allCompleted =
                w.sessions.length > 0 &&
                w.sessions.every((s) => s.workoutCompletedAt ?? s.completedAt);
              const someCompleted = w.sessions.some(
                (s) => s.workoutCompletedAt ?? s.completedAt,
              );
              // Prefer the /day URL so the user lands on the multi-lift
              // workout overview (same as the Today page Recent sessions
              // card). /day reads (blockId, week, day) and renders every
              // lift in the day, plus assistance and the warm-up card.
              // Fall back to /session if a legacy row is missing dayIndex.
              const href =
                primary.dayIndex !== undefined && primary.week !== undefined && primary.blockId
                  ? `/day?blockId=${primary.blockId}&week=${primary.week}&day=${primary.dayIndex}`
                  : `/session?id=${primary.id}`;
              const dayName = `Day ${(primary.dayIndex ?? 0) + 1}`;
              return (
                <li key={w.key}>
                  <Link
                    href={href}
                    className="flex items-center justify-between rounded-lg border border-border bg-bg p-2 text-sm hover:border-accent"
                  >
                    <span>
                      <span className="text-xs text-muted">{dayName} · </span>
                      <span className="font-medium">
                        {lifts.length > 0 ? lifts.join(' + ') : 'Session'}
                      </span>
                      {w.week && (
                        <span className="ml-2 text-xs text-muted">
                          {w.week === 'deload' ? 'Deload' : `Week ${w.week}`}
                        </span>
                      )}
                      {allCompleted ? (
                        <span className="ml-2 text-emerald-400">✓</span>
                      ) : someCompleted ? (
                        <span className="ml-2 text-xs text-amber-400">partial</span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted">{fmtDate(w.performedAt)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {confirmDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-block-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
          onClick={() => !busy && setConfirmDelete(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="delete-block-title" className="text-lg font-semibold">
              Delete &quot;{block.name}&quot;?
            </h3>
            {(() => {
              const n = (sessions ?? []).filter((s) => s.blockId === block.id).length;
              if (n === 0) {
                return (
                  <p className="mt-2 text-sm text-muted">This block has no sessions logged.</p>
                );
              }
              return (
                <p className="mt-2 text-sm text-muted">
                  This block has <span className="text-fg font-medium">{n}</span> logged session
                  {n === 1 ? '' : 's'}. What should happen to them?
                </p>
              );
            })()}
            <div className="mt-5 flex flex-col gap-2">
              {(sessions ?? []).some((s) => s.blockId === block.id) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => performDelete(false)}
                  className="rounded-md border border-border bg-bg px-3 py-2 text-sm font-medium text-fg hover:bg-card disabled:opacity-50"
                >
                  Keep sessions in history
                  <span className="ml-1 text-xs font-normal text-muted">(unlink only)</span>
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => performDelete(true)}
                className="rounded-md border border-red-600/60 bg-red-600/10 px-3 py-2 text-sm font-medium text-red-200 hover:bg-red-600/20 disabled:opacity-50"
              >
                Delete block and all its history
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
                className="mt-1 px-3 py-2 text-sm text-muted hover:text-fg disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- BlockOverflowMenu -----------------------------------------------------
// Tiny ··· menu so the destructive Delete action is one indirection away from
// the routine "Mark block complete" action they share row space with.

function BlockOverflowMenu({
  onDelete,
  onUnmarkComplete,
  disabled,
}: {
  onDelete: () => void;
  onUnmarkComplete?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className="rounded-md border border-border px-2 py-1.5 text-xs font-medium text-muted hover:border-accent hover:text-fg disabled:opacity-50"
      >
        ···
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] rounded-lg border border-border bg-card p-1 text-sm shadow-xl"
        >
          {onUnmarkComplete && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onUnmarkComplete();
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-fg hover:bg-bg"
            >
              Unmark complete
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="block w-full rounded px-2 py-1.5 text-left text-red-300 hover:bg-red-600/15"
          >
            Delete block…
          </button>
        </div>
      )}
    </div>
  );
}

// ---- BlockSettingsStrip ----------------------------------------------------
// Horizontal scannable row of block-level parameters. On mobile it wraps to a
// 2-column grid so each cell stays comfortably tappable.

function BlockSettingsStrip({
  kind,
  weeks,
  tmSummary,
  supplementalLabel,
  supplementalSets,
}: {
  kind: string;
  weeks: number;
  tmSummary: string;
  supplementalLabel: string;
  supplementalSets: number;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label="Type">
          <span className="capitalize">{kind}</span>
        </Field>
        <Field label="Duration">
          {weeks} wk{weeks === 1 ? '' : 's'}
        </Field>
        <Field label="TM%">{tmSummary}</Field>
        <Field label="Supplemental">
          <span>
            {supplementalLabel}
            {supplementalSets > 0 && (
              <span className="ml-1 text-xs text-muted">· {supplementalSets} sets</span>
            )}
          </span>
        </Field>
      </dl>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-fg">{children}</dd>
    </div>
  );
}

// ---- BlockWeekTabs --------------------------------------------------------
// Compact week-tab strip that replaces the old PLAN matrix grid. Each tab
// represents a week scope; selecting one updates ?week= in the URL and
// drives the editor below. A small dot (•) marks tabs that contain at
// least one per-day assistance override, preserving the override-visibility
// the matrix used to provide.

interface BlockWeekTabsProps {
  block: import('@wendler/db-schema').ProgramBlock;
  scope: WendlerWeek;
  onSelect: (next: WendlerWeek) => void;
}

function BlockWeekTabs({
  block,
  scope,
  onSelect,
}: BlockWeekTabsProps) {
  const weeks: WendlerWeek[] = [];
  for (let w = 1; w <= block.weeksBeforeDeload; w++) weeks.push(w as WendlerWeek);
  if (block.includesDeload) weeks.push('deload');

  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Plan</h2>
        <span className="text-[11px] text-muted">
          Editing {scope === 'deload' ? 'Deload' : `Week ${scope}`}
        </span>
      </div>
      <div className="-mx-1 mt-2 flex flex-wrap gap-1.5 overflow-x-auto px-1">
        {weeks.map((w) => (
          <WeekTab
            key={String(w)}
            active={scope === w}
            onClick={() => onSelect(w)}
            label={w === 'deload' ? 'Deload' : `Wk ${w}`}
          />
        ))}
      </div>
    </section>
  );
}

function WeekTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium ring-1 transition-colors ${
        active
          ? 'bg-accent text-bg ring-accent'
          : 'bg-bg text-fg ring-border hover:ring-accent/50'
      }`}
    >
      {label}
    </button>
  );
}
