'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { WarmupBlockDef } from '@wendler/db-schema';
import {
  DEFAULT_PRE_LIFTING_WARMUP_BLOCKS,
  displayDuration,
} from '@wendler/db-schema';
import { nanoid } from 'nanoid';

interface DayCombo {
  /** Canonical lift-set key (lifts sorted alphabetically + joined by '+'). */
  key: string;
  /** Human label for the dropdown. */
  label: string;
}

interface WarmupEditorProps {
  /** Current persisted blocks; undefined → "use built-in defaults". */
  initialBlocks?: WarmupBlockDef[];
  /**
   * Day combinations derived from the user's active program / schedule.
   * Drives the per-block "Applies to" dropdown so the user picks from
   * actual training-day lift combos rather than a fixed press/lower split.
   */
  dayCombos: DayCombo[];
  /**
   * The user's saved-default snapshot, if any. When present, the
   * "Reset to my default" button restores from it.
   */
  userDefaultBlocks?: WarmupBlockDef[];
  /** Called whenever the user edits the working draft (parent mirror). */
  onChange: (blocks: WarmupBlockDef[]) => void;
  /**
   * Auto-save sink. Called for every edit; the parent persists straight
   * to the local DB (and kicks a sync). Mirrors the BlockPlanEditor
   * pattern: structural changes (add/remove/reorder/reset) are written
   * immediately; inline-typing changes are debounced ~400ms so a burst
   * of keystrokes coalesces into one write.
   */
  onAutoSave: (blocks: WarmupBlockDef[]) => void | Promise<void>;
  /** Save the current working draft as the user's "my default" snapshot. */
  onSaveAsUserDefault: () => void;
}

function clone(blocks: WarmupBlockDef[]): WarmupBlockDef[] {
  return blocks.map((b) => ({ ...b, movements: b.movements.map((m) => ({ ...m })) }));
}

/** Friendly labels for legacy `appliesTo` values still on persisted blocks. */
function legacyLabel(value: string): string | undefined {
  if (value === 'press') return 'Bench / press days (legacy)';
  if (value === 'lower') return 'Squat / deadlift days (legacy)';
  return undefined;
}

/** Move arr[from] to arr[to] in-place. */
function moveInPlace<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
  const [item] = arr.splice(from, 1);
  if (item === undefined) return arr;
  arr.splice(to, 0, item);
  return arr;
}

