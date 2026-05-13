'use client';

// WellnessSheet — modal sheet for capturing or editing an illness episode.
// Mirrors the visual shape of PainFlagModal so the UX feels consistent.

import { useState } from 'react';
import type { WellnessFlag, WellnessSeverity } from '@wendler/db-schema';
import { startIllness, updateIllness } from '@/lib/wellness';

interface Props {
  initial?: WellnessFlag; // when provided, edits an existing row
  onClose: () => void;
}

const SEVERITY_OPTIONS: Array<{
  value: WellnessSeverity;
  title: string;
  blurb: string;
}> = [
  { value: 'mild', title: 'Mild', blurb: 'head cold, sniffles, sore throat' },
  { value: 'moderate', title: 'Moderate', blurb: 'chest cold, body aches, low energy' },
  { value: 'severe', title: 'Severe', blurb: 'fever, flu, gut bug, can\'t train' },
];

const todayIso = (): string => new Date().toISOString().slice(0, 10);

export function WellnessSheet({ initial, onClose }: Props) {
  const [severity, setSeverity] = useState<WellnessSeverity>(
    initial?.severity ?? 'mild',
  );
  const [startedAt, setStartedAt] = useState<string>(
    initial?.startedAt ?? todayIso(),
  );
  const [notes, setNotes] = useState<string>(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    setSaving(true);
    try {
      if (initial) {
        await updateIllness(initial.id, {
          severity,
          startedAt,
          notes: notes.trim() || undefined,
        });
      } else {
        await startIllness({
          severity,
          startedAt,
          notes: notes.trim() || undefined,
        });
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">
          {initial ? 'Update illness' : '🤒 Feeling sick'}
        </h3>
        <p className="mt-1 text-xs text-muted">
          We&apos;ll pause the cycle expectations. When you&apos;re back, the app will
          recommend how to resume based on your training history.
        </p>

        <div className="mt-3">
          <span className="text-xs text-muted">Severity</span>
          <div className="mt-1 grid gap-1">
            {SEVERITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setSeverity(opt.value)}
                className={`rounded-lg px-3 py-2 text-left ring-1 ${
                  severity === opt.value
                    ? 'bg-amber-500/15 ring-amber-400'
                    : 'bg-bg ring-border'
                }`}
              >
                <div className="text-sm font-semibold">{opt.title}</div>
                <div className="text-xs text-muted">{opt.blurb}</div>
              </button>
            ))}
          </div>
        </div>

        <label className="mt-3 block">
          <span className="text-xs text-muted">Started</span>
          <input
            type="date"
            value={startedAt}
            max={todayIso()}
            onChange={(e) => setStartedAt(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
          />
        </label>

        <label className="mt-3 block">
          <span className="text-xs text-muted">Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Anything you&apos;d want to remember later"
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
          />
        </label>

        <div className="mt-4 flex gap-2">
          <button
            onClick={onSave}
            disabled={saving}
            className="flex-1 rounded-lg bg-accent py-2 font-semibold text-bg disabled:opacity-50"
          >
            {initial ? 'Save changes' : 'Mark sick'}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg bg-bg px-3 py-2 ring-1 ring-border"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
