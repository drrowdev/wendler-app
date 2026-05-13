'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Race, ProgramBlock } from '@wendler/db-schema';
import type { ProposedTaperAction } from '@wendler/domain';
import { acceptAction, dismissAction } from '@/lib/raceTaperActions';

interface Props {
  race: Race;
  actions: ProposedTaperAction[];
  /** Required so insert-deload knows where to insert. May be undefined; the
   * Accept button on insert-deload disables itself if no active program. */
  programId?: string;
  programBlocks?: readonly ProgramBlock[];
}

/**
 * Per-race accept/dismiss panel for the proposed taper actions. Rendered
 * inside `<TaperBanner expanded />`. Each row: title, why, [Accept] [Dismiss].
 *
 * Visual idiom: a tight stack of cards inside the banner — no extra
 * border/background of its own (the banner already provides framing).
 *
 * Once an action is accepted or dismissed, `proposedTaperActions` stops
 * returning it so the row disappears on the next render. No optimistic
 * removal needed — Dexie liveQuery handles it.
 */
export function TaperActionsPanel({ race, actions, programId, programBlocks }: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (actions.length === 0) return null;

  const handleAccept = async (action: ProposedTaperAction) => {
    setBusyId(action.id);
    setError(null);
    try {
      const result = await acceptAction({ race, action, programId, programBlocks });
      if (action.kind === 'insert-deload' && result.blockId) {
        router.push(`/program/block?id=${result.blockId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept action');
    } finally {
      setBusyId(null);
    }
  };

  const handleDismiss = async (action: ProposedTaperAction) => {
    setBusyId(action.id);
    setError(null);
    try {
      await dismissAction(race, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss action');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Proposed actions
      </p>
      <ul className="space-y-2">
        {actions.map((action) => {
          const isBusy = busyId === action.id;
          const acceptDisabled =
            isBusy ||
            (action.kind === 'insert-deload' && (!programId || !programBlocks));
          return (
            <li
              key={action.id}
              className="rounded-md border border-border/60 bg-bg/40 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{action.title}</p>
                  <p className="mt-1 text-xs leading-snug text-muted">{action.why}</p>
                </div>
                <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => handleAccept(action)}
                    disabled={acceptDisabled}
                    className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-bg disabled:opacity-50"
                    title={
                      action.kind === 'insert-deload' && !programId
                        ? 'Start a program first'
                        : undefined
                    }
                  >
                    {isBusy ? 'Working…' : 'Accept'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDismiss(action)}
                    disabled={isBusy}
                    className="rounded border border-border px-2.5 py-1 text-xs disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <p className="text-[11px] text-muted">
        Why am I seeing this? &ldquo;{race.name}&rdquo; is{' '}
        {actions[0]!.daysOut === 0 ? 'today' : `${actions[0]!.daysOut} days away`} (priority{' '}
        {race.priority}). Accepted actions stick to this race; dismissed ones won&apos;t reappear.
        Auto-applied flags clear after race day.
      </p>
    </div>
  );
}
