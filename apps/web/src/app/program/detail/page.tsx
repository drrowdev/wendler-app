'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { fmtDate } from '@/lib/format';
import { getDb } from '@/lib/db';
import { deleteWithTombstones } from '@/lib/delete';
import { insertSeventhWeekBlock } from '@/lib/seventhWeek';
import {
  useActiveBlock,
  useBlocks,
  usePrograms,
} from '@/lib/hooks';
import {
  MAIN_SCHEMES,
  SUPPLEMENTAL_TEMPLATES,
  SEVENTH_WEEK_VARIANTS,
  initialCursorWeek,
  nextSeventhWeekRecommendation,
  type ProgramBlock,
  type SeventhWeekKind,
} from '@wendler/domain';
import { ProgramDefaultsPanel } from '@/components/ProgramDefaultsPanel';

const SUPPL_NAME: Record<string, string> = Object.fromEntries(
  SUPPLEMENTAL_TEMPLATES.map((s) => [s.id, s.name]),
);
const SCHEME_SHORT: Record<string, string> = Object.fromEntries(
  MAIN_SCHEMES.map((s) => [s.id, s.shortName]),
);

function blockStatus(b: ProgramBlock, activeId?: string) {
  if (b.completedAt && b.id !== activeId) return 'done' as const;
  if (b.id === activeId) return 'active' as const;
  if (b.startedAt) return 'in-progress' as const;
  return 'upcoming' as const;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  active: { label: 'ACTIVE', cls: 'bg-accent text-bg' },
  done: { label: '✓ DONE', cls: 'bg-emerald-600/20 text-emerald-300 ring-1 ring-emerald-600/60' },
  'in-progress': { label: 'in progress', cls: 'bg-emerald-600/20 text-emerald-300' },
  upcoming: { label: 'upcoming', cls: 'bg-card text-muted ring-1 ring-border' },
};

function blockWeeks(b: ProgramBlock) {
  // Deload weeks are no longer authored inline on a block — the 7th-Week
  // prompt logic schedules them as standalone seventh-week blocks. We
  // intentionally ignore the legacy `includesDeload` flag here so the
  // program timeline reflects the new model. A one-shot data migration
  // (LegacyDeloadMigrator) flips any pre-existing flag to false on first
  // load so block records line up with this calculation.
  return b.weeksBeforeDeload ?? 3;
}

