'use client';

import { useState } from 'react';
import { useGoals } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import type { Goal } from '@wendler/db-schema';

const KINDS: { id: Goal['kind']; label: string; placeholder: string; unit: string }[] = [
  { id: 'strength-pr', label: 'Strength PR', placeholder: '180', unit: 'kg' },
  { id: 'race-time', label: 'Race time', placeholder: '5400', unit: 'sec' },
  { id: 'body-comp', label: 'Body composition', placeholder: '78', unit: 'kg' },
  { id: 'habit', label: 'Habit / streak', placeholder: '20', unit: 'sessions' },
  { id: 'custom', label: 'Custom', placeholder: '', unit: '' },
];

function formatTarget(g: Goal) {
  if (g.target === undefined) return '';
  return `${g.target}${g.targetUnit ? ' ' + g.targetUnit : ''}`;
}

function formatDate(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function deadlineDelta(deadline?: string): string | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - Date.now();
  const days = Math.round(ms / 86400000);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'today';
  if (days < 14) return `${days}d left`;
  if (days < 90) return `${Math.round(days / 7)}w left`;
  return `${Math.round(days / 30)}mo left`;
}

export default function GoalsPage() {
  const goals = useGoals();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Goal['kind']>('strength-pr');
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [unit, setUnit] = useState('kg');
  const [deadline, setDeadline] = useState('');
  const [notes, setNotes] = useState('');

  function reset() {
    setTitle('');
    setTarget('');
    setUnit('kg');
    setDeadline('');
    setNotes('');
    setKind('strength-pr');
  }

  async function save() {
    if (!title.trim()) return;
    const now = new Date().toISOString();
    const g: Goal = {
      id: crypto.randomUUID(),
      kind,
      title: title.trim(),
      target: target ? Number(target) : undefined,
      targetUnit: unit || undefined,
      deadline: deadline ? new Date(deadline + 'T00:00:00Z').toISOString() : undefined,
      notes: notes.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    await getDb().goals.put(g);
    reset();
    setOpen(false);
  }

  async function toggleDone(g: Goal) {
    const now = new Date().toISOString();
    await getDb().goals.put({
      ...g,
      completedAt: g.completedAt ? undefined : now,
      updatedAt: now,
    });
  }

  async function remove(g: Goal) {
    if (!confirm(`Delete "${g.title}"?`)) return;
    await getDb().goals.delete(g.id);
  }

  const active = (goals ?? []).filter((g) => !g.completedAt);
  const done = (goals ?? []).filter((g) => g.completedAt);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Goals</h1>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg"
        >
          {open ? 'Cancel' : '+ New goal'}
        </button>
      </header>

      {open && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => {
                  setKind(k.id);
                  setUnit(k.unit);
                }}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  kind === k.id
                    ? 'border-accent bg-accent/20 text-fg'
                    : 'border-border text-muted'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. 200 kg deadlift)"
            className="w-full rounded-md border border-border bg-bg px-3 py-2"
          />
          <div className="flex gap-2">
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Target"
              type="number"
              className="flex-1 rounded-md border border-border bg-bg px-3 py-2"
            />
            <input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="Unit"
              className="w-24 rounded-md border border-border bg-bg px-3 py-2"
            />
            <input
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              type="date"
              className="rounded-md border border-border bg-bg px-3 py-2"
            />
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes"
            rows={2}
            className="w-full rounded-md border border-border bg-bg px-3 py-2"
          />
          <button
            type="button"
            onClick={save}
            disabled={!title.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-50"
          >
            Save goal
          </button>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Active ({active.length})
        </h2>
        {active.length === 0 && (
          <p className="text-sm text-muted">No active goals — set one above.</p>
        )}
        {active.map((g) => (
          <div
            key={g.id}
            className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3"
          >
            <div className="flex-1">
              <div className="font-medium">{g.title}</div>
              <div className="text-xs text-muted">
                {KINDS.find((k) => k.id === g.kind)?.label}
                {g.target !== undefined && ` · target ${formatTarget(g)}`}
                {g.deadline && ` · ${formatDate(g.deadline)} (${deadlineDelta(g.deadline)})`}
              </div>
              {g.notes && <div className="mt-1 text-sm text-muted">{g.notes}</div>}
            </div>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => toggleDone(g)}
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/20"
              >
                Mark done
              </button>
              <button
                type="button"
                onClick={() => remove(g)}
                className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-fg"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </section>

      {done.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Completed ({done.length})
          </h2>
          {done.map((g) => (
            <div
              key={g.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card/50 p-3 opacity-70"
            >
              <div>
                <div className="font-medium line-through">{g.title}</div>
                <div className="text-xs text-muted">
                  Completed {formatDate(g.completedAt)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => toggleDone(g)}
                className="rounded-md border border-border px-2 py-1 text-xs"
              >
                Reopen
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
