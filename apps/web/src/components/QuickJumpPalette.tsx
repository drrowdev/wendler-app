'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  scoreBest,
  type ProgramBlock,
} from '@wendler/domain';
import type {
  Goal,
  MainLift,
  Movement,
  Race,
  SessionRecord,
} from '@wendler/db-schema';
import {
  useBlocks,
  useGoals,
  useMovements,
  useRaces,
  useSessionsRecent,
} from '@/lib/hooks';
import { fmtDate } from '@/lib/format';

type ItemType = 'page' | 'movement' | 'block' | 'race' | 'goal' | 'session';

interface PaletteItem {
  id: string;
  type: ItemType;
  /** Display label (already user-facing). */
  label: string;
  /** Optional secondary hint shown beneath the label. */
  hint?: string;
  /** Lowercased label + aliases used by the scorer. */
  searchTokens: string[];
  /** Where to navigate on enter. */
  href: string;
  /** A higher value floats item up on ties (recency). 0..50. */
  recency?: number;
}

interface PageDef {
  href: string;
  label: string;
  hint?: string;
  aliases?: string[];
}

const PAGES: PageDef[] = [
  { href: '/', label: 'Today', aliases: ['home', 'now'] },
  { href: '/program', label: 'Program', aliases: ['blocks', 'plan'] },
  { href: '/program/new', label: 'New program', aliases: ['create program', 'generate block'] },
  { href: '/calendar', label: 'Calendar', aliases: ['schedule', 'week'] },
  { href: '/stats', label: 'Stats', aliases: ['analytics', 'charts', 'graphs'] },
  { href: '/load', label: 'Load', aliases: ['banister', 'fitness fatigue', 'form'] },
  { href: '/history', label: 'History', aliases: ['log', 'past sessions'] },
  { href: '/races', label: 'Races' },
  { href: '/chat', label: 'AI chat', aliases: ['chat', 'ai', 'ask', 'coach'] },
  { href: '/goals', label: 'Goals' },
  { href: '/profile', label: 'Training Profile', aliases: ['training profile', 'profile', 'phase', 'emphasis', 'filters', 'ai notes'] },
  { href: '/cardio', label: 'Cardio' },
  { href: '/program?tab=cardio', label: 'Cardio plan', aliases: ['running plan', 'run plan'] },
  { href: '/recovery', label: 'Recovery', aliases: ['hrv', 'sleep', 'freshness'] },
  { href: '/movements', label: 'Movements', aliases: ['exercises', 'lifts'] },
  { href: '/settings', label: 'Settings', aliases: ['preferences', 'config', 'backup'] },
  { href: '/more', label: 'More' },
];

const RECENT_KEY = 'wendler-quickjump-recent-v1';
const MAX_RECENT = 20;

function loadRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function pushRecent(href: string) {
  if (typeof window === 'undefined') return;
  try {
    const current = loadRecent().filter((h) => h !== href);
    current.unshift(href);
    window.localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(current.slice(0, MAX_RECENT)),
    );
  } catch {
    // ignore
  }
}

function liftLabel(lift?: MainLift): string {
  if (!lift) return 'Workout';
  return lift.charAt(0).toUpperCase() + lift.slice(1);
}

function buildIndex(input: {
  movements: Movement[] | undefined;
  blocks: ProgramBlock[] | undefined;
  races: Race[] | undefined;
  goals: Goal[] | undefined;
  sessions: SessionRecord[] | undefined;
}): PaletteItem[] {
  const items: PaletteItem[] = [];

  for (const p of PAGES) {
    items.push({
      id: `page:${p.href}`,
      type: 'page',
      label: p.label,
      hint: p.hint,
      searchTokens: [p.label.toLowerCase(), ...(p.aliases ?? []).map((a) => a.toLowerCase())],
      href: p.href,
    });
  }

  for (const m of input.movements ?? []) {
    items.push({
      id: `movement:${m.id}`,
      type: 'movement',
      label: m.name,
      hint: m.isMainLift ? `Main lift · ${liftLabel(m.isMainLift)}` : undefined,
      searchTokens: [m.name.toLowerCase()],
      href: `/movements?focus=${encodeURIComponent(m.id)}`,
    });
  }

  for (const b of input.blocks ?? []) {
    items.push({
      id: `block:${b.id}`,
      type: 'block',
      label: b.name,
      hint: `${b.kind}${b.completedAt ? ' · done' : b.startedAt ? ' · active' : ''}`,
      searchTokens: [b.name.toLowerCase(), b.kind],
      href: `/program/block?id=${encodeURIComponent(b.id)}`,
      // Active blocks float; completed ones don't.
      recency: b.startedAt && !b.completedAt ? 40 : 0,
    });
  }

  for (const r of input.races ?? []) {
    const date = r.date ? new Date(r.date) : null;
    const dateLabel = date && !Number.isNaN(date.getTime())
      ? fmtDate(r.date)
      : '';
    items.push({
      id: `race:${r.id}`,
      type: 'race',
      label: r.name,
      hint: `${dateLabel}${dateLabel ? ' · ' : ''}${r.kind} · ${r.priority}`,
      searchTokens: [r.name.toLowerCase(), r.kind],
      href: `/races?focus=${encodeURIComponent(r.id)}`,
      // Upcoming A-races float above completed ones.
      recency: !r.completedAt && r.priority === 'A' ? 30 : 0,
    });
  }

  for (const g of input.goals ?? []) {
    items.push({
      id: `goal:${g.id}`,
      type: 'goal',
      label: g.title,
      hint: g.kind,
      searchTokens: [g.title.toLowerCase(), g.kind],
      href: `/goals?focus=${encodeURIComponent(g.id)}`,
      recency: !g.completedAt ? 20 : 0,
    });
  }

  // Recent sessions: last 30 only, skip ones with no clear label.
  const recent = (input.sessions ?? []).slice(0, 30);
  for (const s of recent) {
    const isoDate = s.performedAt?.slice(0, 10) ?? '';
    const dateStr = isoDate ? fmtDate(isoDate) : '';
    const lift = liftLabel(s.mainLift);
    const label = `${dateStr} · ${lift}`;
    // Mirror RecentSessionsList.hrefFor: planned-block sessions belong to a
    // day view (which shows every set logged that day across all lifts),
    // standalone sessions fall back to /session?id=... .
    const href =
      s.blockId && s.week != null && s.dayIndex != null
        ? `/day?blockId=${encodeURIComponent(s.blockId)}&week=${s.week}&day=${s.dayIndex}`
        : `/session?id=${encodeURIComponent(s.id)}`;
    items.push({
      id: `session:${s.id}`,
      type: 'session',
      label,
      hint: (s.workoutCompletedAt ?? s.completedAt) ? 'Logged' : 'In progress',
      searchTokens: [label.toLowerCase(), lift.toLowerCase(), dateStr, isoDate],
      href,
    });
  }

  return items;
}

