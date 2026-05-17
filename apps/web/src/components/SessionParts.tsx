'use client';

// Reusable session-rendering parts extracted from app/session/page.tsx.
// Used by both the standard /session view and the multi-lift /day view.

import { useEffect, useRef, useState } from 'react';
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
import { RpeButtons } from './RpeButtons';
import { SkipMenu } from './SkipMenu';

export function SectionHeader({ title, count }: { title: string; count: number }) {
  if (count === 0) return null;
  return (
    <h2 className="mt-4 text-sm font-semibold uppercase tracking-wide text-muted">
      {title}{' '}
      <span className="ml-1 rounded bg-card px-1.5 py-0.5 text-xs text-fg ring-1 ring-border">
        {count}
      </span>
    </h2>
  );
}

/**
 * Resolve which logged SetRecord (if any) belongs to a given prescribed slot.
 *
 * The historical signature took (loggedSets, set) and matched by (kind,
 * weightKg). That breaks for templates with multiple identical prescribed
 * slots (e.g. supplemental 5×5 FSL — same kind, same weight, 5 slots) where
 * a single SetRecord would appear to satisfy all of them.
 *
 * The new signature takes the full prescribed list + slot index. It first
 * looks for a record whose stored `slotIndex` matches; for legacy records
 * without a slotIndex it falls back to ordered occurrence matching among
 * (kind, weight)-equivalent slots. The two-arg legacy form is still
 * supported but should be considered deprecated.
 */
export function findExisting(
  loggedSets: SetRecord[] | undefined,
  prescribed: PrescribedSet[],
  index: number,
): SetRecord | undefined;
export function findExisting(
  loggedSets: SetRecord[] | undefined,
  set: PrescribedSet,
): SetRecord | undefined;
export function findExisting(
  loggedSets: SetRecord[] | undefined,
  arg2: PrescribedSet | PrescribedSet[],
  index?: number,
): SetRecord | undefined {
  if (!loggedSets) return undefined;

  // Legacy two-arg form: kind + weight only.
  if (!Array.isArray(arg2)) {
    const set = arg2;
    return loggedSets.find(
      (s) =>
        !s.deletedAt &&
        Math.round(s.weightKg * 100) === Math.round(set.weightKg * 100) &&
        s.kind === set.kind,
    );
  }

  const prescribed = arg2;
  const i = index!;
  const target = prescribed[i];
  if (!target) return undefined;

  // 1) Direct slot-index hit. New rows always carry slotIndex.
  const direct = loggedSets.find((s) => !s.deletedAt && s.slotIndex === i);
  if (direct) return direct;

  // 2) Legacy fallback: among records lacking slotIndex with the same (kind,
  //    weight), assign to prescribed slots in performedAt order. Skip slots
  //    that already have a direct slotIndex match (they consume their own
  //    record, not a legacy one).
  const sameKW = (s: SetRecord) =>
    !s.deletedAt &&
    s.slotIndex == null &&
    s.kind === target.kind &&
    Math.round(s.weightKg * 100) === Math.round(target.weightKg * 100);
  const candidates = loggedSets
    .filter(sameKW)
    .sort((a, b) => a.performedAt.localeCompare(b.performedAt));
  if (!candidates.length) return undefined;
  let consumed = 0;
  for (let j = 0; j < i; j++) {
    const p = prescribed[j];
    if (!p) continue;
    if (
      p.kind !== target.kind ||
      Math.round(p.weightKg * 100) !== Math.round(target.weightKg * 100)
    ) continue;
    const claimedDirectly = loggedSets.some((s) => !s.deletedAt && s.slotIndex === j);
    if (claimedDirectly) continue;
    consumed++;
  }
  return candidates[consumed];
}

export function nextSetKey(
  sets: PrescribedSet[],
  logged: SetRecord[] | undefined,
): string | null {
  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    if (!set) continue;
    const existing = findExisting(logged ?? [], set);
    if (!existing) return setKey(set, i);
  }
  return null;
}

export function setKey(set: PrescribedSet, index: number): string {
  return `${set.kind}-${index}-${set.weightKg}-${set.reps}`;
}

interface SetCardProps {
  index: number;
  set: PrescribedSet;
  settings: NonNullable<ReturnType<typeof useSettings>>;
  sessionId: string | null;
  movementId: string;
  tmAtTime: number;
  history: SetRecord[];
  existing: SetRecord | undefined;
  big?: boolean;
  defaultExpanded?: boolean;
  /** Equipment type of the underlying movement; selects the correct bar weight. */
  equipment?: EquipmentType;
  onLogged?: () => void;
  onSkipped?: () => void;
  onBeforeSave?: () => Promise<void>;
}

