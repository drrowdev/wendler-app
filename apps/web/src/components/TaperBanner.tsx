'use client';

import Link from 'next/link';
import { nextRaceWindow } from '@wendler/domain';
import { useGoals } from '@/lib/hooks';

const PHASE_STYLES: Record<string, { tone: string; emoji: string }> = {
  'race-day': { tone: 'border-red-500/60 bg-red-500/15', emoji: '🏁' },
  'race-week': { tone: 'border-red-500/40 bg-red-500/10', emoji: '🏁' },
  taper: { tone: 'border-yellow-500/40 bg-yellow-500/10', emoji: '⏬' },
  peak: { tone: 'border-blue-500/40 bg-blue-500/10', emoji: '⛰️' },
  build: { tone: 'border-green-500/40 bg-green-500/10', emoji: '🏗️' },
  'off-season': { tone: 'border-border bg-card', emoji: '🌱' },
};

interface Props {
  /** When true, renders the full panel; otherwise a compact one-liner. */
  expanded?: boolean;
}

export function TaperBanner({ expanded = false }: Props) {
  const goals = useGoals();
  if (!goals) return null;
  const window = nextRaceWindow({
    goals: goals.map((g) => ({
      id: g.id,
      title: g.title,
      kind: g.kind,
      deadline: g.deadline,
      completedAt: g.completedAt,
    })),
  });
  if (!window) return null;
  const style = PHASE_STYLES[window.phase] ?? PHASE_STYLES['off-season']!;
  const phaseLabel = window.phase.replace('-', ' ').toUpperCase();

  if (!expanded) {
    return (
      <Link
        href="/load"
        className={`block rounded-lg border ${style.tone} px-3 py-2 text-sm`}
      >
        <span className="mr-2">{style.emoji}</span>
        <span className="font-medium">{phaseLabel}</span>
        <span className="text-muted">
          {' '}
          · {window.daysOut === 0 ? 'today' : `${window.daysOut}d`} to {window.goalTitle}
        </span>
      </Link>
    );
  }

  return (
    <section className={`rounded-lg border ${style.tone} p-4`}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">
          {style.emoji} {phaseLabel}
        </h2>
        <span className="text-xs text-muted">
          {window.daysOut === 0 ? 'race day' : `${window.daysOut} days out`}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">Next race: {window.goalTitle}</p>
      <ul className="mt-2 list-inside list-disc space-y-0.5 text-sm">
        {window.guidance.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
      <div className="mt-3 flex gap-3 text-xs text-muted">
        <span>Strength × {window.strengthVolumeMultiplier.toFixed(2)}</span>
        <span>Cardio × {window.cardioVolumeMultiplier.toFixed(2)}</span>
      </div>
    </section>
  );
}
