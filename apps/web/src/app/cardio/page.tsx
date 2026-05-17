'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useCardioRecent, useRunPlan } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { deleteWithTombstones } from '@/lib/delete';
import { setManualPlanKind } from '@/lib/runPlan';
import { LinkSlotPicker } from '@/components/LinkSlotPicker';
import type { CardioSession, RunPlannedKind } from '@wendler/db-schema';
import {
  classifyIntensity,
  intensityLabel,
  planEmoji,
  planLabel,
  RUN_PLANNED_KINDS,
  toLocalYmd,
} from '@wendler/domain';
import type { IntensityTag } from '@wendler/domain';

// Tailwind classes per intensity bucket — kept small and muted so the tag
// reads as metadata rather than a CTA.
const INTENSITY_STYLES: Record<Exclude<IntensityTag, 'none'>, string> = {
  easy: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  threshold: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  hard: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
  mixed: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30',
  recovery: 'bg-slate-500/15 text-slate-300 ring-1 ring-slate-500/30',
};

const MODALITIES: { id: CardioSession['modality']; label: string; emoji: string }[] = [
  { id: 'run', label: 'Run', emoji: '🏃' },
  { id: 'bike', label: 'Bike', emoji: '🚴' },
  { id: 'swim', label: 'Swim', emoji: '🏊' },
  { id: 'row', label: 'Row', emoji: '🚣' },
  { id: 'walk', label: 'Walk', emoji: '🚶' },
  { id: 'padel', label: 'Padel', emoji: '🎾' },
  { id: 'other', label: 'Other', emoji: '⚡' },
];

function formatDate(iso: string) {
  const d = new Date(iso);
  const wd = d.toLocaleDateString('fi-FI', { weekday: 'short' });
  return `${wd} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function formatScheduledDate(ymd: string) {
  // ymd is YYYY-MM-DD; build a noon-local Date so we don't trip TZ rollovers.
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const wd = date.toLocaleDateString('fi-FI', { weekday: 'short' });
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

function formatTotalTime(totalSec: number) {
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
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
  const plan = useRunPlan();
  const [open, setOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<CardioSession | null>(null);
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
    await deleteWithTombstones('cardio', [c.id]);
  }

  const list = recent ?? [];
  const totalSec = list.reduce((acc, c) => acc + c.durationSec, 0);
  const totalKm = list.reduce((acc, c) => acc + (c.distanceKm ?? 0), 0);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Cardio</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/program?tab=cardio"
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
            title={plan?.slots?.length ? 'Weekly run plan' : 'Set up your weekly run plan'}
          >
            📅 Plan
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg"
          >
            {open ? 'Cancel' : '+ Log cardio'}
          </button>
        </div>
      </header>

      {list.length > 0 && (
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted">Sessions</div>
            <div className="text-lg font-semibold">{list.length}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted">Total time</div>
            <div className="text-lg font-semibold">{formatTotalTime(totalSec)}</div>
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
          const intensity = classifyIntensity(c);
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
                  {c.plannedKind && c.plannedKind !== 'rest' && (
                    <span
                      className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent"
                      title={
                        c.planMatch === 'manual'
                          ? 'Manually tagged'
                          : 'Matched the planned slot for this weekday'
                      }
                    >
                      {planEmoji(c.plannedKind)} {planLabel(c.plannedKind).toUpperCase()}
                      {c.planMatch === 'manual' && ' ✎'}
                    </span>
                  )}
                  {intensity.tag !== 'none' && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${INTENSITY_STYLES[intensity.tag]}`}
                      title={`Auto-tagged from time-in-zone — easy ${Math.round(intensity.easyShare * 100)}% (Z1+Z2) · grey ${Math.round(intensity.greyShare * 100)}% (Z3) · hard ${Math.round(intensity.hardShare * 100)}% (Z4+Z5)`}
                    >
                      {intensityLabel(intensity.tag)}
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
                {c.modality === 'run' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <label htmlFor={`tag-${c.id}`}>Tag as:</label>
                    <select
                      id={`tag-${c.id}`}
                      value={c.plannedKind ?? ''}
                      onChange={async (e) => {
                        const v = e.target.value as RunPlannedKind | '';
                        await setManualPlanKind(c.id, v === '' ? null : v);
                      }}
                      className="rounded border border-border bg-bg px-1.5 py-0.5 text-xs"
                    >
                      <option value="">— auto / none —</option>
                      {RUN_PLANNED_KINDS.filter((k) => k.id !== 'rest').map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.emoji} {k.label}
                        </option>
                      ))}
                    </select>
                    {(plan?.slots?.length ?? 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => setLinkTarget(c)}
                        className="rounded border border-border bg-bg px-1.5 py-0.5 text-xs hover:text-fg"
                        title="Link this run to a planned slot on a different day"
                      >
                        🔗 Link to slot…
                      </button>
                    )}
                    {c.planScheduledDate &&
                      c.planScheduledDate !== toLocalYmd(new Date(c.performedAt)) && (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 ring-1 ring-sky-500/30"
                          title={`Linked to a planned run on ${c.planScheduledDate}`}
                        >
                          <span>↳ Linked to {formatScheduledDate(c.planScheduledDate)}</span>
                          <button
                            type="button"
                            onClick={() => setManualPlanKind(c.id, null)}
                            aria-label="Unlink from planned slot"
                            className="ml-0.5 rounded text-sky-300 hover:text-fg"
                          >
                            ×
                          </button>
                        </span>
                      )}
                  </div>
                )}
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

      {linkTarget && (
        <LinkSlotPicker
          cardio={linkTarget}
          onClose={() => setLinkTarget(null)}
        />
      )}
    </div>
  );
}
