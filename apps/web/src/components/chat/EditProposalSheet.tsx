'use client';

// EditProposalSheet — the per-row diff UI for a `propose_edit` ChatAction.
//
// Renders the AI's full multi-op plan as an inline-modal sheet:
//   - One header summary (headline, reason, confidence chip).
//   - One row per operation with:
//      * a kind-specific before / after preview (loaded from Dexie live).
//      * two explicit decision buttons (Accept / Decline) — NO default
//        state (same lesson as InjurySheet v376: defaults-all-accepted
//        plus a single-toggle button gets read backwards by users).
//      * an optional "Modify" affordance for the numeric fields the AI
//        proposed (sets, reps, TM kg) — picker bounded to sensible
//        ranges per op kind.
//   - One "Apply N of M ops" button that only enables once every op has
//     a decision. Applies atomically via applyEditProposal.
//
// Per-op preview renderers are inlined in this file for proximity. Each
// is small and uses useLiveQuery for the "before" data so the sheet
// stays accurate when the user trains in another tab.

import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { resolveDayAssistance, type WendlerWeek } from '@wendler/domain';
import type {
  EditOperation,
  EditOperationDecision,
  Movement,
  ProposeEditChatAction,
  ProgramBlock,
} from '@wendler/db-schema';
import { getDb } from '@/lib/db';
import { useMovements } from '@/lib/hooks';
import { applyEditProposal } from '@/lib/edit-proposal-apply';

interface Props {
  chatId: string;
  messageId: string;
  action: ProposeEditChatAction;
  onClose: () => void;
}

const OP_LABELS: Record<EditOperation['kind'], string> = {
  set_training_max: 'Training max',
  set_block_volume_preset: 'Volume preset',
  trim_assistance_entry: 'Trim entry',
  swap_assistance_movement: 'Swap movement',
  add_assistance_entry: 'Add entry',
  add_movement_to_library: 'Add to library',
  add_cardio_plan_slot: 'Add cardio slot',
  remove_assistance_entry: 'Remove entry',
  schedule_deload: 'Schedule deload',
  skip_day_in_week: 'Skip day',
};

const OP_TONE: Record<EditOperation['kind'], string> = {
  set_training_max: 'bg-violet-500/15 text-violet-100 ring-violet-500/40',
  set_block_volume_preset: 'bg-amber-500/15 text-amber-100 ring-amber-500/40',
  trim_assistance_entry: 'bg-amber-500/15 text-amber-100 ring-amber-500/40',
  swap_assistance_movement: 'bg-sky-500/15 text-sky-100 ring-sky-500/40',
  add_assistance_entry: 'bg-emerald-500/15 text-emerald-100 ring-emerald-500/40',
  add_movement_to_library: 'bg-emerald-500/15 text-emerald-100 ring-emerald-500/40',
  add_cardio_plan_slot: 'bg-sky-500/15 text-sky-100 ring-sky-500/40',
  remove_assistance_entry: 'bg-rose-500/15 text-rose-100 ring-rose-500/40',
  schedule_deload: 'bg-sky-500/15 text-sky-100 ring-sky-500/40',
  skip_day_in_week: 'bg-rose-500/15 text-rose-100 ring-rose-500/40',
};

