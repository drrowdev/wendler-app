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
import type {
  EditOperation,
  EditOperationDecision,
  ProposeEditChatAction,
  ProgramBlock,
} from '@wendler/db-schema';
import { getDb } from '@/lib/db';
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
  remove_assistance_entry: 'Remove entry',
  schedule_deload: 'Schedule deload',
};

const OP_TONE: Record<EditOperation['kind'], string> = {
  set_training_max: 'bg-violet-500/15 text-violet-100 ring-violet-500/40',
  set_block_volume_preset: 'bg-amber-500/15 text-amber-100 ring-amber-500/40',
  trim_assistance_entry: 'bg-amber-500/15 text-amber-100 ring-amber-500/40',
  swap_assistance_movement: 'bg-sky-500/15 text-sky-100 ring-sky-500/40',
  add_assistance_entry: 'bg-emerald-500/15 text-emerald-100 ring-emerald-500/40',
  remove_assistance_entry: 'bg-rose-500/15 text-rose-100 ring-rose-500/40',
  schedule_deload: 'bg-sky-500/15 text-sky-100 ring-sky-500/40',
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
}

function OpRow({ index, op, decision, result, onAccept, onDecline, onModify }: OpRowProps) {
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
        <OpDiff op={op} modified={decision.modifiedInput} onModify={onModify} />
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
}

function OpDiff({ op, modified, onModify }: DiffProps) {
  switch (op.kind) {
    case 'set_training_max':
      return <SetTrainingMaxDiff op={op} modified={modified} onModify={onModify} />;
    case 'set_block_volume_preset':
      return <SetBlockVolumePresetDiff op={op} modified={modified} onModify={onModify} />;
    case 'trim_assistance_entry':
      return <TrimAssistanceEntryDiff op={op} modified={modified} onModify={onModify} />;
    case 'swap_assistance_movement':
      return <SwapAssistanceMovementDiff op={op} modified={modified} />;
    case 'add_assistance_entry':
      return <AddAssistanceEntryDiff op={op} modified={modified} onModify={onModify} />;
    case 'remove_assistance_entry':
      return <RemoveAssistanceEntryDiff op={op} />;
    case 'schedule_deload':
      return <ScheduleDeloadDiff />;
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
}: {
  op: EditOperation & { kind: 'swap_assistance_movement' };
  modified?: Record<string, unknown>;
}) {
  const entry = useResolvedEntry(op.blockId, op.dayId, op.entryId);
  const effName = (modified?.newMovementName as string | undefined) ?? op.newMovementName;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span>{op.currentMovementName}</span>
        <span aria-hidden className="text-muted">→</span>
        <span className="font-semibold text-emerald-200">{effName}</span>
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
          ⚠ Entry not found in the current plan — apply will fail unless the AI's ids
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
    const day = block?.plan?.days.find((d) => d.id === dayId);
    return day?.assistance.find((e) => e.id === entryId);
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
