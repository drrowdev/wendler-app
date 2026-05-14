'use client';

// AssistanceTrack — renders Wendler 5/3/1 assistance work (Push / Pull /
// Single-leg / Core / Accessory) attached to a session. Each entry shows its
// prescription and a list of logged sets, with a quick "+" form to add another
// set. All sets log against the host session with kind: 'assistance'.

import { useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ASSISTANCE_CATEGORIES,
  assistanceLabel,
  type AssistanceCategory,
  type AssistanceEntry,
} from '@wendler/domain';
import type { SetRecord } from '@wendler/db-schema';
import { getDb } from '@/lib/db';
import { fmtKg } from '@/lib/format';
import { SectionHeader } from './SessionParts';

const CATEGORY_LABEL: Record<AssistanceCategory, string> = Object.fromEntries(
  ASSISTANCE_CATEGORIES.map((c) => [c.id, c.label]),
) as Record<AssistanceCategory, string>;

interface AssistanceTrackProps {
  entries: AssistanceEntry[];
  sessionId: string | null;
  /** All sets currently logged against the host session. */
  loggedSets: SetRecord[] | undefined;
  /** Materialize the host session row in the DB before saving (mirrors SetCard.onBeforeSave). */
  onBeforeSave?: () => Promise<void>;
  /** Callback when a set is logged (e.g. to start the rest timer). */
  onLogged?: () => void;
  title?: string;
  /** When true, all logging controls are disabled (block is completed/locked). */
  locked?: boolean;
}

export function AssistanceTrack({
  entries,
  sessionId,
  loggedSets,
  onBeforeSave,
  onLogged,
  title = 'Assistance',
  locked = false,
}: AssistanceTrackProps) {
  if (entries.length === 0) return null;

  // Render entries in their saved order. Category labels appear as a
  // subtle sub-header only when the category changes between consecutive
  // entries — preserves the user's drag-ordered sequence while still
  // grouping visually when consecutive entries share a category.
  let lastCategory: AssistanceCategory | null = null;
  const rows: Array<{ kind: 'header'; label: string } | { kind: 'entry'; entry: AssistanceEntry }> = [];
  for (const e of entries) {
    if (e.category !== lastCategory) {
      rows.push({ kind: 'header', label: CATEGORY_LABEL[e.category] ?? e.category });
      lastCategory = e.category;
    }
    rows.push({ kind: 'entry', entry: e });
  }

  return (
    <section>
      <SectionHeader title={title} count={entries.length} />
      <div className="mt-2 space-y-2">
        {rows.map((r, i) =>
          r.kind === 'header' ? (
            <div
              key={`h-${i}`}
              className={`text-xs uppercase tracking-wide text-muted ${i === 0 ? '' : 'pt-2'}`}
            >
              {r.label}
            </div>
          ) : (
            <AssistanceEntryCard
              key={r.entry.id}
              entry={r.entry}
              sessionId={sessionId}
              loggedSets={loggedSets}
              onBeforeSave={onBeforeSave}
              onLogged={onLogged}
              locked={locked}
            />
          ),
        )}
      </div>
    </section>
  );
}

interface AssistanceEntryCardProps {
  entry: AssistanceEntry;
  sessionId: string | null;
  loggedSets: SetRecord[] | undefined;
  onBeforeSave?: () => Promise<void>;
  onLogged?: () => void;
  locked?: boolean;
}

