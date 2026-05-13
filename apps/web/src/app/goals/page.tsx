'use client';

// Goals page — simplified Phase-6+ revision.
//
// UX rewrite goals:
// - 3 goal kinds, not 6 (dropped "Race time" → /races handles it; dropped
//   "Custom" → use Focus instead; dropped "Habit" — wasn't used in practice).
//   Old goals with those legacy kinds still render fine, we just don't surface
//   them in the picker.
// - No unit input — it's pre-determined by the kind ("kg" for strength-pr /
//   body-comp). Users were typing it manually for no reason.
// - Notes hidden behind a toggle (most goals don't need them).
// - The Goal.flavors[] field is surfaced as "Training emphasis" in the UI —
//   "flavors" is internal-jargon that didn't communicate the purpose. Each
//   option carries an `effect` one-liner that explains exactly what the
//   assistance suggester does when it's selected, and the form shows a live
//   "→ ..." summary as the user toggles them.
// - Auto-populated from the kind. The "Customize training emphasis" toggle
//   is collapsed by default. Cards show pills only when they differ from the
//   defaults; tap "Edit emphasis" to change them inline.
// - Lift picker is inline next to the title for strength-pr (required).
// - Tighter active-card layout — single info line, optional notes line, mute
//   the secondary actions.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useGoals, useMovements, useSettings, useRunPlan } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { deleteWithTombstones } from '@/lib/delete';
import type { Goal, GoalFlavor, GoalSignal } from '@wendler/db-schema';
import { defaultFlavorsForKind } from '@wendler/db-schema';
import type { MainLift } from '@wendler/domain';
import { TrainingGoalsSection } from '@/components/TrainingGoalsSection';

type NewGoalKind = 'strength-pr' | 'body-comp' | 'qualitative';

const NEW_GOAL_KINDS: {
  id: NewGoalKind;
  label: string;
  hint: string;
  unit: string;
}[] = [
  { id: 'strength-pr', label: 'Strength PR', hint: 'Hit a target weight on a main lift', unit: 'kg' },
  { id: 'qualitative', label: 'Focus', hint: 'A direction (e.g. "Get stronger")', unit: '' },
  { id: 'body-comp', label: 'Body weight', hint: 'Target body weight', unit: 'kg' },
];

const KIND_LABEL: Record<Goal['kind'], string> = {
  'strength-pr': 'Strength PR',
  'race-time': 'Race time',
  'body-comp': 'Body weight',
  habit: 'Habit',
  qualitative: 'Focus',
  custom: 'Focus',
};

const MAIN_LIFT_LABEL: Record<MainLift, string> = {
  squat: 'Squat',
  bench: 'Bench',
  deadlift: 'Deadlift',
  press: 'Overhead Press',
};

// Training-emphasis tags. The label/hint is what the user sees; `effect` is the
// concrete one-liner shown live as the user toggles them so they understand
// what the suggester will do.
const EMPHASIS_OPTIONS: {
  id: GoalFlavor;
  label: string;
  hint: string;
  effect: string;
}[] = [
  {
    id: 'strength',
    label: 'Strength',
    hint: 'Compound lifts, heavier loads, lower reps.',
    effect: 'Suggests compound assistance (chins, dips, rows) at 5–8 reps.',
  },
  {
    id: 'hypertrophy',
    label: 'Hypertrophy',
    hint: 'Isolation work, 8–15 reps, physique-building.',
    effect: 'Adds isolation slots (curls, lateral raises, leg curls) at 10–15 reps.',
  },
  {
    id: 'functional',
    label: 'Functional',
    hint: 'Real-life carry-over: carries, single-leg, anti-rotation.',
    effect: 'Prefers carries, lunges, single-leg work, and core anti-rotation.',
  },
  {
    id: 'conditioning',
    label: 'Conditioning',
    hint: 'Running / cardio is part of the plan.',
    effect: 'Reduces total assistance volume so cardio has room to recover.',
  },
  {
    id: 'prehab',
    label: 'Injury prevention',
    hint: 'Face pulls, band pull-aparts, mobility, balanced shoulders.',
    effect: 'Reserves a slot for face pulls / band work / mobility on accessory day.',
  },
];

function emphasisEffects(selected: GoalFlavor[]): string[] {
  if (selected.length === 0) return ['Nothing selected — uses Forever defaults for assistance.'];
  return selected
    .map((id) => EMPHASIS_OPTIONS.find((o) => o.id === id)?.effect)
    .filter((s): s is string => Boolean(s));
}

