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
  ChatActionSnapshot,
  ChatActionSnapshotTables,
  EditOperation,
  EditOperationAppliedDetail,
  EditOperationDecision,
  Movement,
  Notification,
  ProgramBlock,
  ProgramSchedule,
  ProposeEditChatAction,
  TrainingMaxRecord,
  AssistanceEntry,
} from '@wendler/db-schema';
import type { BlockPlan } from '@wendler/domain';
import { getDb } from './db';
import { kickSync } from './sync';
import { updateActionStatus } from './chat-actions';

// ===== Helpers for per-week assistance mutation =====
//
// After v21, BlockPlan.assistanceOverrides is the canonical store for
// scheduled assistance per (week, day) — there is no separate "base"
// anymore. propose_edit ops mutate ALL weeks of the block so a single
// op semantically means "this change applies to the block". A user
// who wants a per-week diverged value uses the editor directly.
//
// Entry IDs are SHARED across weeks for the same movement-per-day so
// a single op.entryId targets every week's instance. The helpers
// below abstract: clone the per-week store; ensure a week has an
// entries array to mutate (promoting from the legacy day.assistance
// base when present, for blocks that haven't been touched by the
// v21 Dexie upgrade yet — usually only docs in transit via sync).

function weeksOfBlock(block: ProgramBlock): Array<'1' | '2' | '3' | 'deload' | '7w'> {
  if (block.kind === 'seventh-week') return ['7w'];
  const weeks: Array<'1' | '2' | '3' | 'deload' | '7w'> = ['1', '2', '3'];
  if (block.includesDeload) weeks.push('deload');
  return weeks;
}

function clonePerWeekStore(plan: BlockPlan): Record<string, AssistanceEntry[]> {
  const src = plan.assistanceOverrides ?? {};
  const out: Record<string, AssistanceEntry[]> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = v.map((e) => ({ ...e }));
  }
  return out;
}

function ensureWeekEntries(
  overrides: Record<string, AssistanceEntry[]>,
  key: string,
  plan: BlockPlan,
  dayId: string,
): AssistanceEntry[] {
  if (overrides[key]) return overrides[key]!;
  // Legacy promotion: pre-v21 blocks may still have day.assistance
  // populated. Copy it (with fresh object identities) into the per-
  // week slot so the mutation has somewhere to land.
  const day = plan.days.find((d) => d.id === dayId);
  const fromLegacy = day?.assistance ?? [];
  const cloned = fromLegacy.map((e) => ({ ...e }));
  overrides[key] = cloned;
  return cloned;
}