export function EditProposalSheet({ chatId, messageId, action, onClose }: Props) {
  // Per-op decisions live in component state while the user reviews;
  // committed onto the chip + applied via applyEditProposal on Save.
  // Initial state: every op pending (no defaults — user must decide).
  const [decisions, setDecisions] = useState<Record<string, EditOperationDecision>>(
    () => Object.fromEntries(action.operations.map((o) => [o.id, { status: 'pending' }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [results, setResults] = useState<
    | undefined
    | Record<
        string,
        { status: 'applied' | 'declined' | 'failed'; error?: string }
      >
  >(undefined);

  const setDecision = (
    opId: string,
    next: { status: 'accepted' | 'declined'; modifiedInput?: Record<string, unknown> },
  ) => {
    setDecisions((d) => ({ ...d, [opId]: next }));
  };

  /** Bulk-set every pending op. Skips ops the user has already decided. */
  const setAllPending = (status: 'accepted' | 'declined') => {
    setDecisions((d) => {
      const next = { ...d };
      for (const op of action.operations) {
        const cur = next[op.id];
        if (!cur || cur.status === 'pending') {
          next[op.id] = { status, ...(cur?.modifiedInput ? { modifiedInput: cur.modifiedInput } : {}) };
        }
      }
      return next;
    });
  };

  const setModified = (opId: string, patch: Record<string, unknown>) => {
    setDecisions((d) => {
      const cur = d[opId] ?? { status: 'pending' };
      return {
        ...d,
        [opId]: {
          status: cur.status,
          modifiedInput: { ...(cur.modifiedInput ?? {}), ...patch },
        },
      };
    });
  };

  /**
   * "Use existing library entry" path for an add_movement_to_library op:
   *   1. Mark the library op DECLINED (we're not adding a new entry).
   *   2. Rewrite any sibling add_assistance_entry op whose movementId
   *      matched the tempMovementId so it points at the chosen existing
   *      Movement. The orchestrator's tempIdMap is bypassed entirely
   *      since the real id is now baked into the op's modifiedInput.
   *
   * Driven from AddMovementToLibraryDiff's "Use existing X" link.
   */
  const useExistingForTemp = (tempMovementId: string, real: Movement) => {
    setDecisions((d) => {
      const next = { ...d };
      for (const op of action.operations) {
        if (op.kind === 'add_movement_to_library' && op.tempMovementId === tempMovementId) {
          next[op.id] = { status: 'declined' };
          continue;
        }
        if (op.kind === 'add_assistance_entry' && op.movementId === tempMovementId) {
          const cur = next[op.id] ?? { status: 'pending' };
          next[op.id] = {
            status: cur.status,
            modifiedInput: {
              ...(cur.modifiedInput ?? {}),
              movementId: real.id,
              movementName: real.name,
            },
          };
        }
      }
      return next;
    });
  };

  const acceptedCount = useMemo(
    () => Object.values(decisions).filter((d) => d.status === 'accepted').length,
    [decisions],
  );
  const decidedCount = useMemo(
    () => Object.values(decisions).filter((d) => d.status !== 'pending').length,
    [decisions],
  );
  const total = action.operations.length;
  const allDecided = decidedCount === total;

  const onApply = async () => {
    setBusy(true);
    setError(undefined);
    const r = await applyEditProposal(chatId, messageId, action, decisions);
    setBusy(false);
    const summary: Record<string, { status: 'applied' | 'declined' | 'failed'; error?: string }> =
      {};
    for (const [id, entry] of Object.entries(r.perOp)) {
      if (entry.status === 'applied') summary[id] = { status: 'applied' };
      else if (entry.status === 'declined') summary[id] = { status: 'declined' };
      else summary[id] = { status: 'failed', error: entry.error };
    }
    setResults(summary);
    if (!r.ok) {
      setError(r.error ?? 'Apply failed.');
      return;
    }
    // On success leave the sheet open briefly so the user sees the
    // per-op result chips, then close.
    setTimeout(onClose, 1200);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AI proposal review"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2 sm:items-center"
      onClick={() => !busy && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card"
      >
        <header className="border-b border-border bg-card/80 p-4 backdrop-blur">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold">Coach proposal</h2>
            {action.confidence && <ConfidenceChip confidence={action.confidence} />}
          </div>
          <p className="mt-2 text-base font-medium leading-snug text-fg/90">
            {action.headline}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">{action.reason}</p>
        </header>

        <ol className="flex-1 overflow-y-auto p-4 space-y-3">
          {!results && action.operations.length > 1 && (
            <li className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg/30 px-3 py-2 text-xs">
              <span className="text-muted">Bulk-set pending ops:</span>
              <button
                type="button"
                onClick={() => setAllPending('accepted')}
                className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-semibold text-emerald-100 hover:bg-emerald-500/20"
              >
                Accept all
              </button>
              <button
                type="button"
                onClick={() => setAllPending('declined')}
                className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 font-semibold text-rose-100 hover:bg-rose-500/20"
              >
                Decline all
              </button>
              <span className="ml-auto text-[11px] text-muted">
                {acceptedCount}/{total} accepted · {total - decidedCount} pending
              </span>
            </li>
          )}
          {action.operations.map((op, i) => (
            <OpRow
              key={op.id}
              index={i}
              op={op}
              decision={decisions[op.id] ?? { status: 'pending' }}
              result={results?.[op.id]}
              onAccept={() => setDecision(op.id, { status: 'accepted' })}
              onDecline={() => setDecision(op.id, { status: 'declined' })}
              onModify={(patch) => setModified(op.id, patch)}
              onUseExistingLibraryMovement={useExistingForTemp}
            />
          ))}
        </ol>

        <footer className="border-t border-border bg-card/80 p-4 backdrop-blur">
          {error && (
            <p className="mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
              {error}
            </p>
          )}
          {!allDecided && !results && (
            <p className="mb-2 text-xs text-amber-200">
              Decide every operation before applying. {decidedCount} of {total} decided.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg border border-border bg-bg/40 px-4 py-2 text-sm font-medium hover:bg-bg/60 disabled:opacity-50"
            >
              {results ? 'Close' : 'Cancel'}
            </button>
            {!results && (
              <button
                type="button"
                onClick={() => void onApply()}
                disabled={busy || !allDecided || acceptedCount === 0}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy
                  ? 'Applying…'
                  : !allDecided
                    ? `Decide all (${decidedCount}/${total})`
                    : acceptedCount === 0
                      ? 'Nothing to apply'
                      : `Apply ${acceptedCount} of ${total} ops`}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function ConfidenceChip({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  const tone =
    confidence === 'high'
      ? 'bg-emerald-500/20 text-emerald-100 ring-emerald-500/40'
      : confidence === 'medium'
        ? 'bg-amber-500/20 text-amber-100 ring-amber-500/40'
        : 'bg-rose-500/20 text-rose-100 ring-rose-500/40';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${tone}`}
      title="Coach confidence in this plan (relative ordering only)"
    >
      Confidence: {confidence}
    </span>
  );
}

interface OpRowProps {
  index: number;
  op: EditOperation;
  decision: EditOperationDecision;
  result?: { status: 'applied' | 'declined' | 'failed'; error?: string };
  onAccept: () => void;
  onDecline: () => void;
  onModify: (patch: Record<string, unknown>) => void;
  /**
   * "Use existing X" shortcut for add_movement_to_library: declines this
   * op AND rewrites any sibling add_assistance_entry op whose movementId
   * matches the op's tempMovementId to point at the chosen existing
   * library entry. EditProposalSheet owns this because it spans multiple
   * rows.
   */
  onUseExistingLibraryMovement: (tempMovementId: string, real: Movement) => void;
}

function OpRow({
  index,
  op,
  decision,
  result,
  onAccept,
  onDecline,
  onModify,
  onUseExistingLibraryMovement,
}: OpRowProps) {
  const isAccepted = decision.status === 'accepted';
  const isDeclined = decision.status === 'declined';
  const pending = decision.status === 'pending';

  const ringTone = result
    ? result.status === 'applied'
      ? 'border-emerald-500/40 bg-emerald-500/5'
      : result.status === 'failed'
        ? 'border-rose-500/40 bg-rose-500/5'
        : 'border-border bg-bg/30'
    : pending
      ? 'border-amber-500/40 bg-amber-500/5'
      : isAccepted
        ? 'border-emerald-500/40 bg-emerald-500/5'
        : 'border-border bg-bg/30';

  return (
    <li className={`rounded-xl border p-4 ${ringTone}`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-bold tabular-nums text-muted">#{index + 1}</span>
        <span
          className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${OP_TONE[op.kind]}`}
        >
          {OP_LABELS[op.kind]}
        </span>
        <h3 className="text-sm font-semibold">{op.label}</h3>
      </div>
      {op.rationale && <p className="mb-2 text-xs italic text-muted">{op.rationale}</p>}

      <div className="mb-3">
        <OpDiff
          op={op}
          modified={decision.modifiedInput}
          onModify={onModify}
          onUseExistingLibraryMovement={onUseExistingLibraryMovement}
        />
      </div>

      {result ? (
        <div
          className={`rounded-lg px-3 py-2 text-xs font-medium ${
            result.status === 'applied'
              ? 'bg-emerald-500/15 text-emerald-100'
              : result.status === 'failed'
                ? 'bg-rose-500/15 text-rose-100'
                : 'bg-bg/40 text-muted'
          }`}
        >
          {result.status === 'applied' && '✓ Applied'}
          {result.status === 'failed' && `✕ Failed: ${result.error ?? 'Unknown error'}`}
          {result.status === 'declined' && '— Skipped (declined)'}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onAccept}
            aria-pressed={isAccepted}
            className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
              isAccepted
                ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-100'
                : 'border-border bg-bg/40 text-fg/80 hover:bg-emerald-500/10 hover:text-emerald-100'
            }`}
          >
            {isAccepted ? '✓ Accepted' : 'Accept'}
          </button>
          <button
            type="button"
            onClick={onDecline}
            aria-pressed={isDeclined}
            className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
              isDeclined
                ? 'border-rose-500/50 bg-rose-500/20 text-rose-100'
                : 'border-border bg-bg/40 text-fg/80 hover:bg-rose-500/10 hover:text-rose-100'
            }`}
          >
            {isDeclined ? '✕ Declined' : 'Decline'}
          </button>
          {pending && (
            <span className="ml-1 text-[11px] text-amber-200">
              Pending — pick Accept or Decline
            </span>
          )}
        </div>
      )}
    </li>
  );
}

// ===== Per-op diff renderers =====

interface DiffProps {
  op: EditOperation;
  modified?: Record<string, unknown>;
  onModify: (patch: Record<string, unknown>) => void;
  onUseExistingLibraryMovement: (tempMovementId: string, real: Movement) => void;
}

function OpDiff({
  op,
  modified,
  onModify,
  onUseExistingLibraryMovement,
}: DiffProps) {
  switch (op.kind) {
    case 'set_training_max':
      return <SetTrainingMaxDiff op={op} modified={modified} onModify={onModify} />;
    case 'set_block_volume_preset':
      return <SetBlockVolumePresetDiff op={op} modified={modified} onModify={onModify} />;
    case 'trim_assistance_entry':
      return <TrimAssistanceEntryDiff op={op} modified={modified} onModify={onModify} />;
    case 'swap_assistance_movement':
      return <SwapAssistanceMovementDiff op={op} modified={modified} onModify={onModify} />;
    case 'add_assistance_entry':
      return <AddAssistanceEntryDiff op={op} modified={modified} onModify={onModify} />;
    case 'add_movement_to_library':
      return (
        <AddMovementToLibraryDiff
          op={op}
          modified={modified}
          onModify={onModify}
          onUseExisting={onUseExistingLibraryMovement}
        />
      );
    case 'add_cardio_plan_slot':
      return <AddCardioPlanSlotDiff op={op} />;
    case 'remove_assistance_entry':
      return <RemoveAssistanceEntryDiff op={op} />;
    case 'schedule_deload':
      return <ScheduleDeloadDiff />;
    case 'skip_day_in_week':
      return <SkipDayInWeekDiff op={op} />;
  }
}

function SetTrainingMaxDiff({
  op,
  modified,
  onModify,
}: {
  op: EditOperation & { kind: 'set_training_max' };
  modified?: Record<string, unknown>;
  onModify: (patch: Record<string, unknown>) => void;
}) {
  const prev = useLiveQuery(async () => {
    const all = await getDb().trainingMaxes.toArray();
    const matching = all.filter((t) => t.lift === op.lift);
    if (matching.length === 0) return null;
    matching.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return matching[0]!.trainingMaxKg;
  }, [op.lift]);
  const effective = (modified?.newTrainingMaxKg as number | undefined) ?? op.newTrainingMaxKg;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs text-muted">{op.lift}</span>
        <span className="tabular-nums">
          {prev != null ? `${prev.toFixed(1)} kg` : '— no record'}
        </span>
        <span aria-hidden className="text-muted">→</span>
        <NumberInput
          value={effective}
          step={0.5}
          min={0}
          ariaLabel="Proposed training max kg"
          onChange={(n) => onModify({ newTrainingMaxKg: n })}
          suffix="kg"
        />
        {prev != null && effective !== prev && (
          <span
            className={`text-xs tabular-nums ${
              effective < prev ? 'text-rose-200' : 'text-emerald-200'
            }`}
          >
            ({effective > prev ? '+' : ''}
            {(effective - prev).toFixed(1)} kg)
          </span>
        )}
      </div>
    </div>
  );
}

function SetBlockVolumePresetDiff({
  op,
  modified,
  onModify,
}: {
  op: EditOperation & { kind: 'set_block_volume_preset' };
  modified?: Record<string, unknown>;
  onModify: (patch: Record<string, unknown>) => void;
}) {
  const block = useResolvedBlock(op.blockId);
  const cur =
    typeof block?.assistanceVolume === 'string' ? block.assistanceVolume : 'standard';
  const effective = (modified?.preset as string | undefined) ?? op.preset;
  return (
    <div className="space-y-2 text-sm">
      <div className="text-xs text-muted">
        {block ? `Block "${block.name}"` : 'Active block'}
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="capitalize">{cur}</span>
        <span aria-hidden className="text-muted">→</span>
        <select
          value={effective}
          onChange={(e) => onModify({ preset: e.target.value })}
          className="rounded border border-border bg-bg/40 px-2 py-1 text-sm capitalize focus:border-accent focus:outline-none"
          aria-label="Proposed assistance volume preset"
        >
          <option value="minimal">minimal</option>
          <option value="standard">standard</option>
          <option value="high">high</option>
        </select>
      </div>
    </div>
  );
}

function TrimAssistanceEntryDiff({
  op,
  modified,
  onModify,
}: {
  op: EditOperation & { kind: 'trim_assistance_entry' };
  modified?: Record<string, unknown>;
  onModify: (patch: Record<string, unknown>) => void;
}) {
  const entry = useResolvedEntry(op.blockId, op.dayId, op.entryId);
  const eff = {
    sets: (modified?.newSets as number | undefined) ?? op.newSets,
    reps: (modified?.newReps as number | undefined) ?? op.newReps,
    repsMax: (modified?.newRepsMax as number | undefined) ?? op.newRepsMax,
  };
  return (
    <div className="space-y-2 text-sm">
      <div className="text-xs text-muted">
        {op.movementName} (entry <code>{op.entryId.slice(0, 8)}…</code>)
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="tabular-nums">
          {entry
            ? `${entry.sets}×${entry.repsMax != null ? `${entry.reps}-${entry.repsMax}` : entry.reps}`
            : '— entry not found in current plan'}
        </span>
        <span aria-hidden className="text-muted">→</span>
        <NumberInput
          value={eff.sets}
          step={1}
          min={1}
          max={10}
          ariaLabel="New sets"
          onChange={(n) => onModify({ newSets: n })}
          suffix="×"
        />
        <NumberInput
          value={eff.reps}
          step={1}
          min={1}
          max={50}
          ariaLabel="New reps"
          onChange={(n) => onModify({ newReps: n })}
        />
        {eff.repsMax !== undefined && (
          <>
            <span className="text-muted">-</span>
            <NumberInput
              value={eff.repsMax}
              step={1}
              min={eff.reps}
              max={99}
              ariaLabel="New reps max"
              onChange={(n) => onModify({ newRepsMax: n })}
            />
          </>
        )}
      </div>
    </div>
  );
}

function SwapAssistanceMovementDiff({
  op,
  modified,
  onModify,
}: {
  op: EditOperation & { kind: 'swap_assistance_movement' };
  modified?: Record<string, unknown>;
  onModify: (patch: Record<string, unknown>) => void;
}) {
  const entry = useResolvedEntry(op.blockId, op.dayId, op.entryId);
  const [showAll, setShowAll] = useState(false);

  // Library candidate picker. By default we offer same-pattern movements
  // (the safer, most-physiologically-similar swap surface). "Show all"
  // expands to the full library so the user can override.
  const candidates = useLiveQuery(async () => {
    const movements = await getDb().movements.toArray();
    const sourceMovement = movements.find((m) => m.id === op.currentMovementId);
    const samePattern = sourceMovement
      ? movements.filter((m) => m.id !== op.currentMovementId && m.pattern === sourceMovement.pattern)
      : [];
    return { samePattern, all: movements.filter((m) => m.id !== op.currentMovementId) };
  }, [op.currentMovementId]);

  const effectiveId = (modified?.newMovementId as string | undefined) ?? op.newMovementId;
  const effectiveName = (modified?.newMovementName as string | undefined) ?? op.newMovementName;

  const visibleCandidates = showAll ? candidates?.all : candidates?.samePattern;
  // If the AI's proposed movement isn't in the same-pattern shortlist,
  // auto-expand so the user sees the AI's pick highlighted in the full list.
  const hasInShortlist = visibleCandidates?.some((m) => m.id === effectiveId);

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span>{op.currentMovementName}</span>
        <span aria-hidden className="text-muted">→</span>
        <select
          value={effectiveId}
          onChange={(e) => {
            const id = e.target.value;
            const m = candidates?.all.find((x) => x.id === id);
            if (m) onModify({ newMovementId: m.id, newMovementName: m.name });
          }}
          className="rounded border border-border bg-bg/40 px-2 py-1 text-sm font-semibold text-emerald-100 focus:border-accent focus:outline-none"
          aria-label="Replacement movement"
        >
          {/* Always include the AI's proposed option, even if it's
              outside the visible shortlist, so the user sees what was
              recommended. */}
          {!hasInShortlist && (
            <option value={effectiveId}>{effectiveName} (AI pick)</option>
          )}
          {visibleCandidates?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {!showAll && candidates && candidates.samePattern.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-[11px] text-muted underline hover:text-fg"
          >
            Show all library
          </button>
        )}
        {showAll && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="text-[11px] text-muted underline hover:text-fg"
          >
            Same pattern only
          </button>
        )}
      </div>
      {entry && (
        <div className="text-xs text-muted">
          Day{' '}
          <code>{op.dayId.slice(0, 8)}…</code>
          {' · '}sets × reps preserved ({entry.sets}×
          {entry.repsMax != null ? `${entry.reps}-${entry.repsMax}` : entry.reps})
        </div>
      )}
      {!entry && (
        <div className="text-xs text-rose-200">
          ⚠ Entry not found in the current plan — apply will fail unless the AI&apos;s ids
          are stale.
        </div>
      )}
    </div>
  );
}

function AddAssistanceEntryDiff({
  op,
  modified,
  onModify,
}: {
  op: EditOperation & { kind: 'add_assistance_entry' };
  modified?: Record<string, unknown>;
  onModify: (patch: Record<string, unknown>) => void;
}) {
  const eff = {
    sets: (modified?.sets as number | undefined) ?? op.sets,
    reps: (modified?.reps as number | undefined) ?? op.reps,
    repsMax: (modified?.repsMax as number | undefined) ?? op.repsMax,
  };
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs text-muted">+</span>
        <span className="font-semibold">{op.movementName}</span>
        <span className="text-xs text-muted">({op.category})</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <NumberInput
          value={eff.sets}
          step={1}
          min={1}
          max={10}
          ariaLabel="Sets"
          onChange={(n) => onModify({ sets: n })}
          suffix="×"
        />
        <NumberInput
          value={eff.reps}
          step={1}
          min={1}
          max={50}
          ariaLabel="Reps"
          onChange={(n) => onModify({ reps: n })}
        />
        {eff.repsMax !== undefined && (
          <>
            <span className="text-muted">-</span>
            <NumberInput
              value={eff.repsMax}
              step={1}
              min={eff.reps}
              max={99}
              ariaLabel="Reps max"
              onChange={(n) => onModify({ repsMax: n })}
            />
          </>
        )}
        <span className="text-xs text-muted">{op.unit === 'sec' ? 'sec' : 'reps'}</span>
      </div>
    </div>
  );
}

function RemoveAssistanceEntryDiff({
  op,
}: {
  op: EditOperation & { kind: 'remove_assistance_entry' };
}) {
  const entry = useResolvedEntry(op.blockId, op.dayId, op.entryId);
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span aria-hidden className="text-rose-300">−</span>
        <span className="font-semibold line-through">{op.movementName}</span>
      </div>
      {entry && (
        <div className="text-xs text-muted">
          Was {entry.sets}×{entry.repsMax != null ? `${entry.reps}-${entry.repsMax}` : entry.reps}
          {entry.unit === 'sec' ? ' sec' : ''}
        </div>
      )}
    </div>
  );
}

function ScheduleDeloadDiff() {
  return (
    <p className="text-sm text-fg/85">
      Insert a 7th-week deload block right after the currently-active block.
    </p>
  );
}

function SkipDayInWeekDiff({
  op,
}: {
  op: EditOperation & { kind: 'skip_day_in_week' };
}) {
  const labelByWeek: Record<string, string> = {
    '1': 'Week 1',
    '2': 'Week 2',
    '3': 'Week 3',
    deload: 'Deload week',
    '7w': '7th-week',
  };
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{op.dayLabel ?? 'Day'}</span>
        <span aria-hidden className="text-muted">→</span>
        <span className="font-semibold text-rose-200">Skipped</span>
        <span className="text-xs text-muted">({op.skipReason.replace('-', ' ')})</span>
      </div>
      <div className="text-xs text-muted">
        Weeks affected:{' '}
        <span className="font-medium text-fg/85">
          {op.weeks.map((w) => labelByWeek[w] ?? w).join(' · ')}
        </span>
      </div>
      {op.skipNote && (
        <div className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-xs text-fg/80">
          {op.skipNote}
        </div>
      )}
      <p className="text-[11px] text-muted leading-relaxed">
        The day stays in your rotation; the strength session is just marked
        skipped for those weeks. Pair this with a cardio-plan slot if you&apos;re
        replacing it with a ride / swim / etc.
      </p>
    </div>
  );
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const MODALITY_EMOJI: Record<string, string> = {
  run: '🏃',
  bike: '🚴',
  swim: '🏊',
  row: '🚣',
  walk: '🚶',
  padel: '🎾',
  other: '🏃',
};

function AddCardioPlanSlotDiff({
  op,
}: {
  op: EditOperation & { kind: 'add_cardio_plan_slot' };
}) {
  const dayName = WEEKDAY_NAMES[op.dayOfWeek] ?? `Day ${op.dayOfWeek}`;
  const emoji = MODALITY_EMOJI[op.modality] ?? '🏃';
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold">
          {emoji} {dayName}: {op.modality} · {op.planKind}
        </span>
        {op.durationMin !== undefined && (
          <span className="rounded bg-bg/40 px-1.5 py-0.5 text-xs text-fg/80">
            {op.durationMin} min
          </span>
        )}
      </div>
      {op.notes && (
        <div className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-xs text-fg/80">
          {op.notes}
        </div>
      )}
      <p className="text-[11px] text-muted leading-relaxed">
        Will be added to your weekly cardio plan and shows up on /calendar every
        {' '}{dayName}. The slot is recurring — remove it from /program (Cardio tab)
        when the racing block is over.
      </p>
    </div>
  );
}

