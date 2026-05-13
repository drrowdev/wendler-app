'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import type { MainLift, SessionRecord } from '@wendler/db-schema';
import type { SupplementalTemplateId, WendlerWeek } from '@wendler/domain';
import { getDb } from './db';
import { useAllSessions } from './hooks';

interface UseDaySessionRowOpts {
  blockId: string;
  week: WendlerWeek;
  dayIdx: number;
  /**
   * Optional main lift this row tracks. Omit for the day-anchor row that
   * holds warm-up flag + assistance sets on multi-lift / accessory days.
   */
  lift?: MainLift;
  /** Active block's supplemental template — stamped onto materialised row. */
  supplementalTemplateId?: SupplementalTemplateId;
}

interface UseDaySessionRowResult {
  /**
   * Stable id for this row — either the existing row's id (when one is
   * found in the DB) or a freshly reserved nanoid. Set asynchronously
   * once the all-sessions query has loaded; null until then.
   */
  sessionId: string | null;
  /**
   * Existing DB row matching (blockId, week, dayIdx, lift?), if any.
   * Useful for callers that want to read/update extra fields on it.
   */
  existingSession: SessionRecord | undefined;
  /**
   * Materialise the row in IndexedDB if it isn't already there. Idempotent
   * — safe to call before every set save / flag toggle. Always merges with
   * any prior row so existing flags (preWarmupCompletedAt, workoutCompletedAt)
   * survive.
   */
  ensureSessionRow: () => Promise<void>;
}

/**
 * Single source of truth for "give me the session row for THIS workout slot".
 * Replaces three near-duplicate `ensureSessionRow` blobs (in /session,
 * LiftTrack, DayAssistanceSection) that previously diverged on
 * put-vs-merge semantics and adopt-existing-row timing.
 *
 * Row keying:
 *   (blockId, week, dayIdx, lift?)
 *   - lift defined  → per-lift row (main + supplemental for that lift)
 *   - lift undefined → day-anchor row (warm-up flag, assistance sets,
 *                       accessory-day completion stamp)
 */
export function useDaySessionRow({
  blockId,
  week,
  dayIdx,
  lift,
  supplementalTemplateId,
}: UseDaySessionRowOpts): UseDaySessionRowResult {
  const allSessions = useAllSessions();

  const existingSession = useMemo(() => {
    if (!allSessions) return undefined;
    return allSessions
      .filter((s) => {
        if (s.blockId !== blockId || s.week !== week) return false;
        if (lift) return s.mainLift === lift;
        return !s.mainLift && s.dayIndex === dayIdx;
      })
      .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];
  }, [allSessions, blockId, week, dayIdx, lift]);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const materializedRef = useRef(false);

  useEffect(() => {
    if (existingSession) {
      // Adopt the existing row even if we already pre-allocated a fresh
      // sessionId — as long as we haven't materialised our own row yet.
      // This avoids duplicate rows when (e.g.) PreLiftingWarmup wrote a
      // row before this hook's caller ran.
      if (sessionId === existingSession.id) return;
      if (!materializedRef.current) {
        setSessionId(existingSession.id);
        materializedRef.current = true;
      }
      return;
    }
    if (sessionId) return;
    if (allSessions !== undefined) {
      setSessionId(nanoid());
      materializedRef.current = false;
    }
  }, [existingSession, allSessions, sessionId]);

  const ensureSessionRow = async (): Promise<void> => {
    if (materializedRef.current) return;
    if (!sessionId) return;
    const db = getDb();

    // Race-safety: another caller (e.g. PreLiftingWarmup) may have written a
    // matching row between when our useAllSessions snapshot was taken and now.
    // Adopt that row instead of writing our pre-allocated nanoid, which would
    // create a duplicate (blockId, week, dayIdx, mainLift) row. The completion
    // path stamps `workoutCompletedAt` on EVERY row for the day, so the dupe
    // would survive and inflate per-lift counts forever.
    const candidates = await db.sessions
      .where('blockId')
      .equals(blockId)
      .toArray();
    const existing = candidates
      .filter((s) => {
        if (s.week !== week) return false;
        if (lift) return s.mainLift === lift;
        return !s.mainLift && s.dayIndex === dayIdx;
      })
      .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];
    if (existing) {
      // Adopt the live row and merge any missing fields onto it.
      await db.sessions.put({
        ...existing,
        ...(lift ? { mainLift: lift } : {}),
        week,
        blockId,
        dayIndex: dayIdx,
        ...(supplementalTemplateId !== undefined ? { supplementalTemplateId } : {}),
      });
      if (sessionId !== existing.id) setSessionId(existing.id);
      materializedRef.current = true;
      return;
    }

    const prior = await db.sessions.get(sessionId);
    await db.sessions.put({
      ...(prior ?? {}),
      id: sessionId,
      performedAt: prior?.performedAt ?? new Date().toISOString(),
      ...(lift ? { mainLift: lift } : {}),
      week,
      blockId,
      dayIndex: dayIdx,
      ...(supplementalTemplateId !== undefined ? { supplementalTemplateId } : {}),
    });
    materializedRef.current = true;
  };

  return { sessionId, existingSession, ensureSessionRow };
}
