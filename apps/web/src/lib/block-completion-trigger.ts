'use client';

// block-completion-trigger.ts — proactive Coach chat fires when the
// user marks a block complete. Natural inflection point: time to
// review what just happened and propose the next block. The AI
// gets primed to:
//   - Recap the block (volume, AMRAP performance, fatigue trend).
//   - Surface notable PRs / red flags from the cycle.
//   - Propose the NEXT block via propose_edit if appropriate
//     (kind / mainScheme / supplemental template aligned with the
//     user's current TrainingProfile + upcoming race calendar).
//   - Schedule a check-in for the start of the next block.

import { nanoid } from 'nanoid';
import type { Notification, ProgramBlock } from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';

export async function maybeTriggerBlockCompleted(
  block: ProgramBlock,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const db = getDb();
    const notificationId = `block-completed:${block.id}`;
    const existing = await db.notifications.get(notificationId);
    if (existing) return null;

    const chatId = nanoid();
    const nowIso = now.toISOString();
    const blockLabel = `${block.name} (${block.kind})`;
    const supTemplate = block.supplementalTemplate ?? 'fsl';
    const scheme = block.mainScheme ?? 'classic-531';

    const prompt = [
      `I just marked **${blockLabel}** complete. Please debrief and propose what's next.`,
      ``,
      `**Block kind:** ${block.kind}${block.seventhWeekKind ? ` · ${block.seventhWeekKind}` : ''}`,
      `**Scheme:** ${scheme} · Supplemental: ${supTemplate}`,
      block.startedAt ? `**Started:** ${block.startedAt.slice(0, 10)}` : '',
      `**Completed:** ${nowIso.slice(0, 10)}`,
      ``,
      `Please:`,
      `1. **Debrief** — short recap of this cycle: AMRAP performance vs targets across the main lifts, tonnage trend, fatigue/recovery flags, any PRs.`,
      `2. **What worked / what didn't** — be honest. Don't whitewash. If the block was too aggressive or assistance volume was off, say so.`,
      `3. **Next block proposal** — based on my TrainingProfile, current TMs, recent training, and upcoming races, what should the next block look like? If a 7th-week (deload/TM-test/PR-test) is due per Wendler cadence, propose it. Otherwise propose the next Leader / Anchor with kind + scheme + supplemental.`,
      `4. **TM adjustments** — if any AMRAP smashes from this block warrant TM bumps that haven't already been logged, emit set_training_max propose_edit ops.`,
      `5. **Follow-up** — schedule a check-in at the start of the next block (Wk 1 Day 1) via schedule_followup with a prompt that picks up the thread.`,
      ``,
      `Be specific. If you propose a next block, give me the kind / scheme / supplemental and a one-line rationale.`,
    ]
      .filter((s) => s !== '')
      .join('\n');

    await db.chats.put({
      id: chatId,
      createdAt: nowIso,
      updatedAt: nowIso,
      title: `Block debrief: ${block.name}`,
      messages: [],
      pendingAutoSend: prompt,
    });

    const notification: Notification = {
      id: notificationId,
      createdAt: nowIso,
      updatedAt: nowIso,
      channel: 'ai-action',
      severity: 'success',
      title: `Block complete: ${block.name}`,
      body: `Tap to see the debrief + a proposal for what's next.`,
      deepLink: {
        href: `/chat?id=${chatId}`,
        label: 'Open debrief',
      },
      context: {
        kind: 'block-completed',
        chatId,
        blockId: block.id,
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
    console.warn('[block-completion-trigger] failed:', err);
    return null;
  }
}
