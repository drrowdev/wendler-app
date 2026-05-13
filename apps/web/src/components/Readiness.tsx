'use client';

// Small shared readiness widgets used on /, /profile, and the Recovery tab
// of /load. Each card persists into the per-day `RecoveryEntry` singleton
// via `upsertRecoveryEntry` — the underlying data model is unchanged from
// when these widgets lived only on the Recovery view.

import { useState } from 'react';
import { useRecoveryEntry } from '@/lib/hooks';
import { upsertRecoveryEntry } from '@/lib/recovery';

export function ReadinessScale({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value?: number;
  onChange: (val: number) => void;
}) {
  // Render 5 buttons mapped to (1, 3, 5, 7, 9) on the 1-10 scale so the
  // UI stays simple while the schema keeps its existing 1-10 precision.
  const buckets: { label: string; val: number }[] = [
    { label: '1', val: 1 },
    { label: '2', val: 3 },
    { label: '3', val: 5 },
    { label: '4', val: 7 },
    { label: '5', val: 9 },
  ];
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          {label}
        </span>
        <span className="text-[10px] text-muted">{hint}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-5 gap-1">
        {buckets.map((b) => {
          const active = value === b.val;
          return (
            <button
              key={b.val}
              type="button"
              onClick={() => onChange(b.val)}
              className={`rounded-md px-2 py-1.5 text-sm font-medium tabular-nums ring-1 transition-colors ${
                active
                  ? 'bg-accent text-bg ring-accent'
                  : 'bg-bg text-muted ring-border hover:text-fg'
              }`}
              aria-label={`${label} ${b.label} of 5`}
            >
              {b.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function FatigueSorenessCard() {
  const entry = useRecoveryEntry();
  const setFatigue = async (val: number) => {
    await upsertRecoveryEntry({ fatigue: val });
  };
  const setSoreness = async (val: number) => {
    await upsertRecoveryEntry({ soreness: val });
  };
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-3">
      <header>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          How recovered?
        </h2>
        <p className="text-xs text-muted">
          Today&apos;s fatigue and soreness feed the stress score and bias the
          AI suggester. Tap to log.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border/60 bg-bg/40 p-3">
          <ReadinessScale
            label="Fatigue"
            hint="1 fresh · 5 wrecked"
            value={entry?.fatigue}
            onChange={(v) => void setFatigue(v)}
          />
        </div>
        <div className="rounded-md border border-border/60 bg-bg/40 p-3">
          <ReadinessScale
            label="Soreness"
            hint="1 none · 5 severe"
            value={entry?.soreness}
            onChange={(v) => void setSoreness(v)}
          />
        </div>
      </div>
    </section>
  );
}

export function BodyweightCard() {
  const entry = useRecoveryEntry();
  const [bwInput, setBwInput] = useState<string>('');
  const [savedMsg, setSavedMsg] = useState<string>('');
  const displayedBw = entry?.bodyweightKg;

  const onSubmitBw = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(bwInput.replace(',', '.'));
    if (!Number.isFinite(val) || val <= 0 || val > 500) return;
    await upsertRecoveryEntry({ bodyweightKg: val });
    setBwInput('');
    setSavedMsg('Saved');
    setTimeout(() => setSavedMsg(''), 1500);
  };

  const clearBw = async () => {
    await upsertRecoveryEntry({ bodyweightKg: undefined });
    setSavedMsg('Cleared');
    setTimeout(() => setSavedMsg(''), 1500);
  };

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-3">
      <header>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Bodyweight
        </h2>
        <p className="text-xs text-muted">
          Used for effective-load analytics on weighted bodyweight movements
          (pull-ups, dips, weighted vest work).
        </p>
      </header>
      <div className="rounded-md border border-border/60 bg-bg/40 p-3">
        <div className="flex items-baseline justify-between">
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Current
          </label>
          {displayedBw != null && (
            <span className="text-[10px] text-muted">{savedMsg}</span>
          )}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-fg">
            {displayedBw != null ? displayedBw.toFixed(1) : '—'}
          </span>
          <span className="text-sm text-muted">kg</span>
        </div>
        <form onSubmit={onSubmitBw} className="mt-2 flex flex-wrap gap-1.5">
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            min="30"
            max="300"
            value={bwInput}
            onChange={(e) => setBwInput(e.target.value)}
            placeholder={displayedBw != null ? 'Update…' : 'e.g. 80.5'}
            className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-sm tabular-nums text-fg focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!bwInput.trim()}
            className="rounded-md border border-accent/60 bg-accent/15 px-3 py-1 text-xs font-medium text-accent disabled:opacity-40"
          >
            Save
          </button>
          {displayedBw != null && (
            <button
              type="button"
              onClick={() => void clearBw()}
              className="rounded-md border border-border bg-bg px-3 py-1 text-xs text-muted hover:text-fg"
            >
              Clear
            </button>
          )}
        </form>
      </div>
    </section>
  );
}
