// Client-side injury workflow + Coach helpers.
//
// Builds the Coach user prompt + library payload from live IndexedDB state,
// posts to POST /api/workflows/analyzeInjury, and returns a typed
// AgentResponse<InjuryAnalysisResult>.

import type { AgentResponse } from '@wendler/domain';
import { CoachAgent, type Movement } from '@wendler/domain';
import { authFetch } from './auth';
import { getDb } from './db';
import { getLatestBodyweightOnOrBefore } from './recovery';

export type InjuryAction =
  | 'skip'
  | 'reduce-load'
  | 'reduce-range'
  | 'modify-execution'
  | 'monitor';

export interface SubstitutionAlternative {
  movementId: string;
  movementName: string;
  rationale: string;
}

export interface InjuryAnalysisAdjustment {
  movementId: string;
  movementName: string;
  action: InjuryAction;
  modification: string;
  reasoning: string;
  alternatives: SubstitutionAlternative[];
}

export interface InjuryAnalysisResult {
  summary: string;
  proposedAdjustments: InjuryAnalysisAdjustment[];
  monitoringAdvice?: string;
  consultRecommended: boolean;
  consultReason?: string;
  coachUsage?: { inputTokens: number; outputTokens: number; latencyMs: number };
}

export interface AnalyzeInjuryInput {
  area: string;
  severity: 1 | 2 | 3 | 4 | 5;
  description: string;
  initialMovementIds?: string[];
}

/**
 * Run the analyzeInjury workflow. Pulls dynamic context from IndexedDB
 * (movement library, user profile, recent training summary, other active
 * + recently-resolved injuries), builds the Coach user prompt, and posts
 * to the server-side workflow endpoint.
 */
export async function analyzeInjury(
  input: AnalyzeInjuryInput,
): Promise<AgentResponse<InjuryAnalysisResult>> {
  const db = getDb();
  const [movements, settings, userProfile, allInjuries] = await Promise.all([
    db.movements.toArray(),
    db.settings.get('singleton'),
    db.userProfile.get('singleton'),
    db.injuries.toArray(),
  ]);

  const availableEquipment = (settings as unknown as { availableEquipment?: string[] })
    ?.availableEquipment;

  // Filter library by equipment so the Coach only sees what the user can do.
  const equipmentFilteredMovements = filterByEquipment(movements, availableEquipment);

  // Further focus the library to keep Coach's prompt under the SWA proxy
  // ceiling. Drops single-joint isolation + pure prehab — Coach never
  // proposes these as substitutions for compound-movement injuries, and
  // they account for ~25-30% of a typical library. Always keeps any
  // movement the user explicitly tagged as affected (so the entry stays
  // visible to Coach even if it'd otherwise be filtered out).
  const filteredMovements = focusLibraryForCoach(
    equipmentFilteredMovements,
    input.initialMovementIds,
  );

  // Compose the user-profile dynamic context (DOB → age, etc).
  const profileForCoach = buildProfileForCoach(userProfile, await currentBodyweight());

  // Other active + recently-resolved injuries inform Coach reasoning.
  const otherActiveInjuries = allInjuries
    .filter((i) => !i.deletedAt && !i.resolvedAt)
    .map((i) => ({ area: i.area, severity: i.severity, description: i.description }));

  const sixtyDaysAgoIso = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  const recentResolvedInjuries = allInjuries
    .filter((i) => !i.deletedAt && i.resolvedAt && i.resolvedAt >= sixtyDaysAgoIso)
    .map((i) => ({ area: i.area, resolvedAt: (i.resolvedAt ?? '').slice(0, 10) }));

  const recentTrainingSummary = await buildRecentTrainingSummary();

  const { userPrompt } = CoachAgent.buildCoachPrompt({
    injury: {
      area: input.area,
      severity: input.severity,
      description: input.description,
      ...(input.initialMovementIds && input.initialMovementIds.length > 0
        ? { initialMovementIds: input.initialMovementIds }
        : {}),
    },
    movements: filteredMovements,
    ...(availableEquipment && availableEquipment.length > 0 ? { availableEquipment } : {}),
    ...(profileForCoach !== undefined ? { userProfile: profileForCoach } : {}),
    ...(recentTrainingSummary !== undefined ? { recentTrainingSummary } : {}),
    ...(otherActiveInjuries.length > 0 ? { otherActiveInjuries } : {}),
    ...(recentResolvedInjuries.length > 0 ? { recentResolvedInjuries } : {}),
  });

  // Server expects pre-built userPrompt + library payload.
  const libraryPayload = filteredMovements.map((m) => ({
    id: m.id,
    name: m.name,
    equipment: m.equipment,
    pattern: m.pattern,
    primaryMuscles: m.primaryMuscles,
    secondaryMuscles: m.secondaryMuscles,
    externallyLoadable: m.externallyLoadable,
    isCompound: m.isCompound,
  }));

  try {
    const res = await authFetch('/api/workflows/analyzeInjury', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userPrompt, library: libraryPayload }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        return {
          ok: false,
          errorCode: 'llm-unreachable',
          errors: ['Not authenticated. Sign in and try again.'],
        };
      }
      // Try to surface the real error body — 5xx responses from Azure
      // Functions are typically HTML or JSON; either way we want
      // SOMETHING informative back to the user, not just "HTTP 500".
      let detail = '';
      try {
        const text = await res.text();
        if (text) detail = text.length > 300 ? text.slice(0, 300) + '…' : text;
      } catch {
        // ignore body read failures
      }
      return {
        ok: false,
        errorCode: res.status >= 500 ? 'unknown' : 'llm-unreachable',
        errors: [`Server returned HTTP ${res.status}.${detail ? ` ${detail}` : ''}`],
      };
    }
    const body = (await res.json()) as AgentResponse<InjuryAnalysisResult>;
    return body;
  } catch (err) {
    return {
      ok: false,
      errorCode: 'llm-unreachable',
      errors: [`Network error: ${(err as Error).message}`],
    };
  }
}

