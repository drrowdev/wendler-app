'use client';

import { useState } from 'react';
import { useSettings } from '@/lib/hooks';
import { getDb } from '@/lib/db';

export default function SettingsPage() {
  const settings = useSettings();
  const [editing, setEditing] = useState(false);
  const [bar, setBar] = useState('20');
  const [rounding, setRounding] = useState('2.5');
  const [defaultTm, setDefaultTm] = useState('85');
  const [warmupP, setWarmupP] = useState('40,60,80');
  const [warmupR, setWarmupR] = useState('5,5,3');
  const [plates, setPlates] = useState('25:2, 20:2, 15:1, 10:2, 5:2, 2.5:2, 1.25:2');

  if (!settings) return <p className="text-muted">Loading…</p>;

  const startEdit = () => {
    setBar(String(settings.barWeightKg));
    setRounding(String(settings.roundingKg));
    setDefaultTm(String((settings.defaultTmPercent * 100).toFixed(0)));
    setWarmupP(settings.warmupPercents.map((p) => Math.round(p * 100)).join(','));
    setWarmupR(settings.warmupReps.join(','));
    setPlates(
      Object.entries(settings.pairsByWeight)
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .map(([w, c]) => `${w}:${c}`)
        .join(', '),
    );
    setEditing(true);
  };

  const onSave = async () => {
    const pairs: Record<number, number> = {};
    for (const part of plates.split(',')) {
      const [w, c] = part.split(':').map((s) => s.trim());
      const wn = Number(w);
      const cn = Number(c);
      if (isFinite(wn) && wn > 0 && isFinite(cn) && cn > 0) pairs[wn] = cn;
    }
    await getDb().settings.put({
      id: 'singleton',
      barWeightKg: Number(bar),
      roundingKg: Number(rounding),
      defaultTmPercent: Number(defaultTm) / 100,
      warmupPercents: warmupP.split(',').map((s) => Number(s.trim()) / 100),
      warmupReps: warmupR.split(',').map((s) => Number(s.trim())),
      pairsByWeight: pairs,
      units: 'kg',
      updatedAt: new Date().toISOString(),
    });
    setEditing(false);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>

      {!editing ? (
        <>
          <Section title="Equipment">
            <Row label="Bar weight">{settings.barWeightKg} kg</Row>
            <Row label="Rounding increment">{settings.roundingKg} kg</Row>
            <Row label="Plates available (per side pairs)">
              {Object.entries(settings.pairsByWeight)
                .sort((a, b) => Number(b[0]) - Number(a[0]))
                .map(([w, c]) => `${c}×${w}kg`)
                .join(', ')}
            </Row>
          </Section>
          <Section title="Programming defaults">
            <Row label="Default TM %">{(settings.defaultTmPercent * 100).toFixed(0)}%</Row>
            <Row label="Warm-up %">
              {settings.warmupPercents.map((p) => `${Math.round(p * 100)}%`).join(' / ')}
            </Row>
            <Row label="Warm-up reps">{settings.warmupReps.join(' / ')}</Row>
          </Section>
          <button
            onClick={startEdit}
            className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg"
          >
            Edit
          </button>
        </>
      ) : (
        <>
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <Field label="Bar weight (kg)" value={bar} onChange={setBar} />
            <Field label="Rounding increment (kg)" value={rounding} onChange={setRounding} />
            <Field
              label="Plates available (e.g. 25:2, 20:2, …)"
              value={plates}
              onChange={setPlates}
            />
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <Field label="Default TM %" value={defaultTm} onChange={setDefaultTm} />
            <Field
              label="Warm-up % (comma-separated)"
              value={warmupP}
              onChange={setWarmupP}
            />
            <Field
              label="Warm-up reps (comma-separated)"
              value={warmupR}
              onChange={setWarmupR}
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={onSave}
              className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg bg-card px-4 py-2 ring-1 ring-border"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-fg">{children}</span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
      />
    </label>
  );
}
