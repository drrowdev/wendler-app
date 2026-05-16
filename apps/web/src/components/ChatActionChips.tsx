'use client';

// Action chips rendered under an assistant chat message. Each chip
// represents a concrete recommendation the chat AI surfaced; tapping
// Apply runs the matching handler from `lib/chat-actions.ts`. Pending
// chips render as active buttons; applied/dismissed chips collapse to a
// compact status line.

import { useState } from 'react';
import type { ChatAction, ChatActionApplyDetails } from '@wendler/db-schema';
import {
  applySetTrainingMax,
  applySetBlockVolumePreset,
  applyScheduleDeload,
  applySubstituteMovement,
  dismissAction,
} from '@/lib/chat-actions';
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [injurySheetOpen, setInjurySheetOpen] = useState(false);
  const [proposalSheetOpen, setProposalSheetOpen] = useState(false);

  if (action.status === 'applied') {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
        <div className="flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span className="font-semibold">Applied:</span>
          <span className="truncate">{action.label}</span>
        </div>
        {action.appliedDetails && (
          <div className="ml-5 mt-0.5 text-emerald-200/70">
            {formatAppliedDetails(action.appliedDetails)}
          </div>
        )}
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
      return <SetTrainingMaxPreview action={action} />;
    }
    if (action.kind === 'set_block_volume_preset') {
      return <SetBlockVolumePresetPreview action={action} />;
    }
    if (action.kind === 'schedule_deload') {
      return <ScheduleDeloadPreview action={action} />;
    }
    if (action.kind === 'substitute_movement') {
      return <SubstituteMovementPreview action={action} />;
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
                else if (action.kind === 'propose_edit') void onApply();
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
    case 'set_training_max': {
      const prev = details.previousKg !== undefined ? ` (was ${details.previousKg.toFixed(1)} kg)` : '';
      return `${details.lift}: ${details.newKg.toFixed(1)} kg${prev}`;
    }
    case 'set_block_volume_preset': {
      const prev = details.previousPreset ? ` (was ${details.previousPreset})` : '';
      return `Volume preset → ${details.newPreset}${prev}`;
    }
    case 'schedule_deload':
      return `Deload block ${details.newBlockId.slice(0, 8)}…${details.programId ? ` (program ${details.programId.slice(0, 8)}…)` : ''} · seq ${details.sequenceIndex}`;
    case 'substitute_movement':
      return `${details.previousMovementName} → ${details.newMovementName}`;
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

// SetTrainingMaxPreview — shows the current TM, the proposed TM, the
// delta + percent change, and the working-set kg implication so the user
// understands what the change means at the bar before tapping Apply.
import { useLiveQuery } from 'dexie-react-hooks';
import { getDb } from '@/lib/db';

function SetTrainingMaxPreview({
  action,
}: {
  action: ChatAction & { kind: 'set_training_max' };
}) {
  const current = useLiveQuery(
    async () => {
      const all = await getDb().trainingMaxes.toArray();
      const matching = all.filter((t) => t.lift === action.lift);
      if (matching.length === 0) return null;
      matching.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return matching[0]!;
    },
    [action.lift],
  );

  const currentKg = current?.trainingMaxKg;
  const tmPercent = current?.tmPercent ?? 0.85;
  const delta = currentKg != null ? action.newTrainingMaxKg - currentKg : undefined;
  const deltaPct = currentKg != null && currentKg > 0 ? (delta! / currentKg) * 100 : undefined;
  const direction = delta != null && delta < 0 ? 'cut' : delta != null && delta > 0 ? 'bump' : null;

  const newTopSet = action.newTrainingMaxKg * tmPercent;
  const currentTopSet = currentKg != null ? currentKg * tmPercent : undefined;

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-border bg-bg/40 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          {action.lift} training max
        </div>
        <div className="mt-1 flex items-baseline gap-3">
          <div>
            <div className="text-[11px] text-muted">Current</div>
            <div className="text-lg font-semibold tabular-nums">
              {currentKg != null ? `${currentKg.toFixed(1)} kg` : '— no record yet'}
            </div>
          </div>
          <div aria-hidden className="text-muted">→</div>
          <div>
            <div className="text-[11px] text-muted">Proposed</div>
            <div className="text-lg font-semibold tabular-nums text-accent">
              {action.newTrainingMaxKg.toFixed(1)} kg
            </div>
          </div>
          {direction && deltaPct != null && (
            <div className={`ml-auto rounded px-2 py-1 text-xs font-semibold ${
              direction === 'cut'
                ? 'bg-rose-500/15 text-rose-200 ring-1 ring-rose-500/40'
                : 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-500/40'
            }`}>
              {direction === 'cut' ? '−' : '+'}
              {Math.abs(deltaPct).toFixed(1)}%
            </div>
          )}
        </div>
        {currentTopSet != null && (
          <div className="mt-2 text-[11px] text-muted">
            Top-set @ {Math.round(tmPercent * 100)}% TM:{' '}
            <span className="tabular-nums text-fg/80">{currentTopSet.toFixed(1)} kg</span>{' '}
            → <span className="tabular-nums font-semibold text-accent">{newTopSet.toFixed(1)} kg</span>
          </div>
        )}
      </div>
      <p className="text-xs italic text-muted">{action.reason}</p>
      <p className="text-[11px] text-muted">
        Previous TMs stay in your history. The new value applies from your next session.
      </p>
    </div>
  );
}

