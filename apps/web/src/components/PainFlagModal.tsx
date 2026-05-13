'use client';

import { useState } from 'react';

const COMMON_AREAS = [
  'lower back',
  'shoulder',
  'elbow',
  'wrist',
  'hip',
  'knee',
  'ankle',
  'neck',
  'chest',
  'other',
];

export type Severity = 1 | 2 | 3 | 4 | 5;

export interface PainFlagValue {
  area: string;
  severity: Severity;
  note?: string;
}

interface Props {
  initial?: PainFlagValue;
  onSave: (value: PainFlagValue) => void;
  onCancel: () => void;
  onClear?: () => void;
}

export function PainFlagModal({ initial, onSave, onCancel, onClear }: Props) {
  const [area, setArea] = useState(initial?.area ?? 'lower back');
  const [customArea, setCustomArea] = useState('');
  const [severity, setSeverity] = useState<Severity>(initial?.severity ?? 2);
  const [note, setNote] = useState(initial?.note ?? '');

  const finalArea = area === 'other' ? customArea.trim() || 'other' : area;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Flag pain / injury</h3>
        <p className="mt-1 text-xs text-muted">
          We&apos;ll show a caution badge on this movement going forward.
        </p>

        <label className="mt-3 block">
          <span className="text-xs text-muted">Area</span>
          <select
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
          >
            {COMMON_AREAS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        {area === 'other' && (
          <input
            value={customArea}
            onChange={(e) => setCustomArea(e.target.value)}
            placeholder="Describe…"
            className="mt-2 w-full rounded-lg border border-border bg-bg px-3 py-2"
          />
        )}

        <div className="mt-3">
          <span className="text-xs text-muted">Severity</span>
          <div className="mt-1 grid grid-cols-5 gap-1">
            {[1, 2, 3, 4, 5].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSeverity(s as Severity)}
                className={`rounded-lg py-2 text-sm font-semibold ring-1 ${
                  severity === s
                    ? 'bg-amber-500 text-bg ring-amber-400'
                    : 'bg-bg text-fg ring-border'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">
            1 = niggle · 3 = limits performance · 5 = stop
          </p>
        </div>

        <label className="mt-3 block">
          <span className="text-xs text-muted">Note (optional)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
          />
        </label>

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => onSave({ area: finalArea, severity, note: note.trim() || undefined })}
            className="flex-1 rounded-lg bg-accent py-2 font-semibold text-bg"
          >
            Save flag
          </button>
          <button
            onClick={onCancel}
            className="rounded-lg bg-bg px-3 py-2 ring-1 ring-border"
          >
            Cancel
          </button>
          {initial && onClear && (
            <button
              onClick={onClear}
              className="rounded-lg bg-bg px-3 py-2 text-red-400 ring-1 ring-border"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
