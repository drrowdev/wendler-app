'use client';

import { useEffect, useState } from 'react';
import { nanoid } from 'nanoid';
import {
  epley1RM,
  suggestNewTrainingMax,
  type PrescribedSet,
} from '@wendler/domain';
import type { MainLift, SetRecord } from '@wendler/db-schema';
import { useSettings } from '@/lib/hooks';
import { getDb } from '@/lib/db';

interface AmrapAnalysisProps {
  lift: MainLift;
  prescribed: PrescribedSet[];
  logged: SetRecord[];
  currentTmKg: number;
}

/**
 * After an AMRAP set on the main lift, suggests a new TM/1RM and lets the user
 * accept (writes a new TrainingMax row) or decline. Decision is persisted per
 * AMRAP set id in localStorage so it doesn't re-prompt on reload. Renders
 * nothing until the user has logged the AMRAP set.
 */
export function AmrapAnalysis({ lift, prescribed, logged, currentTmKg }: AmrapAnalysisProps) {
  const settings = useSettings();
  const amrapTarget = prescribed.find((s) => s.isAmrap && s.kind !== 'supplemental');
  const [applying, setApplying] = useState(false);
  const [decision, setDecision] = useState<'pending' | 'applied' | 'declined'>('pending');

  const amrapLogged = logged
    .filter((s) => !s.deletedAt && !s.skipped && s.isAmrap && s.kind !== 'supplemental')
    .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];

  const decisionKey = amrapLogged ? `wendler.amrap-decision.${amrapLogged.id}` : null;

  useEffect(() => {
    if (!decisionKey) return;
    try {
      const stored = localStorage.getItem(decisionKey);
      if (stored === 'applied' || stored === 'declined') setDecision(stored);
      else setDecision('pending');
    } catch {
      // ignore
    }
  }, [decisionKey]);

  if (!amrapTarget) return null;
  if (!amrapLogged) return null;

  const e1rm = epley1RM(amrapLogged.weightKg, amrapLogged.reps);
  const tmPercent = settings?.defaultTmPercent ?? 0.85;
  const newTm = suggestNewTrainingMax(amrapLogged.weightKg, amrapLogged.reps, tmPercent);
  const delta = newTm - currentTmKg;
  const currentImpliedOneRm = tmPercent > 0 ? currentTmKg / tmPercent : currentTmKg;
  const oneRmDelta = e1rm - currentImpliedOneRm;

  const persist = (next: 'pending' | 'applied' | 'declined') => {
    setDecision(next);
    if (decisionKey) {
      try {
        if (next === 'pending') localStorage.removeItem(decisionKey);
        else localStorage.setItem(decisionKey, next);
      } catch {
        // ignore quota / private mode
      }
    }
  };

  const onApply = async () => {
    setApplying(true);
    await getDb().trainingMaxes.add({
      id: nanoid(),
      lift,
      trainingMaxKg: newTm,
      oneRmKg: e1rm,
      tmPercent,
      createdAt: new Date().toISOString(),
      source: 'amrap-suggestion',
      note: `From AMRAP ${amrapLogged.weightKg}×${amrapLogged.reps}${
        amrapLogged.rpe != null ? ` @ RPE ${amrapLogged.rpe}` : ''
      } · new 1RM ${e1rm.toFixed(1)} kg`,
    });
    setApplying(false);
    persist('applied');
  };

  const onDecline = () => persist('declined');
  const onReopen = () => persist('pending');

  if (decision === 'applied' || decision === 'declined') {
    return (
      <section className="mt-3 rounded-xl border border-border bg-card p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">
            {decision === 'applied' ? (
              <>
                <span className="text-emerald-400">✓ Accepted</span> · new e1RM{' '}
                <span className="font-mono text-fg">≈{e1rm.toFixed(1)} kg</span>{' '}
                <span className="text-[10px] uppercase tracking-wide text-accent">
                  estimated
                </span>
                , TM <span className="font-mono text-fg">{newTm.toFixed(1)} kg</span>
              </>
            ) : (
              <>
                <span className="text-muted">✕ Declined</span> · TM unchanged
              </>
            )}
          </span>
          <button
            onClick={onReopen}
            className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-fg"
          >
            Change
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-3 rounded-xl border border-accent/40 bg-accent/5 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-accent">
        AMRAP analysis · choose one
      </h2>
      <p className="mt-1 text-sm">
        {amrapLogged.weightKg} kg × <span className="font-bold">{amrapLogged.reps}</span> reps
        {amrapLogged.rpe != null && (
          <span className="text-muted"> · RPE {amrapLogged.rpe}</span>
        )}
      </p>
      <p className="mt-1 text-sm">
        New estimated 1RM (e1RM):{' '}
        <span className="font-mono">≈{e1rm.toFixed(1)} kg</span>{' '}
        <span className={oneRmDelta >= 0 ? 'text-emerald-400' : 'text-red-400'}>
          ({oneRmDelta >= 0 ? '+' : ''}
          {oneRmDelta.toFixed(1)} kg vs current)
        </span>
      </p>
      <p className="mt-1 text-sm text-muted">
        Accepting writes this as your new 1RM in the TM configuration. Because it comes from
        the AMRAP rather than a tested rep max, it&apos;ll be flagged as <em>estimated</em> in your
        1RM history. New working TM:{' '}
        <span className="font-mono text-fg">{newTm.toFixed(1)} kg</span>{' '}
        <span className={delta >= 0 ? 'text-emerald-400' : 'text-red-400'}>
          ({delta >= 0 ? '+' : ''}
          {delta.toFixed(1)} kg)
        </span>{' '}
        at {Math.round(tmPercent * 100)}%.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={onDecline}
          disabled={applying}
          className="rounded-lg border border-border bg-card py-2 font-semibold text-fg hover:bg-card/80 disabled:opacity-50"
        >
          Decline
        </button>
        <button
          onClick={onApply}
          disabled={applying}
          className="rounded-lg bg-accent py-2 font-semibold text-bg disabled:opacity-50"
        >
          {applying ? 'Applying…' : 'Accept'}
        </button>
      </div>
    </section>
  );
}
