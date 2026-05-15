'use client';

// InjurySheet — modal capture form for a new injury or for editing an
// existing one. After save, calls the analyzeInjury workflow and pipes
// the proposal into <InjuryProposalCard>.

import { useEffect, useState } from 'react';
import { nanoid } from 'nanoid';
import type { Injury, InjurySeverity } from '@wendler/db-schema';
import { getDb } from '@/lib/db';
import { useMovements } from '@/lib/hooks';
import { kickSync } from '@/lib/sync';
import { analyzeInjury, type InjuryAnalysisResult } from '@/lib/injury-workflow';

const COMMON_AREAS = [
  'lower back',
  'shoulder',
  'elbow',
  'wrist',
  'hip',
  'adductor',
  'knee',
  'ankle',
  'neck',
  'chest',
  'other',
];

interface Props {
  /** When provided, edit the existing injury. Otherwise create a new one. */
  injury?: Injury;
  /**
   * When the sheet was opened from a per-set pain flag, this is the set's
   * id and the linked movement so the new injury starts pre-populated.
   */
  origin?: {
    setId?: string;
    movementId?: string;
    area?: string;
    severity?: InjurySeverity;
    description?: string;
  };
  /** Called with the freshly-created (or updated) injury id once analysis returns. */
  onSaved: (injuryId: string) => void;
  onCancel: () => void;
}

