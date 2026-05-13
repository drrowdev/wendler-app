import { roundToIncrement } from './rounding';
import type { PrescribedSet, SeventhWeekKind, WendlerWeek } from './types';

/**
 * The "main work" scheme used for the top sets of each session.
 * The block's supplementalTemplate is independent and runs after the main work.
 */
export type MainScheme = 'classic-531' | '5s-pro' | '351';

export interface MainSchemeInfo {
  id: MainScheme;
  name: string;
  shortName: string;
  description: string;
}

export const MAIN_SCHEMES: MainSchemeInfo[] = [
  {
    id: 'classic-531',
    name: 'Original 5/3/1',
    shortName: '5/3/1+',
    description:
      'Classic 5/3/1 waves with AMRAP top set: W1 5/5/5+, W2 3/3/3+, W3 5/3/1+. Use for Anchors and PR pushes.',
  },
  {
    id: '5s-pro',
    name: '5s PRO',
    shortName: '5s PRO',
    description:
      'Same percentages as 5/3/1 but every working set is 5 reps and no AMRAP. Volume builder for Leader blocks.',
  },
  {
    id: '351',
    name: '3/5/1',
    shortName: '3/5/1+',
    description:
      'Same percentages as 5/3/1 but week 1 and week 2 swap: W1 3/3/3+, W2 5/5/5+, W3 5/3/1+. Wendler-recommended ordering for Leaders so the heavier intensity day comes earlier.',
  },
];

/**
 * The canonical 5/3/1 main-set wave. The top set of each non-deload week is AMRAP.
 * Source: 5/3/1 Forever (Wendler, 2017), Part 2.
 */
export const WAVES: Record<WendlerWeek, { percent: number; reps: number; isAmrap?: boolean }[]> = {
  1: [
    { percent: 0.65, reps: 5 },
    { percent: 0.75, reps: 5 },
    { percent: 0.85, reps: 5, isAmrap: true },
  ],
  2: [
    { percent: 0.7, reps: 3 },
    { percent: 0.8, reps: 3 },
    { percent: 0.9, reps: 3, isAmrap: true },
  ],
  3: [
    { percent: 0.75, reps: 5 },
    { percent: 0.85, reps: 3 },
    { percent: 0.95, reps: 1, isAmrap: true },
  ],
  deload: [
    { percent: 0.4, reps: 5 },
    { percent: 0.5, reps: 5 },
    { percent: 0.6, reps: 5 },
  ],
  // The 7th-week wave is a placeholder — buildMainSets routes to
  // SEVENTH_WEEK_WAVES based on the block's seventhWeekKind. Kept here so
  // WendlerWeek index lookups don't fall through.
  '7w': [],
};

/**
 * 7th Week Protocol waves. Source: 5/3/1 Forever (Wendler, 2017), Part 1
 * "The Deload / 7th Week Protocol". The top set carries a `repsLabelOverride`
 * to render the special targets ("3–5", "PR") and is never AMRAP-flagged
 * (the rep target itself communicates the intent).
 */
export const SEVENTH_WEEK_WAVES: Record<
  SeventhWeekKind,
  { percent: number; reps: number; repsLabelOverride?: string }[]
> = {
  'tm-test': [
    { percent: 0.7, reps: 5 },
    { percent: 0.8, reps: 5 },
    { percent: 0.9, reps: 5 },
    { percent: 1.0, reps: 3, repsLabelOverride: '3–5' },
  ],
  deload: [
    { percent: 0.7, reps: 5 },
    { percent: 0.8, reps: 5, repsLabelOverride: '3–5' },
    { percent: 0.9, reps: 1 },
    { percent: 1.0, reps: 1 },
  ],
  'pr-test': [
    { percent: 0.7, reps: 5 },
    { percent: 0.8, reps: 5 },
    { percent: 0.9, reps: 5 },
    { percent: 1.0, reps: 1, repsLabelOverride: 'PR' },
  ],
};

export interface BuildMainSetsArgs {
  trainingMaxKg: number;
  week: WendlerWeek;
  /** Plate increment used to round each set (typically 2 × smallest plate weight, e.g. 2.5 kg). */
  roundingKg: number;
  /** Defaults to 'classic-531' for backwards compatibility. */
  scheme?: MainScheme;
  /**
   * Optional per-set AMRAP override. Indices into the returned main-set array
   * (0-based) that should be flagged AMRAP regardless of scheme. Use this to
   * force an AMRAP set in a 5s PRO block, or to add extra AMRAPs in a classic
   * 5/3/1 block. Deload is never AMRAP'd by this override.
   */
  amrapMainIndices?: readonly number[];
  /**
   * Required when `week === '7w'`. Selects the 7th-week wave variant.
   * Ignored for normal weeks.
   */
  seventhWeekKind?: SeventhWeekKind;
}

export function buildMainSets({
  trainingMaxKg,
  week,
  roundingKg,
  scheme = 'classic-531',
  amrapMainIndices,
  seventhWeekKind,
}: BuildMainSetsArgs): PrescribedSet[] {
  if (week === '7w') {
    const kind: SeventhWeekKind = seventhWeekKind ?? 'deload';
    const wave = SEVENTH_WEEK_WAVES[kind] ?? [];
    return wave.map((s) => ({
      kind: 'main',
      percentOfTm: s.percent,
      weightKg: roundToIncrement(trainingMaxKg * s.percent, roundingKg),
      reps: s.reps,
      ...(s.repsLabelOverride ? { repsLabelOverride: s.repsLabelOverride } : {}),
    }));
  }
  const wave = WAVES[week];
  // 3/5/1: same percentages as classic, but week 1 and week 2 are swapped.
  // Week 1 runs the 3s wave (70/80/90×3) and Week 2 runs the 5s wave
  // (65/75/85×5). Week 3 and deload are unchanged. AMRAP behaviour matches
  // classic-531 (top set is AMRAP on non-deload weeks).
  const effectiveWave =
    scheme === '351' && week === 1 ? WAVES[2] : scheme === '351' && week === 2 ? WAVES[1] : wave;
  const overrideSet = new Set(week === 'deload' ? [] : amrapMainIndices ?? []);
  // 5s PRO: same percentages as the wave, but every set is 5 reps and no AMRAP
  // (unless explicitly overridden via amrapMainIndices). Deload is unchanged.
  if (scheme === '5s-pro' && week !== 'deload') {
    return effectiveWave.map((s, i) => {
      const isAmrap = overrideSet.has(i);
      return {
        kind: isAmrap ? 'amrap' : 'main',
        percentOfTm: s.percent,
        weightKg: roundToIncrement(trainingMaxKg * s.percent, roundingKg),
        reps: 5,
        ...(isAmrap ? { isAmrap: true } : {}),
      };
    });
  }
  return effectiveWave.map((s, i) => {
    const isAmrap = s.isAmrap || overrideSet.has(i);
    return {
      kind: isAmrap ? 'amrap' : 'main',
      percentOfTm: s.percent,
      weightKg: roundToIncrement(trainingMaxKg * s.percent, roundingKg),
      reps: s.reps,
      ...(isAmrap ? { isAmrap: true } : {}),
    };
  });
}
