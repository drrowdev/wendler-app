'use client';

import { useEffect, useState } from 'react';
import { useRecoveryFor, useRecoveryRecent } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import type { RecoveryEntry } from '@wendler/db-schema';

function todayId() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(id: string) {
  const [y, m, d] = id.split('-');
  return `${d}.${m}.${y}`;
}

interface SliderProps {
  label: string;
  value: number | undefined;
  setValue: (n: number | undefined) => void;
  min?: number;
  max?: number;
  unit?: string;
  hint?: string;
}

function Slider({ label, value, setValue, min = 1, max = 10, unit, hint }: SliderProps) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono text-muted">
          {value === undefined ? '—' : `${value}${unit ?? ''}`}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={max <= 12 ? 1 : 0.1}
        value={value ?? Math.round((min + max) / 2)}
        onChange={(e) => setValue(Number(e.target.value))}
        className="w-full accent-accent"
      />
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

export default function RecoveryPage() {
  const [date, setDate] = useState(todayId);
  const today = useRecoveryFor(date);
  const recent = useRecoveryRecent(30);

  const [sleep, setSleep] = useState<number | undefined>(undefined);
  const [hrv, setHrv] = useState<string>('');
  const [fatigue, setFatigue] = useState<number | undefined>(undefined);
  const [soreness, setSoreness] = useState<number | undefined>(undefined);
  const [mood, setMood] = useState<number | undefined>(undefined);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    setSleep(today?.sleepHours);
    setHrv(today?.hrv ? String(today.hrv) : '');
    setFatigue(today?.fatigue);
    setSoreness(today?.soreness);
    setMood(today?.mood);
    setNotes(today?.notes ?? '');
  }, [today, date]);

  async function save() {
    const r: RecoveryEntry = {
      id: date,
      sleepHours: sleep,
      hrv: hrv ? Number(hrv) : undefined,
      fatigue,
      soreness,
      mood,
      notes: notes.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };
    await getDb().recovery.put(r);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Recovery</h1>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm"
        />
      </header>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <Slider
          label="Sleep"
          value={sleep}
          setValue={setSleep}
          min={3}
          max={12}
          unit=" h"
          hint="Total hours last night"
        />
        <div>
          <div className="flex items-center justify-between text-sm">
            <span>HRV (rMSSD)</span>
          </div>
          <input
            type="number"
            value={hrv}
            onChange={(e) => setHrv(e.target.value)}
            placeholder="ms (from your wearable)"
            className="w-full rounded-md border border-border bg-bg px-3 py-2"
          />
        </div>
        <Slider label="Fatigue" value={fatigue} setValue={setFatigue} hint="1 = fresh, 10 = wrecked" />
        <Slider label="Soreness" value={soreness} setValue={setSoreness} hint="1 = none, 10 = very sore" />
        <Slider label="Mood" value={mood} setValue={setMood} hint="1 = low, 10 = great" />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (stress, illness, etc.)"
          rows={2}
          className="w-full rounded-md border border-border bg-bg px-3 py-2"
        />
        <button
          type="button"
          onClick={save}
          className="w-full rounded-md bg-accent py-2 text-sm font-medium text-bg"
        >
          Save {date === todayId() ? 'today' : fmtDate(date)}
        </button>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Last 30 days
        </h2>
        {(recent ?? []).length === 0 && (
          <p className="text-sm text-muted">No entries yet.</p>
        )}
        <div className="space-y-1">
          {(recent ?? []).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setDate(r.id)}
              className="flex w-full items-center justify-between rounded-md border border-border bg-card/60 px-3 py-2 text-sm hover:bg-card"
            >
              <span>{fmtDate(r.id)}</span>
              <span className="flex gap-3 font-mono text-xs text-muted">
                {r.sleepHours !== undefined && <span>💤 {r.sleepHours}h</span>}
                {r.fatigue !== undefined && <span>😩 {r.fatigue}</span>}
                {r.soreness !== undefined && <span>🦴 {r.soreness}</span>}
                {r.hrv !== undefined && <span>HRV {r.hrv}</span>}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
