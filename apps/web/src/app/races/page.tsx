'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { nanoid } from 'nanoid';
import {
  inferDistanceKm,
  formatRaceTime,
  raceLabel,
  seasonView,
  taperRecommendation,
  type RaceLike,
  type RaceTaperRecommendation,
} from '@wendler/domain';
import type { Race, RaceKind, RacePriority } from '@wendler/db-schema';
import { useRaces, useUpcomingRaces, usePastRaces } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { kickSync } from '@/lib/sync';
import { deleteWithTombstones } from '@/lib/delete';

const KIND_LABEL: Record<RaceKind, string> = {
  '5k': '5K',
  '10k': '10K',
  'half-marathon': 'Half marathon',
  marathon: 'Marathon',
  ultra: 'Ultra',
  trail: 'Trail',
  triathlon: 'Triathlon',
  other: 'Other',
};

const PRIORITY_TONE: Record<RacePriority, string> = {
  A: 'border-red-500/50 bg-red-500/15 text-red-200',
  B: 'border-amber-500/50 bg-amber-500/15 text-amber-200',
  C: 'border-zinc-500/50 bg-zinc-500/15 text-zinc-300',
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function daysOutLabel(days: number) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 0) return `${-days}d ago`;
  if (days < 14) return `${days}d`;
  if (days < 90) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

function parseTimeInput(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const parts = t.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return undefined;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 1) return parts[0]!;
  return undefined;
}

interface RaceFormState {
  name: string;
  date: string;
  kind: RaceKind;
  priority: RacePriority;
  distanceKm: string;
  targetTime: string;
  location: string;
  notes: string;
}

const EMPTY_FORM: RaceFormState = {
  name: '',
  date: '',
  kind: 'half-marathon',
  priority: 'A',
  distanceKm: '',
  targetTime: '',
  location: '',
  notes: '',
};