export function InjurySheet({ injury, origin, onSaved, onCancel }: Props) {
  const movements = useMovements();
  const [area, setArea] = useState(injury?.area ?? origin?.area ?? 'lower back');
  const [customArea, setCustomArea] = useState('');
  const [severity, setSeverity] = useState<InjurySeverity>(
    injury?.severity ?? origin?.severity ?? 3,
  );
  const [description, setDescription] = useState(
    injury?.description ?? origin?.description ?? '',
  );
  const [selectedMovementIds, setSelectedMovementIds] = useState<string[]>(() => {
    if (injury) return [];
    if (origin?.movementId) return [origin.movementId];
    return [];
  });
  const [movementSearch, setMovementSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [proposal, setProposal] = useState<InjuryAnalysisResult | undefined>();

  const finalArea = area === 'other' ? customArea.trim() || 'other' : area;

  const onAnalyze = async () => {
    setError(undefined);
    if (!description.trim() || description.trim().length < 10) {
      setError('Please describe the pain in at least one full sentence.');
      return;
    }
    setBusy(true);
    const res = await analyzeInjury({
      area: finalArea,
      severity,
      description: description.trim(),
      ...(selectedMovementIds.length > 0 ? { initialMovementIds: selectedMovementIds } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(`Analysis failed: ${res.errors.join(' / ')}`);
      return;
    }
    setProposal(res.data);
  };

  // Save the injury record (and accepted adjustments) once the user has
  // reviewed the proposal.
  const onConfirmSave = async (
    acceptedIndices: Set<number>,
    edited: Map<
      number,
      { modification: string; action: 'skip' | 'reduce-load' | 'reduce-range' | 'modify-execution' | 'monitor' }
    >,
  ) => {
    if (!proposal) return;
    const db = getDb();
    const now = new Date().toISOString();
    const injuryId = injury?.id ?? nanoid();
    const adjustments = proposal.proposedAdjustments.map((adj, i) => {
      const adjId = `adj-${injuryId}-${i}`;
      const accepted = acceptedIndices.has(i);
      const edit = edited.get(i);
      return {
        id: adjId,
        movementId: adj.movementId,
        action: edit?.action ?? adj.action,
        modification: edit?.modification ?? adj.modification,
        reasoning: adj.reasoning,
        status: accepted ? ('accepted' as const) : ('declined' as const),
        proposedAt: now,
        ...(accepted ? { acceptedAt: now } : { declinedAt: now }),
        ...(edit ? { userEdited: true } : {}),
      };
    });
    const next: Injury = {
      id: injuryId,
      area: finalArea,
      severity,
      description: description.trim(),
      summary: proposal.summary,
      adjustments,
      ...(proposal.monitoringAdvice ? { monitoringAdvice: proposal.monitoringAdvice } : {}),
      consultRecommended: proposal.consultRecommended,
      ...(proposal.consultReason ? { consultReason: proposal.consultReason } : {}),
      startedAt: injury?.startedAt ?? now,
      ...(origin?.setId ? { originSetId: origin.setId } : {}),
      createdAt: injury?.createdAt ?? now,
      updatedAt: now,
    };
    await db.injuries.put(next);
    kickSync();
    onSaved(injuryId);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        {!proposal ? (
          <CaptureForm
            area={area}
            setArea={setArea}
            customArea={customArea}
            setCustomArea={setCustomArea}
            severity={severity}
            setSeverity={setSeverity}
            description={description}
            setDescription={setDescription}
            selectedMovementIds={selectedMovementIds}
            setSelectedMovementIds={setSelectedMovementIds}
            movementSearch={movementSearch}
            setMovementSearch={setMovementSearch}
            movements={movements ?? []}
            busy={busy}
            error={error}
            onAnalyze={onAnalyze}
            onCancel={onCancel}
          />
        ) : (
          <ProposalReview
            proposal={proposal}
            onSave={onConfirmSave}
            onBack={() => setProposal(undefined)}
            onCancel={onCancel}
          />
        )}
      </div>
    </div>
  );
}

interface CaptureFormProps {
  area: string;
  setArea: (s: string) => void;
  customArea: string;
  setCustomArea: (s: string) => void;
  severity: InjurySeverity;
  setSeverity: (s: InjurySeverity) => void;
  description: string;
  setDescription: (s: string) => void;
  selectedMovementIds: string[];
  setSelectedMovementIds: (ids: string[]) => void;
  movementSearch: string;
  setMovementSearch: (s: string) => void;
  movements: { id: string; name: string }[];
  busy: boolean;
  error?: string;
  onAnalyze: () => void;
  onCancel: () => void;
}

function CaptureForm({
  area,
  setArea,
  customArea,
  setCustomArea,
  severity,
  setSeverity,
  description,
  setDescription,
  selectedMovementIds,
  setSelectedMovementIds,
  movementSearch,
  setMovementSearch,
  movements,
  busy,
  error,
  onAnalyze,
  onCancel,
}: CaptureFormProps) {
  const filteredMovements =
    movementSearch.trim() === ''
      ? movements.slice(0, 8)
      : movements.filter((m) => m.name.toLowerCase().includes(movementSearch.toLowerCase())).slice(0, 12);
  const toggleMovement = (id: string) => {
    setSelectedMovementIds(
      selectedMovementIds.includes(id)
        ? selectedMovementIds.filter((x) => x !== id)
        : [...selectedMovementIds, id],
    );
  };
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Log a limitation</h2>
        <p className="mt-1 text-xs text-muted">
          Tell the Coach what&apos;s going on. The more specific (which side, with load vs bodyweight, which movements), the better the proposal.
        </p>
      </header>

      <label className="block">
        <span className="text-xs text-muted">Area</span>
        <select
          value={area}
          onChange={(e) => setArea(e.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-2"
        >
          {COMMON_AREAS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        {area === 'other' && (
          <input
            type="text"
            value={customArea}
            onChange={(e) => setCustomArea(e.target.value)}
            placeholder="e.g. right adductor"
            className="mt-2 w-full rounded-lg border border-border bg-bg px-2 py-2"
          />
        )}
      </label>

      <div>
        <span className="text-xs text-muted">Severity (1 = twinge, 5 = couldn&apos;t continue)</span>
        <div className="mt-1 grid grid-cols-5 gap-1">
          {([1, 2, 3, 4, 5] as InjurySeverity[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSeverity(s)}
              className={`rounded-lg border px-2 py-2 text-sm font-semibold ${
                severity === s
                  ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                  : 'border-border bg-bg text-muted'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="text-xs text-muted">
          Description
          <span className="ml-1 text-muted/70">
            (be specific: side, load vs bodyweight, which movements)
          </span>
        </span>
        <textarea
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder='e.g. "Pain in right adductor on weighted Bulgarian split squat. Bodyweight is fine. Left side fine. Also felt during dead bug right-leg extension."'
          className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-2 leading-snug"
        />
      </label>

      <div>
        <span className="text-xs text-muted">
          Movements affected (optional — Coach will identify others)
        </span>
        <input
          type="search"
          value={movementSearch}
          onChange={(e) => setMovementSearch(e.target.value)}
          placeholder="Type to search..."
          className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-2 text-sm"
        />
        {selectedMovementIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedMovementIds.map((id) => {
              const m = movements.find((x) => x.id === id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleMovement(id)}
                  className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-200 ring-1 ring-amber-500/40"
                >
                  {m?.name ?? id} ✕
                </button>
              );
            })}
          </div>
        )}
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
          {filteredMovements.map((m) => {
            const sel = selectedMovementIds.includes(m.id);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => toggleMovement(m.id)}
                  className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs ${
                    sel ? 'bg-amber-500/10 text-amber-200' : 'hover:bg-bg/60'
                  }`}
                >
                  <span>{m.name}</span>
                  <span className="text-muted">{sel ? '✓' : '+'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onAnalyze}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50"
        >
          {busy ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>
    </div>
  );
}

interface ProposalReviewProps {
  proposal: InjuryAnalysisResult;
  onSave: (
    acceptedIndices: Set<number>,
    edited: Map<
      number,
      { modification: string; action: 'skip' | 'reduce-load' | 'reduce-range' | 'modify-execution' | 'monitor' }
    >,
  ) => Promise<void>;
  onBack: () => void;
  onCancel: () => void;
}

function ProposalReview({ proposal, onSave, onBack, onCancel }: ProposalReviewProps) {
  // Default: accept all (the user can flip individual ones to declined).
  const [accepted, setAccepted] = useState<Set<number>>(
    () => new Set(proposal.proposedAdjustments.map((_, i) => i)),
  );
  const [editing] = useState<
    Map<
      number,
      { modification: string; action: 'skip' | 'reduce-load' | 'reduce-range' | 'modify-execution' | 'monitor' }
    >
  >(new Map());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAccepted(new Set(proposal.proposedAdjustments.map((_, i) => i)));
  }, [proposal]);

  const toggle = (i: number) => {
    const next = new Set(accepted);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setAccepted(next);
  };

  const acceptAll = () =>
    setAccepted(new Set(proposal.proposedAdjustments.map((_, i) => i)));
  const declineAll = () => setAccepted(new Set());

  const onSaveClick = async () => {
    setBusy(true);
    await onSave(accepted, editing);
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Coach proposal</h2>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-muted underline-offset-2 hover:underline"
        >
          ← Back to edit
        </button>
      </header>

      <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-sky-300">Summary</div>
        <p className="mt-1 text-sm">{proposal.summary}</p>
      </section>

      {proposal.consultRecommended && (
        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-300">
            ⚠ PT consult recommended
          </div>
          <p className="mt-1 text-sm">{proposal.consultReason}</p>
        </section>
      )}

      {proposal.proposedAdjustments.length === 0 ? (
        <p className="rounded-lg border border-border bg-bg p-3 text-sm text-muted">
          Coach didn&apos;t propose any specific movement modifications. Save anyway to track this episode.
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between text-xs text-muted">
            <span>{proposal.proposedAdjustments.length} adjustment(s) proposed</span>
            <div className="flex gap-2">
              <button type="button" onClick={acceptAll} className="underline-offset-2 hover:underline">
                Accept all
              </button>
              <button type="button" onClick={declineAll} className="underline-offset-2 hover:underline">
                Decline all
              </button>
            </div>
          </div>
          <ul className="space-y-2">
            {proposal.proposedAdjustments.map((adj, i) => {
              const isAccepted = accepted.has(i);
              const editState = editing.get(i);
              return (
                <li
                  key={i}
                  className={`rounded-lg border p-3 ${
                    isAccepted
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : 'border-border bg-bg/40'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{adj.movementName}</div>
                      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted">
                        {(editState?.action ?? adj.action).replace('-', ' ')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggle(i)}
                      className={`shrink-0 rounded-lg border px-2 py-1 text-xs ${
                        isAccepted
                          ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                          : 'border-border text-muted hover:text-fg'
                      }`}
                    >
                      {isAccepted ? '✓ Accept' : 'Decline'}
                    </button>
                  </div>
                  <p className="mt-2 text-sm">{editState?.modification ?? adj.modification}</p>
                  <p className="mt-1 text-[11px] italic text-muted">{adj.reasoning}</p>
                  {adj.alternatives.length > 0 && (
                    <details className="mt-2 text-[11px] text-muted">
                      <summary className="cursor-pointer">
                        {adj.alternatives.length} alternative(s) from your library
                      </summary>
                      <ul className="mt-1 space-y-0.5 pl-3">
                        {adj.alternatives.map((alt) => (
                          <li key={alt.movementId}>
                            <span className="font-semibold text-fg/80">{alt.movementName}</span>
                            <span className="ml-1">— {alt.rationale}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {proposal.monitoringAdvice && (
        <section className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Monitoring</div>
          <p className="mt-1 text-sm">{proposal.monitoringAdvice}</p>
        </section>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg"
        >
          Discard
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSaveClick}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
