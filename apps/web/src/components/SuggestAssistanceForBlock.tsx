'use client';

// Phase 4 — block-level assistance suggester. Replaces the per-day
// SuggestAssistancePanel. One button at the top of the block editor calls
// Claude against the whole block and auto-applies picks across every day.
//
// Behavior:
//   - Click → AI runs (loading state with elapsed timer + skeleton rows)
//   - On success: picks are appended per day via onApply(); an undo banner
//     stays visible for ~10s.
//   - On validation failure: one automatic retry with a corrective follow-up.
//   - On hard failure (5xx, retry exhausted, network error): silently fall
//     back to the deterministic suggester and surface a small banner.
//   - PromptPreview disclosure (Phase 3a) is mounted alongside as a debug
//     affordance.

import { useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import {
  buildAssistancePrompt,
  buildSuggesterContext,
  evaluateGoalsForRules,
  resolveAssistanceVolume,
  sortAssistanceEntriesForDay,
  suggestAssistance,
  validateBlock,
  DEFAULT_GOAL_FLAGS,
  type AssistanceCategory,
  type AssistanceEntry,
  type BlockDay,
  type EquipmentType,
  type GoalFlavor as DomainGoalFlavor,
  type MovementPattern,
  type MuscleGroup,
  type RuleSlot,
  type SuggesterContext,
  type ValidatedDay,
  type WendlerWeek,
} from '@wendler/domain';
import type { Movement, ProgramBlock } from '@wendler/db-schema';
import { defaultFlavorsForKind } from '@wendler/db-schema';
import { authFetch } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { notify } from '@/lib/notify';
import { useGoals, usePrograms, useRunPlan, useSettings, useUpcomingRaces, useAllSessions, useCardioRecent } from '@/lib/hooks';
import { useVolumeRecommendation } from '@/lib/useVolumeRecommendation';
import { recordAiGeneration, markAiGenerationUndone } from '@/lib/aiGenerations';
import { PhaseAutoBadge } from '@/components/PhaseAutoBadge';

const SLOT_TO_CATEGORY: Record<RuleSlot, AssistanceCategory> = {
  push: 'push',
  pull: 'pull',
  'single-leg': 'single-leg',
  core: 'core',
  prehab: 'accessory',
  isolation: 'accessory',
  carry: 'other',
};

type AiNewMovement = {
  name: string;
  equipment: EquipmentType;
  pattern: MovementPattern;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles?: MuscleGroup[];
  isBodyweight?: boolean;
};

type AiPick = {
  slot: RuleSlot;
  movementId?: string;
  newMovement?: AiNewMovement;
  movementName: string;
  sets: number;
  reps: number;
  repsMax?: number;
  unit: 'reps' | 'sec';
  rationale: string;
};

type AiResponse =
  | {
      ok: true;
      data: {
        perDay: Array<{ dayIndex: number; isAccessoryDay: boolean; entries: AiPick[] }>;
        blockRationale: string[];
      };
      modelInfo?: { model: string; elapsedMs: number; inputTokens?: number; outputTokens?: number };
    }
  | {
      ok: false;
      errors: string[];
      raw: string;
      modelInfo?: { model: string; elapsedMs: number; inputTokens?: number; outputTokens?: number };
    };

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; startedAt: number }
  | {
      kind: 'applied';
      sourceLabel: string;
      pickCount: number;
      dayCount: number;
      blockRationale: string[];
      modelInfo?: { model: string; elapsedMs: number; inputTokens?: number; outputTokens?: number };
      undo: () => void;
      undoExpiresAt: number;
      usedFallback: boolean;
      fallbackReason?: string;
      validationWarnings: string[];
      /** Movements the LLM proposed and we just inserted into the library. */
      newMovementsAdded: { id: string; name: string }[];
    }
  | { kind: 'error'; message: string };

interface Props {
  block: ProgramBlock;
  days: BlockDay[];
  movements: Movement[];
  /** Current per-day assistance arrays in the same order as `days` (respects weekScope). */
  currentPerDayEntries: AssistanceEntry[][];
  /**
   * Which week scope the user is generating for. Threaded into the prompt
   * so the LLM sees the exact main-work prescription (sets × reps × %TM
   * + AMRAP) for the active week and can scale accessory volume to match.
   */
  weekScope: WendlerWeek;
  /**
   * Cross-week context: per-day entries from OTHER week scopes within the
   * same block. Passed verbatim to {@link buildAssistancePrompt}. Empty
   * array (or omitted) when there are no other scopes worth showing.
   */
  otherWeeksContext?: Array<{
    scopeLabel: string;
    perDay: AssistanceEntry[][];
  }>;
  /**
   * Apply picks atomically. The component appends new entries to whatever's
   * currently on each day (the AI was given existing entries in the prompt
   * so duplicates are unlikely). Returns an undo fn that restores the pre-
   * apply snapshot when called.
   */
  onApply: (perDay: Record<string, AssistanceEntry[]>) => () => void;
}

