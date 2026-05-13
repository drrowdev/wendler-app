import type { PrescribedSet, WendlerWeek } from './types';
import { roundToIncrement } from './rounding';

export type SupplementalTemplateId =
  | 'none'
  | 'fsl'
  | 'fsl-amrap'
  | 'bbb'
  | 'ssl'
  | 'spinal-tap'
  | 'widowmaker'
  | 'custom';

export interface SupplementalTemplate {
  id: SupplementalTemplateId;
  name: string;
  description: string;
}

export const SUPPLEMENTAL_TEMPLATES: SupplementalTemplate[] = [
  { id: 'none', name: 'None', description: 'No supplemental work — straight to assistance.' },
  {
    id: 'fsl',
    name: 'First Set Last (FSL)',
    description:
      'Default Leader supplemental: 5×5 at the first working % (W1 65%, W2 70%, W3 75%). Drop the set count for cardio-heavy phases (e.g. 3×5 during marathon prep).',
  },
  {
    id: 'fsl-amrap',
    name: 'FSL AMRAP',
    description:
      'One AMRAP set at the first working %. Used in Anchors to gauge progress without big volume.',
  },
  {
    id: 'bbb',
    name: 'Boring But Big (BBB)',
    description:
      '5×10 at 50/60/70% of TM across the 3 weeks. Volume-heavy classic — Leader only, not for marathon training.',
  },
  {
    id: 'ssl',
    name: 'Second Set Last (SSL)',
    description:
      '5×5 at the second working % (W1 75%, W2 80%, W3 85%). Heavier than FSL — for advanced lifters in a Leader.',
  },
  {
    id: 'spinal-tap',
    name: 'Spinal Tap',
    description:
      '3×3 at the third (top) working %. Low-volume, high-intensity supplemental from the High School Years template.',
  },
  {
    id: 'widowmaker',
    name: 'Widowmaker',
    description:
      '1×20 at the first working %. Squat or Deadlift only — Anchor-only conditioning set, brutal.',
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Defined per session — set your own loads and reps in the workout view.',
  },
];

export interface SupplementalConfig {
  templateId: SupplementalTemplateId;
  trainingMaxKg: number;
  week: WendlerWeek;
  roundingKg: number;
  /**
   * Optional override for the number of supplemental sets. Honored by the
   * multi-set templates (fsl, ssl, bbb, spinal-tap). Ignored by inherently
   * single-set templates (fsl-amrap, widowmaker) and by 'none' / 'custom'.
   * Useful when running a higher-volume programme alongside cardio (e.g.
   * marathon prep — drop FSL from 5×5 to 3×5).
   */
  setsOverride?: number;
}

const FIRST_PCT: Record<WendlerWeek, number> = {
  1: 0.65,
  2: 0.7,
  3: 0.75,
  deload: 0.4,
  '7w': 0,
};

const SECOND_PCT: Record<WendlerWeek, number> = {
  1: 0.75,
  2: 0.8,
  3: 0.85,
  deload: 0.5,
  '7w': 0,
};

const BBB_PCT: Record<WendlerWeek, number> = {
  1: 0.5,
  2: 0.6,
  3: 0.7,
  deload: 0.4,
  '7w': 0,
};

const SPINAL_TAP_PCTS: Record<WendlerWeek, number[]> = {
  // Per 5/3/1 Forever HS template: supplemental matches the main 5/3/1
  // percentages (Wk1 65/75/85, Wk2 70/80/90, Wk3 75/85/95). Doubles the
  // top-set work as ramping volume.
  1: [0.65, 0.75, 0.85],
  2: [0.7, 0.8, 0.9],
  3: [0.75, 0.85, 0.95],
  deload: [],
  '7w': [],
};

/**
 * Build the supplemental sets for a session given a template, TM and week.
 * Returns an empty array for 'none' / 'custom' / deload (most templates don't run during deload).
 */
