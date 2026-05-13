import type { ProgramBlock } from './blocks';
import type { SeventhWeekKind } from './types';

/**
 * 7th Week Protocol metadata used by the prompt UI. Source for blurbs:
 * 5/3/1 Forever (Wendler, 2017), Part 1 — "The Deload / 7th Week Protocol".
 */
export interface SeventhWeekVariantInfo {
  id: SeventhWeekKind;
  title: string;
  /** Short subtitle shown under the title in the chooser. */
  subtitle: string;
  /** Compact wave preview, e.g. "70%×5 · 80%×5 · 90%×5 · TM × 3–5". */
  wavePreview: string;
  /** Paragraph rendered on the chooser card and on the day page. */
  blurb: string;
}

export const SEVENTH_WEEK_VARIANTS: Record<SeventhWeekKind, SeventhWeekVariantInfo> = {
  'tm-test': {
    id: 'tm-test',
    title: '7th Week · TM Test',
    subtitle: 'Verify your training max',
    wavePreview: '70%×5 · 80%×5 · 90%×5 · TM × 3–5',
    blurb:
      'Work up to your training max and aim for 3–5 strong, fast reps. ' +
      'If you can\u2019t hit at least 3, your TM is too heavy — drop it. ' +
      'If you can do more than 5, leave it: only the standard 5–10 lb bump ' +
      'still applies. Use this prior to starting a new Leader template.',
  },
  deload: {
    id: 'deload',
    title: '7th Week · Deload',
    subtitle: 'Recover between Leader and Anchor',
    wavePreview: '70%×5 · 80%×3–5 · 90%×1 · TM × 1',
    blurb:
      'Work up to a single rep at your training max. No supplemental, ' +
      'light assistance, easy conditioning. The point of the deload is so ' +
      'you never need a deload — get ahead of fatigue rather than chasing ' +
      'it. Use this between your Leader pair and your Anchor.',
  },
  'pr-test': {
    id: 'pr-test',
    title: '7th Week · PR Test',
    subtitle: 'Push a top-set rep PR',
    wavePreview: '70%×5 · 80%×5 · 90%×5 · TM × PR',
    blurb:
      'Work up to your training max and push it for a rep PR or a goal ' +
      'number. Best for lifters who used 5\u2019s PRO for most of the prior ' +
      'phase and need a competitive top set. If you don\u2019t hit 3–5 reps, ' +
      'lower your TM before the next cycle.',
  },
};

export interface SeventhWeekRecommendation {
  /** Which variant the app suggests. null = no prompt right now. */
  recommended: SeventhWeekKind | null;
  /** Why we are (or are not) prompting. Useful for UI hints and tests. */
  reason: string;
}

/**
 * Decide whether to surface the 7th-week prompt for a program, and which
 * variant to highlight. Pure function: pass in the program\'s blocks.
 *
 * Macro structure assumed (per the user\'s convention, mirroring 5/3/1
 * Forever\'s default for most athletes):
 *   Leader → Leader → 7w (deload) → Anchor → 7w (TM/PR test) → repeat.
 *
 * Rules, scanning blocks in `sequenceIndex` order:
 *   - If any incomplete 7th-week block exists → no prompt (already queued).
 *   - Look at the *trailing* run of completed non-7w blocks since the last
 *     7w block (or since the start). Treat \'standalone\' blocks as neutral
 *     (skipped — they don\'t imply a Leader/Anchor cadence).
 *   - If the last completed block in that run is an Anchor, recommend
 *     TM Test (or PR Test if that anchor used \'5s-pro\').
 *   - Else if the last 2+ completed blocks in that run are all Leaders,
 *     recommend Deload.
 *   - Otherwise no prompt.
 */
export function nextSeventhWeekRecommendation(
  blocks: readonly ProgramBlock[],
): SeventhWeekRecommendation {
  if (blocks.length === 0) {
    return { recommended: null, reason: 'No blocks in program yet.' };
  }
  const sorted = [...blocks].sort(
    (a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0),
  );

  if (sorted.some((b) => b.kind === 'seventh-week' && !b.completedAt)) {
    return {
      recommended: null,
      reason: 'A 7th-week block is already scheduled or in progress.',
    };
  }

  // Walk back from the end, collecting the trailing run of completed
  // Leader/Anchor blocks since the most recent 7w (or the start).
  const trailing: ProgramBlock[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const b = sorted[i]!;
    if (b.kind === 'seventh-week') break;
    if (!b.completedAt) continue; // skip uncompleted blocks (and not-yet-started)
    if (b.kind === 'standalone') continue; // standalones don\'t affect cadence
    trailing.unshift(b);
  }

  if (trailing.length === 0) {
    return { recommended: null, reason: 'No completed Leader/Anchor blocks since last 7th week.' };
  }

  const last = trailing[trailing.length - 1]!;
  if (last.kind === 'anchor') {
    const usesFivesPro = last.mainScheme === '5s-pro';
    return {
      recommended: usesFivesPro ? 'pr-test' : 'tm-test',
      reason: usesFivesPro
        ? 'Anchor done with 5\u2019s PRO — push a PR before the next Leader.'
        : 'Anchor complete — verify your training max before the next Leader.',
    };
  }

  if (last.kind === 'leader') {
    const trailingLeaders = trailing.filter((b) => b.kind === 'leader').length;
    if (trailingLeaders >= 2) {
      return {
        recommended: 'deload',
        reason: `${trailingLeaders} Leader blocks complete — recover before your Anchor.`,
      };
    }
    return {
      recommended: null,
      reason: 'One Leader complete — Wendler suggests stacking another Leader before the 7th week.',
    };
  }

  return { recommended: null, reason: 'Trailing block kind not eligible for 7th-week prompt.' };
}
