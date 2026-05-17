'use client';

// Diagnostics page — local-only audit view for "what the AI actually did".
//
// Surfaces three things the user can't easily see elsewhere:
//   1. Current cardio plan slot list (raw, with all fields) — the
//      ground truth for the "I still see Fri bikes on the calendar"
//      class of bug. If a slot survives that should have been removed,
//      it shows up here.
//   2. Last 20 applied propose_edit ChatActions, each with the full
//      operationResults JSON — the structured "what changed" detail
//      per op (entry ids, before/after values, removedCount, etc.).
//   3. Recent chatActionSnapshots — undo log entries with row counts
//      per touched table, so the user can see what's queued for
//      potential undo.
//
// Local-only by design; nothing here is synced or sent to the server.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDb } from '@/lib/db';
import { fmtDate } from '@/lib/format';
import type {
  ChatAction,
  ChatActionSnapshot,
  ProposeEditChatAction,
} from '@wendler/db-schema';

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function DiagnosticsPage() {
  const [tab, setTab] = useState<'cardio' | 'actions' | 'snapshots'>('cardio');

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 space-y-6">
      <header className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold">Diagnostics</h1>
          <Link href="/" className="text-sm text-link hover:underline">
            ← Home
          </Link>
        </div>
        <p className="text-sm text-muted">
          Raw IndexedDB state for the parts of the app where the AI writes —
          for debugging when something looks wrong on the calendar / program
          page. Everything here is local-only.
        </p>
      </header>
      <nav className="flex gap-2 border-b border-border pb-2 text-sm">
        {(
          [
            ['cardio', 'Cardio plan'],
            ['actions', 'Applied AI actions'],
            ['snapshots', 'Undo log'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-1.5 font-medium ${
              tab === id
                ? 'bg-accent text-bg'
                : 'border border-border bg-bg/40 text-fg/80 hover:bg-bg/60'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'cardio' && <CardioPlanPanel />}
      {tab === 'actions' && <ActionsPanel />}
      {tab === 'snapshots' && <SnapshotsPanel />}
    </main>
  );
}

function CardioPlanPanel() {
  const plan = useLiveQuery(() => getDb().cardioPlan.get('singleton'), [], undefined);
  const blocks = useLiveQuery(() => getDb().blocks.toArray(), [], []);
  const blockById = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of blocks ?? []) m.set(b.id, b.name);
    return m;
  }, [blocks]);

  if (plan === undefined) return <p className="text-sm text-muted">Loading…</p>;
  if (!plan || plan.slots.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg/40 px-4 py-6 text-sm text-muted">
        No cardio plan slots currently saved.
      </div>
    );
  }
  return (
    <section className="space-y-3">
      <div className="text-xs text-muted">
        {plan.slots.length} slot(s) · last updated {fmtDate(plan.updatedAt)}
      </div>
      <div className="space-y-2">
        {plan.slots.map((s, i) => {
          const linkName = s.linkedBlockId ? blockById.get(s.linkedBlockId) : undefined;
          return (
            <div
              key={i}
              className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-sm space-y-1"
            >
              <div className="font-semibold">
                #{i + 1} · {WEEKDAY_NAMES[s.dayOfWeek] ?? `Day ${s.dayOfWeek}`} ·{' '}
                {s.modality} · {s.kind}
                {s.durationMin !== undefined && (
                  <span className="ml-2 rounded bg-bg/60 px-1.5 py-0.5 text-xs">
                    {s.durationMin} min
                  </span>
                )}
              </div>
              <ul className="ml-3 list-disc text-xs text-fg/80 space-y-0.5">
                <li>
                  Scope:{' '}
                  <span className="font-medium">
                    {s.effectiveFrom || s.effectiveUntil
                      ? `${s.effectiveFrom ?? '…'} → ${s.effectiveUntil ?? '…'}`
                      : 'every week (no scope) — shows on every matching weekday'}
                  </span>
                </li>
                {s.notes && (
                  <li>
                    Notes: <span className="font-medium">{s.notes}</span>
                  </li>
                )}
                {s.linkedBlockId && (
                  <li>
                    Linked block:{' '}
                    <span className="font-medium">{linkName ?? s.linkedBlockId}</span>{' '}
                    <span className="text-muted">
                      (auto-removes on block complete)
                    </span>
                  </li>
                )}
                <li className="text-muted">
                  Raw key: dayOfWeek={s.dayOfWeek}, modality=&quot;{s.modality}&quot;
                </li>
              </ul>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted leading-relaxed">
        The calendar shows a slot on a given date when (a) the weekday matches{' '}
        <code className="text-fg/80">dayOfWeek</code>, AND (b) the date is within
        the slot&apos;s <code className="text-fg/80">effectiveFrom</code> /{' '}
        <code className="text-fg/80">effectiveUntil</code> window (or both
        bounds are absent — &quot;every week&quot;). To remove a slot manually,
        use <Link className="text-link hover:underline" href="/program?tab=cardio">Program → Cardio</Link>.
      </p>
    </section>
  );
}

function ActionsPanel() {
  const applied = useLiveQuery(
    async () => {
      const chats = await getDb().chats.orderBy('updatedAt').reverse().limit(100).toArray();
      type Item = {
        chatId: string;
        messageId: string;
        action: ProposeEditChatAction;
      };
      const items: Item[] = [];
      for (const chat of chats) {
        for (const m of chat.messages) {
          if (!m.actions) continue;
          for (const a of m.actions) {
            if (
              a.kind === 'propose_edit' &&
              a.status === 'applied' &&
              a.appliedDetails?.kind === 'propose_edit'
            ) {
              items.push({
                chatId: chat.id,
                messageId: m.id,
                action: a as ProposeEditChatAction,
              });
            }
          }
        }
      }
      items.sort((a, b) =>
        (b.action.appliedAt ?? '').localeCompare(a.action.appliedAt ?? ''),
      );
      return items.slice(0, 20);
    },
    [],
    [],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (!applied || applied.length === 0)
    return (
      <p className="rounded-lg border border-border bg-bg/40 px-4 py-6 text-sm text-muted">
        No applied AI proposals yet.
      </p>
    );

  return (
    <section className="space-y-2">
      <div className="text-xs text-muted">
        Showing {applied.length} most-recent applied AI proposal(s).
      </div>
      {applied.map(({ chatId, action }) => {
        const id = action.id;
        const open = expanded.has(id);
        const details =
          action.appliedDetails?.kind === 'propose_edit'
            ? action.appliedDetails
            : undefined;
        const opResults = details?.operationResults ?? {};
        const declined = details?.declinedOperationIds ?? [];
        return (
          <div
            key={id}
            className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-sm space-y-1"
          >
            <button
              type="button"
              onClick={() => toggle(id)}
              className="flex w-full items-center justify-between text-left"
            >
              <span className="font-semibold">
                {open ? '▾' : '▸'} {(action as ChatAction).label}
              </span>
              <span className="text-xs text-muted">
                {action.appliedAt ? fmtDate(action.appliedAt) : '—'} ·{' '}
                {Object.keys(opResults).length} ops
                {action.undoneAt ? ' · UNDONE' : ''}
              </span>
            </button>
            {open && (
              <div className="space-y-2 pt-2 text-xs">
                <div className="text-fg/80">
                  <span className="text-muted">Headline:</span>{' '}
                  {action.headline}
                </div>
                {action.reason && (
                  <div className="text-fg/80">
                    <span className="text-muted">Reason:</span> {action.reason}
                  </div>
                )}
                <div className="space-y-1">
                  <div className="text-muted">
                    Operation results ({Object.keys(opResults).length}):
                  </div>
                  {Object.entries(opResults).map(([opId, detail]) => (
                    <pre
                      key={opId}
                      className="overflow-x-auto rounded border border-border bg-bg/60 p-2 text-[11px] leading-relaxed text-fg/90"
                    >
                      {JSON.stringify(detail, null, 2)}
                    </pre>
                  ))}
                  {declined.length > 0 && (
                    <div className="text-muted">
                      Declined ops: {declined.join(', ')}
                    </div>
                  )}
                </div>
                <Link
                  href={`/chat?id=${chatId}`}
                  className="inline-block text-link hover:underline"
                >
                  Open chat →
                </Link>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function SnapshotsPanel() {
  const snaps = useLiveQuery(
    () =>
      getDb()
        .chatActionSnapshots.orderBy('createdAt')
        .reverse()
        .limit(50)
        .toArray(),
    [],
    [],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (!snaps) return <p className="text-sm text-muted">Loading…</p>;
  if (snaps.length === 0)
    return (
      <p className="rounded-lg border border-border bg-bg/40 px-4 py-6 text-sm text-muted">
        No undo snapshots yet. Applying an AI proposal captures one here.
      </p>
    );

  return (
    <section className="space-y-2">
      <div className="text-xs text-muted">
        {snaps.length} snapshot(s). Retention cap: 50.
      </div>
      {snaps.map((s) => {
        const open = expanded.has(s.chatActionId);
        return (
          <div
            key={s.chatActionId}
            className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-sm space-y-1"
          >
            <button
              type="button"
              onClick={() => toggle(s.chatActionId)}
              className="flex w-full items-center justify-between text-left"
            >
              <span className="font-mono text-xs text-fg/80">
                {open ? '▾' : '▸'} {s.chatActionId.slice(0, 12)}
              </span>
              <span className="text-xs text-muted">
                {fmtDate(s.createdAt)} · {summarizeSnapshot(s)}
              </span>
            </button>
            {open && (
              <pre className="overflow-x-auto rounded border border-border bg-bg/60 p-2 text-[11px] leading-relaxed text-fg/90">
                {JSON.stringify(s.tables, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </section>
  );
}

function summarizeSnapshot(s: ChatActionSnapshot): string {
  const parts: string[] = [];
  if (s.tables.blocks)
    parts.push(`${Object.keys(s.tables.blocks.rowsById).length} blocks`);
  if (s.tables.movements)
    parts.push(`${Object.keys(s.tables.movements.rowsById).length} movements`);
  if (s.tables.trainingMaxes)
    parts.push(`${Object.keys(s.tables.trainingMaxes.rowsById).length} TMs`);
  if (s.tables.cardioPlan) parts.push('cardio plan');
  if (s.tables.schedule) parts.push('schedule');
  return parts.length > 0 ? parts.join(', ') : '(empty)';
}
