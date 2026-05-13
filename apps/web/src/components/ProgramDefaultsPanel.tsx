'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { nanoid } from 'nanoid';
import { getDb } from '@/lib/db';
import { usePrograms, useSchedule } from '@/lib/hooks';
import {
  EQUIPMENT_PRESETS,
  SUPPLEMENTAL_TEMPLATES,
  defaultSupplementalSets,
  effectiveScheduleDays,
  groupDays,
  parseWeekdayFromLabel,
  WEEKDAY_SHORT,
  type AssistanceEntry,
  type BlockDay,
  type BlockPlan,
  type EquipmentType,
  type MainLift,
  type ProgramBlock,
  type ScheduleDay,
  type SupplementalTemplateId,
} from '@wendler/domain';
import { EquipmentPicker } from './EquipmentPicker';
import { SupplementalSetsControl } from './SupplementalSetsControl';

// Reshape a non-completed block's plan so its day slots line up with the new
// program-defaults day list. Per-slot mainLifts are overwritten from the
// schedule (matching the slot-anchored model used in the panel UI). Per-day
// assistance, supplemental overrides, AMRAP overrides etc. stay attached to
// their stable dayId, so reordering schedule days carries the block's
// per-day customizations along with the lifts. Extra schedule days appear
// as fresh accessory-shaped BlockDays; removed schedule days drop the
// trailing block days and orphan their per-week overrides.
function alignBlockPlanToSchedule(plan: BlockPlan, scheduleDays: ScheduleDay[]): BlockPlan {
  const oldDays = plan.days;
  const newDays: BlockDay[] = scheduleDays.map((sd, i) => {
    const existing = oldDays[i];
    if (existing) {
      return { ...existing, mainLifts: [...sd.mainLifts] };
    }
    return { id: nanoid(), mainLifts: [...sd.mainLifts], assistance: [] };
  });
  const validIds = new Set(newDays.map((d) => d.id));
  const oldOverrides = plan.assistanceOverrides ?? {};
  const nextOverrides: Record<string, AssistanceEntry[]> = {};
  for (const [k, v] of Object.entries(oldOverrides)) {
    const dayId = k.split('|')[1];
    if (dayId && validIds.has(dayId)) nextOverrides[k] = v;
  }
  return {
    days: newDays,
    ...(Object.keys(nextOverrides).length ? { assistanceOverrides: nextOverrides } : {}),
  };
}

function plansEqual(a: BlockPlan, b: BlockPlan): boolean {
  if (a === b) return true;
  if (a.days.length !== b.days.length) return false;
  for (let i = 0; i < a.days.length; i++) {
    const x = a.days[i]!;
    const y = b.days[i]!;
    if (x.id !== y.id) return false;
    if (x.mainLifts.length !== y.mainLifts.length) return false;
    for (let j = 0; j < x.mainLifts.length; j++) {
      if (x.mainLifts[j] !== y.mainLifts[j]) return false;
    }
  }
  return true;
}

const ALL_LIFTS: MainLift[] = ['press', 'deadlift', 'bench', 'squat'];
const LIFT_LABEL: Record<MainLift, string> = {
  press: 'Press',
  deadlift: 'Deadlift',
  bench: 'Bench',
  squat: 'Squat',
};
const PANEL_OPEN_KEY = 'wendler:defaultsPanelOpen';

