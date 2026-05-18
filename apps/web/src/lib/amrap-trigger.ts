'use client';

// amrap-trigger.ts — proactive coach trigger fired when the user logs a
// main-lift AMRAP. v473+: gated by a multi-signal CONFIDENCE MODEL
// (`scoreAmrapConfidence` in @wendler/domain) so the proposal only fires
// when several independent signals agree the training max is genuinely
// under-set:
//
//   Hard gates (any fail → no proposal):
//     - TM for this lift changed in the last 28 days (cooldown).
//     - Active injury has an accepted adjustment for this movement.
//     - A-priority race within 21 days.
//
//   Soft signals (need ≥ 3 points):
//     - +1 reps over target ≥ 5
//     - +2 Wk3 1+ AMRAP crushed by ≥5 (Wendler's canonical signal)
//     - +2 Wk1/Wk2 AMRAP crushed by ≥7 (early-week outlier)
//     - +2 e1RM-implied TM exceeds current TM by ≥7%
//     - +1 per prior AMRAP-smash on the same lift in last ~6 weeks (cap +2)
//     - +1 if ≥1 full cycle (21 days) since last TM change
//     - −1 if TSB ≤ −30 (high fatigue masks the signal)
//
// When the threshold is met the proposal chat is created with the score's
// reasons baked into the prompt so the AI knows WHY confidence was high.
//
// Idempotent per (sessionId, movementId): a deterministic notification id
// stops re-emission when the AMRAP set is re-saved (e.g. reps corrected).

import { nanoid } from 'nanoid';
import type { Injury, Notification, Race, SetRecord, TrainingMaxRecord } from '@wendler/db-schema';
import { scoreAmrapConfidence, type PriorAmrapSmash } from '@wendler/domain';
import { getDb } from './db';
import { kickSync } from './sync';

/** ~6-week prior-smash window in ms. */
const PRIOR_WINDOW_MS = 42 * 86_400_000;

/**
 * Inspect a freshly-saved set; if it's a main-lift AMRAP on a regular wave
 * week AND the confidence model says fire, create the coach chat and drop
 * the inbox notification. Returns the chat id when fired, null otherwise.
 * Fire-and-forget from the save handler — failures are logged but don't
 * break the save path.
 */
