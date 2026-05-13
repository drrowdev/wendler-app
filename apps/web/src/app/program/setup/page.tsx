'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { computeTrainingMax } from '@wendler/domain';
import { nanoid } from 'nanoid';
import { MAIN_LIFTS, fmtKg } from '@/lib/format';
import { useAllTrainingMaxes, useMovements, useSettings } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { kickSync } from '@/lib/sync';

interface Row {
  oneRm: string;
  tmPercent: string;
  movementId: string;
}

export default function SetupPage() {
  const settings = useSettings();
  const tms = useAllTrainingMaxes();
  const movements = useMovements();
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [saved, setSaved] = useState(false);

  // Resolve the current movement for each slot — explicit mapping wins, else fall back to
  // whichever movement carries the matching `isMainLift` flag (the original seed behaviour).
  const currentMovementId = useMemo(() => {
    const result: Record<string, string> = {};
    for (const l of MAIN_LIFTS) {
      const mapped = settings?.mainLiftMovements?.[l.key];
      if (mapped && movements?.some((m) => m.id === mapped)) {
        result[l.key] = mapped;
      } else {
        const fallback = movements?.find((m) => m.isMainLift === l.key);
        result[l.key] = fallback?.id ?? '';
      }
    }
    return result;
  }, [settings, movements]);

  useEffect(() => {
    if (!settings) return;
    const next: Record<string, Row> = {};
    for (const l of MAIN_LIFTS) {
      const cur = tms?.get(l.key);
      next[l.key] = {
        oneRm: cur?.oneRmKg ? String(cur.oneRmKg) : '',
        tmPercent: String(((cur?.tmPercent ?? settings.defaultTmPercent) * 100).toFixed(0)),
        movementId: currentMovementId[l.key] ?? '',
      };
    }
    setRows(next);
  }, [settings, tms, currentMovementId]);

  if (!settings) return <p className="text-muted">Loading…</p>;

  const onSave = async () => {
    const db = getDb();
    const now = new Date().toISOString();

    const newMapping: Partial<Record<string, string>> = {
      ...(settings.mainLiftMovements ?? {}),
    };
    for (const l of MAIN_LIFTS) {
      const r = rows[l.key];
      if (r?.movementId) newMapping[l.key] = r.movementId;
      // Save TMs as before.
      const oneRm = parseFloat(r?.oneRm ?? '');
      const tmPercent = parseFloat(r?.tmPercent ?? '') / 100;
      if (!isFinite(oneRm) || oneRm <= 0 || !isFinite(tmPercent)) continue;
      // Skip writing a new history entry when the user didn't actually change
      // the 1RM or TM% for this lift — otherwise tapping Save creates a
      // duplicate row for every main lift on every save.
      const cur = tms?.get(l.key);
      if (
        cur &&
        cur.oneRmKg != null &&
        Math.abs(cur.oneRmKg - oneRm) < 1e-6 &&
        Math.abs(cur.tmPercent - tmPercent) < 1e-6
      ) {
        continue;
      }
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

    await db.settings.put({
      ...settings,
      mainLiftMovements: newMapping as typeof settings.mainLiftMovements,
      updatedAt: now,
    });
    kickSync();

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Pattern groups so the dropdown only offers sensible swaps for each slot.
  // Within a slot we further restrict to *compound* movements — multi-joint
  // lifts that can credibly carry a Training Max — so users won't accidentally
  // assign Lateral Raise to the Press slot or Leg Extension to Squat.
  const slotPattern: Record<string, string[]> = {
    squat: ['squat'],
    deadlift: ['hinge'],
    bench: ['push-horizontal'],
    press: ['push-vertical'],
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Setup Training Maxes</h1>
        <p className="text-sm text-muted">
          Pick the movement for each 5/3/1 slot, then enter your current 1RM (or a recent rep PR
          estimate). We&apos;ll compute your Training Max as a percentage and round to the nearest{' '}
          {settings.roundingKg} kg.{' '}
          <Link href="/movements/new" className="text-accent hover:underline">
            + Add a new movement
          </Link>{' '}
          if it&apos;s not in the list.
        </p>
      </header>

      <div className="space-y-3">
        {MAIN_LIFTS.map((l) => {
          const r = rows[l.key] ?? { oneRm: '', tmPercent: '85', movementId: '' };
          const oneRm = parseFloat(r.oneRm);
          const tmPercent = parseFloat(r.tmPercent) / 100;
          const tm =
            isFinite(oneRm) && oneRm > 0 && isFinite(tmPercent) && tmPercent > 0 && tmPercent < 1
              ? computeTrainingMax(oneRm, { tmPercent, roundingKg: settings.roundingKg })
              : null;
          const allowedPatterns = slotPattern[l.key] ?? [];
          const slotMovements = (movements ?? []).filter(
            (m) =>
              allowedPatterns.includes(m.pattern) &&
              // Compound lifts only (or the seeded main lift for this slot, so
              // legacy data without the flag still appears as a fallback).
              (m.isCompound === true || m.isMainLift === l.key),
          );
          return (
            <div key={l.key} className="rounded-xl border border-border bg-card p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-lg font-semibold">{l.label} slot</h2>
                <span className="text-sm text-muted">
                  TM: <span className="font-mono text-fg">{tm ? fmtKg(tm) : '—'}</span>
                </span>
              </div>
              <label className="mb-3 block">
                <span className="text-xs text-muted">Movement</span>
                <select
                  value={r.movementId}
                  onChange={(e) =>
                    setRows((s) => ({ ...s, [l.key]: { ...r, movementId: e.target.value } }))
                  }
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-base"
                >
                  {slotMovements.length === 0 && <option value="">(no movements)</option>}
                  {slotMovements.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
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
          Save
        </button>
        {saved && <span className="text-sm text-emerald-400">Saved.</span>}
        <Link href="/" className="ml-auto text-sm text-muted hover:text-fg">
          Done
        </Link>
      </div>
    </div>
  );
}
