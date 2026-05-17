'use client';

// race-trigger.ts — proactive Coach chat fires when the user adds an
// A/B-priority race within 12 weeks. The AI sees the new race in the
// snapshot and gets asked to draft a taper plan:
//   - Whether the current block needs to end early / get re-scoped.
//   - When to insert a deload block (schedule_deload op).
//   - Cardio plan tweaks leading into race week.
//   - Race-week movement swaps (avoid high-CNS / new exercises).
//   - Follow-up check-ins (4w out, race week, post-race).
//
// Same pendingAutoSend pattern as v447 / v450 / v454. Idempotent per
// raceId so re-saving the race (e.g. editing target time) doesn't
// double-fire.

import { nanoid } from 'nanoid';
import type { Notification, Race } from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';

const TRIGGER_WINDOW_WEEKS = 12;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Inspect a freshly-added race; if it's A/B priority within the next
 * `TRIGGER_WINDOW_WEEKS`, fire the Coach chat. Returns the chat id on
 * fire, null otherwise. Idempotent per raceId.
 */
export async function maybeTriggerRaceTaper(
  race: Race,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    if (race.priority !== 'A' && race.priority !== 'B') return null;
    if (race.completedAt) return null;
    if (race.result?.finishTimeSec != null) return null;

    const raceDate = new Date(race.date);
    if (!Number.isFinite(raceDate.getTime())) return null;
    const weeksOut = (raceDate.getTime() - now.getTime()) / MS_PER_WEEK;
    if (weeksOut < 0 || weeksOut > TRIGGER_WINDOW_WEEKS) return null;

    const db = getDb();
    const notificationId = `race-taper:${race.id}`;
    const existing = await db.notifications.get(notificationId);
    if (existing) return null;

    const chatId = nanoid();
    const nowIso = now.toISOString();
    const weeksLabel = Math.max(1, Math.round(weeksOut));
    const distanceLabel = race.distanceKm
      ? `${race.distanceKm} km`
      : race.kind;
    const targetLabel = race.targetTimeSec
      ? ` target ${formatSec(race.targetTimeSec)}`
      : '';

    const prompt = [
      `I just added a new race. Please draft a complete taper / race-prep plan.`,
      ``,
      `**Race:** ${race.name}`,
      `**Date:** ${race.date.slice(0, 10)} (${weeksLabel} week(s) out)`,
      `**Priority:** ${race.priority}`,
      `**Kind:** ${distanceLabel}${targetLabel}`,
      race.notes ? `**My notes:** ${race.notes}` : '',
      ``,
      `Please:`,
      `1. **Block review** — look at my current block. Should it run to completion, end early, or get re-scoped? If a deload should be inserted at a specific week, emit a schedule_deload propose_edit op.`,
      `2. **Cardio plan** — review my recurring cardio slots. Propose add/remove_cardio_plan_slot ops for any sessions that should change leading into race week (e.g. a long-run shift, a quality-day cut). Use appliesToWeeks for proper scoping.`,
      `3. **Race-week movement swaps** — if any current block accessory is risky for race week (high-CNS, novel, fatiguing), propose swap_assistance_movement.`,
      `4. **Strength volume** — should the assistance volume preset shift? If yes, emit set_block_volume_preset.`,
      `5. **Follow-up cadence** — schedule 2-3 check-ins via schedule_followup chips: 4 weeks out, race week, post-race debrief. Use prompts that pick up the thread without re-asking the basics.`,
      `6. **Rehearsal / red flags** — plain-text guidance on race-week sleep, fueling, taper-mood pitfalls. Anything specific to this race kind.`,
      ``,
      `Be specific and decisive — if you're uncertain (e.g. recent fatigue signals), ask before guessing. Don't propose ops that wouldn't actually change anything (preset already matches, week already past).`,
    ]
      .filter((s) => s !== '')
      .join('\n');

    await db.chats.put({
      id: chatId,
      createdAt: nowIso,
      updatedAt: nowIso,
      title: `Race plan: ${race.name} (${weeksLabel}w out)`,
      messages: [],
      pendingAutoSend: prompt,
    });

    const notification: Notification = {
      id: notificationId,
      createdAt: nowIso,
      updatedAt: nowIso,
      channel: 'ai-action',
      severity: 'info',
      title: `Race added: ${race.name} — ${weeksLabel}w out`,
      body: `Tap to see the coach's taper plan + cardio adjustments + follow-up cadence.`,
      deepLink: {
        href: `/chat?id=${chatId}`,
        label: 'Open race plan',
      },
      context: {
        kind: 'race-taper',
        chatId,
        raceId: race.id,
        weeksOut: weeksLabel,
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
    console.warn('[race-trigger] failed:', err);
    return null;
  }
}

function formatSec(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
