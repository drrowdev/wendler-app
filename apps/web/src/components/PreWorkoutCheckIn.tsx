'use client';

// Pre-workout readiness check — a single-screen 2-question modal that
// surfaces on the FIRST /day open of the day when today's RecoveryEntry
// has neither fatigue nor soreness set yet.
//
// Design (v361):
//   - Two questions only: "How recovered?" and "Any soreness?". Both
//     stored on a 0-10 Borg-style scale (matches the Coach / Programmer /
//     chat agents, which talk about fatigue and soreness in /10 terms).
//   - The picker is 5 quick-tap buckets mapped to (1, 3, 5, 7, 9) on the
//     1-10 schema — same speed as the old 1-5 pad but the button labels
//     are the actual stored values so what you see ("Fatigue 7/10") is
//     what the AI agents read.
//   - Skippable. Skipping sets a localStorage flag so it doesn't nag twice
//     the same day.
//   - Bodyweight is NOT asked here (one extra tap = won't get filled long-term).
//   - Per design: sleep + HRV intentionally omitted until Garmin/Apple
//     Health auto-import lands; subjective sleep without objective HRV
//     adds friction for low signal.

import { useEffect, useState } from 'react';
import { useRecoveryEntry } from '@/lib/hooks';
import { upsertRecoveryEntry, ymdLocal } from '@/lib/recovery';

const SKIP_KEY_PREFIX = 'wendler:preworkout-check-skipped:v1';

export function PreWorkoutCheckIn() {
  const today = ymdLocal();
  const entry = useRecoveryEntry(today);
  const [open, setOpen] = useState(false);
  const [fatigue, setFatigue] = useState<number | null>(null);
  const [soreness, setSoreness] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (entry === undefined) return; // still loading
    // Already answered today → never re-open.
    if (entry?.fatigue != null && entry?.soreness != null) {
      setOpen(false);
      return;
    }
    // Skipped earlier today → don't re-prompt.
    const skipped = localStorage.getItem(`${SKIP_KEY_PREFIX}:${today}`) === '1';
    if (skipped) {
      setOpen(false);
      return;
    }
    // Pre-fill any partial answer the user already gave.
    if (entry?.fatigue != null) setFatigue(entry.fatigue);
    if (entry?.soreness != null) setSoreness(entry.soreness);
    setOpen(true);
  }, [entry, today]);

  if (!open) return null;

  const canSave = fatigue != null && soreness != null;

  const handleSave = async () => {
    if (!canSave) return;
    await upsertRecoveryEntry({ fatigue, soreness }, today);
    setOpen(false);
  };

  const handleSkip = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(`${SKIP_KEY_PREFIX}:${today}`, '1');
    }
    setOpen(false);
  };

  return (
    <div
      role="dialog"
      aria-labelledby="pwc-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center"
      onClick={handleSkip}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl"
      >
        <header className="mb-3">
          <h2 id="pwc-title" className="text-base font-semibold text-fg">
            Quick check before today&apos;s session
          </h2>
          <p className="text-xs text-muted">
            Feeds the stress score. Two taps, three seconds.
          </p>
        </header>

        <div className="space-y-4">
          <ScaleQuestion
            label="How recovered?"
            hint="1 fresh · 9 wrecked"
            value={fatigue}
            onChange={(val) => setFatigue(val)}
          />
          <ScaleQuestion
            label="Any soreness affecting today?"
            hint="1 none · 9 severe"
            value={soreness}
            onChange={(val) => setSoreness(val)}
          />
        </div>

        <footer className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleSkip}
            className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-fg"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-40"
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

function ScaleQuestion({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  onChange: (val: number) => void;
}) {
  // 5 buttons mapped to (1, 3, 5, 7, 9) on the 0-10 schema. Labels match
  // the stored value so what the user sees here lines up with what the AI
  // agents and the Readiness card read.
  const values = [1, 3, 5, 7, 9];
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-fg">{label}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted">{hint}</span>
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1.5">
        {values.map((v) => {
          const active = value === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onChange(v)}
              className={`rounded-md px-2 py-2.5 text-base font-medium tabular-nums ring-1 transition-colors ${
                active
                  ? 'bg-accent text-bg ring-accent'
                  : 'bg-bg text-muted ring-border hover:text-fg'
              }`}
              aria-label={`${label} ${v} of 10`}
            >
              {v}
            </button>
          );
        })}
      </div>
    </div>
  );
}