export async function maybeTriggerAmrapBump(set: SetRecord): Promise<string | null> {
  try {
    if (!set.isAmrap || set.kind !== 'main') return null;
    if (typeof set.reps !== 'number' || set.reps <= 0) return null;
    if (typeof set.trainingMaxKgAtTime !== 'number' || set.trainingMaxKgAtTime <= 0) {
      return null;
    }
    if (!set.sessionId) return null;
    const db = getDb();

    const session = await db.sessions.get(set.sessionId);
    if (!session) return null;
    const wk = session.week;
    if (wk !== 1 && wk !== 2 && wk !== 3) return null;

    // Idempotency: deterministic notification id keyed by session + movement.
    // If a trigger fired for this AMRAP already, skip.
    const notificationId = `amrap-bump:${set.sessionId}:${set.movementId}`;
    const existing = await db.notifications.get(notificationId);
    if (existing) return null;

    // ---- gather inputs for the confidence model -----------------------------
    const movement = await db.movements.get(set.movementId);
    const movementName = movement?.name ?? 'main lift';
    const mainLift = movement?.isMainLift ?? undefined;

    // Last TM change for this lift, and any TM-bump proposal recency.
    let lastTmChangeAt: string | undefined;
    if (mainLift) {
      const tms = await db.trainingMaxes.toArray();
      const forLift = tms
        .filter((t: TrainingMaxRecord) => t.lift === mainLift)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      lastTmChangeAt = forLift[0]?.createdAt;
    }

    // Recent AMRAP-bump proposals across ALL sessions for this movement.
    // If we proposed one in the last 28 days, hold off — the user already
    // has a pending or recently-acted-on suggestion.
    const recentTmBumpProposal = await hasRecentTmBumpProposal(set.movementId, set.performedAt);

    // Injury → movement gate. Active (non-resolved) injuries whose accepted
    // adjustments target this movementId.
    const injuryBlocksMovement = await isMovementInjuryBlocked(set.movementId);

    // Days to next A-priority race. Undefined when no upcoming A-race.
    const daysToNextARace = await daysToNextARaceFromCalendar(set.performedAt);

    // Prior AMRAP-smashes for this movement in the last ~6 weeks (excluding
    // the current set).
    const priorSmashes = await collectPriorSmashes(
      set.movementId,
      set.id,
      new Date(set.performedAt).getTime(),
      wk,
    );

    // ---- score --------------------------------------------------------------
    const confidence = scoreAmrapConfidence({
      setPerformedAt: set.performedAt,
      week: wk,
      reps: set.reps,
      weightKg: set.weightKg,
      trainingMaxKg: set.trainingMaxKgAtTime,
      lastTmChangeAt,
      recentTmBumpProposal,
      injuryBlocksMovement,
      daysToNextARace,
      priorSmashes,
      // TSB not yet wired — pure-data load model is server-side. Treat as
      // undefined for now; the model handles that branch cleanly.
    });

    if (!confidence.fire) {
      // Skip emission. Optional: log to diagnostics in a future iteration
      // so the user can audit "why didn't I get a bump suggestion?".
      return null;
    }

    // ---- emit chat + notification ------------------------------------------
    const chatId = nanoid();
    const nowIso = new Date().toISOString();
    const target = wk === 1 ? 5 : wk === 2 ? 3 : 1;
    const repsOver = set.reps - target;
    const prompt = buildAmrapPrompt({
      movementName,
      reps: set.reps,
      target,
      tmKg: set.trainingMaxKgAtTime,
      weightKg: set.weightKg,
      week: wk,
      repsOver,
      reasons: confidence.reasons,
      e1rmKg: confidence.details.estimatedOneRmKg,
    });

    await db.chats.put({
      id: chatId,
      createdAt: nowIso,
      updatedAt: nowIso,
      title: `${movementName} AMRAP: ${set.reps} reps (+${repsOver}) — TM bump?`,
      messages: [],
      pendingAutoSend: prompt,
    });

    const notification: Notification = {
      id: notificationId,
      createdAt: nowIso,
      updatedAt: nowIso,
      channel: 'ai-action',
      severity: 'success',
      title: `${movementName} smashed — ${set.reps} reps vs ${target}+ target`,
      body:
        confidence.reasons.length > 0
          ? `Confidence ${confidence.score}/${confidence.threshold}+. ${confidence.reasons[0]} Tap to see the coach's TM bump proposal.`
          : `Tap to see the coach's TM bump proposal.`,
      deepLink: { href: `/chat?id=${chatId}`, label: 'Open proposal' },
      context: {
        kind: 'amrap-bump',
        chatId,
        sessionId: set.sessionId,
        movementId: set.movementId,
        reps: set.reps,
        target,
        week: wk,
        confidenceScore: confidence.score,
        confidenceThreshold: confidence.threshold,
        confidenceReasons: confidence.reasons,
      },
    };
    try {
      await db.notifications.put(notification);
    } catch {
      // Best-effort.
    }

    kickSync();
    return chatId;
  } catch (err) {
    console.warn('[amrap-trigger] failed:', err);
    return null;
  }
}

async function hasRecentTmBumpProposal(
  movementId: string,
  performedAtIso: string,
): Promise<boolean> {
  const db = getDb();
  const performedMs = new Date(performedAtIso).getTime();
  // Notification ids start with `amrap-bump:`. Scan the table for any
  // entry whose context.movementId matches and whose createdAt is within
  // the last 28 days of THIS set's performedAt. The notification table is
  // small by design so a full scan is fine.
  const all = await db.notifications.toArray();
  const windowStart = performedMs - 28 * 86_400_000;
  for (const n of all) {
    if (!n.id.startsWith('amrap-bump:')) continue;
    const ctxMovementId = (n.context as { movementId?: string } | undefined)?.movementId;
    if (ctxMovementId !== movementId) continue;
    const createdMs = new Date(n.createdAt).getTime();
    if (createdMs >= windowStart) return true;
  }
  return false;
}

