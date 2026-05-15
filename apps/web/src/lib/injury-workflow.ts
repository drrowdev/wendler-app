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
  const filteredMovements = filterByEquipment(movements, availableEquipment);

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
      return {
        ok: false,
        errorCode: 'llm-unreachable',
        errors: [`Server returned HTTP ${res.status}.`],
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
