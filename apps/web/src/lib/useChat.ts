'use client';

// useChat — Dexie-backed hook that owns a single conversation thread, sends
// new user messages to /api/chat (SSE-streaming), and persists the result.
// The drawer + the full-screen route both consume this hook. State lives in
// Dexie so the conversation survives reloads and syncs across devices via
// the LWW pipeline (see sync.ts → chat kind).

import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import type { Chat, ChatAction, ChatMessage } from '@wendler/db-schema';
import {
  buildChatContext,
  renderChatContextAsText,
  resolveDayAssistance,
  resolveDayWeekday,
  type MinimalChatCardio,
  type MinimalChatRace,
  type MinimalChatRecovery,
  type MinimalChatSet,
  type MinimalChatTrainingMax,
  type WendlerWeek,
  effectiveAssistanceVolumeForPhase,
  effectiveTrainingPhaseInfo,
} from '@wendler/domain';
import { getDb } from './db';
import { kickSync } from './sync';
import { authFetch } from './auth';

/**
 * Read the user's active movement-exclusion labels — same values the
 * chat send-path pushes to the API. Exposed so the snapshot inspector
 * can show them alongside the snapshot text.
 */
export async function readActiveExclusions(): Promise<string[]> {
  const settings = await getDb().settings.get('singleton');
  const constraints = settings?.trainingProfile?.constraints ?? [];
  return constraints
    .filter((c) => c.active !== false)
    .map((c) => c.label.trim())
    .filter((s) => s.length > 0);
}

export interface SendOptions {
  /** Path the user was on when invoking the chat (for context). */
  contextPath?: string;
}

/** Live conversation read straight from Dexie (or null when not yet created). */
export function useChat(id: string | null): Chat | null | undefined {
  return useLiveQuery(async () => {
    if (!id) return null;
    return (await getDb().chats.get(id)) ?? null;
  }, [id]);
}

