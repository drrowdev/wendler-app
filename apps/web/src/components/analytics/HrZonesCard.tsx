'use client';

import { useMemo } from 'react';
import {
  aggregateHrZones,
  polarizedSummary,
  type MinimalCardio,
  type PolarizedSummary,
} from '@wendler/domain';
import { AnalyticsCard } from './AnalyticsCard';

const ZONE_COLORS = ['#475569', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444'];
const ZONE_LABELS = ['Recovery', 'Endurance', 'Tempo', 'Threshold', 'VO₂ max'];

// Polarized-bucket palette — green (easy) / amber (grey) / red (hard).
// Picked to read distinctly from the 5-zone palette below it.
const POLARIZED = {
  easy: '#22c55e',
  grey: '#f59e0b',
  hard: '#ef4444',
};

function fmtTotalTime(totalSec: number) {
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function statusArrow(status: 'low' | 'ok' | 'high') {
  if (status === 'low') return { glyph: '↓', cls: 'text-amber-400' };
  if (status === 'high') return { glyph: '↑', cls: 'text-rose-400' };
  return { glyph: '✓', cls: 'text-emerald-400' };
}

function verdictClass(kind: PolarizedSummary['verdict']) {
  if (kind === 'on-target') return 'text-emerald-300';
  if (kind === 'no-data') return 'text-muted';
  return 'text-amber-300';
}

/**
 * Aggregate HR-zone breakdown across cardio sessions. Identical visual
 * grammar to the per-session bar on /cardio so users can scan both
 * without recalibrating.
 */
export function HrZonesCard({ recentCardio }: { recentCardio: MinimalCardio[] }) {
  const zones = useMemo(() => aggregateHrZones(recentCardio), [recentCardio]);
  const total = zones.reduce((a, b) => a + b, 0);
  const summary = useMemo(() => polarizedSummary(zones), [zones]);
  const sessionCount = useMemo(
    () => recentCardio.filter((c) => (c.hrZoneSeconds ?? []).some((s) => s > 0)).length,
    [recentCardio],
  );

  if (total <= 0) {
    return (
      <AnalyticsCard title="Time in HR zones" badge="cardio">
        <p className="text-sm text-muted">
          No HR-zone data in this window. Strava-imported runs with a heart-rate
          stream and configured zones will populate this card.
        </p>
      </AnalyticsCard>
    );
  }

  const easyPct = summary.easyShare * 100;
  const greyPct = summary.greyShare * 100;
  const hardPct = summary.hardShare * 100;
  const easyArrow = statusArrow(summary.easy.status);
  const greyArrow = statusArrow(summary.grey.status);
  const hardArrow = statusArrow(summary.hard.status);

  return (
    <AnalyticsCard
      title="Time in HR zones"
      badge="cardio"
      subtitle={`${fmtTotalTime(total)} across ${sessionCount} ${
        sessionCount === 1 ? 'session' : 'sessions'
      }`}
    >
      {/* Polarized-model summary: bucket the 5 zones into Easy / Grey / Hard
          and grade them against the standard 80 / <10 / 10–25 prescription. */}
      <div className="mb-4 rounded-lg border border-border bg-bg/50 p-3">
        <div className="mb-2 flex items-baseline justify-between text-xs">
          <span className="font-semibold uppercase tracking-wide text-muted">
            Polarized split
          </span>
          <span className="text-muted" title="Standard polarized-training prescription">
            Target: 80 / &lt;10 / 10–25
          </span>
        </div>
        <div
          className="flex h-3 overflow-hidden rounded"
          title={`Easy ${easyPct.toFixed(0)}% · Grey ${greyPct.toFixed(0)}% · Hard ${hardPct.toFixed(0)}%`}
        >
          {easyPct > 0 && (
            <div style={{ width: `${easyPct}%`, backgroundColor: POLARIZED.easy }} />
          )}
          {greyPct > 0 && (
            <div style={{ width: `${greyPct}%`, backgroundColor: POLARIZED.grey }} />
          )}
          {hardPct > 0 && (
            <div style={{ width: `${hardPct}%`, backgroundColor: POLARIZED.hard }} />
          )}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="font-semibold text-fg">
              Easy {easyPct.toFixed(0)}%{' '}
              <span className={easyArrow.cls}>{easyArrow.glyph}</span>
            </div>
            <div className="text-muted">Z1+Z2 · target ≥80%</div>
          </div>
          <div>
            <div className="font-semibold text-fg">
              Grey {greyPct.toFixed(0)}%{' '}
              <span className={greyArrow.cls}>{greyArrow.glyph}</span>
            </div>
            <div className="text-muted">Z3 · target &lt;10%</div>
          </div>
          <div>
            <div className="font-semibold text-fg">
              Hard {hardPct.toFixed(0)}%{' '}
              <span className={hardArrow.cls}>{hardArrow.glyph}</span>
            </div>
            <div className="text-muted">Z4+Z5 · target 10–25%</div>
          </div>
        </div>
        <p className={`mt-2 text-xs leading-snug ${verdictClass(summary.verdict)}`}>
          {summary.verdict === 'on-target' ? '✓ ' : '⚠ '}
          {summary.verdictText}
        </p>
      </div>

      <div className="flex h-3 overflow-hidden rounded">
        {zones.map((sec, i) => {
          const pct = (sec / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={i}
              style={{ width: `${pct}%`, backgroundColor: ZONE_COLORS[i] }}
              title={`Z${i + 1}: ${fmtTotalTime(sec)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <div className="mt-3 space-y-1.5">
        {zones.map((sec, i) => {
          const pct = total > 0 ? (sec / total) * 100 : 0;
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-sm"
                style={{ backgroundColor: ZONE_COLORS[i] }}
                aria-hidden
              />
              <span className="w-6 font-semibold text-fg">Z{i + 1}</span>
              <span className="w-20 text-muted">{ZONE_LABELS[i]}</span>
              <div className="relative h-2 flex-1 overflow-hidden rounded bg-bg">
                <div
                  className="h-full"
                  style={{ width: `${pct}%`, backgroundColor: ZONE_COLORS[i] }}
                />
              </div>
              <span className="w-16 text-right tabular-nums text-fg">
                {fmtTotalTime(sec)}
              </span>
              <span className="w-12 text-right tabular-nums text-muted">
                {pct.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
    </AnalyticsCard>
  );
}
