'use client';

// amrap-trigger.ts — proactive coach trigger fired when the user
// logs an AMRAP top-set that smashes the target by 5+ reps. Big
// AMRAP outliers are the textbook signal in Wendler's progression
// rules that the training max is too light. Rather than wait for
// the user to remember and run the suggester, we fire a Coach chat
// with a primed prompt + notification: "You hit X reps on bench
// AMRAP — TM bump? Here's my proposal."
//
// Same plumbing pattern as injury-coach (v447): create chat with
// pendingAutoSend + drop notification + ChatPanel auto-fires the
// send when the user opens the conversation. No SSE wrangling.
//
// Idempotent per (sessionId, movementId): the notification id is
// deterministic so re-saving the AMRAP set (e.g. correcting reps)
// won't spam. If the user already accepted/dismissed a chip for
// this session+lift, the existing chat just re-opens.

import { nanoid } from 'nanoid';
import type { Notification, SetRecord } from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';

/**
 * Standard Wendler 5/3/1 AMRAP targets per week.
 * Wk 1 = 5+ (5s week), Wk 2 = 3+ (3s week), Wk 3 = 1+ (5/3/1 week).
 * 5s-PRO and other no-AMRAP schemes don't fire this trigger because
 * the set won't have `isAmrap: true`.
 */
const WK_TARGET_REPS: Record<1 | 2 | 3, number> = {
  1: 5,
  2: 3,
  3: 1,
};

const SMASH_THRESHOLD = 5; // reps over target that qualifies as "smashed"

/**
 * Inspect a freshly-saved set; if it's a main-lift AMRAP that beat
 * the week's target by ≥5 reps, fire the coach trigger. Returns
 * the chat id when fired, null otherwise. Fire-and-forget from the
 * save handler; failures are logged but don't break the save path.
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

    // Resolve the session to read the wendler week (and confirm it's
    // a regular 5/3/1 week — deload / 7th-week / unknown skip).
    const session = await db.sessions.get(set.sessionId);
    if (!session) return null;
    const wk = session.week;
    if (wk !== 1 && wk !== 2 && wk !== 3) return null;
    const target = WK_TARGET_REPS[wk];
    if (set.reps - target < SMASH_THRESHOLD) return null;

    // Resolve the movement name for the prompt headline.
    const movement = await db.movements.get(set.movementId);
    const movementName = movement?.name ?? 'main lift';

    // Idempotency: deterministic notification id keyed by session +
    // movement. If a trigger fired for this AMRAP already, skip.
    const notificationId = `amrap-bump:${set.sessionId}:${set.movementId}`;
    const existing = await db.notifications.get(notificationId);
    if (existing) return null;

    const chatId = nanoid();
    const nowIso = new Date().toISOString();
    const repsOver = set.reps - target;
    const prompt = buildAmrapPrompt({
      movementName,
      reps: set.reps,
      target,
      tmKg: set.trainingMaxKgAtTime,
      weightKg: set.weightKg,
      week: wk,
      repsOver,
    });

    await db.chats.put({
      id: chatId,
      createdAt: nowIso,
      updatedAt: nowIso,
      title: `${movementName} AMRAP: ${set.reps} reps (+${repsOver}) — TM bump?`,
      messages: [],
      pendingAutoSend: prompt,
      // No new triggerKind variant needed; the title says it all.
      // Cast to keep types narrow without bloating the union now.
    });

    const notification: Notification = {
      id: notificationId,
      createdAt: nowIso,
      updatedAt: nowIso,
      channel: 'ai-action',
      severity: 'success',
      title: `${movementName} smashed — ${set.reps} reps vs ${target}+ target`,
      body: `Tap to see the coach's TM bump proposal.`,
      deepLink: {
        href: `/chat?id=${chatId}`,
        label: 'Open proposal',
      },
      context: {
        kind: 'amrap-bump',
        chatId,
        sessionId: set.sessionId,
        movementId: set.movementId,
        reps: set.reps,
        target,
        week: wk,
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

function buildAmrapPrompt(p: {
  movementName: string;
  reps: number;
  target: number;
  tmKg: number;
  weightKg: number;
  week: 1 | 2 | 3;
  repsOver: number;
}): string {
  return [
    `I just hit an AMRAP top set that beat the target by ${p.repsOver} reps. Worth a TM bump?`,
    ``,
    `**Movement:** ${p.movementName}`,
    `**Week:** ${p.week} (target ${p.target}+)`,
    `**AMRAP set:** ${p.weightKg} kg × ${p.reps} reps`,
    `**TM at time:** ${p.tmKg} kg`,
    ``,
    `Please:`,
    `1. Estimate my current e1RM from this set and compare to my stored TM.`,
    `2. If a bump is justified by Wendler's rules (and consistent with my recent training + fatigue + race calendar), emit a propose_edit chip with set_training_max for the new value. Use the standard Wendler bumps: +2.5kg for upper-body, +5kg for lower-body, unless my history suggests something more conservative or aggressive.`,
    `3. If NOT, explain why (recovery flag, race week, recent fatigue, etc.) and what I should do instead.`,
    ``,
    `Be specific and decisive — don't hedge. If you propose a bump, propose the number.`,
  ].join('\n');
}
