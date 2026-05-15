import { describe, it, expect } from 'vitest';
import { buildSummarizerPrompt, SUMMARIZER_SYSTEM_PROMPT } from './prompt';
import { parseSummarizerResponse, SUMMARIZER_SECTION_HEADINGS } from './response';

describe('buildSummarizerPrompt', () => {
  const base = {
    weekStart: '2026-05-04',
    weekEnd: '2026-05-10',
    rawSignals: {
      sessions: 3,
      sets: 47,
      tonnageKg: 12500,
    },
  };

  it('always returns the static system prompt verbatim', () => {
    const a = buildSummarizerPrompt(base);
    expect(a.systemPrompt).toBe(SUMMARIZER_SYSTEM_PROMPT);
    for (const h of SUMMARIZER_SECTION_HEADINGS) {
      expect(a.systemPrompt).toContain(h);
    }
  });

  it('renders the week range, totals, and volume delta when present', () => {
    const { userPrompt } = buildSummarizerPrompt({
      ...base,
      rawSignals: { ...base.rawSignals, volumeDeltaPct: 12.5 },
    });
    expect(userPrompt).toContain('2026-05-04 → 2026-05-10');
    expect(userPrompt).toContain('Lift sessions: 3');
    expect(userPrompt).toContain('Sets logged: 47');
    expect(userPrompt).toContain('Tonnage: 12500 kg');
    expect(userPrompt).toContain('+12.5%');
  });

  it('renders top sets including PR markers', () => {
    const { userPrompt } = buildSummarizerPrompt({
      ...base,
      rawSignals: {
        ...base.rawSignals,
        topSets: [
          { lift: 'bench', weightKg: 110, reps: 7, isPR: true },
          { lift: 'squat', weightKg: 140, reps: 5 },
        ],
      },
    });
    expect(userPrompt).toContain('bench: 110kg × 7');
    expect(userPrompt).toContain('🏆 PR');
    expect(userPrompt).toContain('squat: 140kg × 5');
  });

  it('renders cardio with modality mix', () => {
    const { userPrompt } = buildSummarizerPrompt({
      ...base,
      rawSignals: {
        ...base.rawSignals,
        cardio: {
          runKm: 42.3,
          longestRunKm: 18.5,
          cardioMin: 245,
          modalityMix: [
            { modality: 'run', minutes: 200, sharePct: 82 },
            { modality: 'bike', minutes: 45, sharePct: 18 },
          ],
        },
      },
    });
    expect(userPrompt).toContain('Run distance: 42.3 km');
    expect(userPrompt).toContain('Longest run: 18.5 km');
    expect(userPrompt).toContain('Total cardio time: 245 min');
    expect(userPrompt).toContain('run 82%');
    expect(userPrompt).toContain('bike 18%');
  });

  it('renders recovery with /10 suffix and avg sleep h', () => {
    const { userPrompt } = buildSummarizerPrompt({
      ...base,
      rawSignals: {
        ...base.rawSignals,
        recovery: {
          avgFatigue: 5.2,
          avgSoreness: 3.0,
          avgSleepH: 7.4,
          entryCount: 6,
        },
      },
    });
    expect(userPrompt).toContain('Entries this week: 6');
    expect(userPrompt).toContain('Avg fatigue: 5.2/10');
    expect(userPrompt).toContain('Avg soreness: 3.0/10');
    expect(userPrompt).toContain('Avg sleep: 7.4 h');
  });

  it('renders Periodizer specialist input when present', () => {
    const { userPrompt } = buildSummarizerPrompt({
      ...base,
      periodizer: {
        verdict: 'deload-soon',
        headline: 'Strong week, deload due next.',
        shortReply: 'ACWR climbing toward the upper edge, but TSB still productive.',
      },
    });
    expect(userPrompt).toContain('## Periodizer specialist input');
    expect(userPrompt).toContain('Verdict: deload-soon');
    expect(userPrompt).toContain('Strong week, deload due next.');
    expect(userPrompt).toContain('ACWR climbing');
  });

  it('renders the active limitations section only when activeCount > 0', () => {
    const a = buildSummarizerPrompt({
      ...base,
      coachLimitations: { summary: 'Right adductor flare.', activeCount: 0 },
    });
    expect(a.userPrompt).not.toContain('Coach specialist input');

    const b = buildSummarizerPrompt({
      ...base,
      coachLimitations: { summary: 'Right adductor flare.', activeCount: 1 },
    });
    expect(b.userPrompt).toContain('Coach specialist input');
    expect(b.userPrompt).toContain('1 active limitation');
    expect(b.userPrompt).toContain('Right adductor flare.');
  });
});

