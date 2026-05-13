'use client';

import Link from 'next/link';
import type { GoalSummary } from '@wendler/domain';
import { useActiveGoalSummaries } from '@/lib/hooks';

const STATUS_TONE: Record<string, string> = {
  achieved: 'bg-emerald-500',
  close: 'bg-emerald-400',
  'on-track': 'bg-sky-400',
  far: 'bg-zinc-500',
};

const TREND_ARROW: Record<string, string> = {
  up: '↑',
  flat: '→',
  down: '↓',
};

const TREND_TONE: Record<string, string> = {
  up: 'text-emerald-400',
  flat: 'text-muted',
  down: 'text-amber-400',
};

function ProgressBar({ pct, status }: { pct: number; status?: string }) {
  const tone = status ? STATUS_TONE[status] ?? 'bg-accent' : 'bg-accent';
  const w = Math.max(0.02, Math.min(1, pct));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
      <div className={`h-full ${tone}`} style={{ width: `${w * 100}%` }} />
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 64;
  const h = 18;
  const stepX = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-accent">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GoalRow({ s, expanded }: { s: GoalSummary; expanded?: boolean }) {
  const isQualitative = s.kind === 'qualitative';
  const tagText = isQualitative ? 'Focus' : kindLabel(s.kind);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{s.label}</div>
        <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          {tagText}
        </span>
      </div>
      {s.sublabel && (
        <div className="truncate text-xs text-muted">{s.sublabel}</div>
      )}
      {s.deadline && !s.sublabel?.includes('Race in') && (
        <div className="text-xs text-muted">{s.deadline.label}</div>
      )}
      {s.progressPct !== undefined && (
        <div className="space-y-0.5">
          <ProgressBar pct={s.progressPct} status={s.status} />
          {expanded && (
            <div className="text-[11px] text-muted">
              {Math.round(s.progressPct * 100)}%
              {s.status && <span className="ml-1">· {s.status.replace('-', ' ')}</span>}
            </div>
          )}
        </div>
      )}
      {s.trend && (
        <div className="flex items-center gap-2">
          <Sparkline values={s.trend.sparkline} />
          <span className={`text-xs font-medium ${TREND_TONE[s.trend.direction]}`}>
            {TREND_ARROW[s.trend.direction]}{' '}
            {s.trend.deltaPct > 0 ? '+' : ''}
            {s.trend.deltaPct.toFixed(1)}%
          </span>
          <span className="text-[11px] text-muted">· {s.trend.weeksCovered}w</span>
        </div>
      )}
    </div>
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'strength-pr': return 'PR';
    case 'race-time': return 'Race';
    case 'body-comp': return 'Body';
    case 'habit': return 'Habit';
    case 'custom': return 'Custom';
    case 'qualitative': return 'Focus';
    default: return kind;
  }
}

interface Props {
  /** When true, renders a richer layout (used on Analytics). */
  expanded?: boolean;
  /** Override the heading; defaults to "Goals". */
  heading?: string;
  /** Max active goals to show. Default 4 on Today, more on Analytics. */
  limit?: number;
}

export function ActiveGoalsCard({ expanded = false, heading = 'Goals', limit }: Props) {
  const summaries = useActiveGoalSummaries(limit ?? (expanded ? 8 : 4));
  if (!summaries) return null;

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">{heading}</h2>
        <Link href="/goals" className="text-xs font-medium text-accent hover:underline">
          {summaries.length === 0 ? 'Set one' : 'Edit'}
        </Link>
      </header>
      {summaries.length === 0 ? (
        <p className="text-sm text-muted">
          No active goals — head to Goals to set one.
        </p>
      ) : (
        <div className="space-y-3">
          {summaries.map((s) => (
            <GoalRow key={s.goalId} s={s} expanded={expanded} />
          ))}
        </div>
      )}
    </section>
  );
}
