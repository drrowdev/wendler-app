import { describe, it, expect } from 'vitest';
import { scoreBest, scoreMatch } from './quickjump';

describe('scoreMatch', () => {
  it('returns 0 for empty query', () => {
    expect(scoreMatch('', 'today')).toBe(0);
    expect(scoreMatch('   ', 'today')).toBe(0);
  });

  it('returns 0 for empty label', () => {
    expect(scoreMatch('q', '')).toBe(0);
  });

  it('returns 0 when no match at all', () => {
    expect(scoreMatch('xyz', 'today')).toBe(0);
  });

  it('exact match outranks prefix outranks substring', () => {
    const exact = scoreMatch('today', 'today');
    const prefix = scoreMatch('toda', 'today');
    const substring = scoreMatch('day', 'today');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(0);
  });

  it('matches word initials', () => {
    const initials = scoreMatch('pb', 'press bench');
    const subseq = scoreMatch('xz', 'press bench'); // no chars
    expect(initials).toBeGreaterThan(0);
    expect(subseq).toBe(0);
  });

  it('initials beat fuzzy subsequence', () => {
    const initials = scoreMatch('rp', 'race plan');
    const fuzzy = scoreMatch('rcn', 'race plan'); // r, c, n - subseq
    expect(initials).toBeGreaterThan(fuzzy);
  });

  it('shorter labels win ties on prefix', () => {
    const shortL = scoreMatch('pr', 'press');
    const longL = scoreMatch('pr', 'press accessory work');
    expect(shortL).toBeGreaterThan(longL);
  });

  it('substring near a word boundary scores higher than mid-word', () => {
    const boundary = scoreMatch('plan', 'race plan');
    const midWord = scoreMatch('lan', 'planning');
    expect(boundary).toBeGreaterThan(midWord);
  });

  it('subsequence with small gap beats one with big gap', () => {
    const tight = scoreMatch('abc', 'aabbcc'); // gaps: 1,1
    const loose = scoreMatch('abc', 'a' + 'x'.repeat(20) + 'b' + 'x'.repeat(20) + 'c');
    expect(tight).toBeGreaterThan(loose);
  });

  it('case-insensitive callers normalise upstream — scorer is case-sensitive', () => {
    // Documents the contract: callers must lowercase first.
    expect(scoreMatch('TODAY', 'today')).toBe(0);
    expect(scoreMatch('today', 'today')).toBeGreaterThan(0);
  });

  it('recencyBoost adds to score within 0..50', () => {
    const base = scoreMatch('press', 'press');
    const boosted = scoreMatch('press', 'press', { recencyBoost: 30 });
    const overflow = scoreMatch('press', 'press', { recencyBoost: 999 });
    expect(boosted - base).toBe(30);
    expect(overflow - base).toBe(50);
  });

  it('does not produce negative scores', () => {
    const s = scoreMatch('x', 'x'.repeat(200));
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

describe('scoreBest', () => {
  it('returns 0 with no aliases', () => {
    expect(scoreBest('today', [])).toBe(0);
  });

  it('takes the highest-scoring alias', () => {
    const best = scoreBest('log', ['history', 'log', 'past sessions']);
    const direct = scoreMatch('log', 'log');
    expect(best).toBe(direct);
  });

  it('a single matching synonym is enough', () => {
    const s = scoreBest('past', ['history', 'log', 'past sessions']);
    expect(s).toBeGreaterThan(0);
  });
});

describe('end-to-end ranking — fixture sanity', () => {
  // Catches regressions in the relative weights as the formula evolves.
  const corpus: { label: string; aliases?: readonly string[] }[] = [
    { label: 'today' },
    { label: 'analytics', aliases: ['stats', 'charts'] },
    { label: 'history', aliases: ['log', 'past sessions'] },
    { label: 'program' },
    { label: 'load', aliases: ['banister', 'fitness fatigue'] },
    { label: 'races' },
    { label: 'cardio' },
    { label: 'cardio plan' },
    { label: 'goals' },
    { label: 'movements' },
    { label: 'settings' },
    { label: 'recovery' },
    { label: 'press', aliases: ['ohp', 'overhead press'] },
    { label: 'bench' },
    { label: 'squat' },
    { label: 'deadlift' },
  ];

  function rank(query: string) {
    return corpus
      .map((c) => ({
        label: c.label,
        score: scoreBest(query.toLowerCase(), [c.label, ...(c.aliases ?? [])]),
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  it('"tod" → today first', () => {
    expect(rank('tod')[0]?.label).toBe('today');
  });

  it('"log" → history first via alias', () => {
    expect(rank('log')[0]?.label).toBe('history');
  });

  it('"ohp" → press first via alias', () => {
    expect(rank('ohp')[0]?.label).toBe('press');
  });

  it('"cp" → cardio plan via initials', () => {
    expect(rank('cp')[0]?.label).toBe('cardio plan');
  });

  it('"stats" → analytics via alias', () => {
    expect(rank('stats')[0]?.label).toBe('analytics');
  });

  it('"prog" → program', () => {
    expect(rank('prog')[0]?.label).toBe('program');
  });

  it('xyz returns nothing', () => {
    expect(rank('xyz')).toHaveLength(0);
  });
});
