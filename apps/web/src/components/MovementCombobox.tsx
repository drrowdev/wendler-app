'use client';

// MovementCombobox — typeahead picker over the Movement library. The user
// types a name (e.g. "dead") and gets a filtered dropdown of matches with the
// equipment shown as a badge. Selecting a movement fires onSelect with the
// full Movement; typing a name that doesn't match any movement is allowed
// and reported via onChangeName so callers can store free-text.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Movement } from '@wendler/db-schema';

interface MovementComboboxProps {
  movements: Movement[];
  /** Currently selected movementId, if any. Drives the equipment badge. */
  selectedId?: string;
  /** Display name (always rendered; used as input value). */
  name: string;
  /** Called when the user picks a known movement from the dropdown. */
  onSelect: (movement: Movement) => void;
  /** Called when the user types/edits the free-text name (no movement match). */
  onChangeName: (name: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxResults?: number;
  autoFocus?: boolean;
}

export function MovementCombobox({
  movements,
  selectedId,
  name,
  onSelect,
  onChangeName,
  placeholder = 'Start typing — e.g. dead, row, lunge…',
  disabled,
  maxResults = 8,
  autoFocus,
}: MovementComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(name);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // The most recent value we reported upstream (via onChangeName or commitSelection),
  // OR the last `name` prop we accepted as authoritative. We use this to ignore
  // echoes of our own writes — the parent's debounced save can briefly
  // round-trip a stale `name` (e.g. the still-buffered "sing") AFTER the user
  // has already picked a different movement from the dropdown. Without this
  // guard the input would silently revert to the typed text the moment the
  // save engine kicks in.
  const lastKnownNameRef = useRef(name);

  // Sync incoming name → input only when the parent really changed the name
  // out from under us (undo, sync from another device, programmatic edit).
  // Echoes of our own onChangeName/commitSelection writes are skipped because
  // we updated lastKnownNameRef synchronously when emitting them.
  useEffect(() => {
    if (name === lastKnownNameRef.current) return;
    lastKnownNameRef.current = name;
    setQuery(name);
  }, [name]);

  const selected = useMemo(
    () => (selectedId ? movements.find((m) => m.id === selectedId) : undefined),
    [movements, selectedId],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // No query: show alphabetical first page so the dropdown is still useful.
      return movements
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, maxResults);
    }
    const scored: Array<{ m: Movement; score: number }> = [];
    for (const m of movements) {
      const lower = m.name.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx === -1) continue;
      // Earlier match = higher score; word-start match wins ties.
      const wordStart = idx === 0 || lower[idx - 1] === ' ' || lower[idx - 1] === '-' ? 1 : 0;
      scored.push({ m, score: -idx * 10 + wordStart * 5 });
    }
    scored.sort((a, b) => b.score - a.score || a.m.name.localeCompare(b.m.name));
    return scored.slice(0, maxResults).map((s) => s.m);
  }, [movements, query, maxResults]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reset the active index whenever the visible list changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [matches.length, open]);

  const commitSelection = (m: Movement) => {
    lastKnownNameRef.current = m.name;
    onSelect(m);
    setQuery(m.name);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const m = matches[activeIdx];
      if (m) {
        e.preventDefault();
        commitSelection(m);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            const v = e.target.value;
            lastKnownNameRef.current = v;
            setQuery(v);
            onChangeName(v);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 pr-16 text-sm"
        />
        {selected && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded bg-bg/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
            {selected.equipment}
          </span>
        )}
      </div>

      {open && matches.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-card py-1 shadow-lg"
        >
          {matches.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={(e) => {
                // mousedown so it fires before input blur.
                e.preventDefault();
                commitSelection(m);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={`flex items-center justify-between gap-3 px-3 py-1.5 text-sm ${
                i === activeIdx ? 'bg-accent/15 text-fg' : 'text-fg'
              }`}
            >
              <span className="truncate">{m.name}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                {m.equipment}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && matches.length === 0 && query.trim() && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted shadow-lg">
          No matches — pressing Tab keeps “{query.trim()}” as a free-text name.
        </div>
      )}
    </div>
  );
}
