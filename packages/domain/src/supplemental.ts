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
    description: '5×5 at the first working set percentage (W1 65%, W2 70%, W3 75%).',
  },
  {
    id: 'fsl-amrap',
    name: 'FSL AMRAP',
    description: 'One AMRAP set at the first working percentage. Best for Anchors.',
  },
  {
    id: 'bbb',
    name: 'Boring But Big (BBB)',
    description: '5×10 at 50/60/70% of TM across the 3 weeks. Volume-heavy — Leader only.',
  },
  {
    id: 'ssl',
    name: 'Second Set Last (SSL)',
    description: '5×5 at the second working percentage (W1 75%, W2 80%, W3 85%).',
  },
  {
    id: 'spinal-tap',
    name: 'Spinal Tap',
    description: '3×3 at the third (top) working percentage. Heavy, low volume.',
  },
  {
    id: 'widowmaker',
    name: 'Widowmaker',
    description: '1×20 at the first working percentage. Squat/deadlift only — brutal.',
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Defined per session.',
  },
];

export interface SupplementalConfig {
  templateId: SupplementalTemplateId;
  trainingMaxKg: number;
  week: WendlerWeek;
  roundingKg: number;
}

const FIRST_PCT: Record<WendlerWeek, number> = {
  1: 0.65,
  2: 0.7,
  3: 0.75,
  deload: 0.4,
};

const SECOND_PCT: Record<WendlerWeek, number> = {
  1: 0.75,
  2: 0.8,
  3: 0.85,
  deload: 0.5,
};

const THIRD_PCT: Record<WendlerWeek, number> = {
  1: 0.85,
  2: 0.9,
  3: 0.95,
  deload: 0.6,
};

const BBB_PCT: Record<WendlerWeek, number> = {
  1: 0.5,
  2: 0.6,
  3: 0.7,
  deload: 0.4,
};

/**
 * Build the supplemental sets for a session given a template, TM and week.
 * Returns an empty array for 'none' / 'custom' / deload (most templates don't run during deload).
 */
export function buildSupplementalSets(cfg: SupplementalConfig): PrescribedSet[] {
  const { templateId, trainingMaxKg, week, roundingKg } = cfg;
  if (templateId === 'none' || templateId === 'custom') return [];
  // Skip supplemental on deload weeks — recovery is the point.
  if (week === 'deload') return [];

  const w = (pct: number) => roundToIncrement(trainingMaxKg * pct, roundingKg);

  switch (templateId) {
    case 'fsl': {
      const weight = w(FIRST_PCT[week]);
      return Array.from({ length: 5 }, () => ({
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
      return Array.from({ length: 5 }, () => ({
        kind: 'supplemental',
        weightKg: weight,
        reps: 5,
        percentOfTm: SECOND_PCT[week],
      }));
    }
    case 'spinal-tap': {
      const weight = w(THIRD_PCT[week]);
      return Array.from({ length: 3 }, () => ({
        kind: 'supplemental',
        weightKg: weight,
        reps: 3,
        percentOfTm: THIRD_PCT[week],
      }));
    }
    case 'bbb': {
      const weight = w(BBB_PCT[week]);
      return Array.from({ length: 5 }, () => ({
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
