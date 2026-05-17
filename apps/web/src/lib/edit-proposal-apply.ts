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
  Movement,
  Notification,
  ProgramBlock,
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
  add_movement_to_library: 4,
  add_assistance_entry: 5,
  trim_assistance_entry: 6,
  swap_assistance_movement: 7,
  set_training_max: 8,
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
  //
  // tempIdMap is mutated as the loop runs — when an add_movement_to_library
  // op runs (slot 4), it stores the temp→real id mapping so the chained
  // add_assistance_entry op (slot 5) can resolve its `movementId` against
  // it. Plain Map shared across the tx is fine — the tx is sequential.
  const tempIdMap = new Map<string, string>();
  try {
    await db.transaction(
      'rw',
      [db.blocks, db.trainingMaxes, db.settings, db.movements],
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
