'use client';

// LiftFocusView — V2 "one-set-at-a-time focus mode" for a lift session.
// Replaces the scrollable SetCard list. Shows a dot strip across all sets
// (warm-up + working + supplemental), the current set front-and-center
// with target/plates/weight/reps/RPE, an inline rest banner that auto-shows
// after each logged set, and a small next-set preview at the bottom.

import { useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import {
  calculatePlates,
  detectPrs,
  epley1RM,
  resolveBarWeightKg,
  type EquipmentType,
  type PrescribedSet,
} from '@wendler/domain';
import type { SetRecord } from '@wendler/db-schema';
import { fmtKg } from '@/lib/format';
import { getDb } from '@/lib/db';
import type { useSettings } from '@/lib/hooks';
import { PlateView } from './PlateView';
import { RpeZonePicker } from './RpeZonePicker';
import { SkipMenu } from './SkipMenu';
import { findExisting } from './SessionParts';

interface Props {
  /** All prescribed sets for this lift, in display order. */
  prescribed: PrescribedSet[];
  settings: NonNullable<ReturnType<typeof useSettings>>;
  sessionId: string | null;
  movementId: string;
  tmAtTime: number;
  history: SetRecord[];
  loggedSets: SetRecord[] | undefined;
  /** Materialize the host session row before saving the first set. */
  onBeforeSave?: () => Promise<void>;
  /** Called after a set is logged (used to auto-start the rest timer). */
  onSetLogged?: (kind: PrescribedSet['kind']) => void;
  /** Equipment type of the underlying movement; selects the correct bar weight. */
  equipment?: EquipmentType;
  /** Initial focus index — overrides the auto "first pending" cursor when set. */
  initialIndex?: number | null;
  /** When true, all logging controls are disabled (block is completed/locked). */
  locked?: boolean;
}

const KIND_LABEL: Record<PrescribedSet['kind'], string> = {
  warmup: 'Warm-up',
  main: 'Working',
  amrap: 'Working',
  supplemental: 'Supplemental',
  assistance: 'Assistance',
};

const REST_SECONDS_DEFAULT: Record<PrescribedSet['kind'], number> = {
  warmup: 60,
  main: 180,
  amrap: 240,
  supplemental: 120,
  assistance: 90,
};

interface BucketInfo {
  /** 1-based position within its kind bucket (e.g. "Working set 2 of 3"). */
  bucketIndex: number;
  bucketTotal: number;
  bucketLabel: string;
}

function bucketInfoFor(prescribed: PrescribedSet[], i: number): BucketInfo {
  const set = prescribed[i]!;
  const sameKindKey = (k: PrescribedSet['kind']) =>
    k === 'main' || k === 'amrap' ? 'working' : k;
  const bucketKey = sameKindKey(set.kind);
  let bucketIndex = 0;
  let bucketTotal = 0;
  prescribed.forEach((s, idx) => {
    if (sameKindKey(s.kind) !== bucketKey) return;
    bucketTotal++;
    if (idx <= i) bucketIndex++;
  });
  return {
    bucketIndex,
    bucketTotal,
    bucketLabel: bucketKey === 'working' ? 'Working' : KIND_LABEL[set.kind],
  };
}

export function LiftFocusView({
  prescribed,
  settings,
  sessionId,
  movementId,
  tmAtTime,
  history,
  loggedSets,
  onBeforeSave,
  onSetLogged,
  initialIndex,
  equipment,
  locked = false,
}: Props) {
  // Per-set state for the visible set (weight/reps/rpe). Reset whenever the
  // visible index changes so we don't carry stale draft values across sets.
  const findExistingFor = (i: number) => findExisting(loggedSets, prescribed, i);

  // The "auto" cursor: first un-logged set. The user can manually navigate
  // away with prev/next, in which case we honour their choice until the next
  // set is logged.
  const firstPendingIndex = useMemo(() => {
    for (let i = 0; i < prescribed.length; i++) {
      if (!findExisting(loggedSets, prescribed, i)) return i;
    }
    return Math.max(0, prescribed.length - 1);
  }, [prescribed, loggedSets]);

  const [manualIndex, setManualIndex] = useState<number | null>(initialIndex ?? null);
  const visibleIndex = manualIndex ?? firstPendingIndex;
  const set = prescribed[visibleIndex];

  // Inline rest timer state — shown as a banner above the set card.
  interface RestState {
    seconds: number;
    targetMs: number;
    label: string;
  }
  const [rest, setRest] = useState<RestState | null>(null);
  const [restRemaining, setRestRemaining] = useState(0);
  useEffect(() => {
    if (!rest) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((rest.targetMs - Date.now()) / 1000));
      setRestRemaining(left);
      if (left === 0) {
        try { navigator.vibrate?.([300, 120, 300]); } catch { /* noop */ }
      }
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [rest]);

  // Highlight just-logged set briefly with PR badges (post-log confirmation).
  const [justLogged, setJustLogged] = useState<{ index: number; prs: string[]; e1rm: number } | null>(null);

  // Drafts for the visible set.
  const existing = findExistingFor(visibleIndex);
  const [reps, setReps] = useState<string>('');
  const [weight, setWeight] = useState<string>('');
  const [rpe, setRpe] = useState<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [showSkip, setShowSkip] = useState(false);

  // Reset drafts whenever the visible set changes (or its existing record
  // changes from outside, e.g. after logging).
  const lastKeyRef = useRef<string>('');
  useEffect(() => {
    if (!set) return;
    const key = `${visibleIndex}:${set.kind}:${set.weightKg}:${set.reps}:${existing?.id ?? '-'}`;
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    setReps(existing ? String(existing.reps) : String(set.reps));
    setWeight(existing ? String(existing.weightKg) : String(set.weightKg));
    setRpe(existing?.rpe);
    setShowSkip(false);
  }, [visibleIndex, set, existing]);

  if (!set) {
    return (
      <div className="rounded-2xl border border-emerald-700/60 bg-emerald-900/10 p-6 text-center">
        <div className="text-2xl font-bold">All sets done 💪</div>
        <p className="mt-1 text-sm text-muted">
          {prescribed.length} set{prescribed.length === 1 ? '' : 's'} logged.
        </p>
      </div>
    );
  }

  const totalSets = prescribed.length;
  const doneSets = prescribed.reduce(
    (n, _s, i) => (findExisting(loggedSets, prescribed, i) ? n + 1 : n),
    0,
  );
  const bucket = bucketInfoFor(prescribed, visibleIndex);
  const plates = calculatePlates(
    set.weightKg,
    {
      barWeightKg: resolveBarWeightKg(equipment, settings),
      pairsByWeight: settings.pairsByWeight,
    },
    { preferredMaxPlateKg: settings.preferredMaxPlateKg },
  );
  const isWarmup = set.kind === 'warmup';
  const done = !!existing && !existing.skipped;
  const skipped = !!existing?.skipped;

  const adjustWeight = (delta: number) => {
    const w = parseFloat(weight);
    if (!isFinite(w)) return;
    setWeight(String(Math.max(0, +(w + delta).toFixed(3))));
  };
  const adjustReps = (delta: number) => {
    const r = parseInt(reps || '0', 10);
    setReps(String(Math.max(0, r + delta)));
  };

  const startRest = (kind: PrescribedSet['kind']) => {
    if (!settings.autoStartRestTimer) return;
    const seconds = settings.restSecondsByKind?.[kind] ?? REST_SECONDS_DEFAULT[kind] ?? 90;
    setRest({
      seconds,
      targetMs: Date.now() + seconds * 1000,
      label: `Rest · ${KIND_LABEL[kind]}`,
    });
    setRestRemaining(seconds);
  };

  const onSave = async () => {
    if (locked) return;
    if (!sessionId || !movementId) return;
    const w = parseFloat(weight);
    const r = parseInt(reps, 10);
    if (!isFinite(w) || !isFinite(r) || w <= 0 || r <= 0) return;
    setSaving(true);
    await onBeforeSave?.();
    const record: SetRecord = {
      id: existing?.id ?? nanoid(),
      sessionId,
      movementId,
      performedAt: new Date().toISOString(),
      weightKg: w,
      reps: r,
      rpe: isWarmup ? undefined : rpe,
      kind: set.kind,
      isAmrap: set.isAmrap,
      percentOfTm: set.percentOfTm,
      trainingMaxKgAtTime: tmAtTime,
      slotIndex: visibleIndex,
      ...(existing && { amendsSetId: existing.amendsSetId ?? existing.id }),
    };
    await getDb().sets.put(record);
    // Proactive AI: AMRAP smash detection (see SessionParts).
    void import('@/lib/amrap-trigger').then(({ maybeTriggerAmrapBump }) => {
      void maybeTriggerAmrapBump(record);
    });

    // Compute PR badges for confirmation (warm-ups never count as PRs).
    const prs = !isWarmup
      ? detectPrs(
          { weightKg: w, reps: r },
          { sets: history.filter((s) => !s.deletedAt && s.id !== existing?.id) },
        ).map((p) => (p.kind === 'reps-at-weight' ? 'rep PR' : `${p.kind} PR`))
      : [];
    const e1rm = !isWarmup && set.isAmrap ? epley1RM(w, r) : 0;
    setJustLogged({ index: visibleIndex, prs, e1rm });

    setSaving(false);
    onSetLogged?.(set.kind);
    startRest(set.kind);
    // Hold on the just-logged set briefly so the user sees the green confirm
    // and any PR badges, then auto-advance to the next pending set.
    window.setTimeout(() => {
      setManualIndex(null);
    }, 1200);
    window.setTimeout(() => setJustLogged(null), 4500);
  };

  const onSkip = async (reason: 'pain' | 'fatigue' | 'time' | 'equipment' | 'other') => {
    if (locked) return;
    if (!sessionId || !movementId) return;
    await onBeforeSave?.();
    const record: SetRecord = {
      id: existing?.id ?? nanoid(),
      sessionId,
      movementId,
      performedAt: new Date().toISOString(),
      weightKg: 0,
      reps: 0,
      kind: set.kind,
      isAmrap: set.isAmrap,
      percentOfTm: set.percentOfTm,
      trainingMaxKgAtTime: tmAtTime,
      skipped: true,
      skipReason: reason,
      slotIndex: visibleIndex,
      ...(existing && { amendsSetId: existing.amendsSetId ?? existing.id }),
    };
    await getDb().sets.put(record);
    setShowSkip(false);
    setManualIndex(null);
  };

  const restMm = Math.floor(restRemaining / 60);
  const restSs = String(restRemaining % 60).padStart(2, '0');
  const restPct = rest
    ? Math.min(100, Math.max(0, Math.round(((rest.seconds - restRemaining) / Math.max(1, rest.seconds)) * 100)))
    : 0;

  const next = prescribed[visibleIndex + 1];
  const showJustLogged = justLogged && justLogged.index === visibleIndex;

  return (
    <div className="space-y-3">
      {/* Inline rest banner (auto-shows after a set is logged). */}
      {rest && (
        <div
          className={`rounded-2xl border p-3 ${
            restRemaining === 0
              ? 'border-emerald-500/60 bg-emerald-500/15'
              : 'border-violet-500/50 bg-violet-500/10'
          }`}
          role="timer"
          aria-live="polite"
        >
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="flex items-baseline justify-between">
                <span className="text-xs uppercase tracking-wide text-muted">{rest.label}</span>
                <span
                  className={`font-mono text-2xl font-semibold tabular-nums ${
                    restRemaining === 0 ? 'text-emerald-300' : 'text-violet-200'
                  }`}
                >
                  {restMm}:{restSs}
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded bg-bg">
                <div
                  className={`h-full transition-all ${
                    restRemaining === 0 ? 'bg-emerald-500' : 'bg-violet-400'
                  }`}
                  style={{ width: `${restPct}%` }}
                />
              </div>
            </div>
            <button
              onClick={() => setRest(null)}
              className="rounded-lg bg-card px-3 py-2 text-xs font-medium ring-1 ring-border"
            >
              Done resting
            </button>
          </div>
        </div>
      )}

      {/* Dot strip + "Set N of M" — outer button gives a generous tap target,
          inner pill keeps the compact visual. */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center" role="presentation">
          {prescribed.map((s, i) => {
            const ex = findExisting(loggedSets, prescribed, i);
            const isCurrent = i === visibleIndex;
            const isDone = ex && !ex.skipped;
            const isSkipped = ex?.skipped;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setManualIndex(i === firstPendingIndex ? null : i)}
                aria-label={`Go to set ${i + 1}`}
                aria-current={isCurrent ? 'step' : undefined}
                className="group flex h-9 items-center justify-center px-1.5"
              >
                <span
                  className={`block h-2.5 rounded-full transition-all ${
                    isCurrent
                      ? 'w-7 bg-violet-400'
                      : isDone
                        ? 'w-3 bg-emerald-500 group-hover:bg-emerald-400'
                        : isSkipped
                          ? 'w-3 bg-amber-500 group-hover:bg-amber-400'
                          : 'w-3 bg-border group-hover:bg-muted'
                  }`}
                />
              </button>
            );
          })}
        </div>
        <div className="text-xs text-muted">
          Set {visibleIndex + 1} of {totalSets}
          {doneSets > 0 && ` · ${doneSets} done`}
        </div>
      </div>

      {/* Main focus card */}
      <div
        className={`rounded-2xl border bg-card p-4 ${
          done
            ? 'border-emerald-700/60'
            : skipped
              ? 'border-amber-500/60'
              : 'border-border'
        }`}
      >
        <div className="text-center">
          <div className="text-xs uppercase tracking-wide text-muted">
            {bucket.bucketLabel} set {bucket.bucketIndex} of {bucket.bucketTotal}
            {set.percentOfTm && (
              <span className="ml-2 rounded bg-bg px-1.5 py-0.5 font-mono text-[11px] text-fg ring-1 ring-border">
                {(set.percentOfTm * 100).toFixed(0)}%
              </span>
            )}
          </div>

          <div className="mt-3">
            <div className="text-xs text-muted">Target</div>
            <div className="font-mono text-5xl font-bold tabular-nums">
              {fmtKg(set.weightKg)}
            </div>
            <div className="mt-1 text-base text-fg">
              × {set.repsLabelOverride ?? set.reps}
              {!set.repsLabelOverride && (
                <> {set.reps === 1 ? 'rep' : 'reps'}</>
              )}
              {set.isAmrap && <span className="text-accent">+</span>}
            </div>
            <div className="mt-2 flex justify-center">
              <PlateView breakdown={plates} />
            </div>
          </div>
        </div>

        {/* Skipped state */}
        {skipped && (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-center text-sm text-amber-300">
            Skipped ({existing?.skipReason ?? 'no reason'})
          </div>
        )}

        {!skipped && (
          <>
            {/* Weight + Reps controls */}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <div>
                <span className="block text-xs text-muted">Weight (kg)</span>
                <div className="mt-1 flex items-stretch overflow-hidden rounded-lg border border-border bg-bg">
                  <button
                    onClick={() => adjustWeight(-2.5)}
                    disabled={locked}
                    className="px-3 text-xl font-semibold text-muted active:bg-card disabled:opacity-40"
                    aria-label="Decrease weight"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={2.5}
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    readOnly={locked}
                    disabled={locked}
                    className="w-full bg-transparent px-2 py-2 text-center text-lg disabled:opacity-50"
                  />
                  <button
                    onClick={() => adjustWeight(2.5)}
                    disabled={locked}
                    className="px-3 text-xl font-semibold text-muted active:bg-card disabled:opacity-40"
                    aria-label="Increase weight"
                  >
                    +
                  </button>
                </div>
              </div>
              <div>
                <span className="block text-xs text-muted">Reps</span>
                <div className="mt-1 flex items-stretch overflow-hidden rounded-lg border border-border bg-bg">
                  <button
                    onClick={() => adjustReps(-1)}
                    disabled={locked}
                    className="px-3 text-xl font-semibold text-muted active:bg-card disabled:opacity-40"
                    aria-label="Decrease reps"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={reps}
                    onChange={(e) => setReps(e.target.value)}
                    readOnly={locked}
                    disabled={locked}
                    className="w-full bg-transparent px-2 py-2 text-center text-lg disabled:opacity-50"
                  />
                  <button
                    onClick={() => adjustReps(1)}
                    disabled={locked}
                    className="px-3 text-xl font-semibold text-muted active:bg-card disabled:opacity-40"
                    aria-label="Increase reps"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* RPE — hidden for warmups */}
            {!isWarmup && (
              <div className="mt-4">
                <RpeZonePicker value={rpe} onChange={setRpe} disabled={locked} />
              </div>
            )}

            {/* Post-log confirmation: PR badges + e1RM */}
            {showJustLogged && (justLogged!.prs.length > 0 || justLogged!.e1rm > 0) && (
              <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
                {justLogged!.prs.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {justLogged!.prs.map((label) => (
                      <span
                        key={label}
                        className="rounded bg-amber-500/30 px-2 py-0.5 text-xs font-semibold text-amber-200"
                      >
                        ⭐ {label}
                      </span>
                    ))}
                  </div>
                )}
                {justLogged!.e1rm > 0 && (
                  <div className="mt-1 text-xs text-muted">
                    e1RM: <span className="font-mono text-fg">{justLogged!.e1rm.toFixed(1)} kg</span>
                  </div>
                )}
              </div>
            )}

            {/* Log set CTA — hidden when locked (block is completed). */}
            {!locked && (
              <button
                onClick={onSave}
                disabled={saving}
                className={`mt-4 w-full rounded-lg py-4 text-base font-semibold ${
                  done ? 'bg-emerald-600 text-white' : 'bg-accent text-bg'
                } disabled:opacity-60`}
              >
                {done ? 'Update set' : 'Log set'}
              </button>
            )}
          </>
        )}
      </div>

      {/* Skip + Next preview footer (visually separated from Log set CTA). */}
      <div className="flex items-end justify-between gap-3">
        {!skipped && !locked ? (
          <button
            onClick={() => setShowSkip(true)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted hover:text-fg"
          >
            Skip set
          </button>
        ) : (
          <span />
        )}

        {next ? (
          <div className="text-right text-xs text-muted">
            <div>Next</div>
            <div className="text-fg">
              {bucketInfoFor(prescribed, visibleIndex + 1).bucketLabel}{' '}
              {bucketInfoFor(prescribed, visibleIndex + 1).bucketIndex} ·{' '}
              <span className="font-mono">{fmtKg(next.weightKg)}</span> × {next.reps}
              {next.isAmrap && <span className="text-accent">+</span>}
            </div>
          </div>
        ) : (
          <span className="text-xs text-muted">Last set</span>
        )}
      </div>

      {showSkip && <SkipMenu onSkip={onSkip} onCancel={() => setShowSkip(false)} />}
    </div>
  );
}
