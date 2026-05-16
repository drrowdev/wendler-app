'use client';

// edit-proposal-apply.ts — atomic apply orchestrator for the
// `propose_edit` ChatAction. Lives next to chat-actions.ts but kept in
// a separate file because the EditOperation surface is wider than any
// individual chip handler and the orchestration logic is non-trivial.
//
// Contract:
//   - The orchestrator filters the proposal's operations down to the
//     accepted set (per the userDecisions map on the chip).
//   - Each accepted op is merged with the user's per-op modifications.
//   - The merged set runs in canonical apply order (preset > deload >
//     entry-remove > entry-add > entry-edit > swap > TM) inside ONE
//     Dexie transaction. On ANY op failure the transaction rolls back
//     and the orchestrator returns a per-op error map.
//   - On success the chip is marked `applied` with per-op
//     appliedDetails captured for audit, ONE notification is posted on
//     the ai-action channel summarising the whole plan, and the sync
//     pipeline is kicked.
//
// The legacy single-op apply handlers (applySetTrainingMax,
// applySetBlockVolumePreset, applyScheduleDeload,
// applySubstituteMovement) are NOT used here — those write the chip
// status themselves. The orchestrator stamps the parent chip ONCE at
// the end with the rolled-up per-op outcomes. The single-op handlers
// stay for the deprecated chip kinds.

import { nanoid } from 'nanoid';
import type {
  ChatAction,
  EditOperation,
  EditOperationAppliedDetail,
  EditOperationDecision,
  Notification,
  ProgramBlock,
  ProposeEditChatAction,
  TrainingMaxRecord,
  AssistanceEntry,
} from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';
import { updateActionStatus } from './chat-actions';

const APPLY_ORDER: Record<EditOperation['kind'], number> = {
  set_block_volume_preset: 0,
  schedule_deload: 1,
  skip_day_in_week: 2,
  remove_assistance_entry: 3,
  add_assistance_entry: 4,
  trim_assistance_entry: 5,
  swap_assistance_movement: 6,
  set_training_max: 7,
};

export interface ApplyProposalResult {
  ok: boolean;
  /** Per-op outcomes keyed by op.id. */
  perOp: Record<
    string,
    | { status: 'applied'; detail: EditOperationAppliedDetail }
    | { status: 'declined' }
    | { status: 'failed'; error: string }
  >;
  /** Top-level error (e.g. transaction failure, no ops accepted, etc.). */
  error?: string;
}

/**
 * Merge a user's per-op decision onto the AI's original op input.
 * Field-by-field override; the caller re-validates downstream.
 */
function applyDecisionToOp(
  op: EditOperation,
  decision: EditOperationDecision | undefined,
): EditOperation {
  if (!decision || !decision.modifiedInput) return op;
  return { ...op, ...decision.modifiedInput } as EditOperation;
}

/**
 * Orchestrate an edit proposal apply. Returns the per-op outcome map.
 * Writes the chip status + audit + notification on success.
 *
 * If `userDecisions` is omitted, all operations are treated as accepted
 * with no modifications (mostly for tests; the UI always supplies it).
 */