function effectiveFlavors(g: Goal): GoalFlavor[] {
  return g.flavors ?? defaultFlavorsForKind(g.kind);
}

function arraysEqualUnordered<T>(a: T[], b: T[]) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

function EmphasisEditor({
  selected,
  onToggle,
  showSummary = true,
  autoAppliedIds,
  autoAppliedHint,
}: {
  selected: GoalFlavor[];
  onToggle: (f: GoalFlavor) => void;
  showSummary?: boolean;
  /** Tags shown as forced-on with a dashed amber border (auto-applied by another system). */
  autoAppliedIds?: GoalFlavor[];
  autoAppliedHint?: string;
}) {
  const auto = new Set(autoAppliedIds ?? []);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {EMPHASIS_OPTIONS.map((f) => {
          const isAuto = auto.has(f.id);
          const on = isAuto || selected.includes(f.id);
          return (
            <button
              key={f.id}
              type="button"
              title={isAuto && autoAppliedHint ? autoAppliedHint : f.hint}
              aria-pressed={on}
              onClick={() => !isAuto && onToggle(f.id)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                isAuto
                  ? 'cursor-not-allowed border-dashed border-amber-400/80 bg-accent/20 text-fg'
                  : on
                    ? 'border-accent bg-accent/20 text-fg'
                    : 'border-border text-muted hover:text-fg'
              }`}
            >
              {f.label}
              {isAuto && <span className="ml-1 text-[9px] text-amber-300/90">auto</span>}
            </button>
          );
        })}
      </div>
      {autoAppliedHint && autoAppliedIds && autoAppliedIds.length > 0 && (
        <p className="text-[10px] italic text-muted/80">{autoAppliedHint}</p>
      )}
      {showSummary && (
        <ul className="ml-1 space-y-0.5 text-[11px] leading-snug text-muted">
          {emphasisEffects(selected).map((line, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-muted/70">→</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}
      {showSummary && (
        <details className="text-[11px] text-muted">
          <summary className="cursor-pointer underline-offset-2 hover:text-fg hover:underline">
            How tags shape assistance picks
          </summary>
          <div className="mt-1.5 space-y-1.5 rounded border border-border bg-bg-soft/40 p-2 leading-snug">
            <p>
              Tags shape the WHOLE block, not just accessory days. They
              influence which <strong>slots</strong> get filled
              (push, pull, single-leg, core, isolation, prehab, carry) and
              which <strong>movement</strong> wins inside each slot.
            </p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>
                <strong>Main lift days</strong> always get 3 categories
                (push + pull + a third) — Wendler Forever&apos;s rule. The
                third slot is tag-driven (single-leg / core / isolation /
                carry). Movement scoring inside each slot also adapts to
                what the main lifts already covered.
              </li>
              <li>
                <strong>No tags selected</strong> → balanced Forever
                default. Each slot weighted equally; no carries.
              </li>
              <li>
                <strong>All tags selected</strong> ≠ neutral. Carries
                enter rotation, prehab is reserved, compound/functional
                movements out-score isolation when tied.
              </li>
              <li>
                <strong>Strength</strong> shifts push/pull to lower reps,
                higher sets (5×5–8 instead of the default 4×8–12) and
                single-leg to 4×6–10.
              </li>
              <li>
                <strong>Hypertrophy</strong> bumps push/pull to 3×10–15,
                widens isolation reps to 12–20, and adds an extra slot to
                main days (4 movements instead of 3).
              </li>
              <li>
                <strong>Conditioning</strong> drops a set off every
                movement (floor at 2) and removes the third slot on main
                days, leaving push + pull only — to leave room for cardio.
                Auto-derived if you have a run plan loaded.
              </li>
              <li>
                <strong>Hypertrophy + Conditioning</strong> cancel each
                other out for slot count → back to the default 3 per main
                day (rep-range effects still compose).
              </li>
              <li>
                <strong>Pair-aware picks</strong>: bench+DL day prefers
                shoulder/tri push (chest already done) and back-focused
                pull (DL covers grip/posterior); squat day prefers
                hamstring/glute SL work over more quads.
              </li>
            </ul>
            <p className="text-muted/80">
              Cardio fatigue, equipment access, and warmup contents are
              factored separately — you don&apos;t need a tag for those.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

function formatTarget(g: Goal) {
  if (g.target === undefined) return '';
  return `${g.target}${g.targetUnit ? ' ' + g.targetUnit : ''}`;
}

function formatDate(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function deadlineDelta(deadline?: string): string | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - Date.now();
  const days = Math.round(ms / 86400000);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'today';
  if (days < 14) return `${days}d left`;
  if (days < 90) return `${Math.round(days / 7)}w left`;
  return `${Math.round(days / 30)}mo left`;
}

export default function GoalsPage() {
  const goals = useGoals();
  const movements = useMovements();
  const settings = useSettings();
  const runPlan = useRunPlan();
  // Conditioning is auto-derived when a run plan is loaded — gray it out so
  // users don't double-stack a manual toggle on top of the implicit one.
  const hasRunPlan = (runPlan?.slots?.length ?? 0) > 0;
  const disabledFlavors: GoalFlavor[] = hasRunPlan ? ['conditioning'] : [];
  const autoHint = hasRunPlan
    ? 'Conditioning is auto-applied because you have a run plan loaded.'
    : undefined;

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<NewGoalKind>('strength-pr');
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [signal, setSignal] = useState<GoalSignal>('none');
  const [movementId, setMovementId] = useState<string>('');
  const [flavors, setFlavors] = useState<GoalFlavor[]>(() =>
    defaultFlavorsForKind('strength-pr'),
  );
  const [showFlavors, setShowFlavors] = useState(false);
  const [editingFor, setEditingFor] = useState<string | null>(null);
  // Inline edit form draft state — keyed by which goal is being edited.
  const [editTitle, setEditTitle] = useState('');
  const [editTarget, setEditTarget] = useState('');
  const [editDeadline, setEditDeadline] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editMovementId, setEditMovementId] = useState('');
  const [editSignal, setEditSignal] = useState<GoalSignal>('none');
  const [editFlavors, setEditFlavors] = useState<GoalFlavor[]>([]);

  // Movements that can carry a Strength-PR goal: the four 5/3/1 main lifts,
  // resolved per the active program's `mainLiftMovements` mapping.
  const liftOptions = useMemo(() => {
    if (!movements) return [] as { id: string; label: string; lift: MainLift }[];
    const mapping = settings?.mainLiftMovements ?? {};
    const order: MainLift[] = ['squat', 'bench', 'deadlift', 'press'];
    const out: { id: string; label: string; lift: MainLift }[] = [];
    for (const lift of order) {
      const mappedId = mapping[lift];
      const mapped = mappedId ? movements.find((m) => m.id === mappedId) : undefined;
      const fallback = movements.find((m) => m.isMainLift === lift);
      const mv = mapped ?? fallback;
      if (!mv) continue;
      out.push({
        id: mv.id,
        label: `${MAIN_LIFT_LABEL[lift]} (${mv.name})`,
        lift,
      });
    }
    return out;
  }, [movements, settings?.mainLiftMovements]);

  const movementName = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of movements ?? []) map.set(m.id, m.name);
    return map;
  }, [movements]);

  function reset() {
    setTitle('');
    setTarget('');
    setDeadline('');
    setNotes('');
    setShowNotes(false);
    setKind('strength-pr');
    setSignal('none');
    setMovementId('');
    setFlavors(defaultFlavorsForKind('strength-pr'));
    setShowFlavors(false);
  }

  function selectKind(next: NewGoalKind) {
    setKind(next);
    setFlavors(defaultFlavorsForKind(next));
  }

  function toggleFlavor(set: GoalFlavor[], f: GoalFlavor): GoalFlavor[] {
    return set.includes(f) ? set.filter((x) => x !== f) : [...set, f];
  }

  async function save() {
    if (!title.trim()) return;
    const now = new Date().toISOString();
    const isQualitative = kind === 'qualitative';
    const isStrengthPr = kind === 'strength-pr';
    const unit = NEW_GOAL_KINDS.find((k) => k.id === kind)?.unit ?? '';
    const g: Goal = {
      id: crypto.randomUUID(),
      kind,
      title: title.trim(),
      target: !isQualitative && target ? Number(target) : undefined,
      targetUnit: !isQualitative && unit ? unit : undefined,
      deadline:
        !isQualitative && deadline
          ? new Date(deadline + 'T00:00:00Z').toISOString()
          : undefined,
      signal: isQualitative ? signal : undefined,
      movementId: isStrengthPr && movementId ? movementId : undefined,
      flavors: flavors.length ? flavors : undefined,
      notes: notes.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    await getDb().goals.put(g);
    reset();
    setOpen(false);
  }

  async function setGoalLift(g: Goal, newMovementId: string) {
    const now = new Date().toISOString();
    await getDb().goals.put({
      ...g,
      movementId: newMovementId || undefined,
      updatedAt: now,
    });
  }

  async function toggleDone(g: Goal) {
    const now = new Date().toISOString();
    await getDb().goals.put({
      ...g,
      completedAt: g.completedAt ? undefined : now,
      updatedAt: now,
    });
  }

  async function remove(g: Goal) {
    if (!confirm(`Delete "${g.title}"?`)) return;
    await deleteWithTombstones('goal', [g.id]);
  }

  function startEdit(g: Goal) {
    setEditTitle(g.title);
    setEditTarget(g.target !== undefined ? String(g.target) : '');
    setEditDeadline(g.deadline ? g.deadline.slice(0, 10) : '');
    setEditNotes(g.notes ?? '');
    setEditMovementId(g.movementId ?? '');
    setEditSignal(g.signal ?? 'none');
    setEditFlavors(effectiveFlavors(g));
    setEditingFor(g.id);
  }

  async function saveEdit(g: Goal) {
    if (!editTitle.trim()) return;
    const isQualitative = g.kind === 'qualitative' || g.kind === 'custom';
    const isStrengthPr = g.kind === 'strength-pr';
    const now = new Date().toISOString();
    const flavorsChanged = !arraysEqualUnordered(editFlavors, defaultFlavorsForKind(g.kind));
    await getDb().goals.put({
      ...g,
      title: editTitle.trim(),
      target: !isQualitative && editTarget !== '' ? Number(editTarget) : undefined,
      deadline:
        !isQualitative && editDeadline
          ? new Date(editDeadline + 'T00:00:00Z').toISOString()
          : undefined,
      signal: isQualitative ? editSignal : g.signal,
      movementId: isStrengthPr ? (editMovementId || undefined) : g.movementId,
      flavors: flavorsChanged ? editFlavors : undefined,
      notes: editNotes.trim() || undefined,
      updatedAt: now,
    });
    setEditingFor(null);
  }

  const active = (goals ?? []).filter((g) => !g.completedAt);
  const done = (goals ?? []).filter((g) => g.completedAt);
  const hardActive = active.filter((g) => g.kind !== 'qualitative' && g.kind !== 'custom');
  const focusActive = active.filter((g) => g.kind === 'qualitative' || g.kind === 'custom');
  const isQualitative = kind === 'qualitative';
  const activeKind = NEW_GOAL_KINDS.find((k) => k.id === kind)!;

  const renderGoalCard = (g: Goal) => {
    const flavorsList = effectiveFlavors(g);
    const isEditingFor = editingFor === g.id;
    return (
      <div
        key={g.id}
        className="rounded-lg border border-border bg-card p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{g.title}</span>
              {g.target !== undefined && (
                <span className="text-xs tabular-nums text-muted">{formatTarget(g)}</span>
              )}
              {g.deadline && (
                <span className="text-[11px] text-muted">
                  · {deadlineDelta(g.deadline)}
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted">
              {KIND_LABEL[g.kind]}
              {g.kind === 'strength-pr' && g.movementId && (
                <> · {movementName.get(g.movementId) ?? 'unknown lift'}</>
              )}
              {g.signal === 'strength-trend' && <> · strength trend</>}
            </div>
            {g.kind === 'strength-pr' && !g.movementId && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
                <span>⚠ No lift mapped — progress will be wrong.</span>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) setGoalLift(g, e.target.value);
                  }}
                  className="rounded border border-border bg-bg px-1.5 py-0.5 text-xs text-fg"
                >
                  <option value="">Set lift…</option>
                  {liftOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {g.notes && <div className="mt-1 text-xs text-muted">{g.notes}</div>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <button
              type="button"
              onClick={() => toggleDone(g)}
              className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-accent/20"
            >
              ✓ Done
            </button>
            <button
              type="button"
              onClick={() => (isEditingFor ? setEditingFor(null) : startEdit(g))}
              className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-accent/20"
            >
              {isEditingFor ? 'Close' : 'Edit'}
            </button>
            <button
              type="button"
              onClick={() => remove(g)}
              className="rounded-md px-2 py-1 text-[11px] text-muted/70 hover:text-red-300"
            >
              Delete
            </button>
          </div>
        </div>

        {isEditingFor && (
          <div className="mt-3 space-y-2 rounded-md border border-border bg-bg/40 p-3">
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted">Title</label>
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
              />
            </div>
            {g.kind === 'strength-pr' && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wide text-muted">Lift</label>
                <select
                  value={editMovementId}
                  onChange={(e) => setEditMovementId(e.target.value)}
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
                >
                  <option value="">— pick a lift —</option>
                  {liftOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {g.kind !== 'qualitative' && g.kind !== 'custom' && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wide text-muted">
                  Target {g.targetUnit && <span className="text-muted/70">· {g.targetUnit}</span>}
                </label>
                <div className="flex gap-2">
                  <input
                    value={editTarget}
                    onChange={(e) => setEditTarget(e.target.value)}
                    type="number"
                    inputMode="decimal"
                    className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
                  />
                  <input
                    value={editDeadline}
                    onChange={(e) => setEditDeadline(e.target.value)}
                    type="date"
                    title="Optional deadline"
                    className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
                  />
                </div>
              </div>
            )}
            {(g.kind === 'qualitative' || g.kind === 'custom') && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wide text-muted">Progress signal</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditSignal('none')}
                    className={`flex-1 rounded-md border px-2 py-1 text-xs ${
                      editSignal === 'none' ? 'border-accent bg-accent/20 text-fg' : 'border-border text-muted'
                    }`}
                  >
                    None
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditSignal('strength-trend')}
                    className={`flex-1 rounded-md border px-2 py-1 text-xs ${
                      editSignal === 'strength-trend' ? 'border-accent bg-accent/20 text-fg' : 'border-border text-muted'
                    }`}
                  >
                    Strength trend (8w)
                  </button>
                </div>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted">Notes</label>
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted">Training emphasis</label>
              <EmphasisEditor
                selected={editFlavors}
                onToggle={(f) => setEditFlavors((cur) => toggleFlavor(cur, f))}
                showSummary={false}
                autoAppliedIds={disabledFlavors}
                autoAppliedHint={autoHint}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditingFor(null)}
                className="rounded-md border border-border px-3 py-1 text-xs text-muted hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => saveEdit(g)}
                disabled={!editTitle.trim()}
                className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-bg disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* Flavor row — always show the effective emphasis tags so the
            user can see at a glance what's influencing the suggester. Auto-
            applied tags (e.g. conditioning when a run plan is loaded) get a
            distinct dashed amber border. */}
        {(() => {
          const autoTags: GoalFlavor[] = hasRunPlan ? ['conditioning'] : [];
          // De-dup auto-applied tags out of the regular pill list so we don't
          // render the same tag twice when it's also stored on the goal.
          const regularPills = flavorsList.filter((f) => !autoTags.includes(f));
          if (regularPills.length === 0 && autoTags.length === 0) return null;
          return (
            <div className="mt-2 flex flex-wrap gap-1">
              {regularPills.map((f) => (
                <span
                  key={f}
                  className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] text-fg"
                >
                  {EMPHASIS_OPTIONS.find((x) => x.id === f)?.label ?? f}
                </span>
              ))}
              {autoTags.map((f) => (
                <span
                  key={f}
                  title={autoHint}
                  className="rounded-full border border-dashed border-amber-400/80 bg-accent/20 px-2 py-0.5 text-[10px] text-fg"
                >
                  {EMPHASIS_OPTIONS.find((x) => x.id === f)?.label ?? f}
                  <span className="ml-1 text-[9px] text-amber-300/90">auto</span>
                </span>
              ))}
            </div>
          );
        })()}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Goals</h1>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg"
          >
            {open ? 'Cancel' : '+ New goal'}
          </button>
        </div>
        <p className="text-xs text-muted">
          What you&rsquo;re working toward. Used to bias suggested assistance lifts and
          tag your blocks.
        </p>
      </header>

      <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted">
        Training emphasis, phase, filters, and notes that shape the AI
        assistance suggester now live on the{' '}
        <Link href="/profile" className="font-medium text-accent underline-offset-2 hover:underline">
          Training Profile
        </Link>{' '}
        page.
      </div>

      {open && (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          {/* Kind picker */}
          <div className="space-y-2">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Goal type
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {NEW_GOAL_KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => selectKind(k.id)}
                  title={k.hint}
                  className={`rounded-md border px-3 py-2 text-left text-sm ${
                    kind === k.id
                      ? 'border-accent bg-accent/20 text-fg'
                      : 'border-border text-muted hover:text-fg'
                  }`}
                >
                  <div className="font-medium">{k.label}</div>
                  <div className="text-[10px] text-muted">{k.hint}</div>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted">
              Logging a real race?{' '}
              <Link href="/races" className="underline hover:text-fg">
                Use the Races page →
              </Link>
            </p>
          </div>

          {/* Strength-PR lift picker (required) */}
          {kind === 'strength-pr' && (
            <div className="space-y-1">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Lift
              </label>
              <select
                value={movementId}
                onChange={(e) => setMovementId(e.target.value)}
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
              >
                <option value="">— pick a lift —</option>
                {liftOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Title */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                isQualitative
                  ? 'e.g. Improved aesthetics'
                  : kind === 'strength-pr'
                    ? 'e.g. 200 kg deadlift'
                    : 'e.g. 78 kg lean'
              }
              className="w-full rounded-md border border-border bg-bg px-3 py-2"
            />
          </div>

          {/* Target + deadline (no kind=qualitative) */}
          {!isQualitative && (
            <div className="space-y-1">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Target {activeKind.unit && <span className="text-muted/70">· {activeKind.unit}</span>}
              </label>
              <div className="flex gap-2">
                <input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder={`Target ${activeKind.unit}`}
                  type="number"
                  inputMode="decimal"
                  className="flex-1 rounded-md border border-border bg-bg px-3 py-2"
                />
                <input
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                  type="date"
                  title="Optional deadline"
                  className="rounded-md border border-border bg-bg px-3 py-2"
                />
              </div>
            </div>
          )}

          {/* Qualitative: progress signal */}
          {isQualitative && (
            <div className="space-y-1">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Progress signal
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSignal('none')}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${
                    signal === 'none'
                      ? 'border-accent bg-accent/20 text-fg'
                      : 'border-border text-muted'
                  }`}
                >
                  None
                </button>
                <button
                  type="button"
                  onClick={() => setSignal('strength-trend')}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${
                    signal === 'strength-trend'
                      ? 'border-accent bg-accent/20 text-fg'
                      : 'border-border text-muted'
                  }`}
                  title="Attaches an 8-week sparkline of your average main-lift e1RM."
                >
                  Strength trend (8w)
                </button>
              </div>
            </div>
          )}

          {/* Optional: notes */}
          {!showNotes ? (
            <button
              type="button"
              onClick={() => setShowNotes(true)}
              className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
            >
              + Add notes
            </button>
          ) : (
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (optional)"
              rows={2}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
            />
          )}

          {/* Optional: customize training emphasis (legacy — vestigial during
              the four-axis Training Profile migration period). */}
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => setShowFlavors((v) => !v)}
              className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
            >
              {showFlavors ? '− Hide training emphasis' : '+ Customize training emphasis (legacy)'}
            </button>
            {showFlavors && (
              <>
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-100">
                  ⓘ Per-goal emphasis tags are <strong>no longer used by the
                  assistance suggester</strong> — this signal moved to the
                  Training Profile section above (primary + secondary goals,
                  phase, constraints). The tag editor is kept for one release
                  so existing tags stay visible while you migrate; new goals
                  don&apos;t need them.
                </p>
                <EmphasisEditor
                  selected={flavors}
                  onToggle={(f) => setFlavors((cur) => toggleFlavor(cur, f))}
                  autoAppliedIds={disabledFlavors}
                  autoAppliedHint={autoHint}
                />
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <button
              type="button"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!title.trim() || (kind === 'strength-pr' && !movementId)}
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
            >
              Save goal
            </button>
          </div>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Active ({hardActive.length + focusActive.length})
        </h2>
        {hardActive.length === 0 && focusActive.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card/50 p-4 text-sm text-muted">
            No active goals yet. Tap <strong>+ New goal</strong> to add one.
          </div>
        )}
        {hardActive.map(renderGoalCard)}
        {focusActive.map(renderGoalCard)}
      </section>

      {done.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Completed ({done.length})
          </h2>
          {done.map((g) => (
            <div
              key={g.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card/50 p-3 opacity-70"
            >
              <div>
                <div className="font-medium line-through">{g.title}</div>
                <div className="text-xs text-muted">
                  Completed {formatDate(g.completedAt)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => toggleDone(g)}
                className="rounded-md border border-border px-2 py-1 text-xs"
              >
                Reopen
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