async function isMovementInjuryBlocked(movementId: string): Promise<boolean> {
  const db = getDb();
  const injuries = (await db.injuries.toArray()) as Injury[];
  for (const inj of injuries) {
    if (inj.resolvedAt) continue;
    if (inj.deletedAt) continue;
    for (const adj of inj.adjustments ?? []) {
      if (adj.movementId !== movementId) continue;
      if (adj.status === 'accepted') return true;
    }
  }
  return false;
}

async function daysToNextARaceFromCalendar(
  performedAtIso: string,
): Promise<number | undefined> {
  const db = getDb();
  const races = (await db.races.toArray()) as Race[];
  const now = new Date(performedAtIso).getTime();
  let minDays: number | undefined;
  for (const r of races) {
    if (r.priority !== 'A') continue;
    if (r.result) continue; // completed; ignore
    const raceMs = new Date(r.date).getTime();
    if (raceMs < now) continue;
    const days = Math.ceil((raceMs - now) / 86_400_000);
    if (minDays === undefined || days < minDays) minDays = days;
  }
  return minDays;
}

async function collectPriorSmashes(
  movementId: string,
  excludeSetId: string,
  performedMs: number,
  currentWeek: 1 | 2 | 3,
): Promise<PriorAmrapSmash[]> {
  const db = getDb();
  const all = await db.sets.where('movementId').equals(movementId).toArray();
  const out: PriorAmrapSmash[] = [];
  const windowStart = performedMs - PRIOR_WINDOW_MS;
  for (const s of all) {
    if (s.id === excludeSetId) continue;
    if (s.deletedAt) continue;
    if (!s.isAmrap || s.kind !== 'main') continue;
    const ms = new Date(s.performedAt).getTime();
    if (ms >= performedMs) continue;
    if (ms < windowStart) continue;
    if (!s.sessionId) continue;
    const session = await db.sessions.get(s.sessionId);
    const wk = session?.week;
    if (wk !== 1 && wk !== 2 && wk !== 3) continue;
    const target = wk === 1 ? 5 : wk === 2 ? 3 : 1;
    const over = s.reps - target;
    if (over < 3) continue;
    void currentWeek; // kept for future per-week weighting; unused for now
    out.push({ performedAt: s.performedAt, repsOverTarget: over });
  }
  return out;
}

function buildAmrapPrompt(p: {
  movementName: string;
  reps: number;
  target: number;
  tmKg: number;
  weightKg: number;
  week: 1 | 2 | 3;
  repsOver: number;
  reasons: string[];
  e1rmKg: number;
}): string {
  const reasonsBlock =
    p.reasons.length > 0
      ? ['', '**Why the coach fired this trigger:**', ...p.reasons.map((r) => `- ${r}`), ''].join('\n')
      : '';
  return [
    `I just hit an AMRAP top set that beat the target by ${p.repsOver} reps. The confidence model says this is a strong signal — please advise on the TM bump.`,
    ``,
    `**Movement:** ${p.movementName}`,
    `**Week:** ${p.week} (target ${p.target}+)`,
    `**AMRAP set:** ${p.weightKg} kg × ${p.reps} reps`,
    `**TM at time:** ${p.tmKg} kg`,
    `**Estimated 1RM (Epley):** ${p.e1rmKg.toFixed(1)} kg`,
    reasonsBlock,
    `Please:`,
    `1. Reconcile the estimated 1RM against my current TM and confirm the gap is real.`,
    `2. Emit a propose_edit chip with set_training_max for the new TM. Use the standard Wendler bumps (+2.5 kg upper, +5 kg lower) unless the gap warrants a larger jump or my recent training / fatigue / race calendar argues for less.`,
    `3. Be decisive — the confidence model already gated on cooldown / injury / race-proximity, so no need to re-litigate those.`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}