describe('parseSummarizerResponse', () => {
  const validPayload = {
    weekStart: '2026-05-04',
    weekEnd: '2026-05-10',
    sections: [
      { heading: 'Training summary', markdown: '3 lift days, 2 long runs.' },
      { heading: 'Strength trend', markdown: 'Bench 110×7 (PR).' },
      { heading: 'Running + cardio', markdown: '42km total, longest 18.5km.' },
      { heading: 'Load + recovery', markdown: 'TSB -8, productive zone.' },
      { heading: 'Active limitations', markdown: '' },
      { heading: 'Looking ahead', markdown: 'Anchor Week 3 next; AMRAP push.' },
    ],
    highlights: ['Bench PR 110×7', 'Weekly volume +12% vs trailing 4-week'],
  };

  it('accepts a fully-formed valid payload', () => {
    const r = parseSummarizerResponse(JSON.stringify(validPayload));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sections).toHaveLength(6);
      expect(r.data.highlights).toEqual([
        'Bench PR 110×7',
        'Weekly volume +12% vs trailing 4-week',
      ]);
    }
  });

  it('strips a code fence', () => {
    const fenced = '```json\n' + JSON.stringify(validPayload) + '\n```';
    expect(parseSummarizerResponse(fenced).ok).toBe(true);
  });

  it('rejects a section in the wrong order', () => {
    const swapped = {
      ...validPayload,
      sections: [
        validPayload.sections[1], // Strength trend
        validPayload.sections[0], // Training summary
        ...validPayload.sections.slice(2),
      ],
    };
    const r = parseSummarizerResponse(JSON.stringify(swapped));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('heading must be'))).toBe(true);
  });

  it('rejects fewer than 6 sections', () => {
    const r = parseSummarizerResponse(
      JSON.stringify({ ...validPayload, sections: validPayload.sections.slice(0, 5) }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects weekStart that does not match the expected', () => {
    const r = parseSummarizerResponse(JSON.stringify(validPayload), {
      expectedWeekStart: '2026-05-11',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('weekStart'))).toBe(true);
  });

  it('rejects more than 4 highlights', () => {
    const r = parseSummarizerResponse(
      JSON.stringify({
        ...validPayload,
        highlights: ['a', 'b', 'c', 'd', 'e'],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('treats highlights as optional (empty array if omitted)', () => {
    const { highlights: _, ...rest } = validPayload;
    void _;
    const r = parseSummarizerResponse(JSON.stringify(rest));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.highlights).toEqual([]);
  });

  it('rejects a section markdown over 1500 chars', () => {
    const tooLong = {
      ...validPayload,
      sections: validPayload.sections.map((s, i) =>
        i === 0 ? { ...s, markdown: 'x'.repeat(1600) } : s,
      ),
    };
    const r = parseSummarizerResponse(JSON.stringify(tooLong));
    expect(r.ok).toBe(false);
  });

  it('rejects malformed weekStart string', () => {
    const r = parseSummarizerResponse(JSON.stringify({ ...validPayload, weekStart: '5/4/2026' }));
    expect(r.ok).toBe(false);
  });
});