export function buildSupplementalSets(cfg: SupplementalConfig): PrescribedSet[] {
  const { templateId, trainingMaxKg, week, roundingKg, setsOverride } = cfg;
  if (templateId === 'none' || templateId === 'custom') return [];
  // Skip supplemental on deload weeks and on 7th-week protocol weeks — recovery
  // / TM testing / PR pushes are the entire point; volume defeats it.
  if (week === 'deload' || week === '7w') return [];

  const w = (pct: number) => roundToIncrement(trainingMaxKg * pct, roundingKg);
  const clampSets = (defaultCount: number) =>
    Math.max(1, Math.min(20, Math.round(setsOverride ?? defaultCount)));

  switch (templateId) {
    case 'fsl': {
      const weight = w(FIRST_PCT[week]);
      return Array.from({ length: clampSets(5) }, () => ({
        kind: 'supplemental',
        weightKg: weight,
        reps: 5,
        percentOfTm: FIRST_PCT[week],
      }));
    }
    case 'fsl-amrap': {
      const weight = w(FIRST_PCT[week]);
      return [
        {
          kind: 'supplemental',
          weightKg: weight,
          reps: 5,
          percentOfTm: FIRST_PCT[week],
          isAmrap: true,
        },
      ];
    }
    case 'ssl': {
      const weight = w(SECOND_PCT[week]);
      return Array.from({ length: clampSets(5) }, () => ({
        kind: 'supplemental',
        weightKg: weight,
        reps: 5,
        percentOfTm: SECOND_PCT[week],
      }));
    }
    case 'spinal-tap': {
      // Spinal Tap (HS template) is structurally a 3-percentage ramp matching
      // the main 5/3/1 sets — Wk1: 65/75/85%, Wk2: 70/80/90%, Wk3: 75/85/95%.
      // setsOverride is interpreted as the number of *cycles* through the
      // ramp (default 1 cycle = 3 sets). Doubling to 6 means two ramps in a
      // session.
      const pcts = SPINAL_TAP_PCTS[week];
      const cycles = Math.max(1, Math.min(6, Math.round((setsOverride ?? 3) / 3)));
      const out: PrescribedSet[] = [];
      for (let c = 0; c < cycles; c++) {
        for (const pct of pcts) {
          out.push({
            kind: 'supplemental',
            weightKg: w(pct),
            reps: 3,
            percentOfTm: pct,
          });
        }
      }
      return out;
    }
    case 'bbb': {
      const weight = w(BBB_PCT[week]);
      return Array.from({ length: clampSets(5) }, () => ({
        kind: 'supplemental',
        weightKg: weight,
        reps: 10,
        percentOfTm: BBB_PCT[week],
      }));
    }
    case 'widowmaker': {
      const weight = w(FIRST_PCT[week]);
      return [
        {
          kind: 'supplemental',
          weightKg: weight,
          reps: 20,
          percentOfTm: FIRST_PCT[week],
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * The per-set TM fractions this template loads its supplemental work at on
 * the given week. Returns an empty array for templates with no fixed %
 * (none / custom) and for the deload week (most templates skip supplemental
 * on deload).
 *
 * Most templates use a single percentage for every set in a week (FSL: one
 * weight × N sets) so the array has length 1. Spinal Tap is the exception —
 * it ramps three percentages within each week (W1 65/75/85, W2 70/80/90,
 * W3 75/85/95) per the 5/3/1 Forever HS template.
 *
 * Used to surface load context inline in editor UIs without needing to open
 * a session — e.g. "FSL · 5 sets · Wk 1 65%" or "Spinal Tap · Wk 1 65/75/85%".
 */
export function supplementalPercentages(
  templateId: SupplementalTemplateId,
  week: WendlerWeek,
): number[] {
  if (week === 'deload' || week === '7w') return [];
  const i = week - 1; // 0..2
  switch (templateId) {
    case 'fsl':
    case 'fsl-amrap':
    case 'widowmaker': {
      const p = [0.65, 0.7, 0.75][i];
      return p === undefined ? [] : [p];
    }
    case 'ssl': {
      const p = [0.75, 0.8, 0.85][i];
      return p === undefined ? [] : [p];
    }
    case 'spinal-tap':
      return SPINAL_TAP_PCTS[week].slice();
    case 'bbb': {
      const p = [0.5, 0.6, 0.7][i];
      return p === undefined ? [] : [p];
    }
    case 'none':
    case 'custom':
    default:
      return [];
  }
}

/**
 * The default number of supplemental sets a template prescribes per session
 * (Wk1-3; deload returns 0). Use to seed UI placeholders so users don't
 * have to memorise each Wendler template's volume.
 */
export function defaultSupplementalSets(templateId: SupplementalTemplateId): number {
  switch (templateId) {
    case 'fsl':
    case 'ssl':
    case 'bbb':
      return 5;
    case 'spinal-tap':
      return 3;
    case 'fsl-amrap':
    case 'widowmaker':
      return 1;
    case 'none':
    case 'custom':
    default:
      return 0;
  }
}