/**
 * Rich diff for add_movement_to_library: shows the proposed movement
 * details, lets the user edit the primary muscles (multi-select chips),
 * and surfaces fuzzy library matches with a one-click "Use existing X
 * instead" path that declines this op AND rewrites any chained
 * add_assistance_entry op's movementId.
 *
 * Dedup is informational at this layer; the apply path rejects exact
 * normalized-name duplicates server-side and soft-falls-back on a race.
 */
function AddMovementToLibraryDiff({
  op,
  modified,
  onModify,
  onUseExisting,
}: {
  op: EditOperation & { kind: 'add_movement_to_library' };
  modified?: Record<string, unknown>;
  onModify: (patch: Record<string, unknown>) => void;
  onUseExisting: (tempMovementId: string, real: Movement) => void;
}) {
  const library = useMovements();
  const effective = {
    primaryMuscles:
      (modified?.primaryMuscles as string[] | undefined) ?? op.primaryMuscles,
  };
  const dedupCandidates = useMemo(() => {
    if (!library) return [];
    return findFuzzyMatches(op, library, effective.primaryMuscles).slice(0, 3);
  }, [library, op, effective.primaryMuscles]);

  const toggleMuscle = (m: string) => {
    const cur = new Set(effective.primaryMuscles);
    if (cur.has(m)) {
      if (cur.size > 1) cur.delete(m); // never empty — server requires ≥ 1
    } else {
      cur.add(m);
    }
    onModify({ primaryMuscles: Array.from(cur) });
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold">{op.name}</span>
        <span className="text-xs text-muted">{op.category}</span>
        <span className="text-xs text-muted">·</span>
        <span className="text-xs text-muted">{op.pattern}</span>
        {op.equipment && (
          <>
            <span className="text-xs text-muted">·</span>
            <span className="text-xs text-muted">{op.equipment}</span>
          </>
        )}
      </div>
      <div className="space-y-1">
        <div className="text-[11px] uppercase tracking-wide text-muted">
          Primary muscles{' '}
          <span className="normal-case text-muted/70">(click to toggle)</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {ALL_MUSCLES.map((m) => {
            const on = effective.primaryMuscles.includes(m);
            return (
              <button
                key={m}
                type="button"
                onClick={() => toggleMuscle(m)}
                aria-pressed={on}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 transition ${
                  on
                    ? 'bg-emerald-500/20 text-emerald-100 ring-emerald-500/50'
                    : 'bg-bg/30 text-muted ring-border hover:bg-bg/50 hover:text-fg/80'
                }`}
              >
                {m}
              </button>
            );
          })}
        </div>
      </div>
      {op.secondaryMuscles && op.secondaryMuscles.length > 0 && (
        <div className="text-[11px] text-muted">
          Secondary: <span className="text-fg/70">{op.secondaryMuscles.join(', ')}</span>
        </div>
      )}
      {op.cues && (
        <div className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-xs text-fg/80">
          {op.cues}
        </div>
      )}
      {op.dedupHint && (
        <div className="text-[11px] italic text-muted">
          AI dedup check: {op.dedupHint}
        </div>
      )}
      {dedupCandidates.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-xs">
          <div className="mb-1 font-semibold text-amber-200">
            Looks similar to {dedupCandidates.length === 1 ? 'an' : 'a few'} existing
            {dedupCandidates.length === 1 ? '' : ' library entries'}:
          </div>
          <ul className="space-y-1">
            {dedupCandidates.map((c) => (
              <li
                key={c.movement.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
              >
                <span className="text-fg/90">
                  <span className="font-medium">{c.movement.name}</span>{' '}
                  <span className="text-[10px] text-muted">
                    ({c.movement.pattern}; {c.movement.primaryMuscles.join('+') || '—'})
                  </span>
                  <span className="ml-2 text-[10px] text-amber-200/80">{c.reason}</span>
                </span>
                <button
                  type="button"
                  onClick={() => onUseExisting(op.tempMovementId, c.movement)}
                  className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-100 hover:bg-amber-500/25"
                  title="Decline this op and reroute any chained 'Add entry' op to this existing movement"
                >
                  Use this instead
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[11px] text-muted leading-relaxed">
        Will be saved to your library as a custom movement. Accepting any chained
        &quot;Add entry&quot; ops in this proposal will reference it automatically.
      </p>
    </div>
  );
}

const ALL_MUSCLES: string[] = [
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'adductors',
  'chest',
  'back',
  'lats',
  'traps',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'core',
  'obliques',
  'erectors',
];

interface DedupCandidate {
  movement: Movement;
  /** Why this surfaced — surfaced to the user. */
  reason: string;
  score: number;
}

/** Normalize for comparison: lowercase, strip articles + punctuation, collapse whitespace. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance — small impl, sufficient for ≤ 80-char movement names. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1).fill(0).map((_, i) => i);
  const cur: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/**
 * Find library movements that look like potential duplicates of the
 * proposed new entry. Two signal sources:
 *   - Levenshtein distance ≤ 2 on normalized names (catches "step-up"
 *     vs "step up", "RDL" vs "Rdl", typos).
 *   - Same `pattern` AND ≥ 60% primary-muscle overlap (Jaccard).
 *
 * Results sorted strongest match first.
 */
function findFuzzyMatches(
  op: EditOperation & { kind: 'add_movement_to_library' },
  library: Movement[],
  effectivePrimaryMuscles: string[],
): DedupCandidate[] {
  const normalizedTarget = normalizeName(op.name);
  if (!normalizedTarget) return [];
  const targetMuscles = new Set(effectivePrimaryMuscles);
  const out: DedupCandidate[] = [];
  for (const m of library) {
    const normalizedExisting = normalizeName(m.name);
    if (!normalizedExisting) continue;
    if (normalizedExisting === normalizedTarget) {
      out.push({ movement: m, reason: 'exact name match', score: 0 });
      continue;
    }
    const dist = levenshtein(normalizedTarget, normalizedExisting);
    if (dist <= 2) {
      out.push({ movement: m, reason: `near name (edit distance ${dist})`, score: dist });
      continue;
    }
    if (m.pattern === op.pattern && m.primaryMuscles.length > 0 && targetMuscles.size > 0) {
      const overlap = m.primaryMuscles.filter((mu) => targetMuscles.has(mu)).length;
      const union = new Set([...m.primaryMuscles, ...targetMuscles]).size;
      const jaccard = overlap / union;
      if (jaccard >= 0.6) {
        out.push({
          movement: m,
          reason: `same ${op.pattern} pattern, ${Math.round(jaccard * 100)}% muscle overlap`,
          score: 10 - jaccard * 5, // worse than near-name matches
        });
      }
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

// ===== Reusable hooks =====

function useResolvedBlock(blockId?: string): ProgramBlock | undefined {
  return useLiveQuery(async () => {
    const all = await getDb().blocks.toArray();
    if (blockId) return all.find((b) => b.id === blockId);
    return all.find((b) => !b.completedAt);
  }, [blockId]);
}

function useResolvedEntry(blockId: string | undefined, dayId: string, entryId: string) {
  const block = useResolvedBlock(blockId);
  return useMemo(() => {
    if (!block?.plan) return undefined;
    // After v21, the base `day.assistance` is empty on migrated blocks.
    // Look up the entry by iterating the per-week canonical store
    // (assistanceOverrides). Entry IDs are shared across weeks for the
    // same movement-per-day, so ANY week's lookup finds it — we just
    // need the first hit to render "before" sets/reps. Falls back to
    // the legacy base for pre-v21 / unmigrated blocks.
    const weeks: WendlerWeek[] =
      block.kind === 'seventh-week' ? ['7w'] : [1, 2, 3, 'deload'];
    for (const wk of weeks) {
      const entries = resolveDayAssistance(block.plan, wk, dayId);
      const hit = entries.find((e) => e.id === entryId);
      if (hit) return hit;
    }
    return undefined;
  }, [block, dayId, entryId]);
}

function NumberInput({
  value,
  onChange,
  step,
  min,
  max,
  suffix,
  ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  ariaLabel: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <input
        type="number"
        value={value}
        step={step ?? 1}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        aria-label={ariaLabel}
        className="w-16 rounded border border-border bg-bg/40 px-1.5 py-0.5 text-right text-sm tabular-nums focus:border-accent focus:outline-none"
      />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </span>
  );
}