function AssistanceEntryCard({
  entry,
  sessionId,
  loggedSets,
  onBeforeSave,
  onLogged,
  locked = false,
}: AssistanceEntryCardProps) {
  const myLogged = useMemo(
    () =>
      (loggedSets ?? [])
        .filter(
          (s) =>
            !s.deletedAt &&
            s.kind === 'assistance' &&
            entry.movementId !== undefined &&
            s.movementId === entry.movementId,
        )
        .sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1)),
    [loggedSets, entry.movementId],
  );

  const [expanded, setExpanded] = useState(false);
  const [weight, setWeight] = useState<string>('');
  const [reps, setReps] = useState<string>(String(entry.reps));
  const [saving, setSaving] = useState(false);
  const [weightError, setWeightError] = useState(false);

  // Look up the linked movement so we can adapt the weight UX:
  //  - bodyweight: blank = 0, label as "Added weight" (since you can add a vest/DB).
  //  - band: hide the weight field entirely. Band tension isn't a meaningful
  //    kg value (varies with stretch, anchor, band wear) so we don't ask.
  //    Sets are stored with weightKg=0 and shown as "Band" in the log.
  const movement = useLiveQuery(
    async () => (entry.movementId ? getDb().movements.get(entry.movementId) : undefined),
    [entry.movementId],
  );
  const isBodyweight = movement?.equipment === 'bodyweight';
  const isBand = movement?.equipment === 'band';
  const hideWeight = isBand;

  const targetSets = entry.sets;
  const doneCount = myLogged.length;
  const complete = doneCount >= targetSets;
  // When the entry is flagged AMRAP, every set being logged is treated as
  // AMRAP — the user picks which set(s) to take to failure.
  const amrapOnNext = !!entry.isAmrap;

  // Auto-collapse the moment the last prescribed set lands, mirroring the
  // main-lift behavior (see LiftTrack.finishLift). Only fires on the
  // false→true transition so the user can still re-open a finished entry to
  // add bonus sets or fix a mistake without the panel snapping shut again.
  const wasCompleteRef = useRef(complete);
  useEffect(() => {
    if (complete && !wasCompleteRef.current) {
      setExpanded(false);
    }
    wasCompleteRef.current = complete;
  }, [complete]);

  const onAddSet = async () => {
    if (locked) return;
    if (!sessionId || !entry.movementId) return;
    // Bands and bodyweight can be logged without a kg value: bodyweight blank
    // means "no added load", band always has no entered weight.
    // Other equipment requires an explicit weight — flag the input red rather
    // than silently no-op so the user understands why nothing happened.
    if (!hideWeight && !isBodyweight && weight.trim() === '') {
      setWeightError(true);
      return;
    }
    const w = hideWeight
      ? 0
      : weight.trim() === '' && isBodyweight
        ? 0
        : parseFloat(weight);
    const r = parseInt(reps, 10);
    if (!isFinite(r) || r <= 0) return;
    if (!isFinite(w) || w < 0) {
      if (!hideWeight && !isBodyweight) setWeightError(true);
      return;
    }
    setWeightError(false);
    setSaving(true);
    await onBeforeSave?.();
    const record: SetRecord = {
      id: nanoid(),
      sessionId,
      movementId: entry.movementId,
      performedAt: new Date().toISOString(),
      weightKg: w,
      reps: r,
      kind: 'assistance',
      ...(amrapOnNext ? { isAmrap: true } : {}),
    };
    await getDb().sets.put(record);
    setSaving(false);
    onLogged?.();
    // Keep weight (assistance is usually constant across sets); reset reps to default.
    setReps(String(entry.reps));
  };

  const removeSet = async (id: string) => {
    if (locked) return;
    await getDb().sets.update(id, { deletedAt: new Date().toISOString() });
  };

  const missingMovement = !entry.movementId;

  return (
    <li
      className={`rounded-xl border ${
        complete
          ? 'border-emerald-700/60 bg-emerald-900/10'
          : expanded
            ? 'border-accent/60 bg-card'
            : 'border-border bg-card'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            complete
              ? 'bg-emerald-600 text-white'
              : doneCount > 0
                ? 'bg-accent/30 text-accent'
                : 'bg-bg text-muted ring-1 ring-border'
          }`}
        >
          {complete ? '✓' : `${doneCount}/${targetSets}`}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate font-semibold">{entry.movementName}</span>
          <span className="shrink-0 text-xs text-muted">{prescriptionSuffix(entry)}</span>
          {entry.isAmrap && (
            <span
              className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-amber-500/40"
              title="AMRAP — take any set to max reps"
            >
              AMRAP
            </span>
          )}
          {entry.loadHint && (
            <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
              {entry.loadHint}
            </span>
          )}
        </span>
        <span className="text-xs text-muted" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/50 px-3 pb-3 pt-2">
          {entry.notes && <div className="mb-2 text-xs text-muted">{entry.notes}</div>}

          {missingMovement && (
            <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-xs text-amber-300">
              No movement linked. Edit this assistance entry in the block to pick a movement
              before logging.
            </div>
          )}

          {myLogged.length > 0 && (
            <ul className="mb-2 space-y-1">
              {myLogged.map((s, i) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded bg-bg px-2 py-1 text-xs ring-1 ring-border"
                >
                  <span className="text-muted">#{i + 1}</span>
                  <span className="font-mono">
                    {s.weightKg > 0
                      ? `${isBodyweight ? '+' : ''}${fmtKg(s.weightKg)}`
                      : isBand
                        ? 'Band'
                        : isBodyweight
                          ? 'BW'
                          : '—'}{' '}
                    × {s.reps}
                    {entry.unit === 'sec' ? ' sec' : ''}
                    {s.isAmrap && (
                      <span className="ml-1 text-[9px] font-semibold uppercase tracking-wide text-amber-300">
                        AMRAP
                      </span>
                    )}
                  </span>
                  {!locked && (
                    <button
                      onClick={() => removeSet(s.id)}
                      className="ml-auto text-muted hover:text-fg"
                      aria-label="Remove set"
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!missingMovement && !locked && (
            <div
              className={`grid gap-2 ${
                hideWeight ? 'grid-cols-[1fr_auto]' : 'grid-cols-[1fr_1fr_auto]'
              }`}
            >
              {!hideWeight && (
                <div>
                  <span className="block text-xs text-muted">
                    {isBodyweight ? 'Added weight (kg)' : 'Weight (kg)'}
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={2.5}
                    value={weight}
                    onChange={(e) => {
                      setWeight(e.target.value);
                      if (weightError) setWeightError(false);
                    }}
                    placeholder={isBodyweight ? '+0' : '0'}
                    className={`mt-1 w-full rounded-lg border bg-bg px-2 py-2 text-center text-lg ${
                      weightError
                        ? 'border-red-500 ring-1 ring-red-500/60'
                        : 'border-border'
                    }`}
                  />
                </div>
              )}
              <div>
                <span className="block text-xs text-muted">
                  {entry.unit === 'sec' ? 'Seconds' : 'Reps'}
                  {amrapOnNext && (
                    <span
                      className="ml-1 rounded bg-amber-500/20 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300"
                      title="AMRAP — go for max reps on any set"
                    >
                      AMRAP
                    </span>
                  )}
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={reps}
                  onChange={(e) => setReps(e.target.value)}
                  className={`mt-1 w-full rounded-lg border bg-bg px-2 py-2 text-center text-lg ${
                    amrapOnNext ? 'border-amber-500/60 ring-1 ring-amber-500/30' : 'border-border'
                  }`}
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={onAddSet}
                  disabled={saving || !sessionId}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50"
                >
                  + Set
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function prescriptionSuffix(entry: AssistanceEntry): string {
  const label = assistanceLabel(entry);
  // assistanceLabel includes the movement name at the end; strip it for the suffix.
  const idx = label.lastIndexOf(' ' + entry.movementName);
  return idx > 0 ? label.slice(0, idx) : label;
}