export function WarmupEditor({
  initialBlocks,
  dayCombos,
  userDefaultBlocks,
  onChange,
  onAutoSave,
  onSaveAsUserDefault,
}: WarmupEditorProps) {
  const [blocks, setBlocks] = useState<WarmupBlockDef[]>(() =>
    clone(initialBlocks ?? DEFAULT_PRE_LIFTING_WARMUP_BLOCKS),
  );

  // Re-seed the working draft when the persisted source changes (e.g.
  // Cancel from edit mode reloads settings). Keyed on JSON to avoid
  // spurious resets from new array refs with identical data.
  const initialKey = useMemo(() => JSON.stringify(initialBlocks ?? null), [initialBlocks]);
  useEffect(() => {
    setBlocks(clone(initialBlocks ?? DEFAULT_PRE_LIFTING_WARMUP_BLOCKS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  // ──────────────────────────────────────────────────────────────────
  // Auto-save plumbing — same shape as BlockPlanEditor: a draftRef holds
  // the latest value; structural edits flush immediately, inline edits
  // are debounced 400ms; pagehide/visibilitychange/unmount flush the
  // pending value so navigating away mid-typing never loses work.
  // ──────────────────────────────────────────────────────────────────
  const onAutoSaveRef = useRef(onAutoSave);
  useEffect(() => {
    onAutoSaveRef.current = onAutoSave;
  }, [onAutoSave]);
  const draftRef = useRef<WarmupBlockDef[] | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback((next: WarmupBlockDef[]) => {
    void onAutoSaveRef.current(next);
  }, []);
  const flushNow = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = draftRef.current;
    draftRef.current = null;
    if (pending) persist(pending);
  }, [persist]);
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

  /** Apply a mutation. `immediate=true` writes through right away
   *  (structural changes); otherwise we debounce so a burst of keystrokes
   *  collapses into one write ~400ms after typing stops. */
  const update = (next: WarmupBlockDef[], immediate = true) => {
    setBlocks(next);
    onChange(next);
    draftRef.current = next;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (immediate) {
      draftRef.current = null;
      persist(next);
    } else {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        draftRef.current = null;
        persist(next);
      }, 400);
    }
  };

  // ──────────────────────────────────────────────────────────────────
  // Block-level drag-and-drop reorder. Mirrors the pattern in
  // AssistanceListEditor.tsx so reorder feels identical across the app:
  // grip handle ⋮⋮ on the row, opacity-50 on the dragged row,
  // ring-2 ring-accent on the drop target.
  // ──────────────────────────────────────────────────────────────────
  const [dragBlockIdx, setDragBlockIdx] = useState<number | null>(null);
  const [dropBlockIdx, setDropBlockIdx] = useState<number | null>(null);
  const onBlockDragStart = (i: number) => (e: DragEvent) => {
    setDragBlockIdx(i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `block:${i}`);
  };
  const onBlockDragOver = (i: number) => (e: DragEvent) => {
    if (dragBlockIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropBlockIdx !== i) setDropBlockIdx(i);
  };
  const onBlockDrop = (i: number) => (e: DragEvent) => {
    e.preventDefault();
    if (dragBlockIdx !== null && dragBlockIdx !== i) {
      const next = clone(blocks);
      moveInPlace(next, dragBlockIdx, i);
      update(next);
    }
    setDragBlockIdx(null);
    setDropBlockIdx(null);
  };
  const onBlockDragEnd = () => {
    setDragBlockIdx(null);
    setDropBlockIdx(null);
  };

  // ──────────────────────────────────────────────────────────────────
  // Movement-level DnD. Constrained to the source block — dragging a
  // movement out of its block has no effect (drop is ignored on a
  // foreign-block target).
  // ──────────────────────────────────────────────────────────────────
  const [dragMv, setDragMv] = useState<{ bIdx: number; mIdx: number } | null>(null);
  const [dropMv, setDropMv] = useState<{ bIdx: number; mIdx: number } | null>(null);
  const onMvDragStart = (bIdx: number, mIdx: number) => (e: DragEvent) => {
    setDragMv({ bIdx, mIdx });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `mv:${bIdx}:${mIdx}`);
    // Don't bubble: the movement <li> sits inside the block container,
    // which also has its own dragstart handler on the grip.
    e.stopPropagation();
  };
  const onMvDragOver = (bIdx: number, mIdx: number) => (e: DragEvent) => {
    if (!dragMv || dragMv.bIdx !== bIdx) return; // only same-block drops
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!dropMv || dropMv.bIdx !== bIdx || dropMv.mIdx !== mIdx) {
      setDropMv({ bIdx, mIdx });
    }
  };
  const onMvDrop = (bIdx: number, mIdx: number) => (e: DragEvent) => {
    if (!dragMv || dragMv.bIdx !== bIdx) {
      setDragMv(null);
      setDropMv(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (dragMv.mIdx !== mIdx) {
      const next = clone(blocks);
      const block = next[bIdx];
      if (block) {
        moveInPlace(block.movements, dragMv.mIdx, mIdx);
        update(next);
      }
    }
    setDragMv(null);
    setDropMv(null);
  };
  const onMvDragEnd = () => {
    setDragMv(null);
    setDropMv(null);
  };

  const patchBlock = (idx: number, patch: Partial<WarmupBlockDef>) => {
    const next = clone(blocks);
    const cur = next[idx];
    if (!cur) return;
    next[idx] = { ...cur, ...patch };
    update(next, false);
  };

  const removeBlock = (idx: number) => {
    const next = clone(blocks);
    next.splice(idx, 1);
    update(next);
  };

  const addBlock = () => {
    update([
      ...clone(blocks),
      {
        id: nanoid(),
        title: 'New block',
        appliesTo: 'always',
        movements: [{ id: nanoid(), name: '', dose: '' }],
      },
    ]);
  };

  const patchMovement = (
    bIdx: number,
    mIdx: number,
    patch: Partial<WarmupBlockDef['movements'][number]>,
  ) => {
    const next = clone(blocks);
    const block = next[bIdx];
    const mv = block?.movements[mIdx];
    if (!block || !mv) return;
    block.movements[mIdx] = { ...mv, ...patch };
    update(next, false);
  };

  const removeMovement = (bIdx: number, mIdx: number) => {
    const next = clone(blocks);
    const block = next[bIdx];
    if (!block) return;
    block.movements.splice(mIdx, 1);
    update(next);
  };

  const addMovement = (bIdx: number) => {
    const next = clone(blocks);
    const block = next[bIdx];
    if (!block) return;
    block.movements.push({ id: nanoid(), name: '', dose: '' });
    update(next);
  };

  const resetToDefaults = () => {
    // Single "Reset to defaults" button: prefers the user's saved snapshot
    // when present, otherwise falls back to the hardcoded built-in defaults
    // (which are also the bootstrap state on a fresh install).
    const target = userDefaultBlocks ?? DEFAULT_PRE_LIFTING_WARMUP_BLOCKS;
    const isUser = !!userDefaultBlocks;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        isUser
          ? 'Restore your saved "my default" warm-up? Your current edits will be replaced.'
          : 'Reset warm-up to the built-in defaults? Your current blocks will be replaced.',
      )
    ) {
      return;
    }
    update(clone(target));
  };

  const saveAsUserDefault = () => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Save the current warm-up as your default snapshot? It will be saved immediately and overwrite any previous snapshot.',
      )
    ) {
      return;
    }
    onSaveAsUserDefault();
  };

  // Build the per-block "Applies to" option set:
  //  - "Every day" (always)
  //  - one entry per actual program day combo (deduped)
  //  - any orphaned values currently saved on a block but no longer in the
  //    schedule, shown with an "(unused)" / legacy suffix so they remain
  //    visible until the user changes them.
  const comboOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [{ value: 'always', label: 'Every day' }];
    for (const c of dayCombos) {
      if (!c.key || seen.has(c.key)) continue;
      seen.add(c.key);
      opts.push({ value: c.key, label: c.label });
    }
    const knownValues = new Set(opts.map((o) => o.value));
    for (const b of blocks) {
      const v = b.appliesTo ?? 'always';
      if (knownValues.has(v)) continue;
      const legacy = legacyLabel(v);
      opts.push({ value: v, label: legacy ?? `${v} (no longer in schedule)` });
      knownValues.add(v);
    }
    return opts;
  }, [dayCombos, blocks]);

  return (
    <div className="space-y-3">
      <p className="text-xs leading-snug text-muted">
        Blocks render top-to-bottom on /day. Drag the{' '}
        <span className="select-none text-muted/60">⋮⋮</span> handle to reorder blocks or
        movements within a block. <em>Applies to</em> filters by the day&apos;s main lifts:{' '}
        <code className="rounded bg-bg px-1 py-0.5 ring-1 ring-border">Every day</code> always
        shows; specific combos (e.g.{' '}
        <code className="rounded bg-bg px-1 py-0.5 ring-1 ring-border">Bench + Deadlift</code>)
        only on days whose main lifts match exactly. Duration is auto-estimated from the
        movements; press <em>Override</em> on a block to set it manually.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={saveAsUserDefault}
          className="rounded-lg border border-border bg-bg px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg"
        >
          ★ Save current as default
        </button>
        <button
          type="button"
          onClick={resetToDefaults}
          title={
            userDefaultBlocks
              ? 'Restore your saved "my default" snapshot'
              : 'Restore the built-in defaults (no personal snapshot saved yet)'
          }
          className="rounded-lg border border-border bg-bg px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg"
        >
          ↺ Reset to defaults
        </button>
      </div>

      <div className="space-y-3">
        {blocks.map((b, bIdx) => (
          <BlockEditor
            key={b.id}
            block={b}
            comboOptions={comboOptions}
            isDragging={dragBlockIdx === bIdx}
            isDropTarget={
              dropBlockIdx === bIdx && dragBlockIdx !== null && dragBlockIdx !== bIdx
            }
            onBlockDragStart={onBlockDragStart(bIdx)}
            onBlockDragOver={onBlockDragOver(bIdx)}
            onBlockDrop={onBlockDrop(bIdx)}
            onBlockDragEnd={onBlockDragEnd}
            onPatch={(patch) => patchBlock(bIdx, patch)}
            onRemove={() => removeBlock(bIdx)}
            onPatchMovement={(mIdx, patch) => patchMovement(bIdx, mIdx, patch)}
            onRemoveMovement={(mIdx) => removeMovement(bIdx, mIdx)}
            onAddMovement={() => addMovement(bIdx)}
            onMvDragStart={(mIdx) => onMvDragStart(bIdx, mIdx)}
            onMvDragOver={(mIdx) => onMvDragOver(bIdx, mIdx)}
            onMvDrop={(mIdx) => onMvDrop(bIdx, mIdx)}
            onMvDragEnd={onMvDragEnd}
            isMvDragging={(mIdx) => dragMv?.bIdx === bIdx && dragMv?.mIdx === mIdx}
            isMvDropTarget={(mIdx) =>
              dropMv?.bIdx === bIdx &&
              dropMv?.mIdx === mIdx &&
              dragMv?.bIdx === bIdx &&
              dragMv?.mIdx !== mIdx
            }
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addBlock}
        className="w-full rounded-lg border border-dashed border-border bg-card px-3 py-2 text-sm text-muted hover:border-accent hover:text-fg"
      >
        + Add block
      </button>
    </div>
  );
}

interface BlockEditorProps {
  block: WarmupBlockDef;
  comboOptions: { value: string; label: string }[];
  isDragging: boolean;
  isDropTarget: boolean;
  onBlockDragStart: (e: DragEvent) => void;
  onBlockDragOver: (e: DragEvent) => void;
  onBlockDrop: (e: DragEvent) => void;
  onBlockDragEnd: () => void;
  onPatch: (patch: Partial<WarmupBlockDef>) => void;
  onRemove: () => void;
  onPatchMovement: (
    mIdx: number,
    patch: Partial<WarmupBlockDef['movements'][number]>,
  ) => void;
  onRemoveMovement: (mIdx: number) => void;
  onAddMovement: () => void;
  onMvDragStart: (mIdx: number) => (e: DragEvent) => void;
  onMvDragOver: (mIdx: number) => (e: DragEvent) => void;
  onMvDrop: (mIdx: number) => (e: DragEvent) => void;
  onMvDragEnd: () => void;
  isMvDragging: (mIdx: number) => boolean;
  isMvDropTarget: (mIdx: number) => boolean;
}

function BlockEditor({
  block,
  comboOptions,
  isDragging,
  isDropTarget,
  onBlockDragStart,
  onBlockDragOver,
  onBlockDrop,
  onBlockDragEnd,
  onPatch,
  onRemove,
  onPatchMovement,
  onRemoveMovement,
  onAddMovement,
  onMvDragStart,
  onMvDragOver,
  onMvDrop,
  onMvDragEnd,
  isMvDragging,
  isMvDropTarget,
}: BlockEditorProps) {
  const hasOverride = block.durationOverride != null && block.durationOverride !== '';
  const [showOverride, setShowOverride] = useState(hasOverride);

  return (
    <div
      onDragOver={onBlockDragOver}
      onDrop={onBlockDrop}
      className={`space-y-2 rounded-lg border bg-bg/40 p-3 transition-all ${
        isDropTarget ? 'border-transparent ring-2 ring-accent' : 'border-border'
      } ${isDragging ? 'opacity-50' : ''}`}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto,1fr,11rem,auto]">
        <span
          draggable
          onDragStart={onBlockDragStart}
          onDragEnd={onBlockDragEnd}
          aria-label="Drag block to reorder"
          title="Drag to reorder"
          className="flex select-none items-center px-1 text-muted/60 cursor-grab active:cursor-grabbing"
        >
          ⋮⋮
        </span>
        <input
          type="text"
          value={block.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          placeholder="Title (e.g. Mobility)"
          aria-label="Block title"
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        />
        <select
          value={block.appliesTo ?? 'always'}
          onChange={(e) => onPatch({ appliesTo: e.target.value })}
          aria-label="Applies to"
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          {comboOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove block"
          className="rounded-md border border-border bg-card px-2 py-1 text-xs text-rose-400 hover:border-rose-400"
        >
          ✕
        </button>
      </div>

      <input
        type="text"
        value={block.note ?? ''}
        onChange={(e) => onPatch({ note: e.target.value || undefined })}
        placeholder="Optional note (shown under the title)"
        aria-label="Block note"
        className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm text-muted"
      />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-bg px-2 py-0.5 font-medium tabular-nums text-muted ring-1 ring-border">
          {displayDuration(block)}
        </span>
        {!showOverride ? (
          <button
            type="button"
            onClick={() => setShowOverride(true)}
            className="text-muted hover:text-fg"
          >
            ✎ Override
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={block.durationOverride ?? ''}
              onChange={(e) => onPatch({ durationOverride: e.target.value || undefined })}
              placeholder="e.g. ~3 min"
              aria-label="Duration override"
              className="w-28 rounded-md border border-border bg-card px-2 py-1 text-xs tabular-nums"
            />
            <button
              type="button"
              onClick={() => {
                onPatch({ durationOverride: undefined });
                setShowOverride(false);
              }}
              className="text-muted hover:text-fg"
            >
              auto
            </button>
          </div>
        )}
      </div>

      <ul className="space-y-1.5">
        {block.movements.map((m, mIdx) => {
          const dragging = isMvDragging(mIdx);
          const dropTarget = isMvDropTarget(mIdx);
          return (
            <li
              key={m.id}
              onDragOver={onMvDragOver(mIdx)}
              onDrop={onMvDrop(mIdx)}
              className={`grid grid-cols-1 gap-2 rounded-md transition-all sm:grid-cols-[auto,1fr,9rem,auto] ${
                dropTarget ? 'ring-2 ring-accent' : ''
              } ${dragging ? 'opacity-50' : ''}`}
            >
              <span
                draggable
                onDragStart={onMvDragStart(mIdx)}
                onDragEnd={onMvDragEnd}
                aria-label="Drag movement to reorder"
                title="Drag to reorder"
                className="flex select-none items-center px-1 text-muted/60 cursor-grab active:cursor-grabbing"
              >
                ⋮⋮
              </span>
              <input
                type="text"
                value={m.name}
                onChange={(e) => onPatchMovement(mIdx, { name: e.target.value })}
                placeholder="Movement"
                aria-label="Movement name"
                className="rounded-md border border-border bg-card px-2 py-1 text-sm"
              />
              <input
                type="text"
                value={m.dose ?? ''}
                onChange={(e) => onPatchMovement(mIdx, { dose: e.target.value || undefined })}
                placeholder="Dose (e.g. 2 × 10)"
                aria-label="Movement dose"
                className="rounded-md border border-border bg-card px-2 py-1 text-sm tabular-nums"
              />
              <button
                type="button"
                onClick={() => onRemoveMovement(mIdx)}
                aria-label="Remove movement"
                className="rounded-md border border-border bg-card px-2 py-1 text-xs text-rose-400 hover:border-rose-400"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={onAddMovement}
        className="rounded-md border border-dashed border-border bg-card px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg"
      >
        + Add movement
      </button>
    </div>
  );
}
