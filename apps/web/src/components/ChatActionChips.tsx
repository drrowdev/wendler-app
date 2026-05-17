'use client';

// Action chips rendered under an assistant chat message. Each chip
// represents a concrete recommendation the chat AI surfaced; tapping
// Apply runs the matching handler from `lib/chat-actions.ts`. Pending
// chips render as active buttons; applied/dismissed chips collapse to a
// compact status line.

import { useState } from 'react';
import type { ChatAction, ChatActionApplyDetails } from '@wendler/db-schema';
import { dismissAction } from '@/lib/chat-actions';
import { InjurySheet } from '@/components/injury/InjurySheet';
import { EditProposalSheet } from '@/components/chat/EditProposalSheet';

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
  const [injurySheetOpen, setInjurySheetOpen] = useState(false);
  const [proposalSheetOpen, setProposalSheetOpen] = useState(false);

  if (action.status === 'applied') {
    // Make propose_edit chips clickable so the user can re-open the
    // accept-sheet in audit (read-only) mode and inspect exactly what
    // was applied. Other action kinds (log_injury) don't have a
    // re-openable sheet yet — they still render as plain text.
    const reopenable = action.kind === 'propose_edit';
    const chipBody = (
      <>
        <div className="flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span className="font-semibold">Applied:</span>
          <span className="truncate">{action.label}</span>
          {reopenable && (
            <span className="ml-auto text-[10px] text-emerald-200/70 underline-offset-2 group-hover:underline">
              View
            </span>
          )}
        </div>
        {action.appliedDetails && (
          <div className="ml-5 mt-0.5 text-emerald-200/70">
            {formatAppliedDetails(action.appliedDetails)}
          </div>
        )}
      </>
    );
    if (reopenable) {
      return (
        <>
          <button
            type="button"
            onClick={() => setProposalSheetOpen(true)}
            className="group block w-full rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-left text-[11px] text-emerald-200 transition hover:bg-emerald-500/20"
            title="Click to view what was applied"
          >
            {chipBody}
          </button>
          {proposalSheetOpen && (
            <EditProposalSheet
              chatId={chatId}
              messageId={messageId}
              action={action}
              onClose={() => setProposalSheetOpen(false)}
              readOnly
            />
          )}
        </>
      );
    }
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
        {chipBody}
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
    if (action.kind === 'propose_edit') {
      setProposalSheetOpen(true);
      return;
    }
  };

  const onDismiss = async () => {
    setBusy(true);
    await dismissAction(chatId, messageId, action.id);
    setBusy(false);
  };

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
              onClick={() => void onApply()}
              disabled={busy}
              className="text-left font-semibold text-accent hover:underline disabled:opacity-60"
            >
              {action.label}
            </button>
            {action.rationale && (
              <p className="mt-0.5 text-[11px] text-muted">{action.rationale}</p>
            )}
            {(error || action.applyError) && (
              <p className="mt-1 text-[11px] text-red-300">
                {error ?? action.applyError}
              </p>
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

      {injurySheetOpen && action.kind === 'log_injury' && (
        <InjurySheet
          origin={{
            area: action.area,
            severity: action.severity,
            description: action.description,
            movementId: action.movementIds?.[0],
          }}
          onCancel={() => setInjurySheetOpen(false)}
          onSaved={async (injuryId) => {
            setInjurySheetOpen(false);
            const { applyLogInjuryAudit } = await import('@/lib/chat-actions');
            await applyLogInjuryAudit(chatId, messageId, action, injuryId);
          }}
        />
      )}

      {proposalSheetOpen && action.kind === 'propose_edit' && (
        <EditProposalSheet
          chatId={chatId}
          messageId={messageId}
          action={action}
          onClose={() => setProposalSheetOpen(false)}
        />
      )}
    </>
  );
}


function formatAppliedDetails(details: ChatActionApplyDetails): string {
  switch (details.kind) {
    case 'log_injury':
      return `Injury record ${details.injuryId.slice(0, 8)}…`;
    case 'propose_edit': {
      const applied = Object.keys(details.operationResults).length;
      const declined = details.declinedOperationIds.length;
      const total = applied + declined;
      return `${applied}/${total} ops applied${declined > 0 ? ` (${declined} declined)` : ''}`;
    }
    default:
      return '';
  }
}
