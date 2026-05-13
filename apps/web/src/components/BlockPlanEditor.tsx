'use client';

// Inline per-block plan editor. Renders the block's day structure as a list
// of editable cards: per-day label, editable main-lift pills, supplemental
// info (with TM% for the active week), and an inline assistance editor.
//
// Week scope is owned by the parent BlockDetailPage via a single block-level
// week tab strip — the editor receives `weekScope` as a prop and applies it
// uniformly to every visible day card.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { nanoid } from 'nanoid';
import {
  SUPPLEMENTAL_TEMPLATES,
  SEVENTH_WEEK_VARIANTS,
  WAVES,
  dayLabel,
  defaultSupplementalSets,
  derivePlan,
  effectivePlan,
  effectiveScheduleDays,
  hasDayAssistanceOverride,
  resolveDayAssistance,
  supplementalPercentages,
  type AssistanceEntry,
  type BlockDay,
  type BlockPlan,
  type MainScheme,
  type SeventhWeekKind,
  type SupplementalTemplateId,
  type WendlerWeek,
} from '@wendler/domain';
import type { MainLift, Movement, ProgramBlock, ProgramSchedule } from '@wendler/db-schema';
import { liftLabel } from '@/lib/format';
import { getDb } from '@/lib/db';
import { kickSync } from '@/lib/sync';
import { trackLocalSave } from '@/lib/save-status';
import { resetDeloadChoice } from '@/lib/deload';
import { AssistanceListEditor } from './AssistanceListEditor';
import { SuggestAssistanceForBlock } from './SuggestAssistanceForBlock';

const ALL_MAIN_LIFTS: MainLift[] = ['squat', 'bench', 'deadlift', 'press'];

interface BlockPlanEditorProps {
  block: ProgramBlock;
  schedule: ProgramSchedule | undefined;
  movements: Movement[] | undefined;
  /**
   * Week scope chosen by the parent block-level week tab strip. All edits
   * are scoped to this week — the resolver creates a per-week override on
   * the first edit so other weeks are never touched. (v287: the legacy
   * "default" scope was removed; every week is programmed independently.)
   */
  weekScope: WendlerWeek;
}

