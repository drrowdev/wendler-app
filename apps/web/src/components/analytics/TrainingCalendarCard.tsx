'use client';

import { useMemo } from 'react';
import { CARDIO_ACCENT, STRENGTH_ACCENT, trainingCalendar, type MinimalCardio } from '@wendler/domain';
import { AnalyticsCard } from './AnalyticsCard';

const STRENGTH_COLOR = STRENGTH_ACCENT;
const BOTH_COLOR = '#ec4899';
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * GitHub-style heatmap: 7 day-rows (Mon→Sun) × N week-columns. Each cell is
 * a square colored by what happened that day:
 *   violet = strength only · sky = cardio only · pink = both · faint = rest
 * Weekday labels run down the left, month labels along the top.
 */
export function TrainingCalendarCard({
  strengthDates,
  cardio,
  weeks = 12,
  cellSize = 24,
}: {
  strengthDates: string[];
  cardio: MinimalCardio[];
  weeks?: number;
  /** Square cell edge in px. Larger values give the card more presence. */
  cellSize?: number;
}) {
  const days = useMemo(
    () =>
      trainingCalendar(
        strengthDates,
        cardio.map((c) => c.performedAt),
        new Date(),
        weeks * 7,
      ),
    [strengthDates, cardio, weeks],
  );

  // Pad the leading edge so column 0 starts on a Monday. Without this, the
  // first column is partial and the weekday rows are misaligned.
  const { columns, monthMarkers } = useMemo(() => {
    if (days.length === 0) return { columns: [] as ((typeof days[number]) | null)[][], monthMarkers: [] as (string | null)[] };
    const first = new Date(days[0]!.date);
    // JS getDay: Sun=0..Sat=6. Convert to Mon=0..Sun=6.
    const firstWeekday = (first.getDay() + 6) % 7;
    const padded: ((typeof days[number]) | null)[] = [
      ...Array(firstWeekday).fill(null),
      ...days,
    ];
    const cols: ((typeof days[number]) | null)[][] = [];
    for (let i = 0; i < padded.length; i += 7) cols.push(padded.slice(i, i + 7));
    // Pad the trailing column to 7 cells so the grid stays rectangular.
    const last = cols[cols.length - 1];
    if (last) while (last.length < 7) last.push(null);

    // Month label per column: show abbreviation in the column where the
    // month of the first non-null cell differs from the previous column's.
    let prevMonth = -1;
    const months = cols.map((col) => {
      const firstCell = col.find((c) => c !== null);
      if (!firstCell) return null;
      const m = new Date(firstCell.date).getMonth();
      if (m !== prevMonth) {
        prevMonth = m;
        return MONTH_LABELS[m];
      }
      return null;
    });
    return { columns: cols, monthMarkers: months };
  }, [days]);

  const totalStrength = days.filter((d) => d.strength).length;
  const totalCardio = days.filter((d) => d.cardio).length;
  const both = days.filter((d) => d.strength && d.cardio).length;

  return (
    <AnalyticsCard
      title="Training calendar"
      badge="combined"
      subtitle={`${weeks}w · ${totalStrength} strength · ${totalCardio} cardio · ${both} both`}
    >
      <div className="flex w-full justify-center overflow-x-auto">
        <div className="inline-flex flex-col gap-1">
          {/* Month markers row */}
          <div
            className="flex gap-[3px] pl-7 text-[10px] text-muted"
            style={{ height: 14 }}
          >
            {monthMarkers.map((m, i) => (
              <div
                key={i}
                className="shrink-0 text-left"
                style={{ width: cellSize }}
              >
                {m ?? ''}
              </div>
            ))}
          </div>

          {/* 7 weekday rows */}
          {Array.from({ length: 7 }).map((_, rowIdx) => (
            <div key={rowIdx} className="flex items-center gap-[3px]">
              <div className="w-6 shrink-0 text-right text-[10px] text-muted">
                {rowIdx === 0 ? 'Mon' : rowIdx === 2 ? 'Wed' : rowIdx === 4 ? 'Fri' : rowIdx === 6 ? 'Sun' : ''}
              </div>
              {columns.map((col, cIdx) => {
                const d = col[rowIdx];
                if (!d) {
                  return (
                    <div
                      key={cIdx}
                      className="shrink-0 rounded-[2px]"
                      style={{ background: 'transparent', width: cellSize, height: cellSize }}
                    />
                  );
                }
                const isBoth = d.strength && d.cardio;
                const bg = isBoth
                  ? BOTH_COLOR
                  : d.strength
                    ? STRENGTH_COLOR
                    : d.cardio
                      ? CARDIO_ACCENT
                      : 'rgba(148,163,184,0.12)';
                return (
                  <div
                    key={cIdx}
                    className="shrink-0 rounded-[2px] border border-border/30"
                    style={{ background: bg, width: cellSize, height: cellSize }}
                    title={`${d.date}${
                      isBoth
                        ? ' · strength + cardio'
                        : d.strength
                          ? ' · strength'
                          : d.cardio
                            ? ' · cardio'
                            : ' · rest'
                    }`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-[2px]"
            style={{ background: STRENGTH_COLOR }}
          />
          Strength
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-[2px]"
            style={{ background: CARDIO_ACCENT }}
          />
          Cardio
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-[2px]"
            style={{ background: BOTH_COLOR }}
          />
          Both
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-[2px] border border-border/60" />
          Rest
        </span>
      </div>
    </AnalyticsCard>
  );
}
