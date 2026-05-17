'use client';

// ProgramTimeline — horizontal swimlane view of the user's macrocycle.
//
// Renders the output of `buildTimelineModel`. Layout uses CSS grid:
// one column per ISO week, fixed minimum width so a window of ~4-8
// weeks always fits the viewport and longer ranges scroll horizontally
// on mobile. Block segments span N columns; race milestones land as
// flag pins anchored to a single week column; the current week gets a
// vertical accent line + label.
//
// Click a block segment → /program/block?id=<blockId>. Race pins are
// non-interactive (tooltip only).
//
// T4 additions:
//   - Skip-week hatch overlay derived from plan.dayOverridesByWeek
//     (per timeline-week column inside each block).
//   - Active-week chip "Wk N of M" on the active block.
//   - Optional TM-evolution annotations at block boundaries — toggle
//     in the legend, off by default to avoid clutter.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  buildTimelineModel,
  isDaySkipped,
  type TimelineBlockSegment,
  type TimelineRaceInput,
  type WendlerWeek,
} from '@wendler/domain';
import type { ProgramBlock, Race, TrainingMaxRecord } from '@wendler/db-schema';

interface Props {
  blocks: ProgramBlock[];
  races: Race[];
  trainingMaxes?: TrainingMaxRecord[];
  today: Date;
  /**
   * Optional anchor used to align the timeline with the user's actual
   * training position. Wired in /calendar from db.schedule.singleton
   * — the cursor week + activeBlockId are the authoritative 'where
   * am I right now' state, used in preference to per-block startedAt
   * dates (which may be missing or stale on legacy blocks).
   */
  activeBlockId?: string;
  cursorWeek?: WendlerWeek;
}

const WEEK_COL_MIN_WIDTH = '5.5rem'; // ~88px; ~4 visible on a 360-wide viewport

// Block-kind → tailwind colour mappings. Picked so adjacent blocks
// stay visually distinct; sevenths use cooler/warmer accents per
// variant so the Wendler "test → deload → PR" rhythm reads at a glance.
function blockTone(seg: TimelineBlockSegment): {
  fill: string;
  border: string;
  text: string;
} {
  if (seg.kind === 'leader') {
    return {
      fill: 'bg-amber-500/20',
      border: 'border-amber-500/50',
      text: 'text-amber-100',
    };
  }
  if (seg.kind === 'anchor') {
    return {
      fill: 'bg-emerald-500/20',
      border: 'border-emerald-500/50',
      text: 'text-emerald-100',
    };
  }
  if (seg.kind === 'standalone') {
    return {
      fill: 'bg-violet-500/20',
      border: 'border-violet-500/50',
      text: 'text-violet-100',
    };
  }
  // seventh-week — variant-driven
  switch (seg.seventhWeekKind) {
    case 'tm-test':
      return {
        fill: 'bg-sky-500/20',
        border: 'border-sky-500/50',
        text: 'text-sky-100',
      };
    case 'pr-test':
      return {
        fill: 'bg-rose-500/20',
        border: 'border-rose-500/50',
        text: 'text-rose-100',
      };
    case 'deload':
    default:
      return {
        fill: 'bg-slate-500/20',
        border: 'border-slate-500/50',
        text: 'text-slate-100',
      };
  }
}

function blockKindLabel(seg: TimelineBlockSegment): string {
  if (seg.kind === 'seventh-week') {
    switch (seg.seventhWeekKind) {
      case 'tm-test':
        return '7w · TM-test';
      case 'pr-test':
        return '7w · PR';
      case 'deload':
        return '7w · Deload';
      default:
        return '7th week';
    }
  }
  return seg.kind.charAt(0).toUpperCase() + seg.kind.slice(1);
}

