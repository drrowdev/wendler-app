'use client';

// InjurySheet — modal capture form for a new injury or for editing an
// existing one. After save, calls the analyzeInjury workflow and pipes
// the proposal into <InjuryProposalCard>.

import { useEffect, useState } from 'react';
import { nanoid } from 'nanoid';
import type { Injury, InjurySeverity, ProgramBlock } from '@wendler/db-schema';
import { getDb } from '@/lib/db';
import { useMovements } from '@/lib/hooks';
import { kickSync } from '@/lib/sync';
import { analyzeInjury, type InjuryAnalysisResult } from '@/lib/injury-workflow';

/**
 * Swap every assistance entry in a block plan that matches `fromId` with
 * the supplied alternative's movementId + name. Used by the Injury
 * accept flow to auto-apply Coach-proposed substitutions. Pure — returns
 * a new ProgramBlock; caller persists it.
 */
function applySubstitutionToBlock(
  block: ProgramBlock,
  fromId: string,
  alt: { movementId: string; movementName: string },
): ProgramBlock {
  if (!block.plan) return block;
  let touched = false;
  const days = block.plan.days.map((d) => {
    const next = d.assistance.map((e) => {
      if (e.movementId !== fromId) return e;
      touched = true;
      return {
        ...e,
        movementId: alt.movementId,
        movementName: alt.movementName,
        // The auto-generated suggester rationale described the OLD pick.
        suggestionRationale: undefined,
      };
    });
    if (next === d.assistance) return d;
    return { ...d, assistance: next };
  });
  if (!touched) return block;
  return { ...block, plan: { ...block.plan, days } };
}

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
  // Pre-fill from origin / existing injury. Match against the dropdown by
  // substring (case-insensitive) so a side-qualified or descriptor-padded
  // area string from the chat AI ("right adductor", "left knee", "elbow
  // tendinitis") lands on the dropdown's body-region entry. The side or
  // descriptor lives in the description anyway. Only fall back to "other"
  // when no dropdown entry is a substring of the supplied area.
  const initialAreaRaw = injury?.area ?? origin?.area ?? 'lower back';
  const initialAreaLower = initialAreaRaw.toLowerCase();
  // Prefer the longest match so "lower back" wins over "back" if we ever
  // added "back" to the list.
  const matchedArea = [...COMMON_AREAS]
    .filter((a) => a !== 'other')
    .sort((a, b) => b.length - a.length)
    .find((a) => initialAreaLower.includes(a.toLowerCase()));
  const [area, setArea] = useState(matchedArea ?? 'other');
  const [customArea, setCustomArea] = useState(matchedArea ? '' : initialAreaRaw);
  // When the supplied area string is MORE SPECIFIC than the matched
  // dropdown option (e.g. supplied "right adductor", dropdown matched
  // "adductor"), preserve the original specific string for storage so the
  // side qualifier survives. The dropdown still shows the body region
  // visually — `specificArea` just overrides `finalArea` until the user
  // explicitly picks a different dropdown option.
  const [specificArea, setSpecificArea] = useState<string | undefined>(() => {
    if (!matchedArea) return undefined;
    return initialAreaLower === matchedArea.toLowerCase() ? undefined : initialAreaRaw;
  });
  const onAreaChange = (next: string) => {
    setArea(next);
    setSpecificArea(undefined); // user took manual control of the body region
  };
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

  const finalArea =
    specificArea ??
    (area === 'other' ? customArea.trim() || 'other' : area);

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

    // Auto-apply substitutions for accepted adjustments whose action is
    // skip / reduce-load AND whose source movementId is currently
    // scheduled in the active block. Uses the deterministic top
    // alternative (alternatives[0]) as the replacement. Skips silently
    // when the movement isn't scheduled or no alternative was produced —
    // the accepted-text adjustment still applies as a flag, just no
    // automatic swap.
    const activeBlock = (await db.blocks.toArray()).find((b) => !b.completedAt);
    if (activeBlock?.plan) {
      let mutated = activeBlock;
      for (let i = 0; i < proposal.proposedAdjustments.length; i++) {
        if (!acceptedIndices.has(i)) continue;
        const adj = proposal.proposedAdjustments[i]!;
        const edit = edited.get(i);
        const action = edit?.action ?? adj.action;
        // Only `skip` triggers a movement swap. `reduce-load` /
        // `reduce-range` / `modify-execution` / `monitor` mean "keep the
        // same movement but train it differently" — they're flagged via
        // the AssistanceTrack chip + suggester prompt section, not via
        // an automatic substitution.
        if (action !== 'skip') continue;
        const top = adj.alternatives[0];
        if (!top) continue;
        if (top.movementId === adj.movementId) continue;
        mutated = applySubstitutionToBlock(mutated, adj.movementId, top);
      }
      if (mutated !== activeBlock) {
        await db.blocks.put({ ...mutated, updatedAt: new Date().toISOString() });
      }
    }

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
        {busy ? (
          <AnalyzingState area={finalArea} />
        ) : !proposal ? (
          <CaptureForm
            area={area}
            setArea={onAreaChange}
            customArea={customArea}
            setCustomArea={setCustomArea}
            specificArea={specificArea}
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
  /**
   * When the source area (from chat AI / pain-flag origin) was more
   * specific than the matched dropdown option (e.g. "right adductor" →
   * dropdown "adductor"), this is the original string. Surfaced as a
   * hint below the dropdown so the user sees the more specific value
   * that will actually be stored.
   */
  specificArea?: string;
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
  specificArea,
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
        {specificArea && area !== 'other' && (
          <p className="mt-1 text-[11px] text-muted">
            Saved as: <span className="font-mono text-fg/80">{specificArea}</span>
            <span className="ml-1">(picking a different option above overrides this)</span>
          </p>
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
  // Per-row decision: 'accepted' / 'declined' / undefined (= no choice yet).
  // Starts undefined for every adjustment — the user MUST explicitly accept
  // or decline each one. Save is disabled until every row has a decision,
  // which removes the "I left it alone, what happens?" ambiguity that the
  // previous default-accepted UX caused.
  const [decisions, setDecisions] = useState<Map<number, 'accepted' | 'declined'>>(
    new Map(),
  );
  const [editing] = useState<
    Map<
      number,
      { modification: string; action: 'skip' | 'reduce-load' | 'reduce-range' | 'modify-execution' | 'monitor' }
    >
  >(new Map());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDecisions(new Map());
  }, [proposal]);

  const setDecision = (i: number, choice: 'accepted' | 'declined') => {
    const next = new Map(decisions);
    next.set(i, choice);
    setDecisions(next);
  };

  const acceptAll = () => {
    const next = new Map<number, 'accepted' | 'declined'>();
    proposal.proposedAdjustments.forEach((_, i) => next.set(i, 'accepted'));
    setDecisions(next);
  };
  const declineAll = () => {
    const next = new Map<number, 'accepted' | 'declined'>();
    proposal.proposedAdjustments.forEach((_, i) => next.set(i, 'declined'));
    setDecisions(next);
  };

  const acceptedCount = Array.from(decisions.values()).filter(
    (v) => v === 'accepted',
  ).length;
  const decidedCount = decisions.size;
  const totalCount = proposal.proposedAdjustments.length;
  const allDecided = decidedCount === totalCount;

  const onSaveClick = async () => {
    if (!allDecided) return;
    const acceptedSet = new Set<number>();
    decisions.forEach((v, k) => {
      if (v === 'accepted') acceptedSet.add(k);
    });
    setBusy(true);
    await onSave(acceptedSet, editing);
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
            <span>
              {allDecided ? (
                <>
                  <span className="font-semibold text-emerald-300">{acceptedCount}</span>
                  <span className="mx-1">of</span>
                  <span>{totalCount}</span> accepted · only accepted ones apply.
                </>
              ) : (
                <>
                  <span className="font-semibold text-amber-300">
                    {decidedCount}
                  </span>
                  <span className="mx-1">of</span>
                  <span>{totalCount}</span> decided · accept or decline each below.
                </>
              )}
            </span>
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
              const decision = decisions.get(i);
              const isAccepted = decision === 'accepted';
              const isDeclined = decision === 'declined';
              const editState = editing.get(i);
              return (
                <li
                  key={i}
                  className={`rounded-lg border p-3 ${
                    isAccepted
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : isDeclined
                        ? 'border-rose-500/30 bg-rose-500/5 opacity-70'
                        : 'border-amber-500/40 bg-amber-500/5'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{adj.movementName}</div>
                      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted">
                        {(editState?.action ?? adj.action).replace('-', ' ')}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => setDecision(i, 'accepted')}
                        aria-pressed={isAccepted}
                        className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                          isAccepted
                            ? 'border-emerald-500/70 bg-emerald-500/25 text-emerald-100'
                            : 'border-border bg-bg/40 text-muted hover:border-emerald-500/40 hover:text-emerald-200'
                        }`}
                      >
                        ✓ Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => setDecision(i, 'declined')}
                        aria-pressed={isDeclined}
                        className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                          isDeclined
                            ? 'border-rose-500/60 bg-rose-500/20 text-rose-100'
                            : 'border-border bg-bg/40 text-muted hover:border-rose-500/40 hover:text-rose-200'
                        }`}
                      >
                        ✕ Decline
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 text-sm">{editState?.modification ?? adj.modification}</p>
                  <p className="mt-1 text-[11px] italic text-muted">{adj.reasoning}</p>
                  {!decision && (
                    <p className="mt-2 text-[11px] text-amber-300">
                      Pending — pick Accept or Decline.
                    </p>
                  )}
                  {adj.alternatives.length > 0 && isAccepted && adj.action === 'skip' && (
                    <div className="mt-2 rounded border border-sky-500/30 bg-sky-500/5 px-2 py-1 text-[11px] text-sky-200">
                      <span aria-hidden className="mr-1">⤳</span>
                      <span className="font-semibold">Auto-swap on accept:</span>{' '}
                      {adj.movementName} → {adj.alternatives[0]!.movementName}{' '}
                      <span className="text-sky-200/70">
                        — applied to every day in the active block where this movement is scheduled.
                      </span>
                    </div>
                  )}
                  {adj.alternatives.length > 0 && (
                    <details className="mt-2 text-[11px] text-muted">
                      <summary className="cursor-pointer">
                        {adj.alternatives.length} alternative(s) from your library
                      </summary>
                      <ul className="mt-1 space-y-0.5 pl-3">
                        {adj.alternatives.map((alt, ai) => (
                          <li key={alt.movementId}>
                            <span className="font-semibold text-fg/80">{alt.movementName}</span>
                            {ai === 0 && (
                              <span className="ml-1 rounded bg-sky-500/15 px-1 text-[10px] uppercase tracking-wide text-sky-300">
                                top pick
                              </span>
                            )}
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
          disabled={busy || !allDecided}
          onClick={onSaveClick}
          title={!allDecided ? `${totalCount - decidedCount} adjustment(s) still need a decision` : undefined}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50"
        >
          {busy
            ? 'Saving…'
            : !allDecided
              ? `Save (${decidedCount}/${totalCount} decided)`
              : `Save (${acceptedCount} accepted)`}
        </button>
      </div>
    </div>
  );
}

// AnalyzingState — full-form loading animation shown while the Coach
// workflow runs. Cycles through descriptive status lines so the user gets
// a sense of what's actually happening (each step corresponds to a real
// stage of the workflow even though the UI can't observe them in real
// time — the analyze call returns once at the end, ~5-15s).
const ANALYZING_STEPS_PREFIX = [
  'Reading the description and the affected movements…',
] as const;

function AnalyzingState({ area }: { area: string }) {
  const STEPS = [
    ANALYZING_STEPS_PREFIX[0],
    `Mapping ${area} demand across your full library…`,
    'Coach is identifying the underlying pattern…',
    'Cross-referencing your active programming…',
    'Building per-movement adjustments…',
    'Grounding alternatives in the deterministic substitution helper…',
    'Almost there — finalising the proposal…',
  ];
  const total = STEPS.length;
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setStepIdx((i) => Math.min(i + 1, total - 1));
    }, 1800);
    return () => clearInterval(interval);
  }, [total]);

  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="relative h-16 w-16">
        <div className="absolute inset-0 animate-ping rounded-full border-2 border-accent/30" />
        <div className="absolute inset-2 animate-pulse rounded-full bg-accent/20" />
        <div className="absolute inset-5 rounded-full bg-accent shadow-lg shadow-accent/40" />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Coach is analysing</h2>
        <p className="text-xs text-muted">
          Anatomical reasoning + library cross-referencing usually takes 5-15 seconds.
        </p>
      </div>
      <ul className="space-y-1.5 text-left text-xs">
        {STEPS.map((step, i) => {
          const done = i < stepIdx;
          const current = i === stepIdx;
          return (
            <li
              key={i}
              className={`flex items-start gap-2 transition-opacity ${
                done ? 'opacity-50' : current ? 'opacity-100' : 'opacity-30'
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 w-3 shrink-0 ${current ? 'animate-pulse text-accent' : ''}`}
              >
                {done ? '✓' : current ? '◐' : '·'}
              </span>
              <span className={current ? 'text-fg' : 'text-muted'}>{step}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
