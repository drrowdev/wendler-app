'use client';

// injury-coach.ts — proactive AI hook that fires when an injury is
// logged via InjurySheet. Creates a new "Coach review" chat with a
// primed first user message (no need for the user to type anything),
// flags it for auto-send, and writes a notification linking to it.
//
// The actual AI call doesn't happen here — the /chat page picks up
// the `pendingAutoSend` marker on mount and fires the send through
// the existing useChat hook. Keeps this module fully synchronous and
// Dexie-only; no SSE parsing to maintain.
//
// The primed message is composed to give the AI ALL the context it
// needs in one shot: injury details, affected movements, an explicit
// list of what guidance the user wants (warmup additions, swaps,
// rehab principles, follow-up timing). The chat snapshot the API
// embeds in the system prompt covers the rest (active block, cardio
// plan, training history).
//
// Complements (does NOT replace) the existing InjurySheet flow that
// auto-applies per-movement substitutions; this layer adds the
// holistic "PA" coach view — warmup, rehab guidance, cardio
// adjustments, follow-up timeline.

import { nanoid } from 'nanoid';
import type {
  Injury,
  Movement,
  Notification,
} from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';

/**
 * Compose the primed first user message. Heavy on structure so the
 * AI emits a comprehensive plan instead of a brief acknowledgement.
 */
function buildInjuryPrompt(
  injury: Injury,
  affectedMovementNames: string[],
): string {
  const severityLabel = `${injury.severity}/5`;
  const movementsLine =
    affectedMovementNames.length > 0
      ? affectedMovementNames.join(', ')
      : 'none specified';
  return [
    `I just logged a new injury and need a coach review.`,
    ``,
    `**Injury:** ${injury.area}`,
    `**Severity:** ${severityLabel}`,
    `**Description:** ${injury.description || '(none)'}`,
    `**Affected movements:** ${movementsLine}`,
    ``,
    `Please act as my PA and put together a complete plan:`,
    ``,
    `1. **Warmup additions** — what mobility / activation drills should I add to every session until this resolves? Give specific movements with sets/reps/holds, not generic advice.`,
    `2. **Movement swaps** — review my current block's accessories and main lifts. Use \`propose_edit\` ops to swap anything that would aggravate this injury. Prefer movements I already have in my library.`,
    `3. **Cardio adjustments** — check my cardio plan. If any session would aggravate the injury (e.g. running with a hip issue), propose scoped substitutes via \`add_cardio_plan_slot\` / \`remove_cardio_plan_slot\` for the relevant block weeks.`,
    `4. **Rehab guidance** — pain thresholds I should respect (e.g. "stay below 3/10"), red flags that warrant seeing a physio, realistic timeline (days vs weeks).`,
    `5. **Follow-up cadence** — when should we check in next? Suggest 1-3 specific check-in points (e.g. "in 3 days reassess pain after Mon session"). I'll set reminders manually for now.`,
    ``,
    `Be specific and decisive — treat this as the start of a multi-session conversation. If you're unsure about something (e.g. exact mechanism of the injury), ASK rather than guess.`,
  ].join('\n');
}

/**
 * Auto-create a coach-review chat for a freshly-logged injury and
 * post a notification linking to it. Fire-and-forget from the
 * caller (InjurySheet); failures are logged but don't disrupt the
 * injury save path.
 *
 * Returns the new chat id on success, or null on failure.
 */
export async function triggerInjuryCoachReview(
  injury: Injury,
  allMovements: Movement[],
): Promise<string | null> {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const chatId = nanoid();
    const nameById = new Map(allMovements.map((m) => [m.id, m.name]));
    const affectedMovementNames = (injury.adjustments ?? [])
      .map((a) => nameById.get(a.movementId))
      .filter((n): n is string => typeof n === 'string');
    const prompt = buildInjuryPrompt(injury, affectedMovementNames);

    const title = `Coach review: ${injury.area} (${injury.severity}/5)`;
    await db.chats.put({
      id: chatId,
      createdAt: now,
      updatedAt: now,
      title: title.length <= 80 ? title : title.slice(0, 77) + '…',
      messages: [],
      pendingAutoSend: prompt,
      triggerKind: 'injury',
    });

    const notification: Notification = {
      id: `injury-coach:${injury.id}`,
      createdAt: now,
      updatedAt: now,
      channel: 'ai-action',
      severity: 'info',
      title: `Coach reviewing your ${injury.area} injury`,
      body: `Tap to see warmups, swaps, rehab guidance, and follow-up timing — the AI runs as soon as you open the chat.`,
      deepLink: {
        href: `/chat?id=${chatId}`,
        label: 'Open coach review',
      },
      context: {
        kind: 'chat-thread',
        chatId,
        injuryId: injury.id,
        source: 'injury-trigger',
      },
    };
    try {
      await db.notifications.put(notification);
    } catch {
      // Best-effort — the chat still exists in the conversation list
      // if the notification write fails.
    }

    kickSync();
    return chatId;
  } catch (err) {
    console.warn('[injury-coach] trigger failed:', err);
    return null;
  }
}