export function ProgramTimeline({
  blocks,
  races,
  trainingMaxes,
  today,
  activeBlockId,
  cursorWeek,
}: Props) {
  const [showTmDeltas, setShowTmDeltas] = useState(false);
  const model = useMemo(() => {
    const raceInput: TimelineRaceInput[] = races.map((r) => ({
      id: r.id,
      name: r.name,
      date: r.date,
      kind: r.kind,
    }));
    return buildTimelineModel(blocks, raceInput, {
      today,
      ...(activeBlockId && cursorWeek !== undefined
        ? { anchor: { activeBlockId, cursorWeek } }
        : {}),
    });
  }, [blocks, races, today, activeBlockId, cursorWeek]);

  // Per-block skip data — for each segment, list the timeline-week
  // indices where ANY plan day is flagged skipped, plus the count.
  // Pure derivation from BlockPlan.dayOverridesByWeek + plan.days.
  const skipInfoByBlock = useMemo(() => {
    const out = new Map<string, Array<{ weekIndex: number; count: number }>>();
    for (const seg of model.blockSegments) {
      const plan = seg.source.plan;
      if (!plan?.dayOverridesByWeek || plan.days.length === 0) continue;
      // Map the block's WendlerWeek labels onto sequential offsets from
      // the segment start. For seventh-week the only valid label is '7w';
      // for normal blocks: weeks 1..weeksBeforeDeload then 'deload'.
      const wendlerWeeks: WendlerWeek[] =
        seg.kind === 'seventh-week'
          ? ['7w']
          : [
              ...Array.from(
                { length: seg.source.weeksBeforeDeload },
                (_, i) => (i + 1) as 1 | 2 | 3,
              ),
              ...(seg.includesDeload ? (['deload'] as const) : []),
            ];
      const entries: Array<{ weekIndex: number; count: number }> = [];
      wendlerWeeks.forEach((wk, offset) => {
        let count = 0;
        for (const day of plan.days) {
          if (isDaySkipped(plan, wk, day.id)) count++;
        }
        if (count > 0) {
          entries.push({ weekIndex: seg.startWeekIndex + offset, count });
        }
      });
      if (entries.length > 0) out.set(seg.blockId, entries);
    }
    return out;
  }, [model.blockSegments]);

  // Per-block TM deltas: lift → (start kg, end kg, delta). Only computed
  // when the toggle is on. "Start" = most recent TrainingMaxRecord at or
  // BEFORE block.startedAt; "end" = most recent record at or before
  // block.completedAt (or today if not completed). Tiny chip per lift
  // with a +/- delta. No record for a lift = no chip.
  const tmDeltasByBlock = useMemo(() => {
    if (!showTmDeltas) return new Map<string, Array<{ lift: string; deltaKg: number }>>();
    const out = new Map<string, Array<{ lift: string; deltaKg: number }>>();
    if (!trainingMaxes || trainingMaxes.length === 0) return out;
    const sorted = [...trainingMaxes].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : 1,
    );
    for (const seg of model.blockSegments) {
      if (!seg.isStarted) continue;
      const startedAt = seg.source.startedAt!;
      const endedAt = seg.source.completedAt ?? today.toISOString();
      const byLift = new Map<string, { start?: number; end?: number }>();
      for (const tm of sorted) {
        if (tm.createdAt > endedAt) break;
        const entry = byLift.get(tm.lift) ?? {};
        if (tm.createdAt < startedAt) {
          entry.start = tm.trainingMaxKg;
        } else {
          if (entry.start === undefined) entry.start = tm.trainingMaxKg;
          entry.end = tm.trainingMaxKg;
        }
        byLift.set(tm.lift, entry);
      }
      const deltas: Array<{ lift: string; deltaKg: number }> = [];
      for (const [lift, { start, end }] of byLift) {
        if (start === undefined || end === undefined) continue;
        const d = Math.round((end - start) * 2) / 2; // 0.5 kg precision
        if (d === 0) continue;
        deltas.push({ lift, deltaKg: d });
      }
      if (deltas.length > 0) out.set(seg.blockId, deltas);
    }
    return out;
  }, [showTmDeltas, trainingMaxes, model.blockSegments, today]);

  if (model.blockSegments.length === 0 && model.raceMilestones.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted">
        <p className="font-medium text-fg/80">No program data yet</p>
        <p className="mt-2 leading-relaxed">
          Start a program from{' '}
          <Link href="/program/new" className="text-accent underline-offset-2 hover:underline">
            /program/new
          </Link>{' '}
          to populate the timeline.
        </p>
      </div>
    );
  }

  const colCount = model.weekHeaders.length;
  const gridTemplate = `repeat(${colCount}, minmax(${WEEK_COL_MIN_WIDTH}, 1fr))`;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="overflow-x-auto">
        <div className="min-w-full p-3" style={{ minWidth: `calc(${WEEK_COL_MIN_WIDTH} * ${colCount})` }}>
          {/* Week-header strip */}
          <div className="grid gap-0" style={{ gridTemplateColumns: gridTemplate }}>
            {model.weekHeaders.map((h, i) => (
              <div
                key={h.weekStartIso}
                className={`relative px-1 pb-1 text-[10px] leading-tight ${
                  h.isCurrent
                    ? 'font-bold text-accent'
                    : h.startsNewMonth
                      ? 'font-semibold text-fg/80'
                      : 'text-muted'
                } ${
                  h.startsNewMonth && i > 0
                    ? 'border-l border-border/60'
                    : ''
                }`}
                title={`ISO week ${h.isoWeek}, ${h.year}`}
              >
                {h.label}
              </div>
            ))}
          </div>

          {/* Block lane */}
          <div
            className="relative mt-2 grid gap-0"
            style={{ gridTemplateColumns: gridTemplate, minHeight: '3.25rem' }}
          >
            {/* Current-week vertical guide — spans the whole lane. */}
            {model.currentWeekIndex >= 0 && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 z-0 border-l-2 border-accent/60"
                style={{
                  left: `calc((100% / ${colCount}) * ${model.currentWeekIndex} + (100% / ${colCount} / 2))`,
                }}
              />
            )}
            {model.blockSegments.map((seg) => {
              const tone = blockTone(seg);
              const span = seg.endWeekIndex - seg.startWeekIndex + 1;
              const projected = !seg.isStarted;
              const skips = skipInfoByBlock.get(seg.blockId) ?? [];
              const tmDeltas = tmDeltasByBlock.get(seg.blockId) ?? [];
              const activeWeekN = seg.isActive
                ? model.currentWeekIndex - seg.startWeekIndex + 1
                : null;
              return (
                <Link
                  key={seg.blockId}
                  href={`/program/block?id=${encodeURIComponent(seg.blockId)}`}
                  className={`relative z-10 m-0.5 flex min-w-0 flex-col justify-center overflow-hidden rounded-md border px-2 py-1 transition hover:brightness-125 ${tone.fill} ${tone.border} ${
                    projected ? 'border-dashed opacity-70' : ''
                  } ${seg.isActive && !seg.isCompleted ? 'ring-2 ring-accent ring-offset-1 ring-offset-card' : ''}`}
                  style={{
                    gridColumn: `${seg.startWeekIndex + 1} / span ${span}`,
                  }}
                  title={`${seg.name} · ${blockKindLabel(seg)} · ${seg.weeks} wk${seg.weeks === 1 ? '' : 's'}${projected ? ' (projected)' : ''}${skips.length > 0 ? ` · ${skips.reduce((s, e) => s + e.count, 0)} day(s) skipped` : ''}`}
                >
                  {/* Skip-week hatch overlays. Positioned absolutely
                      inside the segment, scaled to the segment's own
                      grid (one fraction per week the block occupies). */}
                  {skips.map((s) => {
                    const offset = s.weekIndex - seg.startWeekIndex;
                    return (
                      <span
                        key={s.weekIndex}
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 z-0"
                        style={{
                          left: `${(offset / span) * 100}%`,
                          width: `${(1 / span) * 100}%`,
                          backgroundImage:
                            'repeating-linear-gradient(45deg, rgba(244,63,94,0.18) 0, rgba(244,63,94,0.18) 4px, transparent 4px, transparent 8px)',
                        }}
                      />
                    );
                  })}
                  <span className={`relative z-10 truncate text-xs font-semibold ${tone.text}`}>
                    {seg.name}
                  </span>
                  <span className="relative z-10 flex flex-wrap items-baseline gap-1 text-[10px] text-fg/70">
                    <span>{blockKindLabel(seg)}</span>
                    {activeWeekN !== null && activeWeekN >= 1 && activeWeekN <= seg.weeks && (
                      <span className="rounded bg-accent/30 px-1 text-[9px] font-semibold uppercase tracking-wide text-accent-fg">
                        Wk {activeWeekN} of {seg.weeks}
                      </span>
                    )}
                    {projected && (
                      <span className="rounded bg-bg/40 px-1 text-[9px] uppercase tracking-wide text-muted">
                        projected
                      </span>
                    )}
                    {skips.length > 0 && (
                      <span
                        className="rounded bg-rose-500/30 px-1 text-[9px] font-semibold uppercase tracking-wide text-rose-100"
                        title={`${skips.reduce((s, e) => s + e.count, 0)} skipped day(s) across ${skips.length} week(s)`}
                      >
                        {skips.reduce((s, e) => s + e.count, 0)} skipped
                      </span>
                    )}
                  </span>
                  {tmDeltas.length > 0 && (
                    <span className="relative z-10 mt-0.5 flex flex-wrap gap-1 text-[10px] text-fg/80">
                      {tmDeltas.map((d) => (
                        <span
                          key={d.lift}
                          className={`rounded px-1 font-mono ${
                            d.deltaKg > 0
                              ? 'bg-emerald-500/20 text-emerald-100'
                              : 'bg-rose-500/20 text-rose-100'
                          }`}
                        >
                          {d.lift.slice(0, 2).toUpperCase()} {d.deltaKg > 0 ? '+' : ''}
                          {d.deltaKg}
                        </span>
                      ))}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>

          {/* Race milestone lane */}
          {model.raceMilestones.length > 0 && (
            <div
              className="relative mt-2 grid gap-0 border-t border-border/60 pt-2"
              style={{ gridTemplateColumns: gridTemplate, minHeight: '2rem' }}
            >
              {model.raceMilestones.map((r) => (
                <div
                  key={r.raceId}
                  className="flex items-center justify-center"
                  style={{ gridColumn: `${r.weekIndex + 1} / span 1` }}
                  title={`${r.name}${r.kind ? ` (${r.kind})` : ''} — ${r.dateIso}`}
                >
                  <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold text-rose-100 ring-1 ring-rose-500/50">
                    🏁 {r.name}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* "Today" caption row — visually aligns under the marker. */}
          {model.currentWeekIndex >= 0 && (
            <div
              className="relative mt-1 grid gap-0"
              style={{ gridTemplateColumns: gridTemplate, minHeight: '1rem' }}
            >
              <div
                className="text-center text-[10px] font-semibold text-accent"
                style={{ gridColumn: `${model.currentWeekIndex + 1} / span 1` }}
              >
                ▲ today
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-[10px] text-muted">
        <LegendChip className="bg-amber-500/20 ring-amber-500/50">Leader</LegendChip>
        <LegendChip className="bg-emerald-500/20 ring-emerald-500/50">Anchor</LegendChip>
        <LegendChip className="bg-sky-500/20 ring-sky-500/50">7w TM-test</LegendChip>
        <LegendChip className="bg-rose-500/20 ring-rose-500/50">7w PR</LegendChip>
        <LegendChip className="bg-slate-500/20 ring-slate-500/50">7w Deload</LegendChip>
        <LegendChip className="bg-violet-500/20 ring-violet-500/50">Custom</LegendChip>
        <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showTmDeltas}
            onChange={(e) => setShowTmDeltas(e.target.checked)}
            className="h-3 w-3 accent-accent"
          />
          <span>TM deltas</span>
        </label>
      </div>
      <div className="border-t border-border/60 px-3 pb-2 text-[10px] text-muted/80">
        Dotted = projected start (chained from preceding block) · Hatched = skipped days that week
      </div>
    </div>
  );
}

function LegendChip({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 ring-1 ${className} text-fg/80`}>
      {children}
    </span>
  );
}
