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
// non-interactive (tooltip only). T4 will layer in skip overlays, TM
// evolution annotations, and an active-week chip.

import { useMemo } from 'react';
import Link from 'next/link';
import {
  buildTimelineModel,
  type TimelineBlockSegment,
  type TimelineRaceInput,
} from '@wendler/domain';
import type { ProgramBlock, Race } from '@wendler/db-schema';

interface Props {
  blocks: ProgramBlock[];
  races: Race[];
  today: Date;
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

export function ProgramTimeline({ blocks, races, today }: Props) {
  const model = useMemo(() => {
    const raceInput: TimelineRaceInput[] = races.map((r) => ({
      id: r.id,
      name: r.name,
      date: r.date,
      kind: r.kind,
    }));
    return buildTimelineModel(blocks, raceInput, { today });
  }, [blocks, races, today]);

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
              return (
                <Link
                  key={seg.blockId}
                  href={`/program/block?id=${encodeURIComponent(seg.blockId)}`}
                  className={`relative z-10 m-0.5 flex min-w-0 flex-col justify-center rounded-md border px-2 py-1 transition hover:brightness-125 ${tone.fill} ${tone.border} ${
                    projected ? 'border-dashed opacity-70' : ''
                  } ${seg.isActive && !seg.isCompleted ? 'ring-2 ring-accent ring-offset-1 ring-offset-card' : ''}`}
                  style={{
                    gridColumn: `${seg.startWeekIndex + 1} / span ${span}`,
                  }}
                  title={`${seg.name} · ${blockKindLabel(seg)} · ${seg.weeks} wk${seg.weeks === 1 ? '' : 's'}${projected ? ' (projected)' : ''}`}
                >
                  <span className={`truncate text-xs font-semibold ${tone.text}`}>{seg.name}</span>
                  <span className="flex flex-wrap items-baseline gap-1 text-[10px] text-fg/70">
                    <span>{blockKindLabel(seg)}</span>
                    {projected && (
                      <span className="rounded bg-bg/40 px-1 text-[9px] uppercase tracking-wide text-muted">
                        projected
                      </span>
                    )}
                  </span>
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
        <span className="ml-auto">Dotted = projected start (chained from preceding block)</span>
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
