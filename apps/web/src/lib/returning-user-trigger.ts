'use client';

// returning-user-trigger.ts — proactive Coach chat fires when the
// user re-opens the app after a multi-day gap. Catches the common
// "I was sick / traveling / busy" scenario where the daily brief
// cadence broke and the user needs a single catch-up.
//
// Detection: last app open (tracked via localStorage `wendler:lastOpenIso`)
// vs now. If gap >= GAP_DAYS, fire. Updates the timestamp on every
// successful trigger or skip.
//
// Idempotent per calendar day: same `welcome-back:<YYYY-MM-DD>`
// notification id pattern as the daily brief.
//
// Skipped when:
//   - First-ever open (no prior timestamp) — too noisy on fresh install.
//   - Gap < GAP_DAYS (the daily brief covers this case).
//   - Today already has a welcome-back chat.

import { nanoid } from 'nanoid';
import type { Notification } from '@wendler/db-schema';
import { getDb } from './db';
import { kickSync } from './sync';

const LAST_OPEN_KEY = 'wendler:lastOpenIso';
const GAP_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function todayYmd(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Update the last-open timestamp + maybe fire a welcome-back trigger.
 * Safe to call on every app mount.
 */
export async function maybeTriggerWelcomeBack(now: Date = new Date()): Promise<
  'created' | 'no-gap' | 'first-open' | 'exists' | 'disabled'
> {
  if (typeof window === 'undefined') return 'disabled';
  const nowIso = now.toISOString();
  const last = localStorage.getItem(LAST_OPEN_KEY);
  // Always update so future opens use a fresh anchor.
  localStorage.setItem(LAST_OPEN_KEY, nowIso);

  if (!last) return 'first-open';
  const lastDate = new Date(last);
  if (!Number.isFinite(lastDate.getTime())) return 'first-open';
  const gapDays = (now.getTime() - lastDate.getTime()) / MS_PER_DAY;
  if (gapDays < GAP_DAYS) return 'no-gap';

  try {
    const db = getDb();
    const settings = await db.settings.get('singleton');
    // Re-use the daily-brief opt-out — same proactive-notification
    // surface, same on/off toggle.
    if (settings?.dailyBriefEnabled === false) return 'disabled';

    const ymd = todayYmd(now);
    const notificationId = `welcome-back:${ymd}`;
    const existing = await db.notifications.get(notificationId);
    if (existing) return 'exists';

    const chatId = nanoid();
    const gapLabel = Math.round(gapDays);
    const prompt = [
      `Welcome me back — I haven't opened the app in ${gapLabel} day(s). Please write a short catch-up brief:`,
      ``,
      `1. **What changed while I was away** — sessions I missed vs scheduled, cardio (Strava-imported) that came in, any block / week boundary that crossed during the gap.`,
      `2. **Where I am now** — block, week, cursor position, what's nominally next.`,
      `3. **Reset the plan if needed** — if the missed sessions push me out of sync, propose specific reschedules / skips via propose_edit. If a missed week effectively means restarting from where I left off, say so explicitly.`,
      `4. **What to do today** — one concrete recommendation.`,
      ``,
      `Keep it tight — ≤200 words. End with one optional propose_edit if there's a clear action.`,
    ].join('\n');

    await db.chats.put({
      id: chatId,
      createdAt: nowIso,
      updatedAt: nowIso,
      title: `Welcome back · ${gapLabel}d gap`,
      messages: [],
      pendingAutoSend: prompt,
    });

    const notification: Notification = {
      id: notificationId,
      createdAt: nowIso,
      updatedAt: nowIso,
      channel: 'ai-action',
      severity: 'info',
      title: `Welcome back — ${gapLabel} day gap`,
      body: `Tap for a catch-up brief + reset proposal.`,
      deepLink: {
        href: `/chat?id=${chatId}`,
        label: 'Open catch-up',
      },
      context: {
        kind: 'welcome-back',
        chatId,
        gapDays: gapLabel,
        lastOpen: last,
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
    console.warn('[welcome-back] failed:', err);
    return 'disabled';
  }
}