export async function applyEditProposal(
  chatId: string,
  messageId: string,
  action: ProposeEditChatAction,
  userDecisions?: Record<string, EditOperationDecision>,
): Promise<ApplyProposalResult> {
  const decisions = userDecisions ?? {};
  const perOp: ApplyProposalResult['perOp'] = {};

  // Filter to accepted + merge modifications.
  const accepted: EditOperation[] = [];
  for (const op of action.operations) {
    const d = decisions[op.id];
    if (d?.status === 'declined') {
      perOp[op.id] = { status: 'declined' };
      continue;
    }
    // Treat missing decision as accepted only when no userDecisions
    // were supplied at all (e.g. tests). The UI always supplies a
    // full decision map; a missing entry there is a UI bug.
    const treatAsAccepted = userDecisions ? d?.status === 'accepted' : true;
    if (!treatAsAccepted) {
      perOp[op.id] = { status: 'declined' };
      continue;
    }
    accepted.push(applyDecisionToOp(op, d));
  }

  if (accepted.length === 0) {
    const err = 'No operations were accepted — nothing to apply.';
    return { ok: false, perOp, error: err };
  }

  // Sort by canonical apply order so dependencies resolve correctly.
  accepted.sort((a, b) => APPLY_ORDER[a.kind] - APPLY_ORDER[b.kind]);

  const db = getDb();
  const now = new Date().toISOString();

  // Atomic transaction. If any op throws, the whole tx rolls back.
  try {
    await db.transaction(
      'rw',
      [db.blocks, db.trainingMaxes, db.settings, db.movements],
      async () => {
        for (const op of accepted) {
          // Re-resolve the target block fresh per op (a previous op in
          // the same tx may have mutated it; we read the latest from
          // the tx-scoped table view).
          const detail = await performOp(op);
          perOp[op.id] = { status: 'applied', detail };
        }
      },
    );
  } catch (e) {
    const msg = (e as Error).message;
    // Surface op-level errors when the op handler stamped one already;
    // otherwise the whole proposal failed for a non-op-specific reason.
    for (const op of accepted) {
      if (!perOp[op.id]) {
        perOp[op.id] = { status: 'failed', error: msg };
      }
    }
    // Reset any 'applied' that ran before the failing op — the tx
    // rolled them back, so the audit shouldn't claim they applied.
    for (const op of accepted) {
      const entry = perOp[op.id];
      if (entry && entry.status === 'applied') {
        perOp[op.id] = { status: 'failed', error: 'Rolled back due to a later op failure.' };
      }
    }
    await markFailed(chatId, messageId, action, msg);
    return { ok: false, perOp, error: msg };
  }

  // Stamp the chip + write the notification.
  const operationResults: Record<string, EditOperationAppliedDetail> = {};
  const declinedIds: string[] = [];
  for (const op of action.operations) {
    const entry = perOp[op.id];
    if (entry?.status === 'applied') operationResults[op.id] = entry.detail;
    else if (entry?.status === 'declined') declinedIds.push(op.id);
  }
  const appliedCount = Object.keys(operationResults).length;
  await updateActionStatus(chatId, messageId, action.id, {
    status: 'applied',
    appliedAt: now,
    appliedDetails: {
      kind: 'propose_edit',
      operationResults,
      declinedOperationIds: declinedIds,
    },
  });
  await writeProposalNotification(chatId, action, appliedCount, accepted.length);
  kickSync();
  return { ok: true, perOp };
}

async function markFailed(
  chatId: string,
  messageId: string,
  action: ChatAction,
  error: string,
): Promise<void> {
  await updateActionStatus(chatId, messageId, action.id, {
    status: 'pending',
    applyError: error,
  });
}

async function writeProposalNotification(
  chatId: string,
  action: ProposeEditChatAction,
  appliedCount: number,
  acceptedCount: number,
): Promise<void> {
  const now = new Date().toISOString();
  const notification: Notification = {
    // Keyed by action id so reapplies don't duplicate the audit row.
    id: `chat-action:${action.id}`,
    createdAt: now,
    updatedAt: now,
    channel: 'ai-action',
    severity: 'success',
    title: `AI proposal applied: ${appliedCount}/${acceptedCount} operations`,
    body: action.headline,
    context: {
      kind: 'chat-action',
      actionKind: 'propose_edit',
      chatId,
      messageId: action.id,
    },
  };
  try {
    await getDb().notifications.put(notification);
  } catch {
    // Best-effort.
  }
}

// === Per-op handlers (run inside the orchestrator's Dexie tx) ===
//
// Each handler PERFORMS the op AND returns the audit detail. Throws
// on any validation or write failure so the tx rolls back.

async function performOp(op: EditOperation): Promise<EditOperationAppliedDetail> {
  switch (op.kind) {
    case 'set_training_max':
      return performSetTrainingMax(op);
    case 'set_block_volume_preset':
      return performSetBlockVolumePreset(op);
    case 'trim_assistance_entry':
      return performTrimAssistanceEntry(op);
    case 'swap_assistance_movement':
      return performSwapAssistanceMovement(op);
    case 'add_assistance_entry':
      return performAddAssistanceEntry(op);
    case 'remove_assistance_entry':
      return performRemoveAssistanceEntry(op);
    case 'schedule_deload':
      return performScheduleDeload();
    case 'skip_day_in_week':
      return performSkipDayInWeek(op);
  }
}

async function performSetTrainingMax(
  op: EditOperation & { kind: 'set_training_max' },
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const all = await db.trainingMaxes.toArray();
  const prev = all
    .filter((t) => t.lift === op.lift)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const settings = await db.settings.get('singleton');
  const tmPercent = settings?.defaultTmPercent ?? 0.85;
  const record: TrainingMaxRecord = {
    id: nanoid(),
    lift: op.lift,
    trainingMaxKg: op.newTrainingMaxKg,
    tmPercent,
    createdAt: new Date().toISOString(),
    source: 'manual',
    note: `Chat proposal: ${op.label}`,
  };
  await db.trainingMaxes.put(record);
  return {
    kind: 'set_training_max',
    recordId: record.id,
    ...(prev ? { previousKg: prev.trainingMaxKg } : {}),
    newKg: op.newTrainingMaxKg,
  };
}

