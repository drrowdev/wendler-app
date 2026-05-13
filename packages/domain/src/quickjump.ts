/**
 * Tiny in-house fuzzy scorer for the Cmd-K palette. No new dependency.
 *
 * Score semantics (higher is better, 0 = no match):
 *   - 1000  exact case-insensitive match of full label
 *   -  900  label starts with query
 *   -  800  query matches the label's word-initials (e.g. "ph" → "Press Heavy")
 *   -  600  contiguous substring of the label
 *   -  100..500  fuzzy subsequence: every query char appears in order in the
 *                label, scored down by the size of the gaps between matches
 *
 * Ties are broken by:
 *   1. Source recency (newer items first) — passed in as `recencyBoost`
 *      between 0..50, added to the raw score.
 *   2. Shorter labels (fewer chars to skim).
 *
 * The scorer does not mutate or normalise the corpus; callers pass in lowercased
 * labels. Synonyms are matched by scoring against each synonym and keeping the
 * best score.
 */

export interface ScoreOptions {
  /** A value in [0, 50] added to the raw score so recent items float up on ties. */
  recencyBoost?: number;
}

const SCORE_EXACT = 1000;
const SCORE_PREFIX = 900;
const SCORE_INITIALS = 800;
const SCORE_SUBSTRING = 600;

/**
 * Score a single (query, label) pair. Both inputs should already be lowercased.
 * Returns 0 when there is no match at all.
 */
export function scoreMatch(
  query: string,
  label: string,
  options: ScoreOptions = {},
): number {
  if (!query) return 0;
  if (!label) return 0;
  const q = query.trim();
  if (!q) return 0;

  let raw = 0;
  if (label === q) {
    raw = SCORE_EXACT;
  } else if (label.startsWith(q)) {
    raw = SCORE_PREFIX;
  } else if (matchesInitials(q, label)) {
    raw = SCORE_INITIALS;
  } else {
    const idx = label.indexOf(q);
    if (idx >= 0) {
      // Substring; favour matches that start near a word boundary.
      const boundaryBonus = idx === 0 || /\s|[-_/]/.test(label.charAt(idx - 1)) ? 50 : 0;
      raw = SCORE_SUBSTRING + boundaryBonus - Math.min(idx, 50);
    } else {
      raw = subsequenceScore(q, label);
    }
  }

  if (raw <= 0) return 0;

  // Length penalty (capped) so shorter labels win ties.
  raw -= Math.min(label.length, 40);

  const boost = clamp(options.recencyBoost ?? 0, 0, 50);
  return raw + boost;
}

/**
 * Score a query against multiple synonyms (e.g. label + aliases). Returns the
 * single best score across all aliases.
 */
export function scoreBest(
  query: string,
  labels: readonly string[],
  options: ScoreOptions = {},
): number {
  let best = 0;
  for (const label of labels) {
    const s = scoreMatch(query, label, options);
    if (s > best) best = s;
  }
  return best;
}

function matchesInitials(query: string, label: string): boolean {
  // Take first char of each word; require query to be a prefix of those.
  const initials = label
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((word) => word.charAt(0))
    .join('');
  if (initials.length < query.length) return false;
  return initials.startsWith(query);
}

function subsequenceScore(query: string, label: string): number {
  // Every char of query must appear in label in order. Score = base − total gap.
  let labelIdx = 0;
  let gap = 0;
  let lastMatch = -1;
  for (let qi = 0; qi < query.length; qi += 1) {
    const ch = query.charAt(qi);
    const found = label.indexOf(ch, labelIdx);
    if (found < 0) return 0;
    if (lastMatch >= 0) gap += found - lastMatch - 1;
    lastMatch = found;
    labelIdx = found + 1;
  }
  // Base 500, lose a point per gap char, floor at 100.
  return Math.max(100, 500 - gap);
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