export function BlockPlanEditor({ block, schedule, movements, weekScope }: BlockPlanEditorProps) {
  const fallbackDayOrder = schedule?.dayOrder ?? ALL_MAIN_LIFTS;
  const fallbackLiftsPerDay = schedule?.liftsPerDay ?? 1;

  // The plan we persist into block.plan must NOT carry the labels inherited
  // from the program-level schedule — otherwise saving any unrelated edit
  // would bake those labels into the block and freeze them in place. We keep
  // a "raw" view (block's own labels only, no inheritance) and base every
  // write on it so program-level day renames keep flowing through.
  const propRawPlan = useMemo(
    () =>
      block.plan ??
      (schedule
        ? derivePlan(block, schedule)
        : derivePlan(block, fallbackDayOrder, fallbackLiftsPerDay)),
    [block, schedule, fallbackDayOrder, fallbackLiftsPerDay],
  );

  // Optimistic draft of the raw plan. Set the moment a mutator runs so the
  // UI re-renders instantly without waiting for Dexie + the live query to
  // round-trip. Cleared once the most recent draft has been persisted (and
  // the parent will then deliver the same value via `block.plan`).
  const [draftPlan, setDraftPlan] = useState<BlockPlan | null>(null);
  const draftRef = useRef<BlockPlan | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blockIdRef = useRef(block.id);

  // Reset the draft if the editor switches to a different block — the draft
  // only applies to the block it was created from.
  useEffect(() => {
    if (blockIdRef.current !== block.id) {
      blockIdRef.current = block.id;
      draftRef.current = null;
      setDraftPlan(null);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    }
  }, [block.id]);

  const rawPlan = draftPlan ?? propRawPlan;

  // The block as it currently appears (draft applied) — used to compute the
  // effective plan with inherited labels for rendering.
  const displayBlock = useMemo<ProgramBlock>(
    () => (draftPlan ? { ...block, plan: draftPlan } : block),
    [block, draftPlan],
  );

  const plan = useMemo(
    () =>
      schedule
        ? effectivePlan(displayBlock, schedule)
        : effectivePlan(displayBlock, fallbackDayOrder, fallbackLiftsPerDay),
    [displayBlock, schedule, fallbackDayOrder, fallbackLiftsPerDay],
  );

  const inheritedLabels = useMemo<readonly (string | undefined)[]>(
    () =>
      schedule
        ? effectiveScheduleDays(schedule).map((d) => d.label?.trim() || undefined)
        : [],
    [schedule],
  );

  const persistPlan = useCallback(
    async (next: BlockPlan) => {
      // Bump updatedAt so the cloud sync engine picks up the edit. Without this,
      // plan/assistance changes never reach other devices because the block's
      // sync timestamp is derived from createdAt/startedAt/completedAt only.
      // The trackLocalSave wrapper feeds the global SaveStatusBadge in the top
      // nav and stores a retry handler so a failed save can be re-attempted
      // from the badge.
      await trackLocalSave(
        () => getDb().blocks.update(block.id, { plan: next, updatedAt: new Date().toISOString() }),
        () => void persistPlan(next),
      );
      // Only clear the draft if no newer edit landed while we were writing —
      // otherwise the user would briefly see the old value flicker back in.
      if (draftRef.current === next) {
        draftRef.current = null;
        setDraftPlan(null);
      }
      // Push to the cloud right away — debounced inside kickSync so a burst
      // of edits coalesces into a single sync cycle.
      kickSync();
    },
    [block.id],
  );

  const flushNow = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = draftRef.current;
    if (pending) void persistPlan(pending);
  }, [persistPlan]);

  // Apply a mutation. `immediate` writes through right away (structural
  // changes like add/remove/move/duplicate); otherwise we debounce so a burst
  // of keystrokes only triggers one Dexie write ~400ms after typing stops.
  const applyChange = useCallback(
    (next: BlockPlan, immediate: boolean) => {
      draftRef.current = next;
      setDraftPlan(next);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (immediate) {
        void persistPlan(next);
      } else {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          void persistPlan(next);
        }, 400);
      }
    },
    [persistPlan],
  );

  // Flush any pending debounced edit on unmount or when the page is hidden,
  // so navigating away or closing the tab mid-typing doesn't lose work.
  useEffect(() => {
    const onHide = () => flushNow();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      flushNow();
    };
  }, [flushNow]);

  // ---- mutators -----------------------------------------------------------
  const updateDay = (dayId: string, patch: Partial<BlockDay>) => {
    applyChange(
      {
        ...rawPlan,
        days: rawPlan.days.map((d) => (d.id === dayId ? { ...d, ...patch } : d)),
      },
      false,
    );
  };

  const addDay = () => {
    const newDay: BlockDay = {
      id: nanoid(),
      mainLifts: [],
      assistance: [],
    };
    applyChange({ ...rawPlan, days: [...rawPlan.days, newDay] }, true);
  };

  const addAccessoryDay = () => {
    const newDay: BlockDay = {
      id: nanoid(),
      mainLifts: [],
      label: 'Accessory',
      assistance: [],
    };
    applyChange({ ...rawPlan, days: [...rawPlan.days, newDay] }, true);
  };

  const removeDay = (dayId: string) => {
    if (!confirm('Remove this day from the block?')) return;
    const overrides = { ...(rawPlan.assistanceOverrides ?? {}) };
    for (const k of Object.keys(overrides)) if (k.endsWith(`|${dayId}`)) delete overrides[k];
    applyChange(
      {
        ...rawPlan,
        days: rawPlan.days.filter((d) => d.id !== dayId),
        assistanceOverrides: Object.keys(overrides).length ? overrides : undefined,
      },
      true,
    );
  };

  const duplicateDay = (dayId: string) => {
    const i = rawPlan.days.findIndex((d) => d.id === dayId);
    if (i < 0) return;
    const src = rawPlan.days[i]!;
    const clone: BlockDay = {
      ...src,
      id: nanoid(),
      label: src.label ? `${src.label} (copy)` : undefined,
      assistance: src.assistance.map((e) => ({ ...e, id: nanoid() })),
    };
    const next = rawPlan.days.slice();
    next.splice(i + 1, 0, clone);
    applyChange({ ...rawPlan, days: next }, true);
  };

  const moveDay = (fromIndex: number, toIndex: number) => {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= rawPlan.days.length ||
      toIndex >= rawPlan.days.length
    ) {
      return;
    }
    const next = rawPlan.days.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    applyChange({ ...rawPlan, days: next }, true);
  };

  const setOverride = (
    dayId: string,
    week: WendlerWeek,
    entries: AssistanceEntry[] | null,
  ) => {
    const overrides = { ...(rawPlan.assistanceOverrides ?? {}) };
    const key = `${week}|${dayId}`;
    if (entries === null) delete overrides[key];
    else overrides[key] = entries;
    applyChange(
      {
        ...rawPlan,
        assistanceOverrides: Object.keys(overrides).length ? overrides : undefined,
      },
      false,
    );
  };

  // Phase 4 — block-level apply for the AI suggester. Appends new entries
  // per dayId in a single rawPlan write, scoped to the active week. Returns
  // an undo fn that restores the snapshotted rawPlan when invoked.
  const applyAssistanceAcrossBlock = useCallback(
    (perDay: Record<string, AssistanceEntry[]>): (() => void) => {
      const snapshot = rawPlan;
      const overrides = { ...(rawPlan.assistanceOverrides ?? {}) };
      for (const day of rawPlan.days) {
        const adds = perDay[day.id];
        if (!adds || adds.length === 0) continue;
        const key = `${weekScope}|${day.id}`;
        const current = overrides[key] ?? resolveDayAssistance(plan, weekScope, day.id) ?? [];
        overrides[key] = [...current, ...adds];
      }
      applyChange(
        {
          ...rawPlan,
          assistanceOverrides: Object.keys(overrides).length ? overrides : undefined,
        },
        false,
      );
      return () => applyChange(snapshot, false);
    },
    [rawPlan, weekScope, applyChange, plan],
  );

  // Per-day entries the AI should see (so it doesn't propose duplicates).
  const currentPerDayEntries = useMemo<AssistanceEntry[][]>(
    () => plan.days.map((d) => resolveDayAssistance(plan, weekScope, d.id) ?? []),
    [plan, weekScope],
  );

  // Cross-week context: per-day entries from OTHER weeks within this same
  // block, so the AI suggester can vary movements between weeks (per Wendler
  // 5/3/1 Forever p.86 — "I don't see any problem in changing the exercises
  // from workout to workout"). Only includes weeks with at least one entry.
  const otherWeeksContext = useMemo<
    Array<{ scopeLabel: string; perDay: AssistanceEntry[][] }>
  >(() => {
    const allScopes: Array<{ scope: WendlerWeek; label: string }> = [
      { scope: 1, label: 'Week 1' },
      { scope: 2, label: 'Week 2' },
      { scope: 3, label: 'Week 3' },
      { scope: 'deload', label: 'Deload' },
    ];
    const out: Array<{ scopeLabel: string; perDay: AssistanceEntry[][] }> = [];
    for (const { scope, label } of allScopes) {
      if (scope === weekScope) continue;
      const perDay = plan.days.map(
        (d) => resolveDayAssistance(plan, scope, d.id) ?? [],
      );
      if (perDay.some((entries) => entries.length > 0)) {
        out.push({ scopeLabel: label, perDay });
      }
    }
    return out;
  }, [plan, weekScope]);

  // ---- drag-and-drop reorder ---------------------------------------------
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const onDragStart = (i: number) => (e: DragEvent) => {
    setDragIdx(i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  };
  const onDragOver = (i: number) => (e: DragEvent) => {
    if (dragIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropIdx !== i) setDropIdx(i);
  };
  const onDrop = (i: number) => (e: DragEvent) => {
    e.preventDefault();
    if (dragIdx !== null) void moveDay(dragIdx, i);
    setDragIdx(null);
    setDropIdx(null);
  };
  const onDragEnd = () => {
    setDragIdx(null);
    setDropIdx(null);
  };

  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Days ({plan.days.length})
        </h2>
        <span
          className="rounded-md bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent ring-1 ring-accent/40"
          title="Edits below apply to this week's view"
        >
          Editing {weekScope === 'deload' ? 'Deload' : `Week ${weekScope}`}
        </span>
      </header>

      {weekScope === 'deload' && block.deloadScalingChoice && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-400/40 bg-sky-500/5 px-2 py-1.5 text-xs">
          <span className="text-sky-300">
            Auto-scaled · {block.deloadScalingChoice.replace(/-/g, ' ')}
          </span>
          <button
            type="button"
            onClick={() => {
              void resetDeloadChoice(block.id);
            }}
            className="ml-auto rounded bg-bg px-2 py-0.5 text-muted ring-1 ring-border hover:text-fg"
          >
            Reset & re-recommend
          </button>
        </div>
      )}

      {/* Phase 4 — block-level AI suggester. Replaces the per-day panel. */}
      <SuggestAssistanceForBlock
        block={block}
        days={plan.days}
        movements={movements ?? []}
        currentPerDayEntries={currentPerDayEntries}
        otherWeeksContext={otherWeeksContext}
        weekScope={weekScope}
        onApply={applyAssistanceAcrossBlock}
      />

      <ol className="space-y-3">
        {plan.days.map((day, i) => {
          const isDragging = dragIdx === i;
          const isDropTarget = dropIdx === i && dragIdx !== null && dragIdx !== i;
          return (
            <li
              key={day.id}
              id={`day-${i}`}
              className={`scroll-mt-20 transition-opacity ${
                isDragging ? 'opacity-50' : ''
              } ${isDropTarget ? 'rounded-xl ring-2 ring-accent' : ''}`}
              draggable
              onDragStart={onDragStart(i)}
              onDragOver={onDragOver(i)}
              onDrop={onDrop(i)}
              onDragEnd={onDragEnd}
            >
              <DayCard
                day={day}
                dayIndex={i}
                block={block}
                blockMainScheme={block.mainScheme}
                blockSupplemental={block.supplementalTemplate}
                blockSupplementalSets={block.supplementalSetsOverride}
                plan={plan}
                movements={movements ?? []}
                weekScope={weekScope}
                ownLabel={block.plan?.days.find((d) => d.id === day.id)?.label}
                inheritedLabel={inheritedLabels[i]}
                onUpdate={(patch) => updateDay(day.id, patch)}
                onRemove={() => removeDay(day.id)}
                onDuplicate={() => duplicateDay(day.id)}
                onSetOverride={(week, entries) => setOverride(day.id, week, entries)}
              />
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={addDay}
          className="flex-1 rounded-lg border border-dashed border-border bg-card py-3 text-sm text-muted hover:border-accent hover:text-fg"
        >
          + Add training day
        </button>
        <button
          type="button"
          onClick={addAccessoryDay}
          title="A day for assistance / conditioning work with no main lift"
          className="flex-1 rounded-lg border border-dashed border-violet-500/50 bg-card py-3 text-sm text-violet-300 hover:border-violet-400 hover:bg-violet-500/10"
        >
          + Add accessory day
        </button>
      </div>
    </section>
  );
}

// ---- DayCard ---------------------------------------------------------------

interface DayCardProps {
  day: BlockDay;
  dayIndex: number;
  block: ProgramBlock;
  blockMainScheme?: MainScheme;
  blockSupplemental: SupplementalTemplateId;
  blockSupplementalSets?: number;
  plan: BlockPlan;
  movements: Movement[];
  weekScope: WendlerWeek;
  /**
   * The label stored directly on this block's plan day (if any). Used so the
   * label input can show *only* block-level overrides as its value, while the
   * placeholder shows whatever the day will actually be called (which may
   * inherit from the program-level schedule).
   */
  ownLabel?: string;
  /**
   * Label inherited from the program-level schedule at this day index. When
   * present, the schedule label always wins over `ownLabel`, so the input is
   * shown read-only with a hint that the name comes from the program.
   */
  inheritedLabel?: string;
  onUpdate: (patch: Partial<BlockDay>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onSetOverride: (week: WendlerWeek, entries: AssistanceEntry[] | null) => void;
}

function DayCard({
  day,
  dayIndex,
  block,
  blockMainScheme,
  blockSupplemental,
  blockSupplementalSets,
  plan,
  movements,
  weekScope,
  ownLabel,
  inheritedLabel,
  onUpdate,
  onRemove,
  onDuplicate,
  onSetOverride,
}: DayCardProps) {
  const blockKind = block.kind;
  const blockSeventhWeekKind = block.seventhWeekKind;
  const [expanded, setExpanded] = useState(true);

  // Every edit flows into the active week's override so other weeks aren't
  // touched. The override is created lazily on the first edit. `isOverride`
  // reflects whether one already exists (used to show the "Reset" affordance
  // — clearing the override falls back to whatever's stored on the day,
  // which is `[]` for new blocks and the original default for migrated ones).
  const isOverride = hasDayAssistanceOverride(plan, weekScope, day.id);
  const entries = resolveDayAssistance(plan, weekScope, day.id);
  const writeAssistance = (next: AssistanceEntry[]) => {
    onSetOverride(weekScope, next);
  };

  // Undo state for the destructive "Reset to default" action. Snapshots
  // the override entries that were cleared so the user can restore them
  // within ~10s if the click was accidental. v283: reset is irreversible
  // from the user's perspective and the override often represents real
  // work (manually-arranged or LLM-generated picks).
  const [undoResetSnapshot, setUndoResetSnapshot] = useState<{
    week: WendlerWeek;
    entries: AssistanceEntry[];
    expiresAt: number;
  } | null>(null);
  useEffect(() => {
    if (!undoResetSnapshot) return;
    const remaining = undoResetSnapshot.expiresAt - Date.now();
    if (remaining <= 0) {
      setUndoResetSnapshot(null);
      return;
    }
    const t = setTimeout(() => setUndoResetSnapshot(null), remaining);
    return () => clearTimeout(t);
  }, [undoResetSnapshot]);

  const resetOverride = () => {
    // Snapshot the cleared entries (deep-cloned so they survive any in-place
    // edit that happens between reset and undo) before clearing the override.
    const snapshot = entries.map((e) => ({ ...e }));
    setUndoResetSnapshot({
      week: weekScope,
      entries: snapshot,
      expiresAt: Date.now() + 10_000,
    });
    onSetOverride(weekScope, null);
  };
  const undoReset = () => {
    if (!undoResetSnapshot) return;
    onSetOverride(undoResetSnapshot.week, undoResetSnapshot.entries);
    setUndoResetSnapshot(null);
  };

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      {/* Top row: drag handle, expand toggle, label, actions */}
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              title="Drag to reorder"
              className="select-none text-muted/60 cursor-grab active:cursor-grabbing"
            >
              ⋮⋮
            </span>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="text-muted hover:text-fg"
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? '▾' : '▸'}
            </button>
            <input
              value={inheritedLabel ?? ownLabel ?? ''}
              onChange={(e) => onUpdate({ label: e.target.value || undefined })}
              placeholder={dayLabel(day, dayIndex)}
              readOnly={!!inheritedLabel}
              title={
                inheritedLabel
                  ? 'Inherited from the program-level day name. Edit it on the program detail page.'
                  : undefined
              }
              className={`min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-base font-semibold tracking-tight focus:border-border focus:bg-bg ${
                inheritedLabel ? 'cursor-default text-muted' : ''
              }`}
              aria-label={`Day ${dayIndex + 1} label`}
            />
            {day.mainLifts.length === 0 && (
              <span
                className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300 ring-1 ring-violet-500/30"
                title="No main lifts — pure assistance / conditioning day"
              >
                Accessory
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <IconBtn label="Duplicate" onClick={onDuplicate}>
            ⧉
          </IconBtn>
          <IconBtn label="Remove" onClick={onRemove} danger>
            ✕
          </IconBtn>
        </div>
      </div>

      {expanded && (
        <div className="space-y-0">
          {/* Main lifts — editable pills with picker. Accent bar = orange (primary work). */}
          <Section accent="bg-accent" title="Main lifts">
            <MainLiftPicker
              lifts={day.mainLifts}
              onChange={(next) => onUpdate({ mainLifts: next })}
            />
            {day.mainLifts.length === 0 && (
              <p className="mt-1 text-xs text-muted">
                Pure assistance / conditioning day — no main lift. Tap a lift above to convert
                this into a main training day.
              </p>
            )}
            {day.mainLifts.length > 0 && (() => {
              // Union of per-lift AMRAP overrides — the preview shows the
              // prescription pattern at the day level, not per-lift, so any
              // lift's override flips the relevant set.
              const amrapUnion = new Set<number>();
              if (day.amrapMainSetIndices) {
                for (const lift of day.mainLifts) {
                  const idxs = day.amrapMainSetIndices[lift];
                  if (idxs) for (const i of idxs) amrapUnion.add(i);
                }
              }
              const lines = mainWaveLines({
                blockKind,
                mainScheme: blockMainScheme,
                seventhWeekKind: blockSeventhWeekKind,
                amrapMainIndices: Array.from(amrapUnion),
                scope: weekScope,
              });
              if (lines.length === 0) return null;
              return (
                <div className="mt-3 rounded-lg border border-border/60 bg-bg/40 p-2.5">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Prescription <span className="font-normal normal-case text-muted/70">(% TM × reps)</span>
                  </div>
                  <div className="space-y-1.5">
                    {lines.map((line) => (
                      <div
                        key={line.label}
                        className="flex flex-wrap items-baseline gap-x-2.5 text-sm tabular-nums"
                        title={`${line.label}: main-lift sets at the listed % of TM. Top set marked with + is AMRAP.`}
                      >
                        <span className="shrink-0 rounded-md bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent ring-1 ring-accent/30">
                          {line.label}
                        </span>
                        <span className="font-mono text-fg">{line.sets}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
            {day.mainLifts.length > 0 && (
              <AmrapOverrideEditor
                lifts={day.mainLifts}
                value={day.amrapMainSetIndices}
                onChange={(next) => onUpdate({ amrapMainSetIndices: next })}
              />
            )}
          </Section>

          {/* Supplemental info — read-only here. TM% badges surface the per-week
              load context (one badge per training week on Default; a single
              badge for the active week scope). Follows Wendler 5/3/1 Forever
              percentages baked into supplementalPercentages(). */}
          {day.mainLifts.length > 0 && (() => {
            const tpl = SUPPLEMENTAL_TEMPLATES.find((t) => t.id === blockSupplemental);
            if (!tpl || tpl.id === 'none') return null;
            const sets = blockSupplementalSets ?? defaultSupplementalSets(blockSupplemental);
            const badges = supplementalPctBadges(blockSupplemental, weekScope);
            return (
              <Section accent="bg-emerald-500" title="Supplemental">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-fg">{tpl.name}</span>
                  {sets > 0 && (
                    <span className="text-xs tabular-nums text-muted">· {sets} sets</span>
                  )}
                </div>
                {badges.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {badges.map((b) => (
                      <span
                        key={b.label}
                        className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-emerald-300 ring-1 ring-emerald-500/30"
                        title={`${b.label}: supplemental load is ${b.pct} of training max`}
                      >
                        {b.label} <span className="font-semibold">{b.pct}</span>
                      </span>
                    ))}
                  </div>
                )}
              </Section>
            );
          })()}

          {/* Assistance editor. Accent bar = muted (accessory work). */}
          <Section accent="bg-muted/40" title="Assistance" last>
            {undoResetSnapshot && (
              <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-100">
                <span>
                  Cleared{' '}
                  <span className="font-medium">
                    {undoResetSnapshot.entries.length}
                  </span>{' '}
                  {undoResetSnapshot.entries.length === 1 ? 'entry' : 'entries'} from{' '}
                  {undoResetSnapshot.week === 'deload'
                    ? 'Deload'
                    : `Week ${undoResetSnapshot.week}`}
                  .
                </span>
                <button
                  type="button"
                  onClick={undoReset}
                  className="ml-auto rounded border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 font-medium text-amber-100 hover:bg-amber-500/25"
                >
                  Undo
                </button>
              </div>
            )}
            <CopyAssistanceFromPicker
              plan={plan}
              currentDayId={day.id}
              weekScope={weekScope}
              hasEntries={entries.length > 0}
              onCopy={(sourceEntries) => {
                writeAssistance(sourceEntries.map((e) => ({ ...e, id: nanoid() })));
              }}
            />
            <AssistanceListEditor
              entries={entries}
              movements={movements}
              onChange={writeAssistance}
              emptyHint='No exercises yet. Tap “+ Add exercise” to start.'
            />
            {isOverride && entries.length > 0 && (
              <div className="mt-2 text-right">
                <button
                  type="button"
                  onClick={resetOverride}
                  className="text-[11px] text-muted underline hover:text-fg"
                  title={`Remove all assistance entries from this day for ${weekScope === 'deload' ? 'Deload' : `Week ${weekScope}`}`}
                >
                  Clear {weekScope === 'deload' ? 'Deload' : `Week ${weekScope}`}
                </button>
              </div>
            )}
          </Section>
        </div>
      )}
    </article>
  );
}

// ---- Section ---------------------------------------------------------------
// Renders a labeled section inside the day card with a 3px left accent bar so
// the user can scan main / supplemental / assistance at a glance.

function Section({
  accent,
  title,
  children,
  last,
}: {
  accent: string;
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`flex gap-3 px-4 py-3 ${last ? '' : 'border-b border-border/50'}`}>
      <div className={`-my-1 w-[3px] shrink-0 self-stretch rounded-full ${accent}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- CopyAssistanceFromPicker ---------------------------------------------
// Compact dropdown that lets the user clone the assistance list from another
// day in the same plan. Especially useful for newly-added accessory days
// that start empty. Sources are sibling days (in the *currently visible*
// week scope) that have at least one assistance entry.

function CopyAssistanceFromPicker({
  plan,
  currentDayId,
  weekScope,
  hasEntries,
  onCopy,
}: {
  plan: BlockPlan;
  currentDayId: string;
  weekScope: WendlerWeek;
  hasEntries: boolean;
  onCopy: (entries: AssistanceEntry[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const sources = useMemo(() => {
    return plan.days
      .map((d, i) => {
        if (d.id === currentDayId) return null;
        const entries = resolveDayAssistance(plan, weekScope, d.id);
        if (entries.length === 0) return null;
        return { day: d, index: i, entries };
      })
      .filter((x): x is { day: BlockDay; index: number; entries: AssistanceEntry[] } => x !== null);
  }, [plan, currentDayId, weekScope]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (sources.length === 0) return null;

  const pick = (src: { day: BlockDay; entries: AssistanceEntry[] }) => {
    if (hasEntries && !confirm('Replace the current assistance list with the copy?')) return;
    onCopy(src.entries);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative -mt-0.5 mb-1 flex justify-end">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-fg"
        title="Clone the assistance list from another day"
      >
        Copy from…
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <div className="border-b border-border/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Copy assistance from
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {sources.map((s) => (
              <li key={s.day.id}>
                <button
                  type="button"
                  onClick={() => pick(s)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs hover:bg-bg"
                >
                  <span className="min-w-0 truncate">
                    {s.day.label?.trim() || dayLabel(s.day, s.index)}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted">
                    {s.entries.length}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}


// Editable list of main-lift pills. Each pill opens a small popover that lets
// the user swap to another lift or remove it. A dashed "+ Add lift" button
// appends a new pill from the unused lifts.

function MainLiftPicker({
  lifts,
  onChange,
}: {
  lifts: MainLift[];
  onChange: (next: MainLift[]) => void;
}) {
  const [openIdx, setOpenIdx] = useState<number | 'add' | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Click-outside / Escape closes the open popover.
  useEffect(() => {
    if (openIdx === null) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenIdx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenIdx(null);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [openIdx]);

  const swapAt = (i: number, lift: MainLift) => {
    const next = lifts.slice();
    next[i] = lift;
    onChange(next);
    setOpenIdx(null);
  };
  const removeAt = (i: number) => {
    onChange(lifts.filter((_, j) => j !== i));
    setOpenIdx(null);
  };
  const moveBy = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= lifts.length) return;
    const a = lifts[i];
    const b = lifts[j];
    if (a === undefined || b === undefined) return;
    const next = lifts.slice();
    next[i] = b;
    next[j] = a;
    onChange(next);
    setOpenIdx(j);
  };
  const addLift = (lift: MainLift) => {
    onChange([...lifts, lift]);
    setOpenIdx(null);
  };

  // ---- drag-and-drop reorder (mirrors day-card pattern above) -----------
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const onPillDragStart = (i: number) => (e: DragEvent) => {
    setDragIdx(i);
    setOpenIdx(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  };
  const onPillDragOver = (i: number) => (e: DragEvent) => {
    if (dragIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropIdx !== i) setDropIdx(i);
  };
  const onPillDrop = (i: number) => (e: DragEvent) => {
    e.preventDefault();
    if (dragIdx !== null && dragIdx !== i) {
      const next = lifts.slice();
      const [moved] = next.splice(dragIdx, 1);
      if (moved !== undefined) {
        next.splice(i, 0, moved);
        onChange(next);
      }
    }
    setDragIdx(null);
    setDropIdx(null);
  };
  const onPillDragEnd = () => {
    setDragIdx(null);
    setDropIdx(null);
  };

  const canAdd = ALL_MAIN_LIFTS.some((l) => !lifts.includes(l));

  return (
    <div ref={wrapRef} className="flex flex-wrap items-center gap-1.5">
      {lifts.map((lift, i) => {
        const alternatives = ALL_MAIN_LIFTS.filter((l) => l !== lift && !lifts.includes(l));
        const isDragging = dragIdx === i;
        const isDropTarget = dropIdx === i && dragIdx !== null && dragIdx !== i;
        return (
          <div
            key={`${lift}-${i}`}
            className={`relative transition-opacity ${isDragging ? 'opacity-50' : ''} ${
              isDropTarget ? 'rounded-full ring-2 ring-accent' : ''
            }`}
            draggable={lifts.length > 1}
            onDragStart={onPillDragStart(i)}
            onDragOver={onPillDragOver(i)}
            onDrop={onPillDrop(i)}
            onDragEnd={onPillDragEnd}
          >
            <button
              type="button"
              onClick={() => setOpenIdx(openIdx === i ? null : i)}
              aria-haspopup="menu"
              aria-expanded={openIdx === i}
              title={lifts.length > 1 ? 'Drag to reorder, or tap to edit' : 'Tap to edit'}
              className={`inline-flex items-center gap-1 rounded-full bg-bg px-3 py-1 text-xs text-fg ring-1 ring-border hover:ring-accent/60 ${
                lifts.length > 1 ? 'cursor-grab active:cursor-grabbing' : ''
              }`}
            >
              <span>{liftLabel(lift)}</span>
              <span aria-hidden className="text-[10px] opacity-60">
                ✎
              </span>
            </button>
            {openIdx === i && (
              <LiftPopover>
                {lifts.length > 1 && (
                  <>
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
                      Reorder
                    </div>
                    <PopoverItem
                      disabled={i === 0}
                      onClick={() => moveBy(i, -1)}
                    >
                      ← Move left
                    </PopoverItem>
                    <PopoverItem
                      disabled={i === lifts.length - 1}
                      onClick={() => moveBy(i, 1)}
                    >
                      Move right →
                    </PopoverItem>
                  </>
                )}
                {alternatives.length > 0 && (
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
                    Swap to
                  </div>
                )}
                {alternatives.map((l) => (
                  <PopoverItem key={l} onClick={() => swapAt(i, l)}>
                    {liftLabel(l)}
                  </PopoverItem>
                ))}
                <PopoverItem danger onClick={() => removeAt(i)}>
                  Remove
                </PopoverItem>
              </LiftPopover>
            )}
          </div>
        );
      })}

      {canAdd && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenIdx(openIdx === 'add' ? null : 'add')}
            aria-haspopup="menu"
            aria-expanded={openIdx === 'add'}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-transparent px-3 py-1 text-xs text-muted hover:border-accent hover:text-fg"
          >
            + Add lift
          </button>
          {openIdx === 'add' && (
            <LiftPopover>
              {ALL_MAIN_LIFTS.filter((l) => !lifts.includes(l)).map((l) => (
                <PopoverItem key={l} onClick={() => addLift(l)}>
                  {liftLabel(l)}
                </PopoverItem>
              ))}
            </LiftPopover>
          )}
        </div>
      )}
    </div>
  );
}

function AmrapOverrideEditor({
  lifts,
  value,
  onChange,
}: {
  lifts: MainLift[];
  value: Partial<Record<MainLift, number[]>> | undefined;
  onChange: (next: Partial<Record<MainLift, number[]>> | undefined) => void;
}) {
  // 5/3/1 main work is always 3 working sets across both schemes; expose set 1/2/3 toggles.
  const SET_INDICES = [0, 1, 2] as const;

  const overrideCount = value
    ? Object.values(value).reduce((acc, arr) => acc + (arr?.length ?? 0), 0)
    : 0;
  const hasOverrides = overrideCount > 0;
  // Auto-open when overrides already exist so they remain visible/editable;
  // otherwise stay collapsed since this is a rare-use control.
  const [open, setOpen] = useState(hasOverrides);

  const toggle = (lift: MainLift, idx: number) => {
    const current = value?.[lift] ?? [];
    const has = current.includes(idx);
    const nextForLift = has
      ? current.filter((i) => i !== idx)
      : [...current, idx].sort((a, b) => a - b);
    const nextMap: Partial<Record<MainLift, number[]>> = { ...(value ?? {}) };
    if (nextForLift.length === 0) {
      delete nextMap[lift];
    } else {
      nextMap[lift] = nextForLift;
    }
    const isEmpty = Object.keys(nextMap).length === 0;
    onChange(isEmpty ? undefined : nextMap);
  };

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-fg"
      >
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}
          >
            ▸
          </span>
          AMRAP sets
          {hasOverrides && (
            <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[10px] font-semibold tabular-nums text-amber-200 ring-1 ring-amber-500/40">
              {overrideCount}
            </span>
          )}
        </span>
        <span className="text-[10px] font-normal normal-case tracking-normal text-muted">
          {hasOverrides ? 'override active' : 'use scheme default'}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          <div className="text-[10px] text-muted">
            Force AMRAP on a working set (overrides scheme).
          </div>
          <div className="space-y-1">
            {lifts.map((lift) => {
          const liftSelected = value?.[lift] ?? [];
          return (
            <div key={lift} className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 truncate text-muted">{liftLabel(lift)}</span>
              <div className="flex gap-1">
                {SET_INDICES.map((idx) => {
                  const on = liftSelected.includes(idx);
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => toggle(lift, idx)}
                      aria-pressed={on}
                      title={`Set ${idx + 1}: ${on ? 'AMRAP enabled — tap to clear' : 'tap to mark AMRAP'}`}
                      className={[
                        'rounded-md px-2 py-0.5 text-[11px] font-semibold tabular-nums ring-1 transition-colors',
                        on
                          ? 'bg-amber-500/20 text-amber-200 ring-amber-500/40'
                          : 'bg-card text-muted ring-border hover:text-fg',
                      ].join(' ')}
                    >
                      Set {idx + 1}
                      {on ? '+' : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
          </div>
        </div>
      )}
    </div>
  );
}

function LiftPopover({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="menu"
      className="absolute left-0 top-full z-20 mt-1 min-w-[7rem] rounded-lg border border-border bg-card p-1 text-xs shadow-xl"
    >
      {children}
    </div>
  );
}

function PopoverItem({
  onClick,
  danger,
  disabled,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`block w-full rounded px-2 py-1.5 text-left ${
        disabled
          ? 'cursor-not-allowed text-muted/50'
          : danger
          ? 'text-red-300 hover:bg-red-600/15'
          : 'text-fg hover:bg-bg'
      }`}
    >
      {children}
    </button>
  );
}

// Build the per-week main-lift wave preview lines for the day card. Returns
// just the active week's line. Seventh-week blocks render the variant's
// canonical wave preview.
function mainWaveLines({
  blockKind,
  mainScheme,
  seventhWeekKind,
  amrapMainIndices,
  scope,
}: {
  blockKind: ProgramBlock['kind'];
  mainScheme?: MainScheme;
  seventhWeekKind?: SeventhWeekKind;
  amrapMainIndices?: readonly number[];
  scope: WendlerWeek;
}): Array<{ label: string; sets: string }> {
  if (blockKind === 'seventh-week') {
    const kind: SeventhWeekKind = seventhWeekKind ?? 'deload';
    const variant = SEVENTH_WEEK_VARIANTS[kind];
    return [{ label: variant.title, sets: variant.wavePreview }];
  }
  const scheme: MainScheme = mainScheme ?? 'classic-531';
  const overrideSet = new Set(amrapMainIndices ?? []);
  const fmtSet = (pct: number, reps: number, isAmrap: boolean) =>
    `${Math.round(pct * 100)}×${reps}${isAmrap ? '+' : ''}`;
  const formatWave = (week: WendlerWeek): string => {
    const wave = WAVES[week];
    if (!wave || wave.length === 0) return '';
    return wave
      .map((s, i) => {
        if (week === 'deload') return fmtSet(s.percent, s.reps, false);
        if (scheme === '5s-pro') {
          const isAmrap = overrideSet.has(i);
          return fmtSet(s.percent, 5, isAmrap);
        }
        const isAmrap = !!s.isAmrap || overrideSet.has(i);
        return fmtSet(s.percent, s.reps, isAmrap);
      })
      .join(' · ');
  };
  if (scope === 'deload') {
    return [{ label: 'Deload', sets: formatWave('deload') }];
  }
  if (scope === '7w') {
    // Reachable only on seventh-week blocks, which we've already handled above.
    return [];
  }
  return [{ label: `Wk ${scope}`, sets: formatWave(scope) }];
}

function supplementalPctBadges(
  template: SupplementalTemplateId,
  scope: WendlerWeek,
): Array<{ label: string; pct: string }> {
  const fmt = (pcts: number[]) => `${pcts.map((p) => Math.round(p * 100)).join('/')}%`;
  const pcts = supplementalPercentages(template, scope);
  if (pcts.length === 0) return [];
  return [{ label: '@', pct: `${fmt(pcts)} TM` }];
}

function IconBtn({
  children,
  onClick,
  disabled,
  label,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`rounded bg-bg px-2 py-1 text-xs ring-1 ring-border disabled:opacity-30 ${
        danger ? 'text-red-300 hover:bg-red-900/20' : 'text-fg'
      }`}
    >
      {children}
    </button>
  );
}
