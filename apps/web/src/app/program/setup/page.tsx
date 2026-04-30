'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { computeTrainingMax } from '@wendler/domain';
import { nanoid } from 'nanoid';
import { MAIN_LIFTS, fmtKg } from '@/lib/format';
import { useAllTrainingMaxes, useSettings } from '@/lib/hooks';
import { getDb } from '@/lib/db';

interface Row {
  oneRm: string;
  tmPercent: string;
}

export default function SetupPage() {
  const settings = useSettings();
  const tms = useAllTrainingMaxes();
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings) return;
    const next: Record<string, Row> = {};
    for (const l of MAIN_LIFTS) {
      const cur = tms?.get(l.key);
      next[l.key] = {
        oneRm: cur?.oneRmKg ? String(cur.oneRmKg) : '',
        tmPercent: String(((cur?.tmPercent ?? settings.defaultTmPercent) * 100).toFixed(0)),
      };
    }
    setRows(next);
  }, [settings, tms]);

  if (!settings) return <p className="text-muted">Loading…</p>;

  const onSave = async () => {
    const db = getDb();
    const now = new Date().toISOString();
    for (const l of MAIN_LIFTS) {
      const r = rows[l.key];
      const oneRm = parseFloat(r?.oneRm ?? '');
      const tmPercent = parseFloat(r?.tmPercent ?? '') / 100;
      if (!isFinite(oneRm) || oneRm <= 0 || !isFinite(tmPercent)) continue;
      const tm = computeTrainingMax(oneRm, { tmPercent, roundingKg: settings.roundingKg });
      await db.trainingMaxes.add({
        id: nanoid(),
        lift: l.key,
        oneRmKg: oneRm,
        tmPercent,
        trainingMaxKg: tm,
        createdAt: now,
        source: 'manual',
      });
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Setup Training Maxes</h1>
        <p className="text-sm text-muted">
          Enter your current 1RM (or a recent rep PR estimate) for each lift. We&apos;ll compute your
          Training Max as a percentage and round to the nearest {settings.roundingKg} kg.
        </p>
      </header>

      <div className="space-y-3">
        {MAIN_LIFTS.map((l) => {
          const r = rows[l.key] ?? { oneRm: '', tmPercent: '85' };
          const oneRm = parseFloat(r.oneRm);
          const tmPercent = parseFloat(r.tmPercent) / 100;
          const tm =
            isFinite(oneRm) && oneRm > 0 && isFinite(tmPercent) && tmPercent > 0 && tmPercent < 1
              ? computeTrainingMax(oneRm, { tmPercent, roundingKg: settings.roundingKg })
              : null;
          return (
            <div key={l.key} className="rounded-xl border border-border bg-card p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-lg font-semibold">{l.label}</h2>
                <span className="text-sm text-muted">
                  TM: <span className="font-mono text-fg">{tm ? fmtKg(tm) : '—'}</span>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-muted">1RM (kg)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={2.5}
                    value={r.oneRm}
                    onChange={(e) =>
                      setRows((s) => ({ ...s, [l.key]: { ...r, oneRm: e.target.value } }))
                    }
                    className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-lg"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-muted">TM %</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={70}
                    max={95}
                    value={r.tmPercent}
                    onChange={(e) =>
                      setRows((s) => ({ ...s, [l.key]: { ...r, tmPercent: e.target.value } }))
                    }
                    className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-lg"
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          className="rounded-lg bg-accent px-4 py-3 font-semibold text-bg active:scale-[0.98]"
        >
          Save Training Maxes
        </button>
        {saved && <span className="text-sm text-emerald-400">Saved.</span>}
        <Link href="/" className="ml-auto text-sm text-muted hover:text-fg">
          Done
        </Link>
      </div>
    </div>
  );
}