async function performSetBlockVolumePreset(
  op: EditOperation & { kind: 'set_block_volume_preset' },
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const block = await resolveBlock(op.blockId);
  const previousPreset =
    typeof block.assistanceVolume === 'string' ? block.assistanceVolume : undefined;
  const updated: ProgramBlock = {
    ...block,
    assistanceVolume: op.preset,
    updatedAt: new Date().toISOString(),
  };
  await db.blocks.put(updated);
  return {
    kind: 'set_block_volume_preset',
    ...(previousPreset !== undefined ? { previousPreset } : {}),
    newPreset: op.preset,
  };
}

async function performTrimAssistanceEntry(
  op: EditOperation & { kind: 'trim_assistance_entry' },
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const block = await resolveBlock(op.blockId);
  if (!block.plan) throw new Error(`Block "${block.name}" has no plan to trim.`);
  let captured:
    | {
        previousSets: number;
        previousReps: number;
        previousRepsMax?: number;
      }
    | undefined;
  const days = block.plan.days.map((d) => {
    if (d.id !== op.dayId) return d;
    return {
      ...d,
      assistance: d.assistance.map((e) => {
        if (e.id !== op.entryId) return e;
        captured = {
          previousSets: e.sets,
          previousReps: e.reps,
          ...(e.repsMax !== undefined ? { previousRepsMax: e.repsMax } : {}),
        };
        const trimmed: AssistanceEntry = {
          ...e,
          sets: op.newSets,
          reps: op.newReps,
          ...(op.newRepsMax !== undefined ? { repsMax: op.newRepsMax } : { repsMax: undefined }),
        };
        return trimmed;
      }),
    };
  });
  if (!captured) {
    throw new Error(`Entry ${op.entryId} not found on day ${op.dayId}.`);
  }
  await db.blocks.put({
    ...block,
    plan: { ...block.plan, days },
    updatedAt: new Date().toISOString(),
  });
  return {
    kind: 'trim_assistance_entry',
    previousSets: captured.previousSets,
    previousReps: captured.previousReps,
    ...(captured.previousRepsMax !== undefined ? { previousRepsMax: captured.previousRepsMax } : {}),
    newSets: op.newSets,
    newReps: op.newReps,
    ...(op.newRepsMax !== undefined ? { newRepsMax: op.newRepsMax } : {}),
  };
}

async function performSwapAssistanceMovement(
  op: EditOperation & { kind: 'swap_assistance_movement' },
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const block = await resolveBlock(op.blockId);
  if (!block.plan) throw new Error(`Block "${block.name}" has no plan to swap into.`);
  const newMovement = await db.movements.get(op.newMovementId);
  if (!newMovement) {
    throw new Error(`Replacement movement \`${op.newMovementId}\` not in library.`);
  }
  let captured: { prevId: string | undefined; prevName: string } | undefined;
  const days = block.plan.days.map((d) => {
    if (d.id !== op.dayId) return d;
    return {
      ...d,
      assistance: d.assistance.map((e) => {
        if (e.id !== op.entryId) return e;
        captured = { prevId: e.movementId, prevName: e.movementName };
        return { ...e, movementId: op.newMovementId, movementName: op.newMovementName };
      }),
    };
  });
  if (!captured) {
    throw new Error(`Entry ${op.entryId} not found on day ${op.dayId}.`);
  }
  await db.blocks.put({
    ...block,
    plan: { ...block.plan, days },
    updatedAt: new Date().toISOString(),
  });
  return {
    kind: 'swap_assistance_movement',
    previousMovementId: captured.prevId ?? '(no movementId)',
    previousMovementName: captured.prevName,
    newMovementId: op.newMovementId,
    newMovementName: op.newMovementName,
  };
}

async function performAddAssistanceEntry(
  op: EditOperation & { kind: 'add_assistance_entry' },
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const block = await resolveBlock(op.blockId);
  if (!block.plan) throw new Error(`Block "${block.name}" has no plan to add to.`);
  const movement = await db.movements.get(op.movementId);
  if (!movement) {
    throw new Error(`Movement \`${op.movementId}\` not in library.`);
  }
  const entryId = nanoid();
  let inserted = false;
  const days = block.plan.days.map((d) => {
    if (d.id !== op.dayId) return d;
    inserted = true;
    const entry: AssistanceEntry = {
      id: entryId,
      movementId: op.movementId,
      movementName: op.movementName,
      category: op.category as AssistanceEntry['category'],
      sets: op.sets,
      reps: op.reps,
      ...(op.repsMax !== undefined ? { repsMax: op.repsMax } : {}),
      ...(op.unit ? { unit: op.unit } : {}),
    };
    return { ...d, assistance: [...d.assistance, entry] };
  });
  if (!inserted) {
    throw new Error(`Day ${op.dayId} not found in block "${block.name}".`);
  }
  await db.blocks.put({
    ...block,
    plan: { ...block.plan, days },
    updatedAt: new Date().toISOString(),
  });
  return {
    kind: 'add_assistance_entry',
    newEntryId: entryId,
    movementName: op.movementName,
  };
}