// ---------- helpers ----------

function filterByEquipment(
  movements: Movement[],
  availableEquipment?: readonly string[],
): Movement[] {
  if (!availableEquipment || availableEquipment.length === 0) return movements;
  const allowed = new Set(availableEquipment);
  return movements.filter((m) => m.equipment === 'bodyweight' || allowed.has(m.equipment));
}

/**
 * Drop categories of movements that Coach almost never proposes as
 * substitutions, to keep the user-prompt small enough for the Anthropic
 * call to finish inside the SWA proxy timeout.
 *
 * Always retains any movement the user explicitly tagged on the injury
 * (so Coach can still reason about THOSE), plus all compound multi-joint
 * movements (push/pull/squat/hinge/single-leg/carry patterns).
 *
 * Drops:
 *  - Pure single-joint isolation (curls, lateral raises, kickbacks,
 *    calf raises, shrugs, leg curls, leg extensions, pec deck etc.)
 *  - Pure prehab (band pull-aparts, face pulls, clamshells, glute bridges,
 *    Y-T-W raises, lateral band walks)
 *  - Plyometrics (box jumps, broad jumps, depth jumps — unlikely to be
 *    swap targets for resistance-training injuries)
 *
 * Heuristic — uses the `pattern` field plus primary-muscle profile.
 */
