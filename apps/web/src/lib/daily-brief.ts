'use client';

// daily-brief.ts — proactive "good morning, here's today" Coach
// brief. Runs lazily on app open. Idempotent per calendar day: at
// most one brief chat per day, even across multiple app opens and
// devices (via Dexie + LWW sync).
//
// Mirrors the injury-coach trigger pattern (v447): we create a chat
// with a primed first user message and a `pendingAutoSend` marker,
// post a notification, and let the chat page's existing auto-send
// effect fire the actual AI call when the user taps in. No
// background fetch / SSE wrangling.
//
// Why not real cron? A PWA can't reliably run background tasks
// across iOS Safari evictions, Android battery modes, and offline
// periods. The pragmatic answer is "compose on app open" — the
// brief is fresh every time the user actually engages, which is the
// only time they'd see it anyway.

import { nanoid } from 'nanoid';
import type { Chat, Notification } from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';

/**
 * Local YYYY-MM-DD for today. Uses the device's local timezone so
 * "today" matches the user's wall clock — not UTC.
 */
function todayYmd(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function chatIsForDay(chat: Chat, ymd: string): boolean {
  if (chat.triggerKind !== 'daily-brief') return false;
  return chat.createdAt.startsWith(ymd);
}

/**
 * Idempotently ensure a daily brief exists for today. Safe to call
 * on every app mount; the date-keyed gating prevents duplicates.
 *
 * Returns:
 *   - 'created' — a brand-new brief chat was created.
 *   - 'exists' — today's brief already exists; nothing changed.
 *   - 'disabled' — user has dailyBriefEnabled === false in settings.
 *   - 'too-early' — current local hour is before BRIEF_EARLIEST_HOUR
 *     (don't ping the user at 1am).
 */
export async function ensureDailyBrief(
  now: Date = new Date(),
): Promise<'created' | 'exists' | 'disabled' | 'too-early'> {
  const BRIEF_EARLIEST_HOUR = 5; // don't fire before 5am local
  const BRIEF_LATEST_HOUR = 23; // don't fire after 11pm local (avoids late-night ping)

  const hour = now.getHours();
  if (hour < BRIEF_EARLIEST_HOUR || hour >= BRIEF_LATEST_HOUR) return 'too-early';

  try {
    const db = getDb();
    const settings = await db.settings.get('singleton');
    // Default-on: undefined === true so a fresh user gets briefs
    // out of the box. They can flip it off in settings.
    if (settings?.dailyBriefEnabled === false) return 'disabled';

    const ymd = todayYmd(now);
    // Scan recent chats for an existing same-day brief. Limiting the
    // scan to the 50 most-recent keeps this cheap (briefs are recent
    // by definition).
    const recent = await db.chats
      .orderBy('createdAt')
      .reverse()
      .limit(50)
      .toArray();
    if (recent.some((c) => chatIsForDay(c, ymd))) return 'exists';

    const chatId = nanoid();
    const nowIso = now.toISOString();
    const prompt = buildDailyBriefPrompt(now);
    const title = `Daily brief · ${ymd}`;

    await db.chats.put({
      id: chatId,
      createdAt: nowIso,
      updatedAt: nowIso,
      title,
      messages: [],
      pendingAutoSend: prompt,
      triggerKind: 'daily-brief',
    });

    const notification: Notification = {
      id: `daily-brief:${ymd}`,
      createdAt: nowIso,
      updatedAt: nowIso,
      channel: 'ai-action',
      severity: 'info',
      title: `Your training brief for ${formatHumanDate(now)}`,
      body: `Today's session, recent load, what to focus on, anything to adjust.`,
      deepLink: {
        href: `/chat?id=${chatId}`,
        label: 'Open brief',
      },
      context: {
        kind: 'daily-brief',
        chatId,
        date: ymd,
      },
    };
    try {
      await db.notifications.put(notification);
    } catch {
      // Best-effort.
    }

    kickSync();
    return 'created';
  } catch (err) {
    console.warn('[daily-brief] ensure failed:', err);
    return 'too-early'; // soft-fail; try again next mount
  }
}

/**
 * Compose the primed user message. Structured to extract a focused
 * 4-section brief (today / week / load / heads-up) so the AI hits
 * the same shape every day — easy to scan, easy to tune.
 */
function buildDailyBriefPrompt(now: Date): string {
  const dateLine = formatHumanDate(now);
  return [
    `Good morning. Please write today's training brief in 4 sections, each ≤ 3 short bullets:`,
    ``,
    `**Today (${dateLine})**`,
    `- The session I have scheduled (or "rest day" if none).`,
    `- ONE thing to focus on for that session (specific cue, RPE target, or red flag from recent training).`,
    `- ETA in minutes if I have data to estimate.`,
    ``,
    `**This week**`,
    `- Where I am in the block (week, phase).`,
    `- Sessions remaining + any session most likely to slip.`,
    `- Race / event proximity if any A-race is within 6 weeks.`,
    ``,
    `**Recent load**`,
    `- Last 7 days: tonnage trend, cardio time-in-zones, any flags.`,
    `- Sleep / recovery if anything stands out from my entries.`,
    ``,
    `**Heads-up**`,
    `- Anything I should know that I might miss: deload coming, scheduled follow-ups due, taper week starting, an injury still active, a TM stale.`,
    ``,
    `Keep it tight — total ≤ 220 words. End with one optional propose_edit if there's a clear, valuable action I should accept (e.g. swap a movement, scope a cardio slot). No filler. If a section has nothing to say, write a single line and move on.`,
  ].join('\n');
}

function formatHumanDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}
