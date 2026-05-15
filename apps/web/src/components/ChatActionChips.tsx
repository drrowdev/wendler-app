'use client';

// Action chips rendered under an assistant chat message. Each chip
// represents a concrete recommendation the chat AI surfaced; tapping
// Apply runs the matching handler from `lib/chat-actions.ts`. Pending
// chips render as active buttons; applied/dismissed chips collapse to a
// compact status line.

import { useState } from 'react';
import type { ChatAction } from '@wendler/db-schema';
import {
  applySetTrainingMax,
  applySetBlockVolumePreset,
  applyScheduleDeload,
  applySubstituteMovement,
  dismissAction,
} from '@/lib/chat-actions';
import { InjurySheet } from '@/components/injury/InjurySheet';

interface Props {
  chatId: string;
  messageId: string;
  actions: ChatAction[];
}

export function ChatActionChips({ chatId, messageId, actions }: Props) {
  return (
    <ul className="mt-2 space-y-1.5">
      {actions.map((a) => (
        <li key={a.id}>
          <ChatActionChip chatId={chatId} messageId={messageId} action={a} />
        </li>
      ))}
    </ul>
  );
}

function ChatActionChip({
  chatId,
  messageId,
  action,
}: {
  chatId: string;
  messageId: string;
  action: ChatAction;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [injurySheetOpen, setInjurySheetOpen] = useState(false);

  if (action.status === 'applied') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
        <span aria-hidden>✓</span>
        <span className="font-semibold">Applied:</span>
        <span className="truncate">{action.label}</span>
      </div>
    );
  }
  if (action.status === 'dismissed') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-bg/40 px-2 py-1 text-[11px] text-muted/70">
        <span aria-hidden>—</span>
        <span>Dismissed:</span>
        <span className="truncate">{action.label}</span>
      </div>
    );
  }

  const onApply = async () => {
    setError(undefined);
    if (action.kind === 'log_injury') {
      setInjurySheetOpen(true);
      return;
    }
    setBusy(true);
    let result: { ok: true } | { ok: false; error: string };
    if (action.kind === 'set_training_max') {
      result = await applySetTrainingMax(chatId, messageId, action);
    } else if (action.kind === 'set_block_volume_preset') {
      const r = await applySetBlockVolumePreset(chatId, messageId, action);
      result = r.ok ? { ok: true } : { ok: false, error: r.error };
    } else if (action.kind === 'schedule_deload') {
      const r = await applyScheduleDeload(chatId, messageId, action);
      result = r.ok ? { ok: true } : { ok: false, error: r.error };
    } else if (action.kind === 'substitute_movement') {
      result = await applySubstituteMovement(chatId, messageId, action);
    } else {
      result = { ok: false, error: 'Unknown action kind.' };
    }
    setBusy(false);
    setConfirmOpen(false);
    if (!result.ok) setError(result.error);
  };

  const onDismiss = async () => {
    setBusy(true);
    await dismissAction(chatId, messageId, action.id);
    setBusy(false);
  };

  // Build a per-kind confirm dialog body. log_injury skips the dialog
  // entirely — its own InjurySheet IS the confirm step.
  const confirmBody = (() => {
    if (action.kind === 'set_training_max') {
      return (
        <>
          <p className="text-sm">
            Set the <span className="font-semibold capitalize">{action.lift}</span> training
            max to{' '}
            <span className="font-semibold tabular-nums">
              {action.newTrainingMaxKg.toFixed(1)} kg
            </span>
            ?
          </p>
          <p className="mt-2 text-xs italic text-muted">{action.reason}</p>
          <p className="mt-2 text-[11px] text-muted">
            Previous TMs stay in the history; the new value takes effect from now.
          </p>
        </>
      );
    }
    if (action.kind === 'set_block_volume_preset') {
      return (
        <>
          <p className="text-sm">
            Switch the current block to{' '}
            <span className="font-semibold capitalize">{action.preset}</span> assistance
            volume?
          </p>
          <p className="mt-2 text-xs italic text-muted">{action.reason}</p>
        </>
      );
    }
    if (action.kind === 'schedule_deload') {
      return (
        <>
          <p className="text-sm">
            Schedule a 7th-week deload block right after the currently-active block?
          </p>
          <p className="mt-2 text-xs italic text-muted">{action.reason}</p>
          <p className="mt-2 text-[11px] text-muted">
            The new block lands in /program. The active block isn&apos;t modified — finish your
            current week as planned and the deload becomes active when you mark the block done.
          </p>
        </>
      );
    }
    if (action.kind === 'substitute_movement') {
      return (
        <>
          <p className="text-sm">
            Replace{' '}
            <span className="font-semibold">{action.currentMovementName}</span> with{' '}
            <span className="font-semibold">{action.newMovementName}</span>
            {typeof action.dayIndex === 'number' ? ` on Day ${action.dayIndex + 1}` : ''}{' '}
            in the active block?
          </p>
          <p className="mt-2 text-xs italic text-muted">{action.reason}</p>
          <p className="mt-2 text-[11px] text-muted">
            Existing sets × reps + category are preserved. The swap applies to the per-day
            default — per-week overrides are untouched.
          </p>
        </>
      );
    }
    return null;
  })();

  return (
    <>
      <div className="rounded-md border border-accent/40 bg-accent/5 px-2 py-1.5 text-xs">
        <div className="flex items-start gap-2">
          <span aria-hidden className="mt-0.5 text-accent">
            ⚡
          </span>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => {
                if (action.kind === 'log_injury') void onApply();
                else setConfirmOpen(true);
              }}
              disabled={busy}
              className="text-left font-semibold text-accent hover:underline disabled:opacity-60"
            >
              {action.label}
            </button>
            {action.rationale && (
              <p className="mt-0.5 text-[11px] text-muted">{action.rationale}</p>
            )}
            {error && (
              <p className="mt-1 text-[11px] text-red-300">{error}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void onDismiss()}
            disabled={busy}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-fg disabled:opacity-50"
            title="Dismiss"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>

      {confirmOpen && confirmBody && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center"
          onClick={() => !busy && setConfirmOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-border bg-card p-4"
          >
            <h3 className="text-base font-semibold">Confirm change</h3>
            <div className="mt-3">{confirmBody}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onApply()}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50"
              >
                {busy ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {injurySheetOpen && action.kind === 'log_injury' && (
        <InjurySheet
          origin={{
            area: action.area,
            severity: action.severity,
            description: action.description,
            movementId: action.movementIds?.[0],
          }}
          onCancel={() => setInjurySheetOpen(false)}
          onSaved={async () => {
            setInjurySheetOpen(false);
            const { updateActionStatus } = await import('@/lib/chat-actions');
            await updateActionStatus(chatId, messageId, action.id, {
              status: 'applied',
              appliedAt: new Date().toISOString(),
            });
          }}
        />
      )}
    </>
  );
}