export default function ProgramDetail() {
  const router = useRouter();
  const sp = useSearchParams();
  const programId = sp?.get('id') ?? undefined;

  const programs = usePrograms();
  const blocks = useBlocks();
  const active = useActiveBlock();

  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [seventhWeekDismissed, setSeventhWeekDismissed] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  // Confirm dialog state for "Make active" — set to the block being activated
  // when the action would skip past the currently-active or in-progress block.
  const [confirmActivate, setConfirmActivate] = useState<ProgramBlock | null>(null);

  // Click-outside / escape-key dismissal for the overflow menu.
  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!overflowRef.current) return;
      if (!overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [overflowOpen]);

  const dismissKeyEarly = programId
    ? `7w-prompt-dismissed:${programId}:${(blocks ?? []).filter((b) => b.programId === programId).length}`
    : '';
  useEffect(() => {
    if (!dismissKeyEarly) {
      setSeventhWeekDismissed(false);
      return;
    }
    try {
      setSeventhWeekDismissed(localStorage.getItem(dismissKeyEarly) === '1');
    } catch {
      setSeventhWeekDismissed(false);
    }
  }, [dismissKeyEarly]);

  if (!programs || !blocks) {
    return <div className="p-4 text-sm text-muted">Loading…</div>;
  }

  const program = programs.find((p) => p.id === programId);
  if (!program) {
    return (
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted">Program not found.</p>
        <Link href="/program" className="text-sm text-accent underline">
          ← Back to programs
        </Link>
      </div>
    );
  }

  const programBlocks = blocks
    .filter((b) => b.programId === program.id)
    .sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));

  const isActiveProgram = !!active && programBlocks.some((b) => b.id === active.id);

  const seventhWeekRec = nextSeventhWeekRecommendation(programBlocks);
  const dismissKey = programId ? `7w-prompt-dismissed:${programId}:${programBlocks.length}` : '';
  const dismissSeventhWeek = () => {
    setSeventhWeekDismissed(true);
    try {
      if (dismissKey) localStorage.setItem(dismissKey, '1');
    } catch {
      /* ignore */
    }
  };
  const showSeventhWeekPrompt = !!seventhWeekRec.recommended && !seventhWeekDismissed;

  const createSeventhWeekBlock = async (kind: SeventhWeekKind) => {
    setBusy(true);
    try {
      const { blockId } = await insertSeventhWeekBlock({
        programId: program.id,
        kind,
        programBlocks,
      });
      router.push(`/program/block?id=${blockId}`);
    } finally {
      setBusy(false);
    }
  };

  // Timeline shape: total weeks across all blocks (including deload weeks).
  const totalWeeks = programBlocks.reduce((acc, b) => acc + blockWeeks(b), 0);
  // Cumulative week ranges per block — used for the timeline strip and the
  // "Wk X–Y" labels under each segment.
  const weekRanges = (() => {
    let cursor = 1;
    return programBlocks.map((b) => {
      const w = blockWeeks(b);
      const start = cursor;
      const end = cursor + w - 1;
      cursor = end + 1;
      return { start, end };
    });
  })();
  // Approximate "current week" indicator: if there's an active block in this
  // program, place the marker at the start of that block. (We don't track
  // intra-block week progress on the schedule cursor here; this is a coarse
  // visual aid, not a precise progress meter.)
  const activeIdx = active ? programBlocks.findIndex((b) => b.id === active.id) : -1;
  const currentWeek = activeIdx >= 0 ? weekRanges[activeIdx]!.start : null;

  const doActivate = async (blockId: string) => {
    setBusy(true);
    try {
      const dbi = getDb();
      const sched = await dbi.schedule.get('singleton');
      if (!sched) return;
      const target = programBlocks.find((b) => b.id === blockId);
      const week = target ? initialCursorWeek(target) : 1;
      await dbi.schedule.put({
        ...sched,
        activeBlockId: blockId,
        cursor: { blockId, week, groupIndex: 0 },
        updatedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
    }
  };

  const requestActivate = (b: ProgramBlock) => {
    // No friction needed if there is no current active block in this program.
    // Otherwise, switching active is a meaningful state change (it can skip
    // training that the user intended to do, or rewind to a finished block),
    // so we ask for explicit confirmation before mutating the schedule.
    if (!isActiveProgram) {
      void doActivate(b.id);
      return;
    }
    setConfirmActivate(b);
  };

  const rename = async () => {
    const next = nameDraft.trim();
    if (!next || next === program.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    try {
      await getDb().programs.update(program.id, { name: next, updatedAt: new Date().toISOString() });
      setRenaming(false);
    } finally {
      setBusy(false);
    }
  };

  const performDelete = async (deleteHistory: boolean) => {
    setBusy(true);
    try {
      const dbi = getDb();
      const blockIds = programBlocks.map((b) => b.id);

      if (blockIds.length) {
        const linked = await dbi.sessions.where('blockId').anyOf(blockIds).toArray();
        if (deleteHistory) {
          const sessionIds = linked.map((s) => s.id);
          if (sessionIds.length) {
            const setIds = (await dbi.sets
              .where('sessionId')
              .anyOf(sessionIds)
              .primaryKeys()) as string[];
            await deleteWithTombstones('set', setIds);
            await deleteWithTombstones('session', sessionIds);
          }
        } else {
          for (const s of linked) {
            await dbi.sessions.update(s.id, { blockId: undefined });
          }
        }
        await deleteWithTombstones('block', blockIds);
      }

      const sched = await dbi.schedule.get('singleton');
      if (sched) {
        const touchesActive = sched.activeBlockId && blockIds.includes(sched.activeBlockId);
        const touchesCursor = sched.cursor && blockIds.includes(sched.cursor.blockId);
        if (touchesActive || touchesCursor) {
          const { cursor: _cursor, ...rest } = sched;
          await dbi.schedule.put({
            ...rest,
            activeBlockId: touchesActive ? undefined : sched.activeBlockId,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      await deleteWithTombstones('program', [program.id]);
      router.replace('/program');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/program" className="text-sm text-muted hover:text-fg">
          ← All programs
        </Link>
      </div>

      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void rename();
                  if (e.key === 'Escape') setRenaming(false);
                }}
                className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-2xl font-bold"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void rename()}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setRenaming(false)}
                className="px-3 py-2 text-sm text-muted hover:text-fg"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-3xl font-bold tracking-tight">{program.name}</h1>
              {isActiveProgram && (
                <span className="rounded bg-accent px-2 py-0.5 text-[10px] font-semibold text-bg">
                  ACTIVE
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setNameDraft(program.name);
                  setRenaming(true);
                }}
                className="text-sm text-muted hover:text-fg"
                title="Rename"
              >
                ✎
              </button>
            </div>
          )}
          <p className="mt-1 text-sm text-muted">
            {programBlocks.length} block{programBlocks.length === 1 ? '' : 's'} · created{' '}
            {fmtDate(program.createdAt)}
          </p>
        </div>
        {/* Overflow menu — destructive actions are buried here so they never
            sit next to a primary action. Delete is irreversible; making it
            require an extra click prevents accidental loss. */}
        <div className="relative" ref={overflowRef}>
          <button
            type="button"
            disabled={busy}
            onClick={() => setOverflowOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            aria-label="More program actions"
            className="rounded-md border border-border bg-card px-2.5 py-1.5 text-base leading-none text-muted hover:border-accent hover:text-fg disabled:opacity-50"
          >
            ···
          </button>
          {overflowOpen && (
            <div
              role="menu"
              className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOverflowOpen(false);
                  setConfirmDelete(true);
                }}
                className="block w-full px-3 py-2 text-left text-sm text-red-300 hover:bg-red-600/10"
              >
                Delete program…
              </button>
            </div>
          )}
        </div>
      </header>

      {showSeventhWeekPrompt && seventhWeekRec.recommended && (
        <section className="rounded-xl border border-accent/40 bg-accent/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Time for a 7th-week block?</h2>
              <p className="mt-0.5 text-sm text-muted">{seventhWeekRec.reason}</p>
            </div>
            <button
              type="button"
              onClick={dismissSeventhWeek}
              className="text-xs text-muted hover:text-fg"
              aria-label="Dismiss 7th-week prompt"
            >
              Dismiss
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {(['tm-test', 'deload', 'pr-test'] as const).map((kind) => {
              const v = SEVENTH_WEEK_VARIANTS[kind];
              const isRec = seventhWeekRec.recommended === kind;
              return (
                <div
                  key={kind}
                  className={`rounded-lg border p-3 flex flex-col gap-2 ${
                    isRec
                      ? 'border-accent bg-card ring-1 ring-accent/40'
                      : 'border-border bg-card/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold">{v.title.replace('7th Week · ', '')}</div>
                    {isRec && (
                      <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold text-bg">
                        SUGGESTED
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted">{v.subtitle}</div>
                  <div className="text-[11px] font-mono text-fg/80">{v.wavePreview}</div>
                  <p className="text-xs text-muted leading-snug flex-1">{v.blurb}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => createSeventhWeekBlock(kind)}
                    className={`mt-1 rounded px-2 py-1.5 text-xs font-semibold ${
                      isRec
                        ? 'bg-accent text-bg hover:opacity-90'
                        : 'bg-card ring-1 ring-border hover:bg-card/80'
                    } disabled:opacity-50`}
                  >
                    Use this
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Blocks — primary content. Timeline strip first for spatial context. */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Blocks</h2>

        {programBlocks.length === 0 ? (
          <p className="text-sm text-muted">No blocks yet — create another program to add blocks.</p>
        ) : (
          <>
            {/* Timeline strip — proportional segments per block, with the
                active block highlighted and a current-week marker. Uses
                weekRanges for accurate widths so a 4-week block visibly
                takes more horizontal space than a 3-week block. */}
            <div className="rounded-xl border border-border bg-card/40 p-3">
              {currentWeek !== null && (
                <div className="mb-2 flex justify-end text-[11px] font-medium text-accent">
                  Week {currentWeek} of {totalWeeks}
                </div>
              )}
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg ring-1 ring-border">
                {programBlocks.map((b, i) => {
                  const w = blockWeeks(b);
                  const pct = totalWeeks > 0 ? (w / totalWeeks) * 100 : 100 / programBlocks.length;
                  const status = blockStatus(b, active?.id);
                  const cls =
                    status === 'active'
                      ? 'bg-accent'
                      : status === 'done'
                        ? 'bg-violet-500/70'
                        : status === 'in-progress'
                          ? 'bg-emerald-500/70'
                          : 'bg-border';
                  return (
                    <div
                      key={b.id}
                      style={{ width: `${pct}%` }}
                      className={`${cls} ${i > 0 ? 'border-l border-bg' : ''}`}
                      title={`${b.name} · ${weekRanges[i]!.start === weekRanges[i]!.end ? `Wk ${weekRanges[i]!.start}` : `Wk ${weekRanges[i]!.start}–${weekRanges[i]!.end}`}`}
                    />
                  );
                })}
              </div>
              {/* Labels aligned to their segments: each label container has the
                  same proportional width as the corresponding bar segment. */}
              <div className="mt-2 flex w-full text-[11px] leading-tight text-muted">
                {programBlocks.map((b, i) => {
                  const w = blockWeeks(b);
                  const pct = totalWeeks > 0 ? (w / totalWeeks) * 100 : 100 / programBlocks.length;
                  return (
                    <div
                      key={b.id}
                      style={{ width: `${pct}%` }}
                      className="min-w-0 px-1 text-center"
                    >
                      <div className={`truncate ${i === activeIdx ? 'text-fg font-medium' : ''}`}>
                        {b.name}
                      </div>
                      <div className="truncate text-muted/70">
                        {weekRanges[i]!.start === weekRanges[i]!.end
                          ? `Wk ${weekRanges[i]!.start}`
                          : `Wk ${weekRanges[i]!.start}–${weekRanges[i]!.end}`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <ol className="space-y-2">
              {programBlocks.map((b) => {
                const status = blockStatus(b, active?.id);
                const badge = STATUS_BADGE[status]!;
                return (
                  <li
                    key={b.id}
                    className={`rounded-xl border p-3 transition-opacity ${
                      status === 'active'
                        ? 'border-accent bg-accent/5'
                        : status === 'done'
                          ? 'border-border/60 bg-card/40 opacity-60 hover:opacity-100'
                          : 'border-border bg-card'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        href={`/program/block?id=${b.id}`}
                        className="min-w-0 flex-1 hover:text-accent"
                      >
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-xs text-muted">
                            #{(b.sequenceIndex ?? 0) + 1}
                          </span>
                          <span className="font-semibold">{b.name}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                            {badge.label}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-muted">
                          {SCHEME_SHORT[b.mainScheme ?? 'classic-531']} +{' '}
                          {SUPPL_NAME[b.supplementalTemplate]} · {b.weeksBeforeDeload} weeks
                          {b.startedAt && ` · started ${fmtDate(b.startedAt)}`}
                        </div>
                      </Link>
                      {status !== 'active' && !b.completedAt && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => requestActivate(b)}
                          className="shrink-0 rounded-lg border border-accent/50 bg-accent/10 px-2 py-1 text-xs font-semibold text-accent hover:bg-accent/20 disabled:opacity-50"
                        >
                          Make active
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>

      <ProgramDefaultsPanel programId={program.id} />

      {confirmActivate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-5">
            <div>
              <h3 className="text-lg font-semibold">
                Make &quot;{confirmActivate.name}&quot; active?
              </h3>
              <p className="mt-1 text-sm text-muted">
                {active && (
                  <>
                    This will switch the active block from{' '}
                    <strong className="text-fg">{active.name}</strong> to{' '}
                    <strong className="text-fg">{confirmActivate.name}</strong> and reset the
                    training cursor to Week 1, Day 1. Training history is preserved, but{' '}
                    {active.name} will no longer be in progress.
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmActivate(null)}
                className="px-3 py-2 text-sm text-muted hover:text-fg disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const target = confirmActivate;
                  setConfirmActivate(null);
                  await doActivate(target.id);
                }}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
              >
                {busy ? 'Switching…' : 'Yes, make active'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-5">
            <div>
              <h3 className="text-lg font-semibold">Delete &quot;{program.name}&quot;?</h3>
              <p className="mt-1 text-sm text-muted">
                This program contains {programBlocks.length} block
                {programBlocks.length === 1 ? '' : 's'}. Choose whether to keep their training
                history or delete it completely.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void performDelete(false)}
                className="rounded-md border border-border bg-bg px-3 py-2 text-sm font-medium hover:border-accent disabled:opacity-50"
              >
                Keep sessions in history
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void performDelete(true)}
                className="rounded-md border border-red-600/60 bg-red-600/10 px-3 py-2 text-sm font-medium text-red-200 hover:bg-red-600/20 disabled:opacity-50"
              >
                Delete program and all its history
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
