'use client';

import { useState } from 'react';
import { useCardioRecent } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import type { CardioSession } from '@wendler/db-schema';
import { formatDistance, formatPaceTime, pacePRs, RACE_DISTANCES_M } from '@wendler/domain';

const MODALITIES: { id: CardioSession['modality']; label: string; emoji: string }[] = [
  { id: 'run', label: 'Run', emoji: '🏃' },
  { id: 'bike', label: 'Bike', emoji: '🚴' },
  { id: 'swim', label: 'Swim', emoji: '🏊' },
  { id: 'row', label: 'Row', emoji: '🚣' },
  { id: 'walk', label: 'Walk', emoji: '🚶' },
  { id: 'other', label: 'Other', emoji: '⚡' },
];

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function formatDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseDuration(text: string): number | null {
  const parts = text.split(':').map((p) => Number(p.trim()));
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 1) return parts[0]! * 60;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

export default function CardioPage() {
  const recent = useCardioRecent(50);
  const [open, setOpen] = useState(false);
  const [modality, setModality] = useState<CardioSession['modality']>('run');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [duration, setDuration] = useState('');
  const [distance, setDistance] = useState('');
  const [hr, setHr] = useState('');
  const [rpe, setRpe] = useState('');
  const [notes, setNotes] = useState('');

  async function save() {
    const sec = parseDuration(duration);
    if (sec === null || sec <= 0) {
      alert('Enter a valid duration like 45 (min), 45:30, or 1:05:30');
      return;
    }
    const now = new Date().toISOString();
    const c: CardioSession = {
      id: crypto.randomUUID(),
      performedAt: new Date(date + 'T12:00:00Z').toISOString(),
      modality,
      durationSec: sec,
      distanceKm: distance ? Number(distance) : undefined,
      avgHrBpm: hr ? Number(hr) : undefined,
      rpe: rpe ? Number(rpe) : undefined,
      notes: notes.trim() || undefined,
      source: 'manual',
      updatedAt: now,
    };
    await getDb().cardio.put(c);
    setDuration('');
    setDistance('');
    setHr('');
    setRpe('');
    setNotes('');
    setOpen(false);
  }

  async function remove(c: CardioSession) {
    if (!confirm('Delete this cardio entry?')) return;
    await getDb().cardio.delete(c.id);
  }

  const list = recent ?? [];
  const totalMin = list.reduce((acc, c) => acc + c.durationSec, 0) / 60;
  const totalKm = list.reduce((acc, c) => acc + (c.distanceKm ?? 0), 0);
  const prs = pacePRs(list.map((c) => ({
    id: c.id,
    performedAt: c.performedAt,
    modality: c.modality,
    bestEffortsSec: c.bestEffortsSec,
  })));

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Cardio</h1>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg"
        >
          {open ? 'Cancel' : '+ Log cardio'}
        </button>
      </header>

      {list.length > 0 && (
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted">Sessions</div>
            <div className="text-lg font-semibold">{list.length}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted">Total time</div>
            <div className="text-lg font-semibold">{Math.round(totalMin)}m</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted">Distance</div>
            <div className="text-lg font-semibold">{totalKm.toFixed(1)} km</div>
          </div>
        </div>
      )}

      {open && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap gap-2">
            {MODALITIES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setModality(m.id)}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  modality === m.id
                    ? 'border-accent bg-accent/20 text-fg'
                    : 'border-border text-muted'
                }`}
              >
                {m.emoji} {m.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={date}
              type="date"
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-border bg-bg px-3 py-2"
            />
            <input
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              placeholder="Duration (min or mm:ss)"
              className="flex-1 rounded-md border border-border bg-bg px-3 py-2"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
              placeholder="Distance km"
              type="number"
              step="0.01"
              className="flex-1 rounded-md border border-border bg-bg px-3 py-2"
            />
            <input
              value={hr}
              onChange={(e) => setHr(e.target.value)}
              placeholder="Avg HR"
              type="number"
              className="w-28 rounded-md border border-border bg-bg px-3 py-2"
            />
            <input
              value={rpe}
              onChange={(e) => setRpe(e.target.value)}
              placeholder="RPE 1-10"
              type="number"
              min="1"
              max="10"
              className="w-28 rounded-md border border-border bg-bg px-3 py-2"
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
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg"
          >
            Save
          </button>
        </div>
      )}

      <section className="space-y-2">
        {list.length === 0 && (
          <p className="text-sm text-muted">No cardio logged yet. Tap + to add some, or connect Strava in Settings.</p>
        )}
        {list.map((c) => {
          const m = MODALITIES.find((x) => x.id === c.modality);
          const totalZoneSec = (c.hrZoneSeconds ?? []).reduce((a, b) => a + b, 0);
          return (
            <div
              key={c.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2 font-medium">
                  <span className="text-xl">{m?.emoji}</span>
                  {m?.label}
                  {c.source === 'strava' && (
                    <span className="rounded bg-[#fc4c02]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#fc4c02]">
                      STRAVA
                    </span>
                  )}
                  <span className="text-sm font-normal text-muted">
                    · {formatDate(c.performedAt)}
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-muted">
                  {formatDuration(c.durationSec)}
                  {c.distanceKm !== undefined && ` · ${c.distanceKm.toFixed(2)} km`}
                  {c.avgHrBpm !== undefined && ` · ${c.avgHrBpm} bpm`}
                  {c.elevGainM !== undefined && c.elevGainM > 0 && ` · ↑ ${Math.round(c.elevGainM)} m`}
                  {c.rpe !== undefined && ` · RPE ${c.rpe}`}
                  {c.sufferScore !== undefined && ` · suffer ${Math.round(c.sufferScore)}`}
                </div>
                {c.hrZoneSeconds && totalZoneSec > 0 && (
                  <div className="mt-1 flex gap-0.5 overflow-hidden rounded text-[10px]" title="Time in HR zones">
                    {c.hrZoneSeconds.map((sec, i) => {
                      const pct = (sec / totalZoneSec) * 100;
                      const colors = ['#475569', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444'];
                      if (pct < 1) return null;
                      return (
                        <div
                          key={i}
                          style={{ width: `${pct}%`, backgroundColor: colors[i] }}
                          className="py-1 text-center text-white"
                        >
                          Z{i + 1}
                        </div>
                      );
                    })}
                  </div>
                )}
                {c.notes && <div className="mt-1 text-sm">{c.notes}</div>}
              </div>
              <button
                type="button"
                onClick={() => remove(c)}
                className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-fg"
                aria-label="Delete cardio entry"
              >
                ✕
              </button>
            </div>
          );
        })}
      </section>

      {prs.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Pace PRs
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {RACE_DISTANCES_M.map((d) => {
              const pr = prs.find((p) => p.distanceM === d);
              if (!pr) return null;
              return (
                <div key={d} className="rounded-lg border border-border bg-card p-3 text-center">
                  <div className="text-xs text-muted">{formatDistance(d)}</div>
                  <div className="text-lg font-semibold">{formatPaceTime(pr.timeSec)}</div>
                  <div className="text-[10px] text-muted">{formatDate(pr.performedAt)}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