export default function RacesPage() {
  const all = useRaces();
  // useUpcomingRaces / usePastRaces are kept available for callers that
  // want narrower live queries; here we re-derive from `all` to share the
  // same render-time `seasonView` output.
  useUpcomingRaces();
  usePastRaces();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Race | undefined>(undefined);
  const [form, setForm] = useState<RaceFormState>(EMPTY_FORM);
  const [resultFor, setResultFor] = useState<Race | undefined>(undefined);
  const [resultTime, setResultTime] = useState('');
  const [resultPlace, setResultPlace] = useState('');
  const [resultNotes, setResultNotes] = useState('');

  const view = useMemo(() => {
    if (!all) return undefined;
    return seasonView(all as RaceLike[]);
  }, [all]);

  function reset() {
    setForm(EMPTY_FORM);
    setEditing(undefined);
  }

  function openEdit(race: Race) {
    setEditing(race);
    setForm({
      name: race.name,
      date: race.date.slice(0, 16),
      kind: race.kind,
      priority: race.priority,
      distanceKm: race.distanceKm?.toString() ?? '',
      targetTime: race.targetTimeSec ? formatRaceTime(race.targetTimeSec) : '',
      location: race.location ?? '',
      notes: race.notes ?? '',
    });
    setOpen(true);
  }

  async function save() {
    if (!form.name.trim() || !form.date) return;
    const now = new Date().toISOString();
    const distance =
      form.distanceKm.trim() !== ''
        ? parseFloat(form.distanceKm)
        : inferDistanceKm(form.kind);
    const target = parseTimeInput(form.targetTime);
    const dateIso = new Date(form.date).toISOString();
    if (editing) {
      const updated: Race = {
        ...editing,
        name: form.name.trim(),
        date: dateIso,
        kind: form.kind,
        priority: form.priority,
        distanceKm: distance,
        targetTimeSec: target,
        location: form.location.trim() || undefined,
        notes: form.notes.trim() || undefined,
        updatedAt: now,
      };
      await getDb().races.put(updated);
    } else {
      const created: Race = {
        id: nanoid(),
        name: form.name.trim(),
        date: dateIso,
        kind: form.kind,
        priority: form.priority,
        distanceKm: distance,
        targetTimeSec: target,
        location: form.location.trim() || undefined,
        notes: form.notes.trim() || undefined,
        createdAt: now,
        updatedAt: now,
      };
      await getDb().races.add(created);
    }
    kickSync();
    setOpen(false);
    reset();
  }

  async function remove(race: Race) {
    if (!confirm(`Delete race "${race.name}"?`)) return;
    await deleteWithTombstones('race', [race.id]);
  }

  function openResult(race: Race) {
    setResultFor(race);
    setResultTime(race.result?.finishTimeSec ? formatRaceTime(race.result.finishTimeSec) : '');
    setResultPlace(race.result?.placeOverall?.toString() ?? '');
    setResultNotes(race.result?.notes ?? '');
  }

  async function saveResult() {
    if (!resultFor) return;
    const now = new Date().toISOString();
    const finishTimeSec = parseTimeInput(resultTime);
    const placeOverall = resultPlace.trim() ? parseInt(resultPlace, 10) : undefined;
    const updated: Race = {
      ...resultFor,
      result: {
        finishTimeSec,
        placeOverall: Number.isFinite(placeOverall ?? NaN) ? placeOverall : undefined,
        notes: resultNotes.trim() || undefined,
        loggedAt: now,
      },
      completedAt: now,
      updatedAt: now,
    };
    await getDb().races.put(updated);
    kickSync();
    setResultFor(undefined);
  }

  if (!all || !view) return <div className="p-4 text-sm text-muted">Loading…</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Races</h1>
          <p className="text-sm text-muted">
            Your race calendar drives the taper. Priority A = full taper window;
            B = half-marathon-style taper; C = visibility only.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(true);
          }}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-bg"
        >
          + New race
        </button>
      </header>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Upcoming season</h2>
        {view.upcoming.length === 0 ? (
          <p className="text-sm text-muted">
            No upcoming races. Add one to enable race-aware tapering.
          </p>
        ) : (
          <ul className="space-y-2">
            {view.upcoming.map(({ race: r, daysOut }) => {
              const rec = taperRecommendation(r as RaceLike);
              return (
                <li
                  key={r.id}
                  className="rounded-lg border border-border bg-card p-3"
                >
                  <RaceRow
                    race={r as Race}
                    daysOut={daysOut}
                    rec={rec}
                    onEdit={() => openEdit(r as Race)}
                    onDelete={() => remove(r as Race)}
                    onLogResult={daysOut <= 0 ? () => openResult(r as Race) : undefined}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Past races</h2>
        {view.past.length === 0 ? (
          <p className="text-sm text-muted">No past races logged yet.</p>
        ) : (
          <ul className="space-y-2">
            {view.past.map(({ race: r, daysOut }) => (
              <li
                key={r.id}
                className="rounded-lg border border-border bg-card p-3"
              >
                <RaceRow
                  race={r as Race}
                  daysOut={daysOut}
                  past
                  onEdit={() => openEdit(r as Race)}
                  onDelete={() => remove(r as Race)}
                  onLogResult={!(r as Race).result ? () => openResult(r as Race) : undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-4">
            <h3 className="text-lg font-semibold">
              {editing ? 'Edit race' : 'New race'}
            </h3>
            <label className="block text-sm">
              <span className="text-muted">Name</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
                placeholder="Helsinki Half Marathon"
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Date &amp; start time</span>
              <input
                type="datetime-local"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-sm">
                <span className="text-muted">Kind</span>
                <select
                  value={form.kind}
                  onChange={(e) => {
                    const k = e.target.value as RaceKind;
                    setForm({
                      ...form,
                      kind: k,
                      distanceKm:
                        form.distanceKm.trim() === ''
                          ? (inferDistanceKm(k)?.toString() ?? '')
                          : form.distanceKm,
                    });
                  }}
                  className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
                >
                  {(Object.keys(KIND_LABEL) as RaceKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-muted">Priority</span>
                <select
                  value={form.priority}
                  onChange={(e) =>
                    setForm({ ...form, priority: e.target.value as RacePriority })
                  }
                  className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
                >
                  <option value="A">A · full taper</option>
                  <option value="B">B · half-style taper</option>
                  <option value="C">C · calendar only</option>
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-sm">
                <span className="text-muted">Distance (km)</span>
                <input
                  type="number"
                  step="0.01"
                  value={form.distanceKm}
                  onChange={(e) => setForm({ ...form, distanceKm: e.target.value })}
                  className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
                  placeholder="auto"
                />
              </label>
              <label className="block text-sm">
                <span className="text-muted">Target time</span>
                <input
                  type="text"
                  value={form.targetTime}
                  onChange={(e) => setForm({ ...form, targetTime: e.target.value })}
                  className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
                  placeholder="1:55:00"
                />
              </label>
            </div>
            <label className="block text-sm">
              <span className="text-muted">Location</span>
              <input
                type="text"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Notes</span>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
                className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                className="rounded border border-border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-bg"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {resultFor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-4">
            <h3 className="text-lg font-semibold">Log result · {resultFor.name}</h3>
            <label className="block text-sm">
              <span className="text-muted">Finish time</span>
              <input
                type="text"
                value={resultTime}
                onChange={(e) => setResultTime(e.target.value)}
                className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
                placeholder="1:58:42"
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Place (overall)</span>
              <input
                type="number"
                value={resultPlace}
                onChange={(e) => setResultPlace(e.target.value)}
                className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Notes</span>
              <textarea
                value={resultNotes}
                onChange={(e) => setResultNotes(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setResultFor(undefined)}
                className="rounded border border-border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveResult}
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-bg"
              >
                Save result
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RaceRow({
  race,
  daysOut,
  rec,
  past,
  onEdit,
  onDelete,
  onLogResult,
}: {
  race: Race;
  daysOut: number;
  rec?: RaceTaperRecommendation;
  past?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onLogResult?: () => void;
}) {
  const distance = race.distanceKm ?? inferDistanceKm(race.kind);
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-xs font-medium ${PRIORITY_TONE[race.priority]}`}
        >
          {raceLabel(race)}
        </span>
        <span className="font-medium">{race.name}</span>
        <span className="text-sm text-muted">{fmtDate(race.date)}</span>
        <span className="text-xs text-muted">· {daysOutLabel(daysOut)}</span>
      </div>
      <div className="mt-0.5 text-xs text-muted">
        {distance ? `${distance.toFixed(distance < 10 ? 1 : 2).replace(/\.?0+$/, '')} km` : KIND_LABEL[race.kind]}
        {race.targetTimeSec ? ` · target ${formatRaceTime(race.targetTimeSec)}` : ''}
        {race.location ? ` · ${race.location}` : ''}
      </div>
      {rec && rec.phase !== 'normal' && (
        <p className="mt-1 text-xs text-fg/80">{rec.reason}</p>
      )}
      {race.result && (
        <p className="mt-1 text-sm">
          Finish:{' '}
          <span className="font-medium">
            {race.result.finishTimeSec ? formatRaceTime(race.result.finishTimeSec) : '—'}
          </span>
          {race.result.placeOverall ? ` · place ${race.result.placeOverall}` : ''}
          {race.result.notes ? ` · ${race.result.notes}` : ''}
        </p>
      )}
      <div className="mt-2 flex gap-2 text-xs">
        <button onClick={onEdit} className="text-accent underline">
          Edit
        </button>
        {onLogResult && (
          <button onClick={onLogResult} className="text-accent underline">
            {race.result ? 'Update result' : 'Log result'}
          </button>
        )}
        <button onClick={onDelete} className="text-red-400 underline">
          Delete
        </button>
        {!past && (
          <Link href="/" className="ml-auto text-muted underline">
            Today →
          </Link>
        )}
      </div>
    </div>
  );
}