async function performRemoveAssistanceEntry(
  op: EditOperation & { kind: 'remove_assistance_entry' },
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const block = await resolveBlock(op.blockId);
  if (!block.plan) throw new Error(`Block "${block.name}" has no plan to remove from.`);
  let removedName: string | undefined;
  const days = block.plan.days.map((d) => {
    if (d.id !== op.dayId) return d;
    return {
      ...d,
      assistance: d.assistance.filter((e) => {
        if (e.id !== op.entryId) return true;
        removedName = e.movementName;
        return false;
      }),
    };
  });
  if (removedName === undefined) {
    throw new Error(`Entry ${op.entryId} not found on day ${op.dayId}.`);
  }
  await db.blocks.put({
    ...block,
    plan: { ...block.plan, days },
    updatedAt: new Date().toISOString(),
  });
  return {
    kind: 'remove_assistance_entry',
    removedMovementName: removedName,
  };
}

async function performScheduleDeload(): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const all = await db.blocks.toArray();
  const activeBlock = all.find((b) => !b.completedAt);
  if (!activeBlock) throw new Error('No active block found.');
  const programId = activeBlock.programId;
  const peers = programId ? all.filter((b) => b.programId === programId) : [activeBlock];
  const maxSeq = peers.reduce((acc, b) => Math.max(acc, b.sequenceIndex ?? 0), 0);
  const now = new Date().toISOString();
  const deloadBlock: ProgramBlock = {
    id: nanoid(),
    name: 'Deload week',
    kind: 'seventh-week',
    seventhWeekKind: 'deload',
    weeksBeforeDeload: 1,
    includesDeload: true,
    supplementalTemplate: activeBlock.supplementalTemplate,
    mainScheme: activeBlock.mainScheme,
    createdAt: now,
    updatedAt: now,
    ...(programId ? { programId } : {}),
    sequenceIndex: maxSeq + 1,
  };
  await db.blocks.put(deloadBlock);
  return {
    kind: 'schedule_deload',
    newBlockId: deloadBlock.id,
    sequenceIndex: maxSeq + 1,
  };
}

async function resolveBlock(blockId?: string): Promise<ProgramBlock> {
  const db = getDb();
  if (blockId) {
    const b = await db.blocks.get(blockId);
    if (!b) throw new Error(`Block \`${blockId}\` not found.`);
    return b;
  }
  const all = await db.blocks.toArray();
  const active = all.find((b) => !b.completedAt);
  if (!active) throw new Error('No active block found.');
  return active;
}

async function performSkipDayInWeek(
  op: EditOperation & { kind: 'skip_day_in_week' },
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const block = await resolveBlock(op.blockId);
  if (!block.plan) {
    throw new Error(`Block "${block.name}" has no plan; nothing to skip.`);
  }
  const day = block.plan.days.find((d) => d.id === op.dayId);
  if (!day) {
    throw new Error(`Day ${op.dayId} not found in block "${block.name}".`);
  }
  // Idempotent merge into dayOverridesByWeek. Existing override entries
  // for the SAME (week, dayId) are replaced; entries for other weeks /
  // days are preserved.
  const overrides = { ...(block.plan.dayOverridesByWeek ?? {}) };
  for (const wk of op.weeks) {
    const key = `${wk}|${op.dayId}`;
    overrides[key] = {
      skipped: true,
      skipReason: op.skipReason,
      ...(op.skipNote ? { skipNote: op.skipNote } : {}),
    };
  }
  await db.blocks.put({
    ...block,
    plan: { ...block.plan, dayOverridesByWeek: overrides },
    updatedAt: new Date().toISOString(),
  });
  return {
    kind: 'skip_day_in_week',
    dayId: op.dayId,
    weeks: op.weeks,
    skipReason: op.skipReason,
    ...(op.dayLabel ? { dayLabel: op.dayLabel } : {}),
    ...(op.skipNote ? { skipNote: op.skipNote } : {}),
  };
}