const TYPE_LABEL: Record<ItemType, string> = {
  page: 'Page',
  movement: 'Movement',
  block: 'Block',
  race: 'Race',
  goal: 'Goal',
  session: 'Session',
};

const TYPE_CHIP: Record<ItemType, string> = {
  page: 'bg-sky-500/15 text-sky-200',
  movement: 'bg-emerald-500/15 text-emerald-200',
  block: 'bg-violet-500/15 text-violet-200',
  race: 'bg-amber-500/15 text-amber-200',
  goal: 'bg-rose-500/15 text-rose-200',
  session: 'bg-slate-500/15 text-slate-200',
};

export function QuickJumpPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const router = useRouter();

  const movements = useMovements();
  const blocks = useBlocks();
  const races = useRaces();
  const goals = useGoals();
  const sessions = useSessionsRecent(30);

  // Lazy index — only built when the palette opens or its inputs change while open.
  const index = useMemo(
    () =>
      open
        ? buildIndex({
            movements: movements as Movement[] | undefined,
            blocks: blocks as ProgramBlock[] | undefined,
            races: races as Race[] | undefined,
            goals: goals as Goal[] | undefined,
            sessions: sessions as SessionRecord[] | undefined,
          })
        : [],
    [open, movements, blocks, races, goals, sessions],
  );

  const results = useMemo(() => {
    if (!open) return [];
    if (!query.trim()) {
      // Empty state: 5 most-recently-visited pages.
      const recent = loadRecent();
      const byHref = new Map(index.map((it) => [it.href, it] as const));
      const recentItems: PaletteItem[] = [];
      for (const href of recent) {
        const it = byHref.get(href);
        if (it) recentItems.push(it);
        if (recentItems.length >= 5) break;
      }
      return recentItems;
    }
    const q = query.toLowerCase();
    const scored = index
      .map((it) => ({
        item: it,
        score: scoreBest(q, it.searchTokens, { recencyBoost: it.recency ?? 0 }),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    return scored.map((s) => s.item);
  }, [open, query, index]);

  // Keep selection in range as results change.
  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  // Global hotkey: Cmd/Ctrl-K opens. Also '/' on desktop when not in an input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Custom event so the mobile nav button can open the palette.
  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener('wendler:open-quickjump', onOpen);
    return () => window.removeEventListener('wendler:open-quickjump', onOpen);
  }, []);

  // Focus input on open; reset query on close.
  useEffect(() => {
    if (open) {
      // Defer to allow the modal to render before focusing.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
    }
  }, [open]);

  // Scroll the active row into view as it changes.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const choose = useCallback(
    (item: PaletteItem) => {
      pushRecent(item.href);
      setOpen(false);
      router.push(item.href);
    },
    [router],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick jump"
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 px-3 pt-[10vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="h-4 w-4 text-muted"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const pick = results[activeIdx];
                if (pick) choose(pick);
              }
            }}
            placeholder="Jump to a page, movement, block, race, goal, or session…"
            aria-label="Quick jump query"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            title="Close (Esc)"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition hover:bg-bg/60 hover:text-fg"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <ul ref={listRef} className="max-h-[60vh] overflow-y-auto py-1" role="listbox">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted">
              {query.trim() ? 'No matches' : 'Start typing to search.'}
            </li>
          ) : (
            results.map((it, i) => {
              const active = i === activeIdx;
              return (
                <li key={it.id} data-idx={i} role="option" aria-selected={active}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => choose(it)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition ${
                      active ? 'bg-accent/15 text-fg' : 'text-fg/90 hover:bg-bg/60'
                    }`}
                  >
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TYPE_CHIP[it.type]}`}
                    >
                      {TYPE_LABEL[it.type]}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{it.label}</span>
                      {it.hint && (
                        <span className="truncate text-[11px] text-muted">{it.hint}</span>
                      )}
                    </span>
                    {active && (
                      <kbd className="hidden rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] text-muted md:inline">
                        ↵
                      </kbd>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-border bg-bg/50 px-3 py-1.5 text-[10px] text-muted">
          <span>↑↓ to navigate · ↵ to open · esc to close</span>
          <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Programmatic opener. Mobile nav uses this rather than a synthesised
 * keyboard event so it works reliably across browsers.
 */
export function openQuickJump() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('wendler:open-quickjump'));
}
