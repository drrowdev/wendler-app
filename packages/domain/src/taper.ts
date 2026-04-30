/**
 * Race taper detection (v1.0.0).
 *
 * Given a race-time goal (with deadline) and today's date, recommend whether
 * the lifter should be in normal training, peak/sharpen, taper, or race week.
 *
 * Wendler 5/3/1 doesn't prescribe a race taper specifically, but the philosophy
 * — "a little less is a lot more" near competitions — is consistent. We
 * surface a transparent recommendation; the user makes the call.
 */

export interface RaceGoal {
  id: string;
  title: string;
  /** Should be 'race-time'. Other kinds are ignored. */
  kind: string;
  /** ISO timestamp of the race. */
  deadline?: string;
  completedAt?: string;
}

export type TaperPhase = 'off-season' | 'build' | 'peak' | 'taper' | 'race-week' | 'race-day';

export interface TaperWindow {
  goalId: string;
  goalTitle: string;
  raceDate: string;
  daysOut: number;
  phase: TaperPhase;
  /** Suggested adjustments in plain English. */
  guidance: string[];
  /** Suggested strength volume multiplier (1.0 = normal). */
  strengthVolumeMultiplier: number;
  /** Suggested cardio volume multiplier (1.0 = normal). */
  cardioVolumeMultiplier: number;
}

export interface TaperInputs {
  goals: RaceGoal[];
  now?: Date;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / 86400000);
}

function phaseFor(daysOut: number): TaperPhase {
  if (daysOut < 0) return 'off-season';
  if (daysOut === 0) return 'race-day';
  if (daysOut <= 6) return 'race-week';
  if (daysOut <= 14) return 'taper';
  if (daysOut <= 28) return 'peak';
  if (daysOut <= 84) return 'build';
  return 'off-season';
}

function guidanceFor(phase: TaperPhase): {
  guidance: string[];
  strengthVolumeMultiplier: number;
  cardioVolumeMultiplier: number;
} {
  switch (phase) {
    case 'race-day':
      return {
        guidance: [
          'Race day. No training. Eat, hydrate, warm up, race.',
        ],
        strengthVolumeMultiplier: 0,
        cardioVolumeMultiplier: 0,
      };
    case 'race-week':
      return {
        guidance: [
          'Final week. Cut strength volume ~50%; keep top sets short and crisp (no AMRAPs).',
          'Reduce cardio mileage 30–50%; keep a few short race-pace efforts.',
          'Prioritize sleep and carbs the last 3 days. Skip novel exercises.',
        ],
        strengthVolumeMultiplier: 0.5,
        cardioVolumeMultiplier: 0.6,
      };
    case 'taper':
      return {
        guidance: [
          'Taper window. Drop assistance work to a single set; keep main lifts at prescribed weight, fewer reps.',
          'Trim long cardio by ~25%; maintain intensity, lose volume.',
          'Stop adding load. Confidence > stimulus from here.',
        ],
        strengthVolumeMultiplier: 0.7,
        cardioVolumeMultiplier: 0.75,
      };
    case 'peak':
      return {
        guidance: [
          'Peak block. Push intensity but skip new PR attempts on barbell lifts.',
          'Long runs should approach goal-pace specificity.',
          'Lock in technique — no experimentation.',
        ],
        strengthVolumeMultiplier: 0.9,
        cardioVolumeMultiplier: 1.0,
      };
    case 'build':
      return {
        guidance: [
          'Build phase. Train normally; prioritise the supportive modality (lifting OR cardio).',
          'Keep 1–2 hard cardio sessions and 2–3 lifting sessions per week.',
        ],
        strengthVolumeMultiplier: 1.0,
        cardioVolumeMultiplier: 1.0,
      };
    case 'off-season':
    default:
      return {
        guidance: [
          'Off-season. Strength is the priority — build a bigger engine to peak from later.',
        ],
        strengthVolumeMultiplier: 1.0,
        cardioVolumeMultiplier: 1.0,
      };
  }
}

export function nextRaceWindow(input: TaperInputs): TaperWindow | undefined {
  const now = input.now ?? new Date();
  const races = input.goals
    .filter((g) => g.kind === 'race-time' && !g.completedAt && g.deadline)
    .map((g) => ({ g, date: new Date(g.deadline!) }))
    .filter((r) => !Number.isNaN(r.date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  // Prefer the soonest race that is today or in the future, OR within last day (race day).
  const upcoming = races.find((r) => daysBetween(now, r.date) >= -1);
  if (!upcoming) return undefined;

  const daysOut = Math.max(0, daysBetween(now, upcoming.date));
  const phase = phaseFor(daysOut);
  const g = guidanceFor(phase);
  return {
    goalId: upcoming.g.id,
    goalTitle: upcoming.g.title,
    raceDate: upcoming.date.toISOString(),
    daysOut,
    phase,
    ...g,
  };
}