const UNDO_WINDOW_MS = 10_000;

export function SuggestAssistanceForBlock({
  block,
  days,
  movements,
  currentPerDayEntries,
  otherWeeksContext,
  weekScope,
  onApply,
}: Props) {
  const goals = useGoals();
  const upcomingRaces = useUpcomingRaces();
  const programs = usePrograms();
  const runPlan = useRunPlan();
  const settings = useSettings();
  const allSessions = useAllSessions();
  // Recent cardio drives the cardio-fatigue shift signal. 35 entries covers
  // the 7-day recent window + 28-day baseline comfortably (most users run
  // 3-6 cardio sessions/week, so 35 ≈ 6-10 weeks of history).
  const recentCardio = useCardioRecent(35);
  // Volume recommendation — when the user has not explicitly pinned a
  // preset on the block, this signals-driven preset becomes the default
  // budget the suggester generates against (instead of the hard-coded kind
  // default). Wired in v300; previously the recommendation was shown to
  // the user via BlockAssistanceVolumePanel but the LLM never saw it.
  const volumeRecommendation = useVolumeRecommendation(block);
  // First training day actually performed in this block. Used as the anchor
  // for per-week phase auto-derivation so that activating a block in advance
  // (or with a stale `startedAt`) doesn't skew the calendar windows the LLM
  // sees. Falls back to "now" at render time if no sessions are logged yet.
  const blockFirstSessionDate = useMemo(() => {
    if (!allSessions) return undefined;
    let earliest: string | undefined;
    for (const s of allSessions) {
      if (s.blockId !== block.id) continue;
      if (!s.performedAt) continue;
      if (!earliest || s.performedAt < earliest) earliest = s.performedAt;
    }
    return earliest;
  }, [allSessions, block.id]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Tracks whether the undo window is still open. The banner itself stays
  // visible until the user dismisses it manually, so the rationale is still
  // readable after the undo button disappears.
  const [undoExpired, setUndoExpired] = useState(false);
  // Raw JSON text of the last AI response (or local fallback) so the prompt
  // preview disclosure can show it for debugging. Cleared on a fresh
  // generation, persists in memory across status transitions so the user
  // can still inspect it after the undo banner is dismissed.
  const [lastAiResponseRaw, setLastAiResponseRaw] = useState<string | undefined>();

  // Reset the inline prompt+response disclosure (and any banner status)
  // when the user switches week tabs. Without this the previously-generated
  // week's prompt and response stay visible while the user is looking at a
  // different week, which is confusing.
  useEffect(() => {
    setLastAiResponseRaw(undefined);
    setStatus({ kind: 'idle' });
  }, [weekScope]);

  // Expire just the undo button once the window passes; keep the banner
  // (and its rationale) visible until the user dismisses it explicitly.
  useEffect(() => {
    if (status.kind !== 'applied') {
      setUndoExpired(false);
      return;
    }
    const remaining = status.undoExpiresAt - Date.now();
    if (remaining <= 0) {
      setUndoExpired(true);
      return;
    }
    setUndoExpired(false);
    const t = setTimeout(() => setUndoExpired(true), remaining);
    return () => clearTimeout(t);
  }, [status]);

  const promptInput = useMemo<SuggesterContext | undefined>(() => {
    if (!goals) return undefined;
    return buildSuggesterContext({
      block: {
        kind: block.kind,
        seventhWeekKind: block.seventhWeekKind,
        programId: block.programId,
        weeksBeforeDeload: block.weeksBeforeDeload,
        name: block.name,
        assistanceVolume: block.assistanceVolume,
        availableEquipment: block.availableEquipment,
      },
      days,
      movements,
      settings: settings
        ? {
            goalFlags: settings.goalFlags,
            goalNotes: settings.goalNotes,
            trainingProfile: settings.trainingProfile,
          }
        : undefined,
      programs,
      races: upcomingRaces,
      runPlan: runPlan ? { slots: runPlan.slots } : undefined,
      cardio: recentCardio,
      recommendedVolume: volumeRecommendation?.preset,
      goals,
      blockFirstSessionDate,
      weekScope,
      defaultFlavorsForKind,
    });
  }, [
    goals,
    upcomingRaces,
    programs,
    runPlan,
    recentCardio,
    volumeRecommendation,
    settings,
    block.assistanceVolume,
    block.kind,
    block.seventhWeekKind,
    block.programId,
    block.availableEquipment,
    block.name,
    block.weeksBeforeDeload,
    blockFirstSessionDate,
    weekScope,
    days,
    movements,
  ]);

  const builtPrompt = useMemo(() => {
    if (!promptInput) return undefined;
    return buildAssistancePrompt({
      volume: promptInput.volume,
      days: promptInput.days,
      movements: promptInput.movements,
      goalFlags: promptInput.goalFlags,
      goalNotes: promptInput.goalNotes,
      existingPerDayEntries: currentPerDayEntries,
      otherWeeksContext,
      activeGoalFlavors: promptInput.flatFlavors,
      cardioPeakActive: promptInput.cardioPeakActive,
      warmupCoversPrehab: false,
      availableEquipment: promptInput.availableEquipment,
      longRunDayIndices: promptInput.longRunDayIndices,
      blockLabel: promptInput.blockLabel,
      blockKind: promptInput.blockKind,
      phase: promptInput.phase,
      phasePresetShift: promptInput.phasePresetShift,
      trainingProfileContext: promptInput.trainingProfileContext,
      weekScope,
      mainScheme: block.mainScheme,
      seventhWeekKind: block.seventhWeekKind,
      suppressPhaseVolumeMultiplier: promptInput.suppressPhaseVolumeMultiplier,
      cardioFatigueShift: promptInput.cardioFatigueShift,
      cardioFatigue: promptInput.cardioFatigue,
    });
  }, [promptInput, currentPerDayEntries, otherWeeksContext, weekScope, block.mainScheme, block.seventhWeekKind]);

  const callAi = async (
    systemPrompt: string,
    userPrompt: string,
    movementIds: string[],
    availableEquipment: string[] | undefined,
    crossWeekUsedMovementIds: string[] | undefined,
    extraSystem?: string,
  ): Promise<AiResponse> => {
    const res = await authFetch('/api/suggestAssistance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        systemPrompt: extraSystem ? `${systemPrompt}\n\n${extraSystem}` : systemPrompt,
        userPrompt,
        movementIds,
        maxDayIndex: days.length - 1,
        availableEquipment,
        crossWeekUsedMovementIds,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
    // Capture the raw response text BEFORE parsing so the prompt-preview
    // disclosure can show exactly what the LLM returned (helpful for
    // debugging weird picks weeks later).
    const text = await res.text();
    setLastAiResponseRaw(text);
    return JSON.parse(text) as AiResponse;
  };

  const generate = async () => {
    if (!promptInput || !builtPrompt) return;

    // Pre-flight: which day indices already have entries? Those are
    // intentionally arranged by the user — "Fill-the-gaps" mode skips
    // them. If ALL days are filled, short-circuit before burning an API
    // call. (The LLM is also told to skip these days in the prompt;
    // this is the pre-flight + post-response defence in depth.)
    const filledDayIndices = new Set<number>();
    currentPerDayEntries.forEach((entries, i) => {
      if (entries && entries.length > 0) filledDayIndices.add(i);
    });
    if (filledDayIndices.size === days.length && days.length > 0) {
      setStatus({
        kind: 'error',
        message:
          'Every day already has assistance entries. Clear a day (or remove individual movements) to enable Suggest to fill the gaps.',
      });
      return;
    }

    setStatus({ kind: 'loading', startedAt: Date.now() });
    const movementIds = movements.map((m) => m.id);
    const availableEquipment = promptInput.availableEquipment;

    // MovementIds already used in OTHER weeks of this block — sent to the
    // server so the validator can reject responses that re-use them
    // (system rule 5: prefer same-family rotation across weeks).
    const crossWeekUsedMovementIds = (() => {
      const set = new Set<string>();
      for (const ctx of otherWeeksContext ?? []) {
        for (const entries of ctx.perDay) {
          if (!entries) continue;
          for (const e of entries) {
            if (e.movementId) set.add(e.movementId);
          }
        }
      }
      return set.size > 0 ? Array.from(set) : undefined;
    })();

    let response: AiResponse | undefined;
    let hardError: Error | undefined;

    try {
      response = await callAi(
        builtPrompt.systemPrompt,
        builtPrompt.userPrompt,
        movementIds,
        availableEquipment,
        crossWeekUsedMovementIds,
      );
      if (!response.ok) {
        // One corrective retry: tell Claude what went wrong.
        const corrective =
          'Your previous response failed validation with these errors: ' +
          response.errors.join('; ') +
          '. Return ONLY valid JSON matching the schema. No prose. No code fences.';
        try {
          response = await callAi(
            builtPrompt.systemPrompt,
            builtPrompt.userPrompt,
            movementIds,
            availableEquipment,
            crossWeekUsedMovementIds,
            corrective,
          );
        } catch (err) {
          hardError = err as Error;
        }
      }
    } catch (err) {
      hardError = err as Error;
    }

    if (hardError || !response || !response.ok) {
      // Auto-fallback to the deterministic suggester so the user still gets
      // a usable result. We surface a small banner so they know.
      const reason =
        hardError?.message ??
        (response && !response.ok
          ? `Schema validation failed after retry (${response.errors.join('; ')})`
          : 'Unknown AI error');
      applyDeterministicFallback(reason);
      return;
    }

    // Resolve novel movements: insert each unique newMovement into the
    // Dexie movements table (case-insensitive name dedup against the
    // existing library AND within this batch) so every entry written to
    // the block carries a real, library-backed movementId. e1RM history
    // works from the very first set, identical to seeded movements.
    const lowerNameToId = new Map<string, string>();
    for (const m of movements) lowerNameToId.set(m.name.trim().toLowerCase(), m.id);
    const newMovementsAdded: { id: string; name: string }[] = [];
    let novelResolveError: string | undefined;

    for (const dp of response.data.perDay) {
      for (const e of dp.entries) {
        if (e.movementId || !e.newMovement) continue;
        const key = e.newMovement.name.trim().toLowerCase();
        const existingId = lowerNameToId.get(key);
        if (existingId) {
          e.movementId = existingId;
          e.newMovement = undefined;
          continue;
        }
        const newId = `custom:${nanoid(8)}`;
        try {
          await getDb().movements.add({
            id: newId,
            name: e.newMovement.name.trim(),
            equipment: e.newMovement.equipment,
            pattern: e.newMovement.pattern,
            primaryMuscles: e.newMovement.primaryMuscles,
            secondaryMuscles: e.newMovement.secondaryMuscles ?? [],
            isCustom: true,
            // Novel LLM-proposed movements are accessory by default — they
            // can't be assigned as 5/3/1 main lifts without an explicit
            // user toggle in the movements editor.
            isCompound: false,
          });
        } catch (err) {
          novelResolveError = `Failed to add novel movement "${e.newMovement.name}": ${(err as Error).message}`;
          break;
        }
        lowerNameToId.set(key, newId);
        newMovementsAdded.push({ id: newId, name: e.newMovement.name.trim() });
        e.movementId = newId;
        e.newMovement = undefined;
      }
      if (novelResolveError) break;
    }

    if (novelResolveError) {
      applyDeterministicFallback(novelResolveError);
      return;
    }

    // Map AI per-day entries to AssistanceEntry shape, keyed by dayId.
    // After mapping, apply Wendler's canonical day-order: the matching main
    // category (push for bench/press, pull for deadlift, single-leg for
    // squat) lands first, with the rest of the entries flowing in default
    // order (push → pull → single-leg → core → accessory → other). Pure
    // and stable — preserves within-category order from the LLM.
    //
    // Fill-the-gaps defence: any day index in `filledDayIndices` is
    // dropped here regardless of what the LLM returned. The prompt asks
    // for `entries: []` on filled days, but this filter ensures correctness
    // even if the model ignored the directive.
    const perDay: Record<string, AssistanceEntry[]> = {};
    let totalPicks = 0;
    const skippedFilled: number[] = [];
    for (const dayPlan of response.data.perDay) {
      const day = days[dayPlan.dayIndex];
      if (!day) continue;
      if (filledDayIndices.has(dayPlan.dayIndex)) {
        // Don't append to days the user already arranged; record for the
        // banner so the user sees why they got fewer picks.
        if (dayPlan.entries.length > 0) skippedFilled.push(dayPlan.dayIndex);
        continue;
      }
      // Build entries AND a parallel slot map. The slot map lets
      // sortAssistanceEntriesForDay distinguish `prehab` from `isolation`
      // (both collapse to category `accessory` in AssistanceEntry), so
      // the guardrail can pull prehab to the end while preserving the
      // LLM's intra-day muscle-rotation ordering for everything else.
      const slotMap = new Map<string, RuleSlot>();
      const mapped = dayPlan.entries.map<AssistanceEntry>((e) => {
        const id = nanoid();
        slotMap.set(id, e.slot);
        return {
          id,
          category: SLOT_TO_CATEGORY[e.slot] ?? 'accessory',
          movementId: e.movementId!,
          movementName: e.movementName,
          sets: e.sets,
          reps: e.reps,
          repsMax: e.repsMax,
          unit: e.unit,
          suggestionRationale: e.rationale,
        };
      });
      if (mapped.length === 0) continue;
      const newEntries = sortAssistanceEntriesForDay(mapped, day.mainLifts, slotMap);
      perDay[day.id] = newEntries;
      totalPicks += newEntries.length;
    }

    if (totalPicks === 0) {
      setStatus({
        kind: 'error',
        message: 'AI returned no new picks (everything you have is already covered).',
      });
      return;
    }

    // Cross-cutting validation: catches duplicates across days and per-day
    // budget overflow that parseAssistanceResponse can't see (it validates
    // entries one at a time). Errors trigger the deterministic fallback;
    // warnings are surfaced in the applied banner.
    const validatorInput: ValidatedDay[] = response.data.perDay.map((dp) => ({
      dayIndex: dp.dayIndex,
      isAccessoryDay: dp.isAccessoryDay,
      entries: dp.entries.map((e) => ({
        movementId: e.movementId!,
        movementName: e.movementName,
        sets: e.sets,
        reps: e.reps,
        repsMax: e.repsMax,
        unit: e.unit,
      })),
    }));
    const scheduledMainLifts = days.flatMap((d) => d.mainLifts);
    const validation = validateBlock({
      perDay: validatorInput,
      volume: promptInput.volume,
      goalFlags: promptInput.goalFlags,
      scheduledMainLifts,
    });
    if (!validation.ok) {
      applyDeterministicFallback(
        `Block-level validation failed: ${validation.errors.join('; ')}`,
      );
      return;
    }

    const undo = onApply(perDay);
    // Persist this generation to the audit log so the prompt-history page
    // can review it later. Returns an id; we capture it so the Undo button
    // can flip the outcome to 'undone'.
    const aiGenerationId = await recordAiGeneration({
      blockId: block.id,
      blockName: block.name,
      blockKind: block.kind,
      weekScope,
      phase: promptInput?.phase,
      source: 'ai',
      systemPrompt: builtPrompt?.systemPrompt ?? '',
      userPrompt: builtPrompt?.userPrompt ?? '',
      rawResponse: lastAiResponseRaw ?? JSON.stringify(response),
      modelInfo: response.modelInfo,
      cardioFatigueShift: promptInput?.cardioFatigueShift,
      cardioFatigueSummary: promptInput?.cardioFatigue
        ? {
            recentWeightedMin: promptInput.cardioFatigue.recentWeightedMin,
            baselineWeightedMin: promptInput.cardioFatigue.baselineWeightedMin,
            deltaPct: promptInput.cardioFatigue.deltaPct,
          }
        : undefined,
      pickCount: totalPicks,
      dayCount: Object.keys(perDay).length,
      outcome: 'applied',
    });
    // Log to the notifications inbox so the rationale persists past the
    // transient banner. Includes the cardio-fatigue diagnostics + LLM raw
    // response context for after-the-fact troubleshooting weeks later.
    void notify.action({
      channel: 'ai-suggester',
      title: `AI applied ${totalPicks} pick${totalPicks === 1 ? '' : 's'} across ${Object.keys(perDay).length} day${Object.keys(perDay).length === 1 ? '' : 's'}`,
      body: response.data.blockRationale.join('\n'),
      deepLink: { href: `/program/block?id=${block.id}`, label: `Open ${block.name ?? 'block'}` },
      context: {
        blockId: block.id,
        weekScope,
        modelInfo: response.modelInfo,
        cardioFatigue: promptInput?.cardioFatigue,
        cardioFatigueShift: promptInput?.cardioFatigueShift,
        newMovementsAdded,
        validationWarnings: validation.warnings,
        aiGenerationId,
      },
    });
    setStatus({
      kind: 'applied',
      sourceLabel: 'AI',
      pickCount: totalPicks,
      dayCount: Object.keys(perDay).length,
      blockRationale: response.data.blockRationale,
      modelInfo: response.modelInfo,
      undo: () => {
        undo();
        void markAiGenerationUndone(aiGenerationId);
        setStatus({ kind: 'idle' });
      },
      undoExpiresAt: Date.now() + UNDO_WINDOW_MS,
      usedFallback: false,
      validationWarnings: validation.warnings,
      newMovementsAdded,
    });
  };

  const applyDeterministicFallback = async (reason: string) => {
    if (!promptInput) return;
    // Fill-the-gaps mode applies here too: respect days the user has
    // already filled. The deterministic suggester already skips days
    // whose `existingPerDayEntries` are non-empty (its rule engine takes
    // them as immutable), but we add the same post-response filter to
    // guarantee parity with the AI path even if `suggestAssistance`'s
    // semantics ever drift.
    const filledDayIndices = new Set<number>();
    currentPerDayEntries.forEach((entries, i) => {
      if (entries && entries.length > 0) filledDayIndices.add(i);
    });
    const det = suggestAssistance({
      volume: promptInput.volume,
      days: promptInput.days,
      activeGoalFlavors: promptInput.activeGoalFlavors,
      movements: promptInput.movements,
      cardioPeakActive: promptInput.cardioPeakActive,
      availableEquipment: promptInput.availableEquipment,
      existingPerDayEntries: currentPerDayEntries,
      goalDirectives: evaluateGoalsForRules(promptInput.goalFlags, {
        suppressPhaseVolumeMultiplier: promptInput.suppressPhaseVolumeMultiplier,
        phase: promptInput.phase,
      }),
      longRunDayIndices: promptInput.longRunDayIndices,
    });
    // Capture the fallback output in the same disclosure stream as AI
    // responses, prefixed so it's clear which path produced this debugging
    // payload.
    setLastAiResponseRaw(
      `// Local deterministic fallback (reason: ${reason})\n` +
        JSON.stringify({ rationale: det.rationale, perDay: det.perDay }, null, 2),
    );
    const perDay: Record<string, AssistanceEntry[]> = {};
    let totalPicks = 0;
    for (const dp of det.perDay) {
      const day = days[dp.dayIndex];
      if (!day) continue;
      if (filledDayIndices.has(dp.dayIndex)) continue;
      const mapped = dp.entries.map<AssistanceEntry>((e) => ({
        id: nanoid(),
        category: e.category,
        movementId: e.movementId,
        movementName: e.movementName,
        sets: e.sets,
        reps: e.reps,
        repsMax: e.repsMax,
        unit: e.unit,
        suggestionRationale: e.rationale,
      }));
      if (mapped.length === 0) continue;
      // Same canonical day-ordering applied to the deterministic fallback so
      // both code paths produce visually identical structure on the page.
      const newEntries = sortAssistanceEntriesForDay(mapped, day.mainLifts);
      perDay[day.id] = newEntries;
      totalPicks += newEntries.length;
    }

    if (totalPicks === 0) {
      setStatus({
        kind: 'error',
        message: `AI unavailable (${reason}) and the local suggester also produced no new picks.`,
      });
      return;
    }
    const undo = onApply(perDay);
    // Persist the fallback to the audit log with source='fallback' and the
    // reason in the rawResponse blob so prompt-history analysis can see
    // when/why the LLM was bypassed.
    const aiGenerationId = await recordAiGeneration({
      blockId: block.id,
      blockName: block.name,
      blockKind: block.kind,
      weekScope,
      phase: promptInput?.phase,
      source: 'fallback',
      systemPrompt: builtPrompt?.systemPrompt ?? '',
      userPrompt: builtPrompt?.userPrompt ?? '',
      rawResponse: JSON.stringify(
        { fallbackReason: reason, rationale: det.rationale, perDay: det.perDay },
        null,
        2,
      ),
      cardioFatigueShift: promptInput?.cardioFatigueShift,
      cardioFatigueSummary: promptInput?.cardioFatigue
        ? {
            recentWeightedMin: promptInput.cardioFatigue.recentWeightedMin,
            baselineWeightedMin: promptInput.cardioFatigue.baselineWeightedMin,
            deltaPct: promptInput.cardioFatigue.deltaPct,
          }
        : undefined,
      pickCount: totalPicks,
      dayCount: Object.keys(perDay).length,
      outcome: 'applied',
    });
    // Same inbox entry as the AI path but flagged as a fallback so it's
    // clear in the history that the LLM was bypassed (with the reason).
    void notify.warn({
      channel: 'ai-suggester',
      title: `Local fallback applied ${totalPicks} pick${totalPicks === 1 ? '' : 's'} across ${Object.keys(perDay).length} day${Object.keys(perDay).length === 1 ? '' : 's'}`,
      body: `AI unavailable (${reason}). Local deterministic suggester produced the picks instead.\n\n${det.rationale.join('\n')}`,
      deepLink: { href: `/program/block?id=${block.id}`, label: `Open ${block.name ?? 'block'}` },
      context: {
        blockId: block.id,
        weekScope,
        usedFallback: true,
        fallbackReason: reason,
        cardioFatigue: promptInput?.cardioFatigue,
        cardioFatigueShift: promptInput?.cardioFatigueShift,
        aiGenerationId,
      },
    });
    setStatus({
      kind: 'applied',
      sourceLabel: 'local suggester',
      pickCount: totalPicks,
      dayCount: Object.keys(perDay).length,
      blockRationale: det.rationale,
      undo: () => {
        undo();
        void markAiGenerationUndone(aiGenerationId);
        setStatus({ kind: 'idle' });
      },
      undoExpiresAt: Date.now() + UNDO_WINDOW_MS,
      usedFallback: true,
      fallbackReason: reason,
      validationWarnings: [],
      newMovementsAdded: [],
    });
  };

  const ready = !!promptInput && !!builtPrompt;

  return (
    <section className="rounded-xl border border-sky-500/40 bg-sky-500/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-sky-100">✨ Suggest assistance for this block</h3>
            {promptInput && (
              <PhaseAutoBadge
                phase={promptInput.phase}
                source={promptInput.phaseSource}
                reason={
                  promptInput.phaseSource === 'block'
                    ? '7th-week deload block'
                    : promptInput.phaseSource === 'race'
                      ? `race in window`
                      : undefined
                }
              />
            )}
          </div>
          <p className="text-[11px] text-muted">
            Fills empty days only — days you&apos;ve already arranged are left alone. Claude sees your existing picks (so it doesn&apos;t duplicate movements or families) and only generates for the gaps.
          </p>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={!ready || status.kind === 'loading'}
          className="rounded-md bg-sky-500/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          {status.kind === 'loading' ? 'Generating…' : 'Generate'}
        </button>
      </div>

      {status.kind === 'loading' && <LoadingPanel startedAt={status.startedAt} dayCount={days.length} />}

      {status.kind === 'applied' && (
        <AppliedBanner
          status={status}
          undoExpired={undoExpired}
          onDismiss={() => setStatus({ kind: 'idle' })}
        />
      )}

      {status.kind === 'error' && (
        <div className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-[11px] text-rose-200">
          <div className="font-medium">Couldn&apos;t generate assistance</div>
          <div className="mt-1 text-rose-200/90">{status.message}</div>
          <button
            type="button"
            onClick={() => setStatus({ kind: 'idle' })}
            className="mt-2 rounded border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 text-rose-100 hover:bg-rose-500/20"
          >
            Dismiss
          </button>
        </div>
      )}

      {builtPrompt && (
        <PromptPreview
          systemPrompt={builtPrompt.systemPrompt}
          userPrompt={builtPrompt.userPrompt}
          aiResponse={lastAiResponseRaw}
        />
      )}
    </section>
  );
}

function LoadingPanel({ startedAt, dayCount }: { startedAt: number; dayCount: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="mt-3 space-y-2">
      <div className="text-[11px] text-sky-200">Asking Claude… {elapsed}s</div>
      <ul className="space-y-1.5">
        {Array.from({ length: Math.max(1, dayCount) }, (_, i) => (
          <li
            key={i}
            className="flex items-center gap-2 rounded-md border border-border/60 bg-card/40 p-2"
          >
            <div className="h-3 w-20 animate-pulse rounded bg-sky-500/20" />
            <div className="h-3 w-32 animate-pulse rounded bg-sky-500/10" />
            <div className="ml-auto h-3 w-16 animate-pulse rounded bg-sky-500/10" />
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-muted">Typically 15–30 seconds.</p>
    </div>
  );
}

function AppliedBanner({
  status,
  undoExpired,
  onDismiss,
}: {
  status: Extract<Status, { kind: 'applied' }>;
  undoExpired: boolean;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-emerald-200">
          ✓ Added {status.pickCount} picks across {status.dayCount} day{status.dayCount === 1 ? '' : 's'}
        </span>
        <span className="text-emerald-200/80">
          via {status.sourceLabel}
          {status.modelInfo && ` · ${status.modelInfo.model}`}
          {status.modelInfo && ` · ${(status.modelInfo.elapsedMs / 1000).toFixed(1)}s`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {!undoExpired && (
            <button
              type="button"
              onClick={status.undo}
              className="rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-100 hover:bg-emerald-500/20"
            >
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="text-emerald-200/70 hover:text-emerald-100"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
      {status.usedFallback && (
        <div className="mt-1 text-amber-200">
          Used local suggester (AI unavailable
          {status.fallbackReason ? `: ${truncate(status.fallbackReason, 120)}` : ''}).
        </div>
      )}
      {status.newMovementsAdded.length > 0 && (
        <div className="mt-2 rounded-md border border-sky-400/30 bg-sky-500/10 p-1.5 text-sky-100">
          <span className="font-medium">✨ Added {status.newMovementsAdded.length} new movement{status.newMovementsAdded.length === 1 ? '' : 's'} to your library:</span>{' '}
          <span className="text-sky-200/90">
            {status.newMovementsAdded.map((m) => m.name).join(', ')}
          </span>
        </div>
      )}
      {status.validationWarnings.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-amber-200/90">
          {status.validationWarnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {status.blockRationale.length > 0 && (
        <BlockRationaleDisclosure rationale={status.blockRationale} />
      )}
    </div>
  );
}

// Rationale is rendered with the top 2 entries shown inline (the user gets
// the gist immediately) and the rest behind a disclosure toggle. Switches
// from the previous pill-bubble grid (which read as a wall of tags) to a
// clean bulleted list — these are sentences, not labels.
function BlockRationaleDisclosure({ rationale }: { rationale: string[] }) {
  const PREVIEW = 2;
  const [expanded, setExpanded] = useState(false);
  const preview = rationale.slice(0, PREVIEW);
  const rest = rationale.slice(PREVIEW);
  const hasMore = rest.length > 0;

  return (
    <div className="mt-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-emerald-300/80">
        Why these picks
      </div>
      <ul className="space-y-0.5 text-[11px] text-emerald-100/90">
        {preview.map((r, i) => (
          <li key={i} className="flex gap-1.5">
            <span aria-hidden="true" className="text-emerald-400/60">•</span>
            <span>{r}</span>
          </li>
        ))}
        {expanded &&
          rest.map((r, i) => (
            <li key={i + PREVIEW} className="flex gap-1.5">
              <span aria-hidden="true" className="text-emerald-400/60">•</span>
              <span>{r}</span>
            </li>
          ))}
      </ul>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[10px] text-emerald-300/80 hover:text-emerald-100"
        >
          {expanded
            ? '▾ Show less'
            : `▸ ${rest.length} more reason${rest.length === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}

function PromptPreview({
  systemPrompt,
  userPrompt,
  aiResponse,
}: {
  systemPrompt: string;
  userPrompt: string;
  aiResponse?: string;
}) {
  const [show, setShow] = useState(false);
  const [copiedSystem, setCopiedSystem] = useState(false);
  const [copiedUser, setCopiedUser] = useState(false);
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [copiedBoth, setCopiedBoth] = useState(false);

  const copy = async (
    text: string,
    marker: 'system' | 'user' | 'response' | 'both',
  ) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    if (marker === 'system') {
      setCopiedSystem(true);
      setTimeout(() => setCopiedSystem(false), 1500);
    } else if (marker === 'user') {
      setCopiedUser(true);
      setTimeout(() => setCopiedUser(false), 1500);
    } else if (marker === 'response') {
      setCopiedResponse(true);
      setTimeout(() => setCopiedResponse(false), 1500);
    } else {
      setCopiedBoth(true);
      setTimeout(() => setCopiedBoth(false), 1500);
    }
  };

  // Pretty-print the response when it's a parseable JSON string. Falls back
  // to the raw text on parse failure so we can still see malformed output.
  const responsePretty = (() => {
    if (!aiResponse) return undefined;
    try {
      return JSON.stringify(JSON.parse(aiResponse), null, 2);
    } catch {
      return aiResponse;
    }
  })();

  const combinedParts = [`# SYSTEM\n\n${systemPrompt}`, `# USER\n\n${userPrompt}`];
  if (responsePretty) combinedParts.push(`# RESPONSE\n\n${responsePretty}`);
  const combined = combinedParts.join('\n\n');
  const totalKb = (
    (systemPrompt.length + userPrompt.length + (responsePretty?.length ?? 0)) /
    1024
  ).toFixed(1);
  const responseLabel = aiResponse
    ? ' · response captured'
    : ' · response not captured yet';

  return (
    <div className="mt-4 border-t border-border/40 pt-3">
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="flex w-full items-center justify-between text-left text-xs text-muted hover:text-fg"
      >
        <span>
          {show ? '▾' : '▸'} LLM prompt + response
          <span className="ml-2 text-[10px] opacity-70">
            ({totalKb} KB · paste into your AI of choice{responseLabel})
          </span>
        </span>
        {show && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              void copy(combined, 'both');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                void copy(combined, 'both');
              }
            }}
            className="rounded border border-border/60 bg-card/40 px-2 py-0.5 text-[10px] text-fg hover:bg-card/80"
          >
            {copiedBoth ? 'Copied!' : 'Copy all'}
          </span>
        )}
      </button>

      {show && (
        <div className="mt-2 space-y-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                System prompt
              </span>
              <button
                type="button"
                onClick={() => void copy(systemPrompt, 'system')}
                className="rounded border border-border/60 bg-card/40 px-2 py-0.5 text-[10px] text-fg hover:bg-card/80"
              >
                {copiedSystem ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="max-h-64 overflow-auto rounded-md border border-border/60 bg-black/40 p-2 text-[11px] leading-snug text-fg/90">
              {systemPrompt}
            </pre>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                User prompt
              </span>
              <button
                type="button"
                onClick={() => void copy(userPrompt, 'user')}
                className="rounded border border-border/60 bg-card/40 px-2 py-0.5 text-[10px] text-fg hover:bg-card/80"
              >
                {copiedUser ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="max-h-64 overflow-auto rounded-md border border-border/60 bg-black/40 p-2 text-[11px] leading-snug text-fg/90">
              {userPrompt}
            </pre>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                AI response
              </span>
              {responsePretty && (
                <button
                  type="button"
                  onClick={() => void copy(responsePretty, 'response')}
                  className="rounded border border-border/60 bg-card/40 px-2 py-0.5 text-[10px] text-fg hover:bg-card/80"
                >
                  {copiedResponse ? 'Copied!' : 'Copy'}
                </button>
              )}
            </div>
            <pre className="max-h-64 overflow-auto rounded-md border border-border/60 bg-black/40 p-2 text-[11px] leading-snug text-fg/90">
              {responsePretty ?? '(No response captured yet — generate to populate.)'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
