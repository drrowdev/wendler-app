import { classifyIntensity } from './cardio-analytics';
import type { MuscleGroup } from './types';

/**
 * What muscles a cardio session loaded, split into primary (took the brunt
 * of the work — long-run quads, intervals on the bike) and secondary
 * (involved but not dominant — easy-run glutes, swim biceps).
 *
 * Used by the Recovery → Muscle Freshness panel: any group that appears
 * in either list resets that group's "days since last trained" clock,
 * matching how strength sets already work (they lump primary+secondary).
 *
 * The split is exposed so future UI can weight the two differently
 * (e.g. show secondary contributions at 50% intensity).
 */
export interface CardioMuscleImpact {
  primary: MuscleGroup[];
  secondary: MuscleGroup[];
}

const NONE: CardioMuscleImpact = { primary: [], secondary: [] };

/** Effective intensity bucket used by the muscle-impact rules. */
type EffectiveIntensity = 'easy' | 'threshold' | 'hard';

interface CardioInput {
  modality: 'run' | 'bike' | 'swim' | 'row' | 'walk' | 'padel' | 'other';
  durationSec: number;
  distanceKm?: number;
  hrZoneSeconds?: number[];
}

/**
 * Per-modality minimum duration (minutes) that makes an HR-less session
 * count as "easy" load. Short sessions without HR data are skipped so a
 * 10-min spin or 15-min walk doesn't reset freshness.
 */
const HR_LESS_MIN_MINUTES: Record<CardioInput['modality'], number> = {
  run: 25,
  bike: 40,
  row: 15,
  swim: 25,
  walk: 60,
  padel: 40,
  other: Number.POSITIVE_INFINITY,
};

function effectiveIntensity(
  session: CardioInput,
): EffectiveIntensity | null {
  const minutes = session.durationSec / 60;
  // Walks are almost always low-HR by nature; classifying them as 'easy'
  // and gating on duration produces a more honest picture than zone math.
  if (session.modality === 'walk') {
    return minutes >= HR_LESS_MIN_MINUTES.walk ? 'easy' : null;
  }
  const tag = classifyIntensity(session).tag;
  switch (tag) {
    case 'hard':
      return 'hard';
    case 'threshold':
    case 'mixed':
      return 'threshold';
    case 'easy':
    case 'recovery':
      return 'easy';
    case 'none':
    default:
      // No HR / too short for the classifier — duration fallback so
      // padel & pool sessions still register.
      return minutes >= HR_LESS_MIN_MINUTES[session.modality] ? 'easy' : null;
  }
}

function runImpact(
  intensity: EffectiveIntensity,
  minutes: number,
  km: number,
): CardioMuscleImpact {
  if (intensity === 'hard') {
    // Intervals / threshold reps / race pace — eccentric load on quads
    // peaks, posterior chain works hard, calves take a beating.
    return {
      primary: ['quads', 'hamstrings', 'glutes', 'calves'],
      secondary: ['core'],
    };
  }
  if (intensity === 'threshold') {
    return {
      primary: ['quads', 'hamstrings', 'calves'],
      secondary: ['glutes', 'core'],
    };
  }
  // easy
  const isLong = minutes >= 45 || km >= 8;
  if (isLong) {
    // Long easy runs accumulate enough volume to fatigue the whole leg.
    return {
      primary: ['calves'],
      secondary: ['quads', 'hamstrings', 'glutes'],
    };
  }
  // Short easy run / shakeout — calves take some load, that's about it.
  return { primary: [], secondary: ['calves', 'quads'] };
}

function bikeImpact(
  intensity: EffectiveIntensity,
  minutes: number,
): CardioMuscleImpact {
  if (intensity === 'hard') {
    return {
      primary: ['quads', 'glutes'],
      secondary: ['calves', 'hamstrings'],
    };
  }
  if (intensity === 'threshold') {
    return {
      primary: ['quads', 'glutes'],
      secondary: ['calves', 'hamstrings'],
    };
  }
  // easy spin
  if (minutes >= 60) {
    return { primary: [], secondary: ['quads', 'glutes', 'calves'] };
  }
  return { primary: [], secondary: ['quads'] };
}

function rowImpact(intensity: EffectiveIntensity): CardioMuscleImpact {
  if (intensity === 'hard') {
    return {
      primary: ['hamstrings', 'glutes', 'back', 'lats', 'quads'],
      secondary: ['biceps', 'core', 'forearms', 'erectors'],
    };
  }
  if (intensity === 'threshold') {
    return {
      primary: ['hamstrings', 'glutes', 'back', 'lats'],
      secondary: ['quads', 'biceps', 'core', 'erectors'],
    };
  }
  // easy
  return {
    primary: [],
    secondary: ['back', 'lats', 'hamstrings', 'glutes', 'quads'],
  };
}

function swimImpact(intensity: EffectiveIntensity): CardioMuscleImpact {
  if (intensity === 'hard') {
    return {
      primary: ['lats', 'shoulders', 'back'],
      secondary: ['triceps', 'biceps', 'core', 'chest'],
    };
  }
  if (intensity === 'threshold') {
    return {
      primary: ['lats', 'shoulders', 'back'],
      secondary: ['triceps', 'core'],
    };
  }
  // easy
  return { primary: [], secondary: ['lats', 'shoulders', 'back'] };
}

function walkImpact(minutes: number, km: number): CardioMuscleImpact {
  // Walking only counts when it's actually a hike-length effort; a
  // 30-minute commute walk shouldn't reset leg freshness.
  if (minutes >= 90 || km >= 8) {
    return { primary: [], secondary: ['calves', 'quads', 'glutes'] };
  }
  return { primary: [], secondary: ['calves'] };
}

function padelImpact(intensity: EffectiveIntensity): CardioMuscleImpact {
  if (intensity === 'hard') {
    return {
      primary: ['quads', 'calves'],
      secondary: ['shoulders', 'core', 'obliques', 'forearms'],
    };
  }
  if (intensity === 'threshold') {
    return {
      primary: ['quads', 'calves'],
      secondary: ['shoulders', 'core', 'obliques'],
    };
  }
  // easy / casual padel
  return { primary: [], secondary: ['quads', 'calves', 'shoulders'] };
}

/**
 * Map a single cardio session to the muscle groups it loaded, split by
 * primary vs secondary contribution. Returns empty lists for sessions
 * that don't meaningfully fatigue anything (short walks without HR, the
 * 'other' modality, etc.) so they don't reset the freshness clock.
 *
 * Intensity is taken from `classifyIntensity` (HR-zone based) when HR is
 * available; otherwise a per-modality duration threshold gates whether
 * the session counts at all.
 */
export function cardioMuscleImpact(
  session: CardioInput,
): CardioMuscleImpact {
  const intensity = effectiveIntensity(session);
  if (intensity === null) return NONE;
  const minutes = session.durationSec / 60;
  const km = session.distanceKm ?? 0;
  switch (session.modality) {
    case 'run':
      return runImpact(intensity, minutes, km);
    case 'bike':
      return bikeImpact(intensity, minutes);
    case 'row':
      return rowImpact(intensity);
    case 'swim':
      return swimImpact(intensity);
    case 'walk':
      return walkImpact(minutes, km);
    case 'padel':
      return padelImpact(intensity);
    case 'other':
      return NONE;
  }
}