const APPLY_ORDER: Record<EditOperation['kind'], number> = {
  set_block_volume_preset: 0,
  schedule_deload: 1,
  skip_day_in_week: 2,
  remove_assistance_entry: 3,
  remove_cardio_plan_slot: 4,
  add_movement_to_library: 5,
  add_assistance_entry: 6,
  add_cardio_plan_slot: 7,
  trim_assistance_entry: 8,
  swap_assistance_movement: 9,
  set_training_max: 10,
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

  // Capture before-state snapshot OUTSIDE the apply tx. Single-user
  // app + the chat UI doesn't race with itself on a single apply, so
  // a separate read pass is safe and keeps the apply tx scope small.
  // Stored only on success — a rolled-back apply leaves nothing
  // behind to undo.
  const snapshotTables = await captureSnapshotTables(accepted);

  // Atomic transaction. If any op throws, the whole tx rolls back.
  //
  // tempIdMap is mutated as the loop runs — when an add_movement_to_library
  // op runs (slot 4), it stores the temp→real id mapping so the chained
  // add_assistance_entry op (slot 5) can resolve its `movementId` against
  // it. Plain Map shared across the tx is fine — the tx is sequential.
  const tempIdMap = new Map<string, string>();
  try {
    await db.transaction(
      'rw',
      [db.blocks, db.trainingMaxes, db.settings, db.movements, db.cardioPlan, db.schedule],
      async () => {
        for (const op of accepted) {
          // Re-resolve the target block fresh per op (a previous op in
          // the same tx may have mutated it; we read the latest from
          // the tx-scoped table view).
          const detail = await performOp(op, tempIdMap);
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
  // Persist the before-state snapshot so the user can undo this
  // proposal later. Done AFTER updateActionStatus so a failure here
  // doesn't leave the chip in an inconsistent state — worst case the
  // snapshot is missing and the Undo button hides itself. Failures
  // here are logged but not thrown.
  try {
    await persistSnapshot(action.id, snapshotTables, now);
  } catch (err) {
    console.warn('[applyEditProposal] snapshot persist failed:', err);
  }
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

// === Snapshot capture (undo log) ===
//
// Before the apply tx runs, we capture the current state of every
// table the apply will touch. After tx success the snapshot is
// persisted to db.chatActionSnapshots, keyed by the action.id.
// The user can then roll back the proposal from the read-only sheet.
//
// Strategy: per touched multi-row table (blocks / movements /
// trainingMaxes) we record EVERY row's full state + the full id set.
// On undo, restored rows get a fresh `updatedAt` so LWW sync wins;
// rows present now but absent in `presentIds` were created by this
// apply and get deleted (with tombstone). Singletons (cardioPlan,
// schedule) capture the singleton row as-is, or null if it didn't
// exist yet.
//
// We always capture per-op blockId targets PLUS, when an op might
// touch the active block by fallback, ALL blocks (covers the
// `op.blockId` undefined path + `schedule_deload` which creates a
// new block in the program sequence).
async function captureSnapshotTables(
  accepted: EditOperation[],
): Promise<ChatActionSnapshotTables> {
  const db = getDb();
  let touchesBlocks = false;
  let touchesAllBlocks = false; // any op that could create a block or fallback to active
  let touchesCardio = false;
  let touchesSchedule = false; // schedule_deload writes to schedule cursor
  let touchesTm = false;
  let touchesMovements = false;

  for (const op of accepted) {
    switch (op.kind) {
      case 'set_block_volume_preset':
      case 'trim_assistance_entry':
      case 'swap_assistance_movement':
      case 'add_assistance_entry':
      case 'remove_assistance_entry':
      case 'skip_day_in_week':
        touchesBlocks = true;
        if (!('blockId' in op) || !op.blockId) touchesAllBlocks = true;
        break;
      case 'schedule_deload':
        touchesBlocks = true;
        touchesAllBlocks = true;
        break;
      case 'add_cardio_plan_slot':
      case 'remove_cardio_plan_slot':
        touchesCardio = true;
        break;
      case 'set_training_max':
        touchesTm = true;
        break;
      case 'add_movement_to_library':
        touchesMovements = true;
        break;
    }
  }

  const out: ChatActionSnapshotTables = {};

  if (touchesBlocks) {
    // Always snapshot the full blocks table — `touchesAllBlocks` is
    // common (any op that resolves the active block as a fallback
    // needs all blocks). Cost is small (typically <20 blocks).
    void touchesAllBlocks;
    const all = await db.blocks.toArray();
    const rowsById: Record<string, unknown> = {};
    const presentIds: string[] = [];
    for (const b of all) {
      rowsById[b.id] = b;
      presentIds.push(b.id);
    }
    out.blocks = { presentIds, rowsById };
  }

  if (touchesCardio) {
    const row = (await db.cardioPlan.get('singleton')) ?? null;
    out.cardioPlan = { singletonRow: row };
  }

  if (touchesSchedule) {
    const row = (await db.schedule.get('singleton')) ?? null;
    out.schedule = { singletonRow: row };
  }

  if (touchesTm) {
    const all = await db.trainingMaxes.toArray();
    const rowsById: Record<string, unknown> = {};
    const presentIds: string[] = [];
    for (const r of all) {
      rowsById[r.id] = r;
      presentIds.push(r.id);
    }
    out.trainingMaxes = { presentIds, rowsById };
  }

  if (touchesMovements) {
    const all = await db.movements.toArray();
    const rowsById: Record<string, unknown> = {};
    const presentIds: string[] = [];
    for (const m of all) {
      rowsById[m.id] = m;
      presentIds.push(m.id);
    }
    out.movements = { presentIds, rowsById };
  }

  return out;
}

const SNAPSHOT_RETENTION_CAP = 50;

async function persistSnapshot(
  chatActionId: string,
  tables: ChatActionSnapshotTables,
  createdAt: string,
): Promise<void> {
  if (Object.keys(tables).length === 0) return; // nothing touched — nothing to undo
  const db = getDb();
  const snapshot: ChatActionSnapshot = {
    chatActionId,
    createdAt,
    version: 1,
    tables,
  };
  await db.chatActionSnapshots.put(snapshot);
  // Prune oldest snapshots when over the retention cap. Local-only
  // table so a sloppy delete is fine — worst case the user loses
  // the ability to undo a very-old proposal.
  try {
    const count = await db.chatActionSnapshots.count();
    if (count > SNAPSHOT_RETENTION_CAP) {
      const toDelete = count - SNAPSHOT_RETENTION_CAP;
      const oldest = await db.chatActionSnapshots
        .orderBy('createdAt')
        .limit(toDelete)
        .primaryKeys();
      for (const k of oldest) {
        await db.chatActionSnapshots.delete(k as string);
      }
    }
  } catch {
    // Best-effort.
  }
}

// === Per-op handlers (run inside the orchestrator's Dexie tx) ===
//
// Each handler PERFORMS the op AND returns the audit detail. Throws
// on any validation or write failure so the tx rolls back.

async function performOp(
  op: EditOperation,
  tempIdMap: Map<string, string>,
): Promise<EditOperationAppliedDetail> {
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
      return performAddAssistanceEntry(op, tempIdMap);
    case 'add_movement_to_library':
      return performAddMovementToLibrary(op, tempIdMap);
    case 'add_cardio_plan_slot':
      return performAddCardioPlanSlot(op);
    case 'remove_cardio_plan_slot':
      return performRemoveCardioPlanSlot(op);
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
  const weeks = weeksOfBlock(block);
  const overrides = clonePerWeekStore(block.plan);
  let captured:
    | { previousSets: number; previousReps: number; previousRepsMax?: number }
    | undefined;
  for (const wk of weeks) {
    const key = `${wk}|${op.dayId}`;
    const entries = ensureWeekEntries(overrides, key, block.plan, op.dayId);
    const idx = entries.findIndex((e) => e.id === op.entryId);
    if (idx === -1) continue;
    const entry = entries[idx]!;
    if (!captured) {
      captured = {
        previousSets: entry.sets,
        previousReps: entry.reps,
        ...(entry.repsMax !== undefined ? { previousRepsMax: entry.repsMax } : {}),
      };
    }
    const trimmed: AssistanceEntry = {
      ...entry,
      sets: op.newSets,
      reps: op.newReps,
      ...(op.newRepsMax !== undefined ? { repsMax: op.newRepsMax } : { repsMax: undefined }),
    };
    entries[idx] = trimmed;
    overrides[key] = entries;
  }
  if (!captured) {
    throw new Error(`Entry ${op.entryId} not found on day ${op.dayId} in any week.`);
  }
  await db.blocks.put({
    ...block,
    plan: { ...block.plan, assistanceOverrides: overrides },
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
  const weeks = weeksOfBlock(block);
  const overrides = clonePerWeekStore(block.plan);
  let captured: { prevId: string | undefined; prevName: string } | undefined;
  for (const wk of weeks) {
    const key = `${wk}|${op.dayId}`;
    const entries = ensureWeekEntries(overrides, key, block.plan, op.dayId);
    const idx = entries.findIndex((e) => e.id === op.entryId);
    if (idx === -1) continue;
    const entry = entries[idx]!;
    if (!captured) {
      captured = { prevId: entry.movementId, prevName: entry.movementName };
    }
    entries[idx] = {
      ...entry,
      movementId: op.newMovementId,
      movementName: op.newMovementName,
    };
    overrides[key] = entries;
  }
  if (!captured) {
    throw new Error(`Entry ${op.entryId} not found on day ${op.dayId} in any week.`);
  }
  await db.blocks.put({
    ...block,
    plan: { ...block.plan, assistanceOverrides: overrides },
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
  tempIdMap: Map<string, string>,
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const block = await resolveBlock(op.blockId);
  if (!block.plan) throw new Error(`Block "${block.name}" has no plan to add to.`);
  // Resolve tmp:<slug> references against the temp-id map populated by
  // a prior add_movement_to_library op in the same proposal. If the
  // reference can't be resolved, fail loud — better than silently
  // writing a broken entry.
  let resolvedMovementId = op.movementId;
  if (op.movementId.startsWith('tmp:')) {
    const real = tempIdMap.get(op.movementId);
    if (!real) {
      throw new Error(
        `Assistance entry references "${op.movementId}" but no matching add_movement_to_library op ran first.`,
      );
    }
    resolvedMovementId = real;
  }
  const movement = await db.movements.get(resolvedMovementId);
  if (!movement) {
    throw new Error(`Movement \`${resolvedMovementId}\` not in library.`);
  }
  const dayExists = block.plan.days.some((d) => d.id === op.dayId);
  if (!dayExists) {
    throw new Error(`Day ${op.dayId} not found in block "${block.name}".`);
  }
  // One shared entryId across all weeks — matches the post-v21 model
  // where the same movement-per-day has a single canonical id; the
  // editor / chat / future propose_edit ops can address it once.
  const entryId = nanoid();
  const newEntry: AssistanceEntry = {
    id: entryId,
    movementId: resolvedMovementId,
    movementName: op.movementName,
    category: op.category as AssistanceEntry['category'],
    sets: op.sets,
    reps: op.reps,
    ...(op.repsMax !== undefined ? { repsMax: op.repsMax } : {}),
    ...(op.unit ? { unit: op.unit } : {}),
  };
  const weeks = weeksOfBlock(block);
  const overrides = clonePerWeekStore(block.plan);
  for (const wk of weeks) {
    const key = `${wk}|${op.dayId}`;
    const entries = ensureWeekEntries(overrides, key, block.plan, op.dayId);
    entries.push({ ...newEntry });
    overrides[key] = entries;
  }
  await db.blocks.put({
    ...block,
    plan: { ...block.plan, assistanceOverrides: overrides },
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
  const weeks = weeksOfBlock(block);
  const overrides = clonePerWeekStore(block.plan);
  let removedName: string | undefined;
  for (const wk of weeks) {
    const key = `${wk}|${op.dayId}`;
    const entries = ensureWeekEntries(overrides, key, block.plan, op.dayId);
    const idx = entries.findIndex((e) => e.id === op.entryId);
    if (idx === -1) continue;
    if (removedName === undefined) {
      removedName = entries[idx]!.movementName;
    }
    entries.splice(idx, 1);
    overrides[key] = entries;
  }
  if (removedName === undefined) {
    throw new Error(`Entry ${op.entryId} not found on day ${op.dayId} in any week.`);
  }
  await db.blocks.put({
    ...block,
    plan: { ...block.plan, assistanceOverrides: overrides },
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

async function performAddCardioPlanSlot(
  op: EditOperation & { kind: 'add_cardio_plan_slot' },
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const existing = (await db.cardioPlan.get('singleton')) ?? {
    id: 'singleton' as const,
    slots: [],
    updatedAt: new Date().toISOString(),
  };
  // Resolve the linked block. Default behavior is to tie the slot to
  // the active block (linkedToActiveBlock === undefined OR true) so
  // it's auto-removed when that block completes — the user's expected
  // 'AI keeps the plan up-to-date with what we agreed' UX. The AI can
  // opt out by passing linkedToActiveBlock: false when the user wants
  // a permanent slot.
  //
  // Selection order:
  //   1. Block pointed to by schedule.cursor.blockId — the user's
  //      "I'm working on this right now" block. This is the canonical
  //      anchor used by the timeline + projection.
  //   2. First uncompleted block — fallback for cases where the
  //      cursor isn't set or points to a deleted block.
  const linkToActive = op.linkedToActiveBlock !== false;
  let linkedBlock: ProgramBlock | undefined;
  let allBlocks: ProgramBlock[] = [];
  let schedule: ProgramSchedule | undefined;
  if (linkToActive) {
    allBlocks = await db.blocks.toArray();
    schedule = await db.schedule.get('singleton');
    if (schedule?.cursor?.blockId) {
      linkedBlock = allBlocks.find((b) => b.id === schedule!.cursor!.blockId);
    }
    if (!linkedBlock) {
      linkedBlock = allBlocks.find((b) => !b.completedAt);
    }
  }
  const linkedBlockId = linkedBlock?.id;

  // Resolve appliesToWeeks → effectiveFrom/Until ISO dates against the
  // linked block's start.
  //
  // Anchor selection (block startMonday):
  //   1. If `linkedBlock.startedAt` is set, use the Monday of THAT
  //      date — that's the canonical source of truth for when Wk 1
  //      began. Robust against a stale or mid-transition schedule
  //      cursor.
  //   2. Fallback: derive from today's Monday minus (cursorWeek - 1)
  //      weeks. Used only for blocks that haven't started yet (no
  //      startedAt) — rare but possible for a programmatically-created
  //      deload block via schedule_deload.
  let effectiveFrom: string | undefined;
  let effectiveUntil: string | undefined;
  if (op.appliesToWeeks && op.appliesToWeeks.length > 0 && linkedBlock) {
    const isoMonday = (d: Date): Date => {
      const m = new Date(d);
      m.setHours(0, 0, 0, 0);
      const wd = (m.getDay() + 6) % 7;
      m.setDate(m.getDate() - wd);
      return m;
    };
    let activeStartMonday: Date;
    if (linkedBlock.startedAt) {
      activeStartMonday = isoMonday(new Date(linkedBlock.startedAt));
    } else {
      const today = new Date();
      const todayMonday = isoMonday(today);
      const cursorWeek =
        schedule?.cursor?.blockId === linkedBlock.id ? schedule.cursor.week : 1;
      let weeksAlreadyIn = 0;
      if (cursorWeek === 'deload') {
        weeksAlreadyIn = linkedBlock.weeksBeforeDeload;
      } else if (cursorWeek === '7w') {
        weeksAlreadyIn = 0;
      } else {
        weeksAlreadyIn = Math.max(0, (cursorWeek as 1 | 2 | 3) - 1);
      }
      activeStartMonday = new Date(todayMonday);
      activeStartMonday.setDate(activeStartMonday.getDate() - weeksAlreadyIn * 7);
    }
    // Resolve each week label to its (Monday, Sunday) range.
    const weekRanges: Array<{ start: Date; end: Date }> = [];
    for (const wk of op.appliesToWeeks) {
      let weekIndex: number; // 0-based offset from activeStartMonday
      if (wk === 'deload') {
        weekIndex = linkedBlock.weeksBeforeDeload;
      } else if (wk === '7w') {
        weekIndex = 0;
      } else {
        weekIndex = Number(wk) - 1;
      }
      const start = new Date(activeStartMonday);
      start.setDate(start.getDate() + weekIndex * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      weekRanges.push({ start, end });
    }
    const minStart = weekRanges.reduce(
      (acc, r) => (r.start.getTime() < acc.getTime() ? r.start : acc),
      weekRanges[0]!.start,
    );
    const maxEnd = weekRanges.reduce(
      (acc, r) => (r.end.getTime() > acc.getTime() ? r.end : acc),
      weekRanges[0]!.end,
    );
    const fmt = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${da}`;
    };
    effectiveFrom = fmt(minStart);
    effectiveUntil = fmt(maxEnd);
  }

  const slots = [...existing.slots];
  // Match an existing slot by (dayOfWeek, modality). When found we
  // UPDATE its fields with whatever the new op specifies — the user's
  // intent on a re-accept is 'apply the new proposal to this slot',
  // not 'preserve the old version'. Fields the new op doesn't specify
  // are left untouched (durationMin / notes / etc fall back to the
  // existing values when omitted).
  const dupIdx = slots.findIndex(
    (s) => s.dayOfWeek === op.dayOfWeek && s.modality === op.modality,
  );
  const newSlotBase = {
    dayOfWeek: op.dayOfWeek,
    modality: op.modality as
      | 'run'
      | 'bike'
      | 'swim'
      | 'row'
      | 'walk'
      | 'padel'
      | 'other',
    kind: op.planKind as
      | 'rest'
      | 'easy'
      | 'long'
      | 'quality'
      | 'recovery'
      | 'race-pace'
      | 'z2'
      | 'intervals'
      | 'cross',
    ...(op.durationMin !== undefined ? { durationMin: op.durationMin } : {}),
    ...(op.notes ? { notes: op.notes } : {}),
    ...(linkedBlockId ? { linkedBlockId } : {}),
    ...(effectiveFrom ? { effectiveFrom } : {}),
    ...(effectiveUntil ? { effectiveUntil } : {}),
    // Persist the canonical week labels so the calendar can resolve
    // visibility DYNAMICALLY against the linked block's current
    // startedAt — auto-corrects if the user fixes block data later.
    // effectiveFrom/Until above are kept as a fast static cache.
    ...(op.appliesToWeeks && op.appliesToWeeks.length > 0
      ? { appliesToWeeks: op.appliesToWeeks }
      : {}),
  };
  let wasUpdate = false;
  if (dupIdx >= 0) {
    const prev = slots[dupIdx]!;
    // Merge: new op's explicit fields win; prev fields fill the gaps
    // for anything the new op didn't specify.
    slots[dupIdx] = { ...prev, ...newSlotBase };
    wasUpdate = true;
  } else {
    slots.push(newSlotBase);
  }
  await db.cardioPlan.put({
    ...existing,
    slots,
    updatedAt: new Date().toISOString(),
  });

  // Diagnostic: explain WHY scope resolution was skipped (when the op
  // asked for scope but we didn't write effectiveFrom/Until). Surfaces
  // in the audit + diagnostics page so silent scope-drop is debuggable.
  let scopeSkippedReason:
    | 'no-applies-to-weeks'
    | 'no-linked-block'
    | 'opted-out'
    | undefined;
  if (!effectiveFrom) {
    if (!linkToActive) scopeSkippedReason = 'opted-out';
    else if (!op.appliesToWeeks || op.appliesToWeeks.length === 0)
      scopeSkippedReason = 'no-applies-to-weeks';
    else if (!linkedBlock) scopeSkippedReason = 'no-linked-block';
  }

  return {
    kind: 'add_cardio_plan_slot',
    dayOfWeek: op.dayOfWeek,
    modality: op.modality,
    planKind: op.planKind,
    ...(op.durationMin !== undefined ? { durationMin: op.durationMin } : {}),
    ...(op.notes ? { notes: op.notes } : {}),
    ...(wasUpdate ? { reusedExisting: true } : {}),
    ...(op.appliesToWeeks && op.appliesToWeeks.length > 0
      ? { appliesToWeeks: op.appliesToWeeks }
      : {}),
    ...(linkedBlockId ? { linkedBlockId } : {}),
    ...(effectiveFrom ? { effectiveFrom } : {}),
    ...(effectiveUntil ? { effectiveUntil } : {}),
    ...(scopeSkippedReason ? { scopeSkippedReason } : {}),
  };
}

async function performRemoveCardioPlanSlot(
  op: EditOperation & { kind: 'remove_cardio_plan_slot' },
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  const existing = await db.cardioPlan.get('singleton');
  if (!existing || existing.slots.length === 0) {
    return {
      kind: 'remove_cardio_plan_slot',
      dayOfWeek: op.dayOfWeek,
      modality: op.modality,
      noopReason: 'not-found',
    };
  }
  // Remove ALL matching slots, not just the first. Duplicates can
  // exist from pre-v434 state when add_cardio_plan_slot was silently
  // skipping on a (dayOfWeek, modality) collision rather than
  // merging — re-accept cycles before v434 could leave the cardio
  // plan with multiple Friday-bike rows. The user's intent on
  // "delete the Friday bike" is always 'leave nothing matching that
  // key', so taking out every duplicate is the correct semantics.
  const matches = existing.slots.filter(
    (s) => s.dayOfWeek === op.dayOfWeek && s.modality === op.modality,
  );
  if (matches.length === 0) {
    return {
      kind: 'remove_cardio_plan_slot',
      dayOfWeek: op.dayOfWeek,
      modality: op.modality,
      noopReason: 'not-found',
    };
  }
  const slots = existing.slots.filter(
    (s) => !(s.dayOfWeek === op.dayOfWeek && s.modality === op.modality),
  );
  await db.cardioPlan.put({
    ...existing,
    slots,
    updatedAt: new Date().toISOString(),
  });
  // Surface the FIRST match's metadata in the audit detail — the
  // duplicates were almost certainly stale leftovers, and the AI's
  // semantic "what did I just remove?" reasoning works best with the
  // canonical / most-recent row's fields.
  const removed = matches[0]!;
  return {
    kind: 'remove_cardio_plan_slot',
    dayOfWeek: op.dayOfWeek,
    modality: op.modality,
    removedKind: removed.kind,
    ...(removed.durationMin !== undefined
      ? { removedDurationMin: removed.durationMin }
      : {}),
    removedCount: matches.length,
  };
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

/**
 * Normalize a movement name for dedup comparison: lowercase, trim,
 * strip punctuation, collapse whitespace, strip leading articles.
 */
function normalizeMovementName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function performAddMovementToLibrary(
  op: EditOperation & { kind: 'add_movement_to_library' },
  tempIdMap: Map<string, string>,
): Promise<EditOperationAppliedDetail> {
  const db = getDb();
  // Server-side exact-dup check. The renderer surfaces fuzzy matches
  // as informational warnings; this is the hard reject path. When an
  // exact normalized-name match exists, we DO NOT throw — we soft-fall
  // back to the existing movement (race-condition handling: parallel
  // sync may have added the same movement after the user accepted).
  // The tempIdMap is populated with the existing id so the chained
  // add_assistance_entry op resolves to it.
  const targetName = normalizeMovementName(op.name);
  if (!targetName) {
    throw new Error('Movement name resolves to empty after normalization.');
  }
  const existing = await db.movements.toArray();
  const exactDup = existing.find(
    (m) => normalizeMovementName(m.name) === targetName,
  );
  if (exactDup) {
    tempIdMap.set(op.tempMovementId, exactDup.id);
    return {
      kind: 'add_movement_to_library',
      newMovementId: exactDup.id,
      movementName: exactDup.name,
      reusedExistingMovementId: exactDup.id,
    };
  }
  // Genuine new movement. Generate an id in the same shape that the
  // /movements/new page uses so the library row is indistinguishable
  // from manually-created ones (per user preference — no AI badge).
  const newId = `custom:${nanoid(8)}`;
  const movement: Movement = {
    id: newId,
    name: op.name.trim(),
    equipment: (op.equipment ?? 'bodyweight') as Movement['equipment'],
    pattern: op.pattern as Movement['pattern'],
    primaryMuscles: op.primaryMuscles as Movement['primaryMuscles'],
    secondaryMuscles: (op.secondaryMuscles ?? []) as Movement['secondaryMuscles'],
    isCustom: true,
    ...(op.isCompound !== undefined ? { isCompound: op.isCompound } : { isCompound: false }),
    ...(op.externallyLoadable !== undefined
      ? { externallyLoadable: op.externallyLoadable }
      : {}),
    ...(op.cues ? { techniqueCues: op.cues } : {}),
  };
  await db.movements.put(movement);
  tempIdMap.set(op.tempMovementId, newId);
  return {
    kind: 'add_movement_to_library',
    newMovementId: newId,
    movementName: movement.name,
  };
}