/** Listing of all conversations, newest first, for the drawer history view. */
export function useChatList(): Chat[] | undefined {
  return useLiveQuery(async () => {
    const all = await getDb().chats.toArray();
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
}

/**
 * Build the exact text snapshot the chat orchestrator receives on
 * every send. Exposed (not just private) so the snapshot-inspector
 * debug UI can render it verbatim — what the AI sees is what we show.
 */
export async function buildContextBlob(): Promise<string> {
  const db = getDb();
  const [sets, cardio, recovery, races, tms, settings, movements, blocks, sessions, schedule, cardioPlan, memories] =
    await Promise.all([
      db.sets.toArray(),
      db.cardio.toArray(),
      db.recovery.toArray(),
      db.races.toArray(),
      db.trainingMaxes.toArray(),
      db.settings.get('singleton'),
      db.movements.toArray(),
      db.blocks.toArray(),
      db.sessions.toArray(),
      db.schedule.get('singleton'),
      db.cardioPlan.get('singleton'),
      db.aiMemories.toArray(),
    ]);
  const movementName = new Map(movements.map((m) => [m.id, m.name]));
  const summary = buildChatContext({
    now: new Date(),
    sets: sets as MinimalChatSet[],
    cardio: cardio as MinimalChatCardio[],
    recovery: recovery as MinimalChatRecovery[],
    races: races as MinimalChatRace[],
    trainingMaxes: tms as MinimalChatTrainingMax[],
    profile: settings?.trainingProfile,
    movementName,
  });
  const baseText = renderChatContextAsText(summary);

  // Append an "Active block plan" section so the chat agent knows what's
  // currently prescribed and can target specific days/movements with
  // substitute_movement / schedule_deload action chips. Surfaced as a
  // separate section so the existing snapshot rendering stays untouched.
  const activeBlock = blocks.find((b) => !b.completedAt);
  const lines: string[] = [];

  // "## Your trainer remembers" — persistent AI-curated memories.
  // Emitted FIRST so the AI sees its own prior conclusions about the
  // user before reasoning about anything else. Helps prevent the
  // assistant from re-proposing the same `remember` op every chat
  // (it has the existing memory list to check against).
  if (memories.length > 0) {
    lines.push('', '## Your trainer remembers');
    lines.push(
      `(${memories.length} memory rows. DO NOT propose a \`remember\` op duplicating any item here. Reference these in your reasoning when relevant.)`,
    );
    const byCategory = new Map<string, typeof memories>();
    for (const m of memories) {
      const arr = byCategory.get(m.category) ?? [];
      arr.push(m);
      byCategory.set(m.category, arr);
    }
    const ORDER: Array<'preference' | 'fact' | 'goal' | 'constraint' | 'context'> = [
      'preference',
      'fact',
      'goal',
      'constraint',
      'context',
    ];
    for (const cat of ORDER) {
      const rows = byCategory.get(cat);
      if (!rows || rows.length === 0) continue;
      lines.push(`- **${cat}**:`);
      for (const m of rows) {
        lines.push(`  - ${m.text} (id=\`${m.id.slice(0, 8)}\`)`);
      }
    }
  }

  // Cardio plan section is independent of having an active block — emit
  // first so a chat-only flow (Q&A about cardio without an active block)
  // still gets the data.
  if (cardioPlan && Array.isArray(cardioPlan.slots) && cardioPlan.slots.length > 0) {
    lines.push('', '## Cardio plan');
    lines.push(
      `(${cardioPlan.slots.length} recurring slot(s). Match key for remove_cardio_plan_slot is (dayOfWeek, modality).)`,
    );
    const WEEKDAY_NAMES_FULL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const blockNameById = new Map<string, string>();
    for (const b of blocks) blockNameById.set(b.id, b.name);
    for (const s of cardioPlan.slots) {
      const day = WEEKDAY_NAMES_FULL[s.dayOfWeek] ?? `Day ${s.dayOfWeek}`;
      const dur = s.durationMin !== undefined ? ` · ${s.durationMin} min` : '';
      // Scope: prefer week-semantic appliesToWeeks (the canonical source);
      // fall back to the static effectiveFrom/Until cache for legacy slots.
      let scope = 'every week';
      if (s.appliesToWeeks && s.appliesToWeeks.length > 0 && s.linkedBlockId) {
        const weekLabels = s.appliesToWeeks
          .map((w) => (w === 'deload' ? 'Deload' : w === '7w' ? '7w' : `Wk ${w}`))
          .join('/');
        const linkName = blockNameById.get(s.linkedBlockId) ?? s.linkedBlockId;
        scope = `${weekLabels} of ${linkName}`;
      } else if (s.effectiveFrom || s.effectiveUntil) {
        scope = `${s.effectiveFrom ?? '…'} → ${s.effectiveUntil ?? '…'}`;
      }
      const notes = s.notes ? ` · "${s.notes}"` : '';
      lines.push(
        `  - ${day}: ${s.modality} · ${s.kind}${dur} — active during ${scope}${notes}`,
      );
    }
  }

  if (!activeBlock) return baseText + (lines.length > 0 ? '\n' + lines.join('\n') : '');

  lines.push('', '## Active block plan');
  lines.push(`- Block: ${activeBlock.name} (id=\`${activeBlock.id}\`)`);
  lines.push(
    `- Kind: ${activeBlock.kind}${activeBlock.seventhWeekKind ? ` · ${activeBlock.seventhWeekKind}` : ''}`,
  );

  // Volume preset — stored AND effective (after phase auto-shift).
  // Critical for AI reasoning about set_block_volume_preset chips: if the
  // effective preset is ALREADY at the target, suggesting the chip is a
  // no-op and the AI should skip it.
  const phaseInfo = settings?.trainingProfile
    ? effectiveTrainingPhaseInfo(
        settings.trainingProfile,
        races,
        new Date(),
        {
          kind: activeBlock.kind,
          ...(activeBlock.seventhWeekKind
            ? { seventhWeekKind: activeBlock.seventhWeekKind }
            : {}),
          // Plumb the visible cursor week so the deload-week of a
          // Leader/Anchor with `includesDeload: true` auto-derives
          // phase = 'deload' (matches what the user sees in the app).
          ...(schedule?.cursor?.blockId === activeBlock.id
            ? { cursorWeek: schedule.cursor.week }
            : {}),
        },
      )
    : { phase: 'normal' as const, source: 'manual' as const };
  if (activeBlock.assistanceVolume) {
    const stored =
      typeof activeBlock.assistanceVolume === 'string'
        ? activeBlock.assistanceVolume
        : 'custom';
    const effective =
      typeof activeBlock.assistanceVolume === 'string'
        ? effectiveAssistanceVolumeForPhase(activeBlock.assistanceVolume, phaseInfo.phase)
        : 'custom';
    if (stored === effective) {
      lines.push(`- Assistance volume preset: ${stored}`);
    } else {
      lines.push(
        `- Assistance volume preset: stored=${stored} → EFFECTIVE=${effective} (auto-shifted because phase=\`${phaseInfo.phase}\` from \`${phaseInfo.source}\`). Future assistance generations will use the effective preset; do NOT recommend set_block_volume_preset chips that match the effective value.`,
      );
    }
  }

  // Per-week completion snapshot. Lets the AI reason about whether a
  // proposed change (preset shift, volume tweak, substitution) would
  // actually take effect this week or only future weeks. A week is
  // "complete" when every day in the rotation has a session row with
  // workoutCompletedAt set.
  const blockSessions = sessions.filter((s) => s.blockId === activeBlock.id);
  const days = activeBlock.plan?.days ?? [];
  const dayCount = Math.max(1, days.length);
  const weekScopes: Array<'1' | '2' | '3' | 'deload' | '7w'> = (() => {
    if (activeBlock.kind === 'seventh-week') return ['7w'];
    return ['1', '2', '3', 'deload'];
  })();
  const weekStatus: string[] = [];
  for (const wk of weekScopes) {
    const target = wk === 'deload' ? 'deload' : wk === '7w' ? '7w' : Number(wk);
    const inWeek = blockSessions.filter((s) => s.week === target);
    const completedDays = new Set(
      inWeek.filter((s) => s.workoutCompletedAt).map((s) => s.dayIndex),
    ).size;
    const label =
      wk === 'deload' ? 'Deload week' : wk === '7w' ? '7th-week block' : `Week ${wk}`;
    if (completedDays >= dayCount) {
      weekStatus.push(`  - ${label}: COMPLETE (${completedDays}/${dayCount} days)`);
    } else if (completedDays > 0) {
      weekStatus.push(`  - ${label}: in progress (${completedDays}/${dayCount} days done)`);
    } else if (inWeek.length > 0) {
      weekStatus.push(`  - ${label}: started (no day fully complete yet)`);
    } else {
      weekStatus.push(`  - ${label}: not started`);
    }
  }
  if (weekStatus.length > 0) {
    lines.push('- Week completion:');
    lines.push(...weekStatus);
    lines.push(
      `  (Suggest assistance only re-generates UPCOMING weeks. Preset / volume chips do nothing for weeks already marked COMPLETE — do not propose them when only complete weeks would be affected.)`,
    );

    // Disambiguate "this week" vs. "next training week". The block's
    // Week N labels are training-cycle labels, not calendar weeks. A
    // user asking "next week" might mean (a) the next calendar week
    // (Monday after today) or (b) the next block week to be trained.
    // We surface both anchors so the AI can be precise.
    const today = new Date();
    const weekdayName = today.toLocaleDateString('en-US', { weekday: 'long' });
    const todayYmd = (() => {
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, '0');
      const d = String(today.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    })();
    const cursorWeek = schedule?.cursor?.blockId === activeBlock.id
      ? schedule.cursor.week
      : undefined;
    const cursorLabel = cursorWeek === 'deload'
      ? 'Deload week'
      : cursorWeek === '7w'
        ? '7th-week block'
        : cursorWeek !== undefined
          ? `Week ${cursorWeek}`
          : undefined;
    lines.push(
      `- TODAY: ${todayYmd} (${weekdayName}). The next-scheduled training session sits in ${cursorLabel ?? '(cursor not set — infer from week completion above)'}. When the user says "this week" or "next week" without qualifying it, ASK which one they mean (calendar week vs. block week) before assuming — these often disagree by 1–2 days.`,
    );
  }
  if (days.length > 0) {
    lines.push('- Days:');
    const plan = activeBlock.plan!;
    // Helper to convert the local '1'|'2'|'3'|'deload'|'7w' string into
    // the canonical WendlerWeek (number for 1/2/3) the domain uses.
    const toWendlerWeek = (wk: '1' | '2' | '3' | 'deload' | '7w'): WendlerWeek =>
      wk === 'deload' || wk === '7w' ? wk : (Number(wk) as 1 | 2 | 3);
    days.forEach((day, i) => {
      // Resolve the EFFECTIVE assistance for each week of the block.
      // This is what /program/block actually shows and what would run
      // in any given week. We use resolveDayAssistance so per-week
      // overrides (the editor's only write target) are honoured —
      // reading day.assistance directly here would show the BASE only
      // and silently lose every manual edit the user made in /program/
      // block. That used to happen pre-v421 and produced 'stale
      // snapshot' bugs that looked like AI hallucinations.
      const perWeek = weekScopes.map((wk) => ({
        wk,
        entries: resolveDayAssistance(plan, toWendlerWeek(wk), day.id),
      }));
      const anyHasEntries = perWeek.some((w) => w.entries.length > 0);
      const maxCount = Math.max(0, ...perWeek.map((w) => w.entries.length));
      const mainPart =
        day.mainLifts.length > 0
          ? ` · main lifts: ${day.mainLifts.join(', ')}`
          : anyHasEntries
            ? ` · accessory-only day (no main lifts, up to ${maxCount} assistance movements per week — listed per-week below)`
            : ' · EMPTY (no main lifts and no assistance scheduled in any week)';
      // Resolve the day's weekday. Source-of-truth priority:
      //   1. Explicit `block.plan.days[i].weekday` (per-block override).
      //   2. `schedule.dayGroups[i].weekday` (program-wide default, which
      //      is where the /program/block setup dropdown saves the user's
      //      "Day 3 is Friday" choice — see ProgramDefaultsPanel).
      //   3. Parse the label ("Monday", "Thu" …) via resolveDayWeekday.
      // Emit a human-readable weekday name in the header so the AI never
      // has to ASK the user which day a given Day N falls on.
      const scheduleDayGroups = Array.isArray(schedule?.dayGroups)
        ? (schedule!.dayGroups as Array<{ weekday?: number } | unknown>)
        : [];
      const scheduleDayGroup = scheduleDayGroups[i] as
        | { weekday?: number }
        | undefined;
      const weekdayNumeric = resolveDayWeekday({
        weekday:
          (typeof day.weekday === 'number' ? day.weekday : undefined) ??
          (typeof scheduleDayGroup?.weekday === 'number'
            ? scheduleDayGroup.weekday
            : undefined),
        label: day.label,
      });
      const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const weekdayPart =
        typeof weekdayNumeric === 'number'
          ? ` · scheduled on ${WEEKDAY_NAMES[weekdayNumeric]} (weekday=${weekdayNumeric})`
          : ' · scheduled weekday: not set';
      const dayHeader = `  - Day ${i + 1}${day.label ? ` "${day.label}"` : ''} (id=\`${day.id}\`)${weekdayPart}${mainPart}`;
      lines.push(dayHeader);

      // Skip-status block (unchanged).
      const skipOverrides = activeBlock.plan?.dayOverridesByWeek ?? {};
      const skippedIn: string[] = [];
      for (const wk of weekScopes) {
        if (skipOverrides[`${wk}|${day.id}`]?.skipped === true) {
          const skipNote = skipOverrides[`${wk}|${day.id}`]?.skipNote;
          const skipReason = skipOverrides[`${wk}|${day.id}`]?.skipReason;
          const label = wk === 'deload' ? 'Deload' : wk === '7w' ? '7w' : `Wk ${wk}`;
          const tail =
            skipReason || skipNote
              ? ` (${[skipReason, skipNote].filter(Boolean).join(': ')})`
              : '';
          skippedIn.push(`${label}${tail}`);
        }
      }
      if (skippedIn.length > 0) {
        lines.push(`    - SKIPPED in: ${skippedIn.join(' · ')}`);
      }

      // Render per-week assistance. Collapse weeks with identical
      // resolved entries into a single 'All weeks' line — common when
      // there are no overrides — so the snapshot stays lean. When
      // weeks differ (user has manual overrides for some weeks), list
      // each week explicitly so the AI sees exactly what's scheduled
      // where.
      const fingerprint = (entries: typeof perWeek[number]['entries']) =>
        entries
          .map(
            (e) =>
              `${e.id}|${e.movementId ?? ''}|${e.movementName}|${e.category}|${e.sets}×${e.reps}${e.repsMax != null ? '-' + e.repsMax : ''}${e.isAmrap ? '+' : ''}${e.unit === 'sec' ? 'sec' : ''}`,
          )
          .join('::');
      const uniqueFingerprints = new Set(perWeek.map((w) => fingerprint(w.entries)));
      const renderEntries = (
        entries: typeof perWeek[number]['entries'],
        weekLabel: string,
      ) => {
        if (entries.length === 0) {
          lines.push(`    ${weekLabel}: (no assistance scheduled for this week)`);
          return;
        }
        lines.push(`    ${weekLabel}:`);
        for (const entry of entries) {
          const mid = entry.movementId ?? '(no movement id)';
          const reps =
            entry.repsMax != null
              ? `${entry.reps}-${entry.repsMax}`
              : String(entry.reps);
          const amrap = entry.isAmrap ? '+' : '';
          // entryId is the per-week-resolved id; trim/remove/swap ops
          // must reference THIS id to target the correct row in the
          // override / base map.
          lines.push(
            `      - ${entry.category}: ${entry.movementName} (entryId=\`${entry.id}\`, movementId=\`${mid}\`) — ${entry.sets}×${reps}${amrap}${entry.unit === 'sec' ? ' sec' : ''}`,
          );
        }
      };
      if (uniqueFingerprints.size <= 1) {
        // Every week resolves to the same set of entries → collapse.
        const labels = weekScopes
          .map((wk) => (wk === 'deload' ? 'Deload' : wk === '7w' ? '7w' : `Wk ${wk}`))
          .join(', ');
        renderEntries(perWeek[0]?.entries ?? [], `All weeks (${labels})`);
      } else {
        // Weeks diverge → list each.
        for (const { wk, entries } of perWeek) {
          const label = wk === 'deload' ? 'Deload' : wk === '7w' ? '7w' : `Wk ${wk}`;
          renderEntries(entries, label);
        }
      }
    });
  }

  // Movement library — every entry the AI can reference by movementId.
  // Used by:
  //   - add_assistance_entry  — movementId MUST exist in this list (or be
  //                             a tmp:<slug> reference to a sibling
  //                             add_movement_to_library op).
  //   - swap_assistance_movement — newMovementId MUST exist here.
  //   - add_movement_to_library — the AI's dedup self-check should scan
  //                               this list BEFORE proposing a new entry.
  // Compact format keeps the prompt token cost down; the AI only needs
  // enough metadata to (a) pick the right movementId for a chained op
  // and (b) detect "this already exists, don't propose a duplicate".
  if (movements.length > 0) {
    lines.push('', '## Movement library');
    lines.push(
      `(${movements.length} movements. When proposing add_movement_to_library, scan THIS list first and skip the op if any entry already matches by name OR by pattern + primary muscles overlap.)`,
    );
    const sorted = [...movements].sort((a, b) => {
      if (a.pattern !== b.pattern) return a.pattern.localeCompare(b.pattern);
      return a.name.localeCompare(b.name);
    });
    for (const m of sorted) {
      const primary = m.primaryMuscles.join('+') || '—';
      const tags: string[] = [];
      if (m.isCompound) tags.push('compound');
      if (m.isCustom) tags.push('custom');
      if (m.externallyLoadable) tags.push('loadable');
      const tagSuffix = tags.length > 0 ? `, ${tags.join('+')}` : '';
      lines.push(
        `  - ${m.name} (id=\`${m.id}\`; ${m.pattern}; ${primary}; ${m.equipment}${tagSuffix})`,
      );
    }
  }

  return baseText + '\n' + lines.join('\n');
}

function titleFromFirstMessage(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? 'New chat';
  return firstLine.length <= 80 ? firstLine : firstLine.slice(0, 77) + '…';
}

export interface ToolCallStatus {
  /** Anthropic tool_use id — stable for the duration of the turn. */
  id: string;
  /** Tool name as registered (e.g. "consult_coach"). */
  name: string;
  /** When the dispatch started (perf.now-style ms timestamp). */
  startedAtMs: number;
  /** When the dispatch finished. Undefined while still in flight. */
  endedAtMs?: number;
  /** Tokens consumed by the specialist call. Undefined while in flight. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * High-level phase of the current send. Useful for picking the right
 * "what is the assistant doing right now?" loading message in the UI.
 *
 *   - `idle`        : nothing in flight
 *   - `thinking`    : Claude is generating its first response chunk
 *                     (before any tool use or final text)
 *   - `consulting`  : at least one tool dispatch is in flight
 *   - `composing`   : tools have completed; waiting for Claude's final
 *                     iteration to start streaming text
 *   - `streaming`   : final text deltas are arriving
 */
export type ChatTurnPhase =
  | 'idle'
  | 'thinking'
  | 'consulting'
  | 'composing'
  | 'streaming';

export interface UseChatSender {
  send: (content: string, opts?: SendOptions) => Promise<string>;
  /** Conversation id (existing or newly minted on first send). */
  id: string | null;
  sending: boolean;
  /** In-progress streaming text (assistant turn being received). */
  streaming: string;
  /** Tool calls dispatched during the current turn (most-recent last). Cleared between turns. */
  toolCalls: ToolCallStatus[];
  /** High-level phase of the current turn for UI loading messages. */
  phase: ChatTurnPhase;
  error: string | null;
}

/**
 * useChatSender — handles new-message submission with SSE streaming. Splits
 * from `useChat` so the drawer can render the live conversation while a
 * response streams in. The pre-final assistant text is exposed as
 * `streaming` and rendered as a pending bubble by the panel.
 */
export function useChatSender(externalId: string | null): UseChatSender {
  const [id, setId] = useState<string | null>(externalId);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCallStatus[]>([]);
  const [phase, setPhase] = useState<ChatTurnPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  // Keep internal id in sync when the parent switches conversations
  // (e.g. user clicks "New chat" → externalId becomes null). Without this,
  // the sender would keep appending to the previous conversation. We skip
  // mid-send to avoid clobbering an in-flight request.
  useEffect(() => {
    if (!sending) setId(externalId);
  }, [externalId, sending]);

  const send = useCallback(
    async (content: string, opts: SendOptions = {}): Promise<string> => {
      if (sending) throw new Error('Already sending');
      const trimmed = content.trim();
      if (!trimmed) throw new Error('Empty message');
      setError(null);
      setSending(true);
      setStreaming('');
      setToolCalls([]);
      setPhase('thinking');
      try {
        const db = getDb();
        const now = new Date().toISOString();
        const userMsg: ChatMessage = {
          id: nanoid(),
          role: 'user',
          content: trimmed,
          createdAt: now,
          ...(opts.contextPath ? { contextPath: opts.contextPath } : {}),
        };
        let chatId = id;
        let existing: Chat | undefined;
        if (chatId) {
          existing = await db.chats.get(chatId);
        }
        const messagesSoFar: ChatMessage[] = existing
          ? [...existing.messages, userMsg]
          : [userMsg];
        const chatRow: Chat = existing
          ? { ...existing, messages: messagesSoFar, updatedAt: now }
          : {
              id: chatId ?? nanoid(),
              createdAt: now,
              updatedAt: now,
              title: titleFromFirstMessage(trimmed),
              messages: messagesSoFar,
            };
        chatId = chatRow.id;
        if (!id) setId(chatId);
        await db.chats.put(chatRow);
        kickSync();

        const contextBlob = await buildContextBlob();

        // Active hard-exclusion filter labels from the user's training
        // profile. Server-side propose_edit parser rejects ops that
        // introduce a movement whose name matches any of these
        // (substring, case-insensitive after stripping "no "). The
        // snapshot also lists them inline so the model SEES them, but
        // this is the durable backstop in case the model anchors on a
        // prior turn's reply.
        const activeExclusions = await readActiveExclusions();

        // Today's date in the user's local timezone (YYYY-MM-DD). The API
        // injects this verbatim into the system prompt so the model can
        // reason about "race in N weeks" without guessing.
        const todayLocal = (() => {
          const d = new Date();
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return `${y}-${m}-${day}`;
        })();

        const resp = await authFetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            context: contextBlob,
            contextPath: opts.contextPath,
            todayLocal,
            ...(activeExclusions.length > 0 ? { activeExclusions } : {}),
            messages: messagesSoFar.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        if (!resp.ok || !resp.body) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string; detail?: string };
          throw new Error(body.detail ?? body.error ?? `HTTP ${resp.status}`);
        }

        // Parse the SSE stream. Each event is `data: {json}\n\n`. We
        // accumulate `delta` events into `accumulated`, mirror to local
        // `streaming` for live render, and finalize on `done`.
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let accumulatedActions: ChatAction[] = [];
        let streamErr: string | null = null;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Split on the SSE event delimiter; keep partial trailing data
          // in the buffer for the next iteration.
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const eventBlock = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = eventBlock
              .split('\n')
              .find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json) continue;
            try {
              const evt = JSON.parse(json) as
                | { type: 'delta'; text: string }
                | { type: 'done'; modelInfo: unknown }
                | { type: 'error'; detail: string }
                | { type: 'tool_use_start'; id: string; name: string }
                | {
                    type: 'tool_use_end';
                    id: string;
                    name: string;
                    durationMs: number;
                    inputTokens: number;
                    outputTokens: number;
                  }
                | { type: 'composing_start' }
                | { type: 'action_chips'; actions: ChatAction[] };
              if (evt.type === 'delta') {
                accumulated += evt.text;
                setStreaming(accumulated);
                setPhase('streaming');
              } else if (evt.type === 'error') {
                streamErr = evt.detail;
              } else if (evt.type === 'action_chips') {
                accumulatedActions = evt.actions;
              } else if (evt.type === 'tool_use_start') {
                setToolCalls((prev) => [
                  ...prev,
                  {
                    id: evt.id,
                    name: evt.name,
                    startedAtMs: Date.now(),
                  },
                ]);
                setPhase('consulting');
              } else if (evt.type === 'tool_use_end') {
                setToolCalls((prev) =>
                  prev.map((tc) =>
                    tc.id === evt.id
                      ? {
                          ...tc,
                          endedAtMs: Date.now(),
                          inputTokens: evt.inputTokens,
                          outputTokens: evt.outputTokens,
                        }
                      : tc,
                  ),
                );
              } else if (evt.type === 'composing_start') {
                setPhase('composing');
              }
            } catch {
              // Tolerate keep-alives or malformed lines without aborting.
            }
          }
        }
        if (streamErr) throw new Error(streamErr);
        if (!accumulated.trim()) throw new Error('Empty response from model');

        const replyTs = new Date().toISOString();
        const assistantMsg: ChatMessage = {
          id: nanoid(),
          role: 'assistant',
          content: accumulated,
          createdAt: replyTs,
          ...(accumulatedActions.length > 0 ? { actions: accumulatedActions } : {}),
        };
        const finalMessages = [...messagesSoFar, assistantMsg];
        await db.chats.put({
          ...chatRow,
          messages: finalMessages,
          updatedAt: replyTs,
        });
        kickSync();
        return chatId;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setSending(false);
        setStreaming('');
        setPhase('idle');
      }
    },
    [id, sending],
  );

  return { send, id, sending, streaming, toolCalls, phase, error };
}

/** Rename a chat conversation. */
export async function renameChat(id: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  const db = getDb();
  const row = await db.chats.get(id);
  if (!row) return;
  await db.chats.put({
    ...row,
    title: trimmed.length <= 80 ? trimmed : trimmed.slice(0, 77) + '…',
    updatedAt: new Date().toISOString(),
  });
  kickSync();
}

/** Delete a chat conversation. */
export async function deleteChat(id: string): Promise<void> {
  const { deleteWithTombstones } = await import('./delete');
  await deleteWithTombstones('chat', [id]);
}