// "Program defaults" — cadence, per-day lift assignments, and supplemental
// scheme used as the template for *new* blocks. Existing blocks are not
// touched here; each block owns its own configuration via the block editor.
//
// Optionally accepts a `programId` so the per-program equipment defaults
// section is rendered. Without it, the equipment section is hidden.
export function ProgramDefaultsPanel({ programId }: { programId?: string } = {}) {
  const schedule = useSchedule();
  const programs = usePrograms();
  const program = programId ? programs?.find((p) => p.id === programId) : undefined;
  const [busy, setBusy] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  // Per-day lift drag state. Tracks both the day and the lift index within
  // that day so we can highlight the right pill across multiple day rows.
  const [liftDrag, setLiftDrag] = useState<{ day: number; idx: number } | null>(null);
  const [liftDrop, setLiftDrop] = useState<{ day: number; idx: number } | null>(null);
  // Collapsed by default — defaults editing is a one-time-ish concern; the
  // page hero is the blocks list. Persisted in localStorage.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      if (window.localStorage.getItem(PANEL_OPEN_KEY) === '1') setOpen(true);
    } catch {
      /* ignore storage errors */
    }
  }, []);
  const toggleOpen = () => {
    setOpen((v) => {
      const next = !v;
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(PANEL_OPEN_KEY, next ? '1' : '0');
        }
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  };
  if (!schedule) return null;

  const groups: ScheduleDay[] = effectiveScheduleDays(schedule);
  const sessionsPerWeek = groups.length;
  const supplementalTemplate: SupplementalTemplateId = schedule.supplementalTemplate ?? 'fsl';
  const supplementalSetsOverride = schedule.supplementalSetsOverride;
  const supplementalTpl = SUPPLEMENTAL_TEMPLATES.find((t) => t.id === supplementalTemplate);

  const saveAvailableEquipment = async (next: EquipmentType[]) => {
    if (!program) return;
    setBusy(true);
    try {
      await getDb().programs.update(program.id, {
        availableEquipment: [...next],
        updatedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
    }
  };

  const saveSupplemental = async (patch: {
    template?: SupplementalTemplateId;
    setsOverride?: number | undefined;
  }) => {
    setBusy(true);
    try {
      const nextTemplate = patch.template ?? supplementalTemplate;
      // When the template changes, drop any per-template sets override so the
      // user starts from the new template's default.
      const nextSets =
        patch.template !== undefined && patch.template !== supplementalTemplate
          ? undefined
          : 'setsOverride' in patch
            ? patch.setsOverride
            : supplementalSetsOverride;
      await getDb().schedule.put({
        ...schedule,
        supplementalTemplate: nextTemplate,
        supplementalSetsOverride: nextSets,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
    }
  };

  const propagateToBlocks = async (nextDays: ScheduleDay[]) => {
    const db = getDb();
    const blocks: ProgramBlock[] = await db.blocks.toArray();
    // Current + future blocks only — defaults flow into anything not yet
    // completed. Past blocks are historical record; leave them untouched.
    // Legacy blocks without an explicit `plan` derive from the schedule via
    // `effectivePlan()`, so they auto-update without a write.
    const targets = blocks.filter((b) => !b.completedAt && b.plan);
    if (targets.length === 0) return;
    const ts = new Date().toISOString();
    await db.transaction('rw', db.blocks, async () => {
      for (const b of targets) {
        const aligned = alignBlockPlanToSchedule(b.plan!, nextDays);
        if (plansEqual(b.plan!, aligned)) continue;
        await db.blocks.update(b.id, { plan: aligned, updatedAt: ts });
      }
    });
  };

  const saveGroups = async (next: ScheduleDay[]) => {
    setBusy(true);
    try {
      await getDb().schedule.put({
        ...schedule,
        dayGroups: next,
        updatedAt: new Date().toISOString(),
      });
      await propagateToBlocks(next);
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = async (n: number) => {
    setBusy(true);
    try {
      const auto: ScheduleDay[] = groupDays(schedule.dayOrder, n).map((g) => ({
        mainLifts: g,
      }));
      await getDb().schedule.put({
        ...schedule,
        liftsPerDay: n,
        dayGroups: auto,
        updatedAt: new Date().toISOString(),
      });
      await propagateToBlocks(auto);
    } finally {
      setBusy(false);
    }
  };

  const cloneGroups = (): ScheduleDay[] =>
    groups.map((d) => ({
      mainLifts: [...d.mainLifts],
      ...(d.label !== undefined ? { label: d.label } : {}),
      ...(typeof d.weekday === 'number' ? { weekday: d.weekday } : {}),
    }));

  const setWeekday = (dayIdx: number, weekday: number | null) => {
    const next = cloneGroups();
    const cur = next[dayIdx]!;
    if (weekday === null) delete cur.weekday;
    else cur.weekday = weekday;
    void saveGroups(next);
  };

  const toggleLift = (dayIdx: number, lift: MainLift) => {
    const next = cloneGroups();
    const cur = next[dayIdx]!;
    const i = cur.mainLifts.indexOf(lift);
    if (i >= 0) cur.mainLifts.splice(i, 1);
    else cur.mainLifts.push(lift);
    void saveGroups(next);
  };

  const reorderLift = (dayIdx: number, from: number, to: number) => {
    const cur = groups[dayIdx];
    if (!cur) return;
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= cur.mainLifts.length ||
      to >= cur.mainLifts.length
    ) {
      return;
    }
    const next = cloneGroups();
    const target = next[dayIdx]!;
    const [moved] = target.mainLifts.splice(from, 1);
    if (moved === undefined) return;
    target.mainLifts.splice(to, 0, moved);
    void saveGroups(next);
  };

  const onLiftDragStart = (day: number, idx: number) => (e: DragEvent) => {
    setLiftDrag({ day, idx });
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `lift:${day}:${idx}`);
  };
  const onLiftDragOver = (day: number, idx: number) => (e: DragEvent) => {
    if (!liftDrag || liftDrag.day !== day) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const cur = liftDrop;
    if (!cur || cur.day !== day || cur.idx !== idx) setLiftDrop({ day, idx });
  };
  const onLiftDrop = (day: number, idx: number) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (liftDrag && liftDrag.day === day && liftDrag.idx !== idx) {
      reorderLift(day, liftDrag.idx, idx);
    }
    setLiftDrag(null);
    setLiftDrop(null);
  };
  const onLiftDragEnd = () => {
    setLiftDrag(null);
    setLiftDrop(null);
  };

  const addDay = () => {
    void saveGroups([...cloneGroups(), { mainLifts: [] }]);
  };

  const removeDay = (dayIdx: number) => {
    const next = cloneGroups().filter((_, i) => i !== dayIdx);
    void saveGroups(next.length ? next : [{ mainLifts: [] }]);
  };

  const reorderDay = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= groups.length || to >= groups.length) return;
    // Slot-anchored reorder: weekday and label belong to the *slot* (Day 1,
    // Day 2, ...), not to the lift content. Dragging Squat+Press from Day 1
    // (Mon) over Day 2 (Thu) should leave the Mon/Thu and "Day 1"/"Day 2"
    // names in place and only shuffle the mainLifts between rows.
    const next = cloneGroups();
    const lifts = next.map((d) => d.mainLifts);
    const [movedLifts] = lifts.splice(from, 1);
    if (!movedLifts) return;
    lifts.splice(to, 0, movedLifts);
    next.forEach((d, i) => {
      d.mainLifts = lifts[i]!;
    });
    void saveGroups(next);
  };

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
    if (dragIdx !== null) reorderDay(dragIdx, i);
    setDragIdx(null);
    setDropIdx(null);
  };
  const onDragEnd = () => {
    setDragIdx(null);
    setDropIdx(null);
  };

  const summarizeDay = (g: ScheduleDay) =>
    g.mainLifts.length === 0 ? 'accessory' : g.mainLifts.map((l) => LIFT_LABEL[l]).join(' + ');

  const renameDay = (dayIdx: number, label: string) => {
    const next = cloneGroups();
    const cur = next[dayIdx]!;
    const trimmed = label.trim();
    if (trimmed) cur.label = trimmed;
    else delete cur.label;
    void saveGroups(next);
  };

  const addAccessoryDay = () => {
    void saveGroups([...cloneGroups(), { mainLifts: [], label: 'Accessory' }]);
  };

  // Preset descriptors. Active preset gets a filled accent background to
  // distinguish it unambiguously from the unselected outline state.
  const PRESETS: Array<{ n: number; label: string }> = [
    { n: 1, label: '4×/wk (1 lift)' },
    { n: 2, label: '2×/wk (pairs)' },
    { n: 4, label: '1×/wk (all)' },
  ];

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card/40 p-4">
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="-m-1 flex w-full items-start gap-2 rounded-lg p-1 text-left hover:bg-card/40"
      >
        <span aria-hidden className="mt-0.5 select-none text-muted">
          {open ? '▾' : '▸'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="text-lg font-semibold">Program defaults</h2>
            <span className="text-xs text-muted">
              {sessionsPerWeek}×/wk
              {' · '}
              {groups
                .map((g, i) =>
                  g.mainLifts.length ? summarizeDay(g) : (g.label?.trim() || `Day ${i + 1}`) + ' · accessory',
                )
                .join(', ')}
            </span>
          </div>
          {open && (
            <p className="mt-1 text-xs text-muted">
              Used as the template when you add a new block. Existing blocks keep their own settings
              — edit each block to change live training.
            </p>
          )}
        </div>
      </button>

      {!open ? null : (
        <>
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              Weekly cadence
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {PRESETS.map(({ n, label }) => {
                const expectedDays = ALL_LIFTS.length / n;
                const flat = groups.flatMap((g) => g.mainLifts);
                const matches =
                  groups.length === expectedDays &&
                  groups.every(
                    (g) => g.mainLifts.length === n && new Set(g.mainLifts).size === n,
                  ) &&
                  flat.length === ALL_LIFTS.length &&
                  ALL_LIFTS.every((l) => flat.includes(l));
                return (
                  <button
                    key={n}
                    type="button"
                    disabled={busy}
                    onClick={() => void applyPreset(n)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 disabled:opacity-50 ${
                      matches
                        ? 'bg-accent text-bg ring-accent shadow-sm'
                        : 'bg-card text-muted ring-border hover:text-fg hover:bg-card/70'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              Days &amp; lift combinations
            </div>
            <ol className="space-y-2">
              {groups.map((g, di) => (
                <li
                  key={di}
                  draggable={!busy}
                  onDragStart={onDragStart(di)}
                  onDragOver={onDragOver(di)}
                  onDrop={onDrop(di)}
                  onDragEnd={onDragEnd}
                  className={`rounded-lg border bg-bg p-2.5 transition ${
                    dragIdx === di
                      ? 'border-accent opacity-50'
                      : dropIdx === di && dragIdx !== null
                        ? 'border-accent ring-2 ring-accent/40'
                        : 'border-border'
                  } ${busy ? '' : 'cursor-grab active:cursor-grabbing'}`}
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
                      <span className="select-none text-muted" title="Drag to reorder">
                        ⋮⋮
                      </span>
                      <DayLabelEditor
                        value={g.label}
                        placeholder={`Day ${di + 1}`}
                        disabled={busy}
                        onCommit={(v) => renameDay(di, v)}
                      />
                      <WeekdayPicker
                        value={g.weekday ?? null}
                        labelFallback={parseWeekdayFromLabel(g.label)}
                        disabled={busy}
                        onChange={(w) => setWeekday(di, w)}
                      />
                      {g.mainLifts.length === 0 ? (
                        <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300 ring-1 ring-violet-500/30">
                          Accessory
                        </span>
                      ) : (
                        <span className="text-muted">· {summarizeDay(g)}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-muted">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => removeDay(di)}
                        className="rounded px-1.5 py-0.5 hover:bg-red-600/10 hover:text-red-300 disabled:opacity-30"
                        title="Remove day"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      ...g.mainLifts.map((lift, idx) => ({ lift, idx, selected: true as const })),
                      ...ALL_LIFTS.filter((l) => !g.mainLifts.includes(l)).map((lift) => ({
                        lift,
                        idx: -1,
                        selected: false as const,
                      })),
                    ].map(({ lift, idx, selected }) => {
                      const isMulti = g.mainLifts.length > 1;
                      const isDragging =
                        selected && liftDrag?.day === di && liftDrag.idx === idx;
                      const isDropTarget =
                        selected &&
                        liftDrop?.day === di &&
                        liftDrop.idx === idx &&
                        liftDrag?.day === di &&
                        liftDrag.idx !== idx;
                      return (
                        <button
                          key={`${selected ? 'sel' : 'avail'}-${lift}-${idx}`}
                          type="button"
                          disabled={busy}
                          draggable={selected && isMulti && !busy}
                          onDragStart={
                            selected && isMulti ? onLiftDragStart(di, idx) : undefined
                          }
                          onDragOver={
                            selected && isMulti ? onLiftDragOver(di, idx) : undefined
                          }
                          onDrop={selected && isMulti ? onLiftDrop(di, idx) : undefined}
                          onDragEnd={selected && isMulti ? onLiftDragEnd : undefined}
                          onClick={() => toggleLift(di, lift)}
                          title={
                            selected
                              ? isMulti
                                ? `Position ${idx + 1} — drag to reorder, click to remove`
                                : 'Click to remove'
                              : 'Click to add'
                          }
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ring-1 transition disabled:opacity-50 ${
                            selected
                              ? 'bg-violet-500 text-white ring-violet-500'
                              : 'bg-card text-muted ring-border hover:text-fg'
                          } ${isDragging ? 'opacity-50' : ''} ${
                            isDropTarget ? 'ring-2 ring-amber-300' : ''
                          } ${selected && isMulti && !busy ? 'cursor-grab active:cursor-grabbing' : ''}`}
                        >
                          {selected && isMulti && (
                            <span className="rounded bg-white/20 px-1 text-[10px] font-bold tabular-nums">
                              {idx + 1}
                            </span>
                          )}
                          {LIFT_LABEL[lift]}
                        </button>
                      );
                    })}
                  </div>
                  {g.mainLifts.length === 0 && (
                    <p className="mt-1.5 text-[11px] text-muted">
                      No main lifts — pure assistance / conditioning day. Toggle a lift above to
                      convert it to a main training day.
                    </p>
                  )}
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={addDay}
                className="rounded-lg border border-dashed border-border bg-card px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-50"
              >
                + Add training day
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={addAccessoryDay}
                className="rounded-lg border border-dashed border-violet-500/50 bg-card px-3 py-1.5 text-xs text-violet-300 hover:border-violet-400 hover:bg-violet-500/10 disabled:opacity-50"
                title="A day for assistance / conditioning work with no main lift"
              >
                + Add accessory day
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              Supplemental work
            </div>
            <div className="rounded-lg border border-border bg-bg p-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={supplementalTemplate}
                  disabled={busy}
                  onChange={(e) =>
                    void saveSupplemental({ template: e.target.value as SupplementalTemplateId })
                  }
                  className="rounded border border-border bg-card px-2 py-1 text-xs disabled:opacity-50"
                  aria-label="Supplemental template"
                >
                  {SUPPLEMENTAL_TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <SupplementalSetsControl
                  value={supplementalSetsOverride}
                  templateDefault={defaultSupplementalSets(supplementalTemplate)}
                  onChange={(next) => saveSupplemental({ setsOverride: next })}
                  ariaLabel="Supplemental sets per session"
                />
              </div>
              {supplementalTpl && (
                <p className="mt-1.5 text-xs text-muted">
                  <span className="text-fg/80">{supplementalTpl.name}.</span>{' '}
                  {supplementalTpl.description}
                </p>
              )}
            </div>
          </div>

          {program && (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                Available equipment
              </div>
              <p className="text-[11px] text-muted">
                The assistance suggester only proposes movements you can
                actually do. Bodyweight is always available regardless of
                selection.
              </p>
              <EquipmentPicker
                value={program.availableEquipment ?? [...EQUIPMENT_PRESETS[0]!.equipment]}
                onChange={(next) => void saveAvailableEquipment(next)}
                showHelp={false}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface DayLabelEditorProps {
  value?: string;
  placeholder: string;
  disabled?: boolean;
  onCommit: (next: string) => void;
}

// Click-to-edit inline label. Shows the current label (or placeholder text in
// muted style when empty) plus a small ✏ button. While editing, renders a
// compact text input that commits on Enter/blur and cancels on Escape.
function DayLabelEditor({ value, placeholder, disabled, onCommit }: DayLabelEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value ?? '');
      // Defer focus until after render so the input exists.
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, value]);

  const commit = () => {
    if ((value ?? '') !== draft) onCommit(draft);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(value ?? '');
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder={placeholder}
        maxLength={24}
        className="min-w-0 flex-1 rounded border border-accent bg-bg px-1.5 py-0.5 text-xs font-semibold text-fg outline-none ring-2 ring-accent/30"
      />
    );
  }

  const display = value?.trim() || placeholder;
  const isPlaceholder = !value?.trim();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setEditing(true)}
      title="Rename day"
      className={`inline-flex min-w-0 items-center gap-1 truncate rounded px-1 py-0.5 text-left font-semibold hover:bg-card/60 disabled:opacity-50 ${
        isPlaceholder ? 'text-muted' : 'text-fg'
      }`}
    >
      <span className="truncate">{display}</span>
      <span aria-hidden className="text-[10px] opacity-50">✎</span>
    </button>
  );
}

interface WeekdayPickerProps {
  value: number | null;
  /** When `value` is null, this is shown faded as the inferred weekday. */
  labelFallback: number | null;
  disabled?: boolean;
  onChange: (weekday: number | null) => void;
}

// Compact weekday `<select>` so the user can lock a day to e.g. Monday and
// have the Today hero render relative copy ("Today", "Tomorrow", "In N
// days"). When no explicit value is set we render an empty-but-styled value
// matching the parsed-from-label fallback, so the chip never looks blank
// when the label already says "Monday".
function WeekdayPicker({ value, labelFallback, disabled, onChange }: WeekdayPickerProps) {
  const effective = value ?? labelFallback;
  const inferred = value == null && labelFallback != null;
  return (
    <select
      value={value == null ? '' : String(value)}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === '' ? null : Number(v));
      }}
      title={
        inferred
          ? 'Inferred from the day name. Pick a weekday to lock it.'
          : 'Schedule this day on a specific weekday'
      }
      aria-label="Weekday"
      className={`shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] font-medium disabled:opacity-50 ${
        effective == null ? 'text-muted' : inferred ? 'text-muted' : 'text-fg'
      }`}
    >
      <option value="">— day —</option>
      {WEEKDAY_SHORT.map((label, i) => (
        <option key={i} value={i}>
          {label}
        </option>
      ))}
    </select>
  );
}

