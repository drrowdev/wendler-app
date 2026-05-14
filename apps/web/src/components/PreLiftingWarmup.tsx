'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MainLift, WarmupBlockDef } from '@wendler/db-schema';
import {
  DEFAULT_PRE_LIFTING_WARMUP_BLOCKS,
  displayDuration,
  selectWarmupBlocks,
} from '@wendler/db-schema';
import type { WendlerWeek } from '@wendler/domain';
import { getDb } from '@/lib/db';
import { kickSync } from '@/lib/sync';
import { useAllSessions, useSettings } from '@/lib/hooks';
import { nanoid } from 'nanoid';

interface PreLiftingWarmupProps {
  blockId: string;
  week: WendlerWeek;
  dayGroupIndex: number;
  /**
   * The day's main lifts. Drives both the session-anchor row (firstLift =
   * dayLifts[0]) and the appliesTo filter for warm-up blocks. Empty array
   * for accessory days.
   */
  dayLifts: MainLift[];
  /** When true, mark/unmark controls are hidden (block is completed/locked). */
  locked?: boolean;
}

export function PreLiftingWarmup({
  blockId,
  week,
  dayGroupIndex,
  dayLifts,
  locked = false,
}: PreLiftingWarmupProps) {
  const settings = useSettings();
  const allSessions = useAllSessions();
  const enabled = settings?.preLiftingWarmupEnabled ?? true;
  const firstLift: MainLift | undefined = dayLifts[0];

  const blocks = useMemo<WarmupBlockDef[]>(() => {
    const source = settings?.preLiftingWarmup?.blocks ?? DEFAULT_PRE_LIFTING_WARMUP_BLOCKS;
    return selectWarmupBlocks(source, dayLifts);
  }, [settings?.preLiftingWarmup, dayLifts]);

  // Anchor the warmup checkbox state to the same session row that owns the
  // day's assistance work — the FIRST lift's session for the day-group, or
  // the no-mainLift dayIndex row on accessory days. Mirrors DayAssistanceSection.
  const anchorSession = useMemo(() => {
    if (!allSessions) return undefined;
    return allSessions
      .filter((s) =>
        firstLift
          ? s.blockId === blockId && s.week === week && s.mainLift === firstLift
          : s.blockId === blockId && s.week === week && !s.mainLift && s.dayIndex === dayGroupIndex,
      )
      .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];
  }, [allSessions, blockId, week, firstLift, dayGroupIndex]);

  const completedAt = anchorSession?.preWarmupCompletedAt;
  const completed = !!completedAt;
  const [collapsed, setCollapsed] = useState(true);

  // Auto-collapse the moment the user marks complete; auto-expand again if
  // they unmark. Manual toggle still wins until the next state change.
  useEffect(() => {
    setCollapsed(completed);
  }, [completed]);

  if (!enabled) return null;

  const toggle = async () => {
    if (locked) return;
    const db = getDb();
    const now = new Date().toISOString();
    if (anchorSession) {
      await db.sessions.update(anchorSession.id, {
        preWarmupCompletedAt: completed ? undefined : now,
      });
    } else {
      // Materialise a session row to hold the flag. Same shape ensureSessionRow
      // / DayAssistanceSection use elsewhere.
      await db.sessions.put({
        id: nanoid(),
        performedAt: now,
        mainLift: firstLift,
        week,
        blockId,
        dayIndex: dayGroupIndex,
        preWarmupCompletedAt: now,
      });
    }
    kickSync();
  };

  return (
    <section
      className={`rounded-2xl border ${
        completed ? 'border-emerald-700/40 bg-emerald-900/10' : 'border-border bg-card'
      }`}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-bg/40"
      >
        <div className="flex items-baseline gap-3">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
              completed ? 'bg-emerald-600 text-white' : 'bg-bg text-fg ring-1 ring-border'
            }`}
            title={completed ? 'Warm-up complete' : 'Warm-up not started'}
          >
            {completed ? '✓' : '·'}
          </span>
          <div>
            <div className="text-lg font-bold tracking-tight">Warm-up</div>
            <div className="text-xs text-muted">8–10 min · before the main lifts</div>
          </div>
        </div>
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg text-muted ring-1 ring-border bg-bg"
          aria-hidden
        >
          {collapsed ? '▸' : '▾'}
        </span>
      </button>

      {!collapsed && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          <p className="text-xs leading-snug text-muted">
            Adjust focus to the day&apos;s main lift. Skipping is the fastest route back to a
            flared trap or pubic region — treat it as non-negotiable.
          </p>

          <div className="space-y-2">
            {blocks.map((b) => (
              <div
                key={b.id}
                className="rounded-lg ring-1 ring-border bg-bg/40 overflow-hidden"
              >
                <div className="flex items-baseline justify-between gap-2 px-3 py-2 bg-bg/60">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold tracking-tight">{b.title}</span>
                    {b.note && (
                      <span className="text-xs text-muted">{b.note}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted whitespace-nowrap">{displayDuration(b)}</span>
                </div>
                <ul className="divide-y divide-border">
                  {b.movements.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <span className="leading-snug">{m.name}</span>
                      {m.dose && (
                        <span className="shrink-0 rounded bg-bg px-2 py-0.5 text-xs font-medium tabular-nums text-muted ring-1 ring-border">
                          {m.dose}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {completed ? (
              <>
                <div className="flex-1 rounded-lg border border-emerald-700/40 bg-emerald-900/10 py-2 text-center text-sm text-emerald-300">
                  ✓ Warm-up complete
                </div>
                {!locked && (
                  <button
                    type="button"
                    onClick={toggle}
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-muted hover:border-accent hover:text-fg"
                  >
                    Unmark
                  </button>
                )}
              </>
            ) : !locked ? (
              <button
                type="button"
                onClick={toggle}
                className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
              >
                Mark warm-up complete
              </button>
            ) : (
              <div className="flex-1 rounded-lg border border-border bg-bg/40 py-2 text-center text-xs text-muted">
                Warm-up not logged
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