function focusLibraryForCoach(
  movements: Movement[],
  alwaysKeepIds: readonly string[] | undefined,
): Movement[] {
  const keepSet = new Set(alwaysKeepIds ?? []);
  return movements.filter((m) => {
    if (keepSet.has(m.id)) return true;
    const pattern = (m.pattern ?? '').toLowerCase();
    const primary = (m.primaryMuscles ?? []).map((p) => p.toLowerCase());
    // Keep compound patterns outright — these are the bulk of Coach's
    // working set.
    if (
      pattern === 'squat' ||
      pattern === 'hinge' ||
      pattern === 'push-horizontal' ||
      pattern === 'push-vertical' ||
      pattern === 'pull-horizontal' ||
      pattern === 'pull-vertical' ||
      pattern === 'carry' ||
      pattern === 'core'
    ) {
      return true;
    }
    // Drop plyometrics + pure prehab.
    if (pattern === 'plyo' || pattern === 'prehab' || pattern === 'mobility') {
      return false;
    }
    // For isolation pattern, drop single-joint-only movements (one primary
    // muscle, typical biceps/triceps/calves/shoulders isolation). Keep
    // movements with 2+ primary muscles — those are compound-ish enough
    // to be substitution candidates.
    if (pattern === 'isolation') {
      return primary.length >= 2;
    }
    // Unknown / new patterns: keep by default, better safe than missing.
    return true;
  });
}

function buildProfileForCoach(
  userProfile: { dateOfBirth?: string; sex?: 'male' | 'female'; heightCm?: number; trainingExperience?: 'novice' | 'intermediate' | 'advanced' | 'elite'; yearsLifting?: number; yearsRunning?: number; backgroundNotes?: string } | undefined,
  bwKg: number | undefined,
):
  | {
      ageYears?: number;
      sex?: 'male' | 'female';
      heightCm?: number;
      trainingExperience?: 'novice' | 'intermediate' | 'advanced' | 'elite';
      yearsLifting?: number;
      yearsRunning?: number;
      backgroundNotes?: string;
    }
  | undefined {
  if (!userProfile && bwKg === undefined) return undefined;
  const out: ReturnType<typeof buildProfileForCoach> = {};
  if (userProfile?.dateOfBirth) {
    const [y, m, d] = userProfile.dateOfBirth.split('-').map(Number);
    if (y && m && d) {
      const now = new Date();
      let age = now.getFullYear() - y;
      const beforeBirthday = now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d);
      if (beforeBirthday) age -= 1;
      if (age >= 0 && age < 120) (out as { ageYears?: number }).ageYears = age;
    }
  }
  if (userProfile?.sex) out!.sex = userProfile.sex;
  if (typeof userProfile?.heightCm === 'number') out!.heightCm = userProfile.heightCm;
  if (userProfile?.trainingExperience) {
    out!.trainingExperience = userProfile.trainingExperience;
  }
  if (typeof userProfile?.yearsLifting === 'number') out!.yearsLifting = userProfile.yearsLifting;
  if (typeof userProfile?.yearsRunning === 'number') out!.yearsRunning = userProfile.yearsRunning;
  if (userProfile?.backgroundNotes) out!.backgroundNotes = userProfile.backgroundNotes;
  if (Object.keys(out!).length === 0) return undefined;
  return out;
}

async function currentBodyweight(): Promise<number | undefined> {
  return getLatestBodyweightOnOrBefore();
}

/**
 * Build a 1-paragraph summary of the user's recent training context for the
 * Coach agent. Keeps token cost low; the Coach mostly uses this for "is the
 * user mid-block, deloading, ramping after layoff" framing — not for
 * detailed analysis.
 */
async function buildRecentTrainingSummary(): Promise<string | undefined> {
  const db = getDb();
  const allSessions = await db.sessions.toArray();
  const recent = allSessions
    .filter((s) => !!(s.workoutCompletedAt ?? s.completedAt))
    .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))
    .slice(0, 10);
  if (recent.length === 0) return undefined;
  const last = recent[0]!;
  const oldest = recent[recent.length - 1]!;
  const daysSpan = Math.max(
    1,
    Math.round(
      (new Date(last.performedAt).getTime() - new Date(oldest.performedAt).getTime()) / 86400000,
    ),
  );
  return `Last ${recent.length} completed sessions span ${daysSpan} day(s). Most recent on ${last.performedAt.slice(0, 10)}.`;
}
