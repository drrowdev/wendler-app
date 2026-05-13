'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { nextRaceWindow, proposedTaperActions } from '@wendler/domain';
import { useActiveBlock, useBlocks, useGoals, useUpcomingRaces } from '@/lib/hooks';
import { TaperActionsPanel } from './TaperActionsPanel';

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
  const races = useUpcomingRaces();
  const activeBlock = useActiveBlock();
  const allBlocks = useBlocks();

  const window = useMemo(() => {
    if (!goals) return undefined;
    return nextRaceWindow({
      goals: goals.map((g) => ({
        id: g.id,
        title: g.title,
        kind: g.kind,
        deadline: g.deadline,
        completedAt: g.completedAt,
      })),
      races: races ?? [],
    });
  }, [goals, races]);

  // Find the underlying Race (if the window is race-driven, not goal-driven)
  // so the actions panel can read/write its taperActions.
  const activeRace = useMemo(() => {
    if (!window?.raceId || !races) return undefined;
    return races.find((r) => r.id === window.raceId);
  }, [window?.raceId, races]);

  const proposedActions = useMemo(() => {
    if (!activeRace) return [];
    return proposedTaperActions(activeRace);
  }, [activeRace]);

  const programId = activeBlock?.programId;
  const programBlocks = useMemo(
    () => (allBlocks ?? []).filter((b) => b.programId === programId),
    [allBlocks, programId],
  );

  if (!goals || !window) return null;

  const style = PHASE_STYLES[window.phase] ?? PHASE_STYLES['off-season']!;
  const phaseLabel = window.phase.replace('-', ' ').toUpperCase();
  const isCutoff = window.raceTaperPhase === 'cutoff';

  if (!expanded) {
    return (
      <Link
        href="/races"
        className={`block rounded-lg border ${style.tone} px-3 py-2 text-sm`}
        title={window.reason ?? undefined}
      >
        <span className="mr-2">{style.emoji}</span>
        <span className="font-medium">{phaseLabel}</span>
        <span className="text-muted">
          {' '}
          · {window.daysOut === 0 ? 'today' : `${window.daysOut}d`} to {window.goalTitle}
        </span>
        {proposedActions.length > 0 && (
          <span className="ml-2 rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {proposedActions.length} action{proposedActions.length === 1 ? '' : 's'}
          </span>
        )}
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
      <p className="mt-1 text-sm text-muted">
        Next race: {window.goalTitle}
        {window.racePriority ? ` · priority ${window.racePriority}` : ''}
      </p>
      {window.reason && (
        <p className="mt-2 text-sm leading-snug">{window.reason}</p>
      )}
      {proposedActions.length === 0 && (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-sm">
          {window.guidance.slice(window.reason ? 1 : 0).map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}
      {activeRace && proposedActions.length > 0 && (
        <TaperActionsPanel
          race={activeRace}
          actions={proposedActions}
          programId={programId}
          programBlocks={programBlocks}
        />
      )}
      {isCutoff && (
        <p className="mt-3 text-xs text-muted">
          Lifting this close to race day adds fatigue without upside. Mobility,
          short walks, and easy spins only.
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
        <span>
          Strength × {window.strengthVolumeMultiplier.toFixed(2)} · Cardio ×{' '}
          {window.cardioVolumeMultiplier.toFixed(2)}
        </span>
        <Link href="/races" className="underline hover:text-fg">
          View season →
        </Link>
      </div>
    </section>
  );
}