export function SetCard({
  index,
  set,
  settings,
  sessionId,
  movementId,
  tmAtTime,
  history,
  existing,
  big,
  defaultExpanded,
  equipment,
  onLogged,
  onSkipped,
  onBeforeSave,
}: SetCardProps) {
  const plates = calculatePlates(
    set.weightKg,
    {
      barWeightKg: resolveBarWeightKg(equipment, settings),
      pairsByWeight: settings.pairsByWeight,
    },
    { preferredMaxPlateKg: settings.preferredMaxPlateKg },
  );
  const [reps, setReps] = useState<string>(existing ? String(existing.reps) : String(set.reps));
  const [weight, setWeight] = useState<string>(
    existing ? String(existing.weightKg) : String(set.weightKg),
  );
  const [rpe, setRpe] = useState<number | undefined>(existing?.rpe);
  const [saving, setSaving] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [weightError, setWeightError] = useState(false);
  const done = !!existing && !existing.skipped;
  const skipped = !!existing?.skipped;
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded ?? false);
  const prevDefaultRef = useRef(defaultExpanded);
  useEffect(() => {
    if (prevDefaultRef.current !== defaultExpanded) {
      prevDefaultRef.current = defaultExpanded;
      setExpanded(defaultExpanded ?? false);
    }
  }, [defaultExpanded]);

  const onSave = async () => {
    if (!sessionId || !movementId) return;
    setSaving(true);
    const w = parseFloat(weight);
    const r = parseInt(reps, 10);
    if (!isFinite(w) || w <= 0) {
      setWeightError(true);
      setSaving(false);
      return;
    }
    if (!isFinite(r) || r <= 0) {
      setSaving(false);
      return;
    }
    setWeightError(false);
    await onBeforeSave?.();
    const record: SetRecord = {
      id: existing?.id ?? nanoid(),
      sessionId,
      movementId,
      performedAt: new Date().toISOString(),
      weightKg: w,
      reps: r,
      rpe,
      kind: set.kind,
      isAmrap: set.isAmrap,
      percentOfTm: set.percentOfTm,
      trainingMaxKgAtTime: tmAtTime,
      ...(existing && { amendsSetId: existing.amendsSetId ?? existing.id }),
    };
    await getDb().sets.put(record);
    // Proactive AI: if this is a main-lift AMRAP that smashed the
    // week's target by 5+ reps, fire a Coach chat with a TM-bump
    // proposal. Fire-and-forget; failures are logged.
    void import('@/lib/amrap-trigger').then(({ maybeTriggerAmrapBump }) => {
      void maybeTriggerAmrapBump(record);
    });
    setSaving(false);
    onLogged?.();
  };

  const onSkip = async (reason: 'pain' | 'fatigue' | 'time' | 'equipment' | 'other') => {
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
      ...(existing && { amendsSetId: existing.amendsSetId ?? existing.id }),
    };
    await getDb().sets.put(record);
    setShowSkip(false);
    onSkipped?.();
  };

  const adjust = (delta: number) => {
    const w = parseFloat(weight);
    if (!isFinite(w)) return;
    setWeight(String(Math.max(0, w + delta)));
  };

  const previewPrs =
    isFinite(parseFloat(weight)) && isFinite(parseInt(reps, 10))
      ? detectPrs(
          { weightKg: parseFloat(weight), reps: parseInt(reps, 10) },
          { sets: history.filter((s) => !s.deletedAt && s.id !== existing?.id) },
        )
      : [];

  const newE1rm =
    set.isAmrap && isFinite(parseFloat(weight)) && isFinite(parseInt(reps, 10))
      ? epley1RM(parseFloat(weight), parseInt(reps, 10))
      : 0;

  const kindLabel: Record<PrescribedSet['kind'], string> = {
    warmup: 'Warm-up',
    main: 'Working',
    amrap: 'AMRAP',
    supplemental: 'Supplemental',
    assistance: 'Assistance',
  };

  return (
    <li
      className={`rounded-xl border ${
        skipped
          ? 'border-amber-500/60 bg-amber-500/5'
          : done
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
            done
              ? 'bg-emerald-600 text-white'
              : skipped
                ? 'bg-amber-500/30 text-amber-200'
                : 'bg-bg text-muted ring-1 ring-border'
          }`}
        >
          {done ? '✓' : skipped ? '–' : index + 1}
        </span>
        <span className="hidden w-16 text-xs uppercase tracking-wide text-muted sm:inline">
          {set.percentOfTm ? `${(set.percentOfTm * 100).toFixed(0)}%` : kindLabel[set.kind]}
        </span>
        <span className="flex-1 truncate text-sm">
          <span className="font-semibold">{fmtKg(set.weightKg)}</span>
          <span className="text-muted"> × </span>
          <span className="font-semibold">{set.reps}</span>
          {set.isAmrap && <span className="text-accent">+</span>}
          {done && existing && (existing.weightKg !== set.weightKg || existing.reps !== set.reps) && (
            <span className="ml-2 text-xs text-emerald-300">
              · logged {fmtKg(existing.weightKg)}×{existing.reps}
            </span>
          )}
          {skipped && <span className="ml-2 text-xs text-amber-300">· skipped</span>}
        </span>
        <span className="text-xs text-muted" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/50 px-3 pb-3 pt-2">
          <div className="mb-2 flex items-baseline justify-between">
            <div>
              <span className="text-xs uppercase tracking-wide text-muted">
                Set {index + 1} · {kindLabel[set.kind]}
                {set.percentOfTm && ` · ${(set.percentOfTm * 100).toFixed(0)}%`}
              </span>
              <div className="mt-1">
                <PlateView breakdown={plates} />
              </div>
            </div>
            {!skipped && (
              <button
                onClick={() => setShowSkip(true)}
                className="text-xs text-muted underline"
                aria-label="Skip this set"
              >
                Skip
              </button>
            )}
          </div>

          {skipped && (
            <div className="text-xs text-amber-300">
              Skipped ({existing?.skipReason ?? 'no reason'})
            </div>
          )}

          {!skipped && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="block text-xs text-muted">Weight (kg)</span>
                  <div
                    className={`mt-1 flex items-stretch overflow-hidden rounded-lg border bg-bg ${
                      weightError
                        ? 'border-red-500 ring-1 ring-red-500/60'
                        : 'border-border'
                    } ${big ? 'text-2xl' : ''}`}
                  >
                    <button
                      onClick={() => adjust(-2.5)}
                      className={`px-3 font-semibold text-muted active:bg-card ${big ? 'text-3xl' : 'text-xl'}`}
                    >
                      −
                    </button>
                    <input
                      type="number"
                      inputMode="decimal"
                      step={2.5}
                      value={weight}
                      onChange={(e) => {
                        setWeight(e.target.value);
                        if (weightError) setWeightError(false);
                      }}
                      className={`w-full bg-transparent px-2 py-2 text-center ${big ? 'text-3xl' : 'text-lg'}`}
                    />
                    <button
                      onClick={() => adjust(2.5)}
                      className={`px-3 font-semibold text-muted active:bg-card ${big ? 'text-3xl' : 'text-xl'}`}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div>
                  <span className="block text-xs text-muted">Reps</span>
                  <div className="mt-1 flex items-stretch overflow-hidden rounded-lg border border-border bg-bg">
                    <button
                      onClick={() => setReps(String(Math.max(0, parseInt(reps || '0', 10) - 1)))}
                      className={`px-3 font-semibold text-muted active:bg-card ${big ? 'text-3xl' : 'text-xl'}`}
                    >
                      −
                    </button>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={reps}
                      onChange={(e) => setReps(e.target.value)}
                      className={`w-full bg-transparent px-2 py-2 text-center ${big ? 'text-3xl' : 'text-lg'}`}
                    />
                    <button
                      onClick={() => setReps(String(parseInt(reps || '0', 10) + 1))}
                      className={`px-3 font-semibold text-muted active:bg-card ${big ? 'text-3xl' : 'text-xl'}`}
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              {set.kind !== 'warmup' && (
                <div className="mt-3">
                  <RpeButtons value={rpe} onChange={setRpe} compact />
                </div>
              )}

              {previewPrs.length > 0 && set.kind !== 'warmup' && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {previewPrs.map((pr) => (
                    <span
                      key={pr.kind}
                      className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300"
                    >
                      ⭐ {pr.kind === 'reps-at-weight' ? 'rep' : pr.kind} PR
                    </span>
                  ))}
                </div>
              )}

              {set.isAmrap && newE1rm > 0 && (
                <div className="mt-2 text-xs text-muted">
                  e1RM: <span className="font-mono text-fg">{newE1rm.toFixed(1)} kg</span>
                </div>
              )}

              <button
                onClick={async () => {
                  await onSave();
                  setExpanded(false);
                }}
                disabled={saving}
                className={`mt-3 w-full rounded-lg font-semibold ${
                  big ? 'py-4 text-lg' : 'py-2 text-sm'
                } ${done ? 'bg-emerald-600 text-white' : 'bg-accent text-bg'}`}
              >
                {done ? 'Update' : 'Log set'}
              </button>
            </>
          )}
        </div>
      )}

      {showSkip && <SkipMenu onSkip={onSkip} onCancel={() => setShowSkip(false)} />}
    </li>
  );
}
