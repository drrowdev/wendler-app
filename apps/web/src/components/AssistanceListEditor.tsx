'use client';

// Compact, expand-on-tap editor for an AssistanceEntry list. Inspired by
// hardy.app: each entry is a single line at rest (movement + equipment +
// "3×10"), and clicking the row reveals the inline editor. The editor is
// minimal — a single prescription text input that parses formats like
// "3x10", "3x8-10", "5x30 sec", "3x10 each side". Notes / load hint are
// hidden behind small text links.

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { nanoid } from 'nanoid';
import {
  categoryFromMovement,
  formatAssistancePrescription,
  parseAssistancePrescription,
  type AssistanceEntry,
} from '@wendler/domain';
import type { Movement } from '@wendler/db-schema';
import { MovementCombobox } from './MovementCombobox';

interface AssistanceListEditorProps {
  entries: AssistanceEntry[];
  movements: Movement[];
  onChange: (next: AssistanceEntry[]) => void;
  disabled?: boolean;
  emptyHint?: string;
}

export function AssistanceListEditor({
  entries,
  movements,
  onChange,
  disabled,
  emptyHint = 'No assistance entries yet.',
}: AssistanceListEditorProps) {
  // The id of the entry whose inline editor is currently open. Newly-added
  // entries are auto-opened so the user can fill them in.
  const [openId, setOpenId] = useState<string | null>(null);

  // Optimistic local mirror of the entries list. Mutators update this
  // synchronously so the UI reflects the change immediately, regardless of
  // how long the parent's debounced save takes to round-trip the new list
  // back as a fresh `entries` prop.
  //
  // Without this, fast user input (rapid deletes, fast typing) computes its
  // next state from a stale prop and ends up clobbering preceding edits —
  // deleted entries reappear, typed characters get dropped.
  const [localEntries, setLocalEntries] = useState<AssistanceEntry[]>(entries);
  // The most recent value we emitted upstream. We use this to distinguish
  // an inbound prop update that's just an echo of our own write from a
  // genuine external change (sync/reload/programmatic edit) that should
  // overwrite our local draft.
  const lastEmittedRef = useRef<AssistanceEntry[]>(entries);

  useEffect(() => {
    if (entriesEqual(entries, lastEmittedRef.current)) return;
    setLocalEntries(entries);
    lastEmittedRef.current = entries;
  }, [entries]);

  const emit = (next: AssistanceEntry[]) => {
    setLocalEntries(next);
    lastEmittedRef.current = next;
    onChange(next);
  };

  const addEntry = () => {
    const next: AssistanceEntry = {
      id: nanoid(),
      category: 'other',
      movementName: '',
      sets: 3,
      reps: 10,
    };
    emit([...localEntries, next]);
    setOpenId(next.id);
  };

  const updateEntry = (id: string, patch: Partial<AssistanceEntry>) => {
    emit(localEntries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const removeEntry = (id: string) => {
    emit(localEntries.filter((e) => e.id !== id));
    if (openId === id) setOpenId(null);
  };

  const moveEntryTo = (fromIndex: number, toIndex: number) => {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= localEntries.length ||
      toIndex >= localEntries.length
    ) {
      return;
    }
    const arr = localEntries.slice();
    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, moved!);
    emit(arr);
  };

  // Drag-and-drop reorder via the per-row grip handle.
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
    if (dragIdx !== null) moveEntryTo(dragIdx, i);
    setDragIdx(null);
    setDropIdx(null);
  };
  const onDragEnd = () => {
    setDragIdx(null);
    setDropIdx(null);
  };

  return (
    <div className="space-y-1">
      {localEntries.length === 0 && (
        <p className="rounded-lg border border-dashed border-border bg-bg p-3 text-xs text-muted">
          {emptyHint}
        </p>
      )}

      {localEntries.map((entry, i) => (
        <AssistanceEntryRow
          key={entry.id}
          entry={entry}
          movements={movements}
          isOpen={openId === entry.id}
          onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
          onUpdate={(patch) => updateEntry(entry.id, patch)}
          onRemove={() => removeEntry(entry.id)}
          disabled={disabled}
          isDragging={dragIdx === i}
          isDropTarget={dropIdx === i && dragIdx !== null && dragIdx !== i}
          onDragStart={onDragStart(i)}
          onDragOver={onDragOver(i)}
          onDrop={onDrop(i)}
          onDragEnd={onDragEnd}
        />
      ))}

      {!disabled && (
        <button
          type="button"
          onClick={addEntry}
          className="mt-2 w-full rounded-lg border border-dashed border-border bg-bg py-2 text-sm text-muted hover:border-accent hover:text-fg"
        >
          + Add exercise
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural equality helper for the entries-prop sync. We can't use
// reference equality because the parent rebuilds the array on every render,
// and we can't shallow-compare objects because the InlineEditor mutates many
// fields (notes, loadHint, sets, reps, isAmrap, …). JSON.stringify is fine
// here — assistance lists are short (a handful of entries with ~10 scalar
// fields each) and the comparison runs at most once per parent render.
function entriesEqual(a: AssistanceEntry[], b: AssistanceEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Single row: collapsed = one line, expanded = inline editor.

interface AssistanceEntryRowProps {
  entry: AssistanceEntry;
  movements: Movement[];
  isOpen: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<AssistanceEntry>) => void;
  onRemove: () => void;
  disabled?: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}

function AssistanceEntryRow({
  entry,
  movements,
  isOpen,
  onToggle,
  onUpdate: rawOnUpdate,
  onRemove,
  disabled,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: AssistanceEntryRowProps) {
  const equipment = movements.find((m) => m.id === entry.movementId)?.equipment;
  const prescription = formatAssistancePrescription(entry);

  // Any edit that changes what the entry IS (movement, sets, reps, AMRAP,
  // unit) invalidates the suggester's rationale — drop it so we don't leave a
  // stale ✨ chip describing something that no longer matches.
  const onUpdate = (patch: Partial<AssistanceEntry>) => {
    const RATIONALE_INVALIDATING: (keyof AssistanceEntry)[] = [
      'movementId',
      'movementName',
      'sets',
      'reps',
      'repsMax',
      'isAmrap',
      'unit',
      'category',
    ];
    if (entry.suggestionRationale && RATIONALE_INVALIDATING.some((k) => k in patch)) {
      rawOnUpdate({ ...patch, suggestionRationale: undefined });
    } else {
      rawOnUpdate(patch);
    }
  };

  const onMovementSelect = (m: Movement) => {
    onUpdate({
      movementId: m.id,
      movementName: m.name,
      category: categoryFromMovement(m),
    });
  };
  const onMovementNameChange = (val: string) => {
    onUpdate({ movementId: undefined, movementName: val });
  };

  return (
    <div
      className={`rounded-lg border bg-card transition-all ${
        isOpen ? 'border-accent/60' : 'border-border'
      } ${disabled ? 'opacity-50 pointer-events-none' : ''} ${
        isDragging ? 'opacity-50' : ''
      } ${isDropTarget ? 'ring-2 ring-accent' : ''}`}
      onDragOver={disabled ? undefined : onDragOver}
      onDrop={disabled ? undefined : onDrop}
    >
      {/* Header row — combobox input always visible; type to filter the
          movement library, click chevron / row to toggle inline editor. */}
      <div className="flex w-full items-center gap-2 px-3 py-2">
        {!disabled && (
          <span
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            aria-label="Drag to reorder"
            title="Drag to reorder"
            className="select-none text-muted/60 cursor-grab active:cursor-grabbing"
          >
            ⋮⋮
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
          className="text-muted/60 text-xs hover:text-fg"
        >
          {isOpen ? '▾' : '▸'}
        </button>
        <div className="flex-1 min-w-0">
          <MovementCombobox
            movements={movements}
            selectedId={entry.movementId}
            name={entry.movementName}
            onSelect={(m) => {
              onMovementSelect(m);
              if (!isOpen) onToggle();
            }}
            onChangeName={(val) => {
              onMovementNameChange(val);
              if (val.trim() && !isOpen) onToggle();
            }}
            placeholder="Tap to add exercise…"
            disabled={disabled}
            autoFocus={isOpen && !entry.movementName}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted">{prescription}</span>
        {!disabled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            aria-label="Remove exercise"
            title="Remove exercise"
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted/60 hover:bg-red-600/15 hover:text-red-300"
          >
            ✕
          </button>
        )}
      </div>

      {entry.suggestionRationale && (
        <div className="px-3 pb-2 -mt-1">
          <p
            className="block w-full whitespace-normal break-words rounded bg-sky-500/10 px-1.5 py-1 text-[11px] leading-snug text-sky-300/90 ring-1 ring-sky-500/30"
            title="Why this was suggested. Edits clear this hint."
          >
            ✨ {entry.suggestionRationale}
          </p>
        </div>
      )}

      {isOpen && (
        <InlineEditor
          entry={entry}
          onUpdate={onUpdate}
          equipmentBadge={equipment}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded inline editor: prescription input + optional notes (toggle).
// Movement selection is handled in the row header combobox above.

interface InlineEditorProps {
  entry: AssistanceEntry;
  onUpdate: (patch: Partial<AssistanceEntry>) => void;
  equipmentBadge?: string;
}

function InlineEditor({
  entry,
  onUpdate,
  equipmentBadge,
}: InlineEditorProps) {
  const [showNotes, setShowNotes] = useState(!!entry.notes || !!entry.loadHint);

  return (
    <div className="space-y-2 border-t border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <PrescriptionInput entry={entry} onUpdate={onUpdate} />
        <span className="text-[11px] text-muted">e.g. 3×10, 3×8-10, 3×8+, 5×30 sec</span>
        {equipmentBadge && (
          <span className="ml-auto rounded bg-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
            {equipmentBadge}
          </span>
        )}
      </div>

      {showNotes && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input
            value={entry.loadHint ?? ''}
            onChange={(e) =>
              onUpdate({ loadHint: e.target.value.trim() ? e.target.value : undefined })
            }
            placeholder="Load (heavy / bw / 50%)"
            className="rounded border border-border bg-bg px-2 py-1.5 text-sm"
            aria-label="Load hint"
          />
          <input
            value={entry.notes ?? ''}
            onChange={(e) =>
              onUpdate({ notes: e.target.value.trim() ? e.target.value : undefined })
            }
            placeholder="Notes (cues, tempo, …)"
            className="rounded border border-border bg-bg px-2 py-1.5 text-sm"
            aria-label="Notes"
          />
        </div>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted hover:text-fg">
        <input
          type="checkbox"
          checked={!!entry.isAmrap}
          onChange={(e) => onUpdate({ isAmrap: e.target.checked || undefined })}
          className="h-3.5 w-3.5 accent-accent"
          aria-label="Last set AMRAP"
        />
        <span>
          AMRAP
          <span className="ml-1 text-muted/70">
            — take any set to max reps ({formatAssistancePrescription({
              ...entry,
              isAmrap: true,
            })})
          </span>
        </span>
      </label>

      <div className="flex items-center justify-between text-xs text-muted">
        <button
          type="button"
          onClick={() => setShowNotes((v) => !v)}
          className="hover:text-fg"
        >
          {showNotes ? '− hide load / notes' : '+ load / notes'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single text field that parses "3x10" / "3x8-10" / "5x30 sec" / "3x10 each side"
// and writes the parsed values back to the entry. Invalid input is rejected
// silently (the field stays focused so the user can fix it) and a small
// warning dot appears next to the input.

function PrescriptionInput({
  entry,
  onUpdate,
}: {
  entry: AssistanceEntry;
  onUpdate: (patch: Partial<AssistanceEntry>) => void;
}) {
  // Local text state lets the user type without us forcing a reformat on
  // every keystroke. We commit on blur (or Enter), and keep local state in
  // sync if the entry mutates from outside.
  const [text, setText] = useState(formatAssistancePrescription(entry));
  const [invalid, setInvalid] = useState(false);
  const lastFormattedRef = useRef(text);

  useEffect(() => {
    const next = formatAssistancePrescription(entry);
    if (next !== lastFormattedRef.current) {
      setText(next);
      lastFormattedRef.current = next;
      setInvalid(false);
    }
  }, [entry.sets, entry.reps, entry.repsMax, entry.unit, entry.isAmrap]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => {
    if (text.trim() === lastFormattedRef.current.trim()) return;
    const parsed = parseAssistancePrescription(text);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onUpdate({
      sets: parsed.sets,
      reps: parsed.reps,
      repsMax: parsed.repsMax,
      unit: parsed.unit,
      isAmrap: parsed.isAmrap,
    });
  };

  return (
    <div className="flex items-center gap-1">
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (invalid) setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="3×10"
        aria-label="Prescription"
        className={`w-32 rounded border bg-bg px-2 py-1.5 text-sm tabular-nums ${
          invalid ? 'border-red-500 text-red-300' : 'border-border'
        }`}
      />
      {invalid && (
        <span className="text-[10px] text-red-400" title="Couldn't parse — try 3×10 or 3×8-10">
          ?
        </span>
      )}
    </div>
  );
}