// SetBlockVolumePresetPreview — shows current block name + assistance
// volume preset, with the rep budget for each preset so the user sees
// what the change means in concrete reps/day.
const PRESET_LABELS: Record<string, { mainDay: number; accessoryDay: number }> = {
  minimal: { mainDay: 200, accessoryDay: 120 },
  standard: { mainDay: 300, accessoryDay: 200 },
  high: { mainDay: 400, accessoryDay: 280 },
};

function SetBlockVolumePresetPreview({
  action,
}: {
  action: ChatAction & { kind: 'set_block_volume_preset' };
}) {
  const block = useLiveQuery(async () => {
    const all = await getDb().blocks.toArray();
    if (action.blockId) return all.find((b) => b.id === action.blockId) ?? null;
    return all.find((b) => !b.completedAt) ?? null;
  }, [action.blockId]);

  const currentPreset =
    typeof block?.assistanceVolume === 'string' ? block.assistanceVolume : 'standard';
  const cur = PRESET_LABELS[currentPreset] ?? PRESET_LABELS.standard!;
  const nxt = PRESET_LABELS[action.preset] ?? PRESET_LABELS.standard!;
  const mainDelta = nxt.mainDay - cur.mainDay;
  const mainDeltaPct = cur.mainDay > 0 ? (mainDelta / cur.mainDay) * 100 : 0;

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-border bg-bg/40 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          {block ? `Block "${block.name}"` : 'Active block'}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded bg-bg/60 p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">Current</div>
            <div className="font-semibold capitalize">{currentPreset}</div>
            <div className="mt-1 text-[11px] text-muted">
              Main day: <span className="tabular-nums text-fg/80">{cur.mainDay} reps</span>
              <br />
              Accessory: <span className="tabular-nums text-fg/80">{cur.accessoryDay} reps</span>
            </div>
          </div>
          <div className="rounded bg-accent/10 p-2 ring-1 ring-accent/40">
            <div className="text-[10px] uppercase tracking-wide text-accent">Proposed</div>
            <div className="font-semibold capitalize">{action.preset}</div>
            <div className="mt-1 text-[11px] text-muted">
              Main day: <span className="tabular-nums text-fg/80">{nxt.mainDay} reps</span>
              <br />
              Accessory: <span className="tabular-nums text-fg/80">{nxt.accessoryDay} reps</span>
            </div>
          </div>
        </div>
        {mainDelta !== 0 && (
          <div className={`mt-2 text-[11px] ${mainDelta < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
            Main-day budget: {mainDelta > 0 ? '+' : ''}
            {mainDelta} reps ({mainDelta > 0 ? '+' : ''}
            {mainDeltaPct.toFixed(0)}%) — applies to next assistance generation.
          </div>
        )}
      </div>
      <p className="text-xs italic text-muted">{action.reason}</p>
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-100">
        <div className="font-semibold text-amber-50">⚠ This does NOT trim your existing entries</div>
        <p className="mt-1 leading-relaxed">
          Only the preset is changed. Already-scheduled assistance for this block stays at its
          current sets × reps. To apply the lower budget to remaining weeks, open the block,
          delete the affected week&apos;s assistance, and run <span className="font-semibold">Suggest assistance</span> again.
        </p>
      </div>
    </div>
  );
}

// ScheduleDeloadPreview — shows where the new deload block lands in
// the program sequence + confirms that the active block isn't touched.
function ScheduleDeloadPreview({
  action,
}: {
  action: ChatAction & { kind: 'schedule_deload' };
}) {
  void action;
  const blockInfo = useLiveQuery(async () => {
    const all = await getDb().blocks.toArray();
    const active = all.find((b) => !b.completedAt);
    if (!active) return null;
    const peers = active.programId
      ? all.filter((b) => b.programId === active.programId)
      : [active];
    peers.sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
    const maxSeq = peers.reduce((acc, b) => Math.max(acc, b.sequenceIndex ?? 0), 0);
    return { active, peers, nextSeq: maxSeq + 1 };
  });

  if (!blockInfo) {
    return <p className="text-sm text-muted">Loading active block…</p>;
  }
  if (!blockInfo.active) {
    return (
      <p className="text-sm text-amber-200">
        No active block found. The deload action will fail at apply time.
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <p>Schedule a 7th-week deload block right after your active block:</p>
      <ol className="space-y-1 rounded-lg border border-border bg-bg/40 p-3 text-xs">
        {blockInfo.peers.map((b) => (
          <li
            key={b.id}
            className={`flex items-baseline gap-2 ${
              b.id === blockInfo.active!.id ? 'font-semibold text-fg' : 'text-muted'
            }`}
          >
            <span className="w-6 tabular-nums">#{b.sequenceIndex ?? 0}</span>
            <span>{b.name}</span>
            <span className="text-[10px] text-muted">({b.kind})</span>
            {b.id === blockInfo.active!.id && (
              <span className="ml-auto rounded bg-accent/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                Active
              </span>
            )}
          </li>
        ))}
        <li className="flex items-baseline gap-2 rounded bg-sky-500/10 px-1 py-0.5 font-semibold text-sky-200 ring-1 ring-sky-500/40">
          <span className="w-6 tabular-nums">#{blockInfo.nextSeq}</span>
          <span>Deload week</span>
          <span className="text-[10px]">(seventh-week / deload)</span>
          <span className="ml-auto rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
            New
          </span>
        </li>
      </ol>
      <p className="text-xs italic text-muted">{action.reason}</p>
      <p className="text-[11px] text-muted">
        Your active block isn&apos;t modified — finish the current week as planned. The deload
        becomes active automatically when you mark the active block done.
      </p>
    </div>
  );
}

// SubstituteMovementPreview — shows which day(s) in which block will be
// touched, sets/reps preserved, with explicit confirmation that other
// days/blocks aren't affected.
function SubstituteMovementPreview({
  action,
}: {
  action: ChatAction & { kind: 'substitute_movement' };
}) {
  const previewData = useLiveQuery(async () => {
    const db = getDb();
    const blocks = await db.blocks.toArray();
    let block = action.blockId ? blocks.find((b) => b.id === action.blockId) : undefined;
    if (!block) block = blocks.find((b) => !b.completedAt);
    if (!block?.plan) return null;
    const hits: { dayId: string; dayLabel: string; entry: { id: string; movementName: string; sets: number; reps: number; repsMax?: number; unit?: string } }[] = [];
    block.plan.days.forEach((d, di) => {
      const dayLabel = d.label?.trim() || `Day ${di + 1}`;
      d.assistance.forEach((e) => {
        const matchById = e.movementId === action.currentMovementId;
        const matchByName =
          !matchById &&
          (e.movementName ?? '').toLowerCase().trim() ===
            action.currentMovementName.toLowerCase().trim();
        if (matchById || matchByName) {
          hits.push({
            dayId: d.id,
            dayLabel,
            entry: {
              id: e.id,
              movementName: e.movementName,
              sets: e.sets,
              reps: e.reps,
              repsMax: e.repsMax,
              unit: e.unit,
            },
          });
        }
      });
    });
    return { block, hits };
  }, [action.blockId, action.currentMovementId, action.currentMovementName]);

  if (!previewData) {
    return <p className="text-sm text-muted">Loading block plan…</p>;
  }
  if (previewData.hits.length === 0) {
    return (
      <div className="space-y-3 text-sm">
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">
          <div className="font-semibold">Nothing scheduled to swap</div>
          <p className="mt-1 text-xs text-amber-100/90">
            &quot;{action.currentMovementName}&quot; (id <code>{action.currentMovementId}</code>) isn&apos;t scheduled in block
            &quot;{previewData.block.name}&quot;. Tapping Apply will report an error and make no changes.
          </p>
        </div>
      </div>
    );
  }
  // Filter targeted day from the day list when dayId is supplied.
  const wantDayId = action.dayId;
  const wantDayIdx = action.dayIndex;
  const targetHit = (() => {
    if (wantDayId) return previewData.hits.find((h) => h.dayId === wantDayId);
    if (typeof wantDayIdx === 'number') {
      const planDays = previewData.block.plan!.days;
      const dayId = planDays[wantDayIdx]?.id;
      return dayId ? previewData.hits.find((h) => h.dayId === dayId) : undefined;
    }
    return previewData.hits[0];
  })();
  const collateralHits = previewData.hits.filter((h) => h !== targetHit);

  return (
    <div className="space-y-3 text-sm">
      {targetHit ? (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">
            Will change
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <span className="rounded bg-bg/60 px-2 py-0.5 text-[11px] font-semibold ring-1 ring-border">
              {targetHit.dayLabel}
            </span>
            <span className="font-semibold">{targetHit.entry.movementName}</span>
            <span className="text-xs text-muted tabular-nums">
              {targetHit.entry.sets}×{targetHit.entry.repsMax != null
                ? `${targetHit.entry.reps}-${targetHit.entry.repsMax}`
                : targetHit.entry.reps}
              {targetHit.entry.unit === 'sec' ? ' sec' : ''}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <span aria-hidden className="text-muted">→</span>
            <span className="font-semibold text-emerald-200">{action.newMovementName}</span>
            <span className="text-xs text-muted tabular-nums">
              {targetHit.entry.sets}×{targetHit.entry.repsMax != null
                ? `${targetHit.entry.reps}-${targetHit.entry.repsMax}`
                : targetHit.entry.reps}
              {targetHit.entry.unit === 'sec' ? ' sec' : ''}{' '}
              <span className="text-emerald-300/70">(sets × reps preserved)</span>
            </span>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
          Specified day not found. The handler will reject this apply.
        </div>
      )}
      {collateralHits.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <div className="font-semibold text-amber-200">
            ⚠ &quot;{action.currentMovementName}&quot; also appears on {collateralHits.length} other day
            {collateralHits.length === 1 ? '' : 's'} in this block
          </div>
          <ul className="mt-1 space-y-0.5 text-amber-100/90">
            {collateralHits.map((h, i) => (
              <li key={i}>
                {h.dayLabel}: {h.entry.movementName} {h.entry.sets}×{h.entry.repsMax != null ? `${h.entry.reps}-${h.entry.repsMax}` : h.entry.reps}
                {h.entry.unit === 'sec' ? ' sec' : ''}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-amber-200/80">
            Those days are NOT changed by this action. If you want the swap applied
            everywhere, dismiss this chip and ask the chat to re-run the substitution
            without a specific day target.
          </p>
        </div>
      )}
      <p className="text-xs italic text-muted">{action.reason}</p>
    </div>
  );
}
