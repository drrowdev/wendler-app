import { describe, it, expect } from 'vitest';
import { buildPeriodizerPrompt, PERIODIZER_SYSTEM_PROMPT } from './prompt';
import { parsePeriodizerResponse } from './response';

describe('buildPeriodizerPrompt', () => {
  const base = {
    question: 'Should I deload this week?',
    today: '2026-05-15',
  };

  it('always returns the static system prompt verbatim', () => {
    const a = buildPeriodizerPrompt(base);
    expect(a.systemPrompt).toBe(PERIODIZER_SYSTEM_PROMPT);
    const b = buildPeriodizerPrompt({
      ...base,
      loadSignals: { tsb: -22, ctl: 60, atl: 82, acwr: 1.55 },
    });
    expect(b.systemPrompt).toBe(a.systemPrompt);
    // Sanity check — the system prompt must mention every verdict the
    // validator accepts so the model knows the vocabulary.
    for (const v of [
      'deload-now',
      'deload-soon',
      'continue',
      'taper-now',
      'ramp-up',
      'tm-test',
      'extend-block',
    ]) {
      expect(a.systemPrompt).toContain(v);
    }
  });

  it('renders the question, today, and active-block section when present', () => {
    const { userPrompt } = buildPeriodizerPrompt({
      ...base,
      cursorLabel: 'Anchor block, Week 2, Day 1',
      activeBlock: {
        name: 'Anchor 5/3/1 + SSL',
        kind: 'anchor',
        weekInBlock: 2,
        blockLengthWeeks: 3,
        startedAt: '2026-05-04',
      },
      lastDeloadAt: '2026-03-23',
    });
    expect(userPrompt).toContain('Should I deload this week?');
    expect(userPrompt).toContain('Today: 2026-05-15');
    expect(userPrompt).toContain('Anchor block, Week 2, Day 1');
    expect(userPrompt).toContain('kind=anchor');
    expect(userPrompt).toContain('week 2');
    expect(userPrompt).toContain('2026-03-23');
  });

  it('renders load signals with explicit numeric formatting', () => {
    const { userPrompt } = buildPeriodizerPrompt({
      ...base,
      loadSignals: { tsb: -18.4, ctl: 62, atl: 80.5, acwr: 1.47, acwrSimple: 1.49 },
    });
    expect(userPrompt).toContain('TSB: -18.4');
    expect(userPrompt).toContain('CTL (42d EWMA): 62.0');
    expect(userPrompt).toContain('ATL (7d EWMA): 80.5');
    expect(userPrompt).toContain('ACWR (rolling-uncoupled): 1.47');
    expect(userPrompt).toContain('ACWR (simple rolling): 1.49');
  });

  it('renders upcoming races sorted as supplied with priority', () => {
    const { userPrompt } = buildPeriodizerPrompt({
      ...base,
      upcomingRaces: [
        { name: 'Helsinki HM', date: '2026-06-07', distanceKm: 21.1, priority: 'A' },
        { name: 'Espoo 10k', date: '2026-05-24', distanceKm: 10, priority: 'C' },
      ],
    });
    expect(userPrompt).toContain('Helsinki HM');
    expect(userPrompt).toContain('21.1km');
    expect(userPrompt).toContain('priority A');
    expect(userPrompt).toContain('Espoo 10k');
  });

  it('renders the recovery section with /10 suffix to match the chat snapshot', () => {
    const { userPrompt } = buildPeriodizerPrompt({
      ...base,
      recentRecovery: [
        { date: '2026-05-14', fatigue: 7, soreness: 3, sleepH: 6.5 },
        { date: '2026-05-13', fatigue: 5, soreness: 1 },
      ],
    });
    expect(userPrompt).toContain('fatigue 7/10');
    expect(userPrompt).toContain('soreness 3/10');
    expect(userPrompt).toContain('sleep 6.5h');
    expect(userPrompt).toContain('0-10 Borg-style');
  });

  it('renders active limitations with the conservative-bias note', () => {
    const { userPrompt } = buildPeriodizerPrompt({
      ...base,
      activeLimitations: [
        { area: 'right adductor', severity: 3, summary: 'Strain under load; bodyweight OK.' },
      ],
    });
    expect(userPrompt).toContain('right adductor');
    expect(userPrompt).toContain('severity 3/5');
    expect(userPrompt).toContain('more conservative');
  });

  it('omits optional sections when fields are absent', () => {
    const { userPrompt } = buildPeriodizerPrompt(base);
    expect(userPrompt).not.toContain('## Load signals');
    expect(userPrompt).not.toContain('## Upcoming races');
    expect(userPrompt).not.toContain('## Recent recovery');
    expect(userPrompt).not.toContain('## Active limitations');
    expect(userPrompt).not.toContain('## About the user');
  });

  it('renders user profile when present', () => {
    const { userPrompt } = buildPeriodizerPrompt({
      ...base,
      userProfile: {
        ageYears: 39,
        sex: 'male',
        trainingExperience: 'advanced',
        yearsLifting: 14,
        yearsRunning: 8,
      },
    });
    expect(userPrompt).toContain('## About the user');
    expect(userPrompt).toContain('Age: 39');
    expect(userPrompt).toContain('Sex: male');
    expect(userPrompt).toContain('advanced');
    expect(userPrompt).toContain('14 yr lifting');
    expect(userPrompt).toContain('8 yr running');
  });
});

describe('parsePeriodizerResponse', () => {
  const validPayload = {
    verdict: 'deload-now',
    headline: 'Time to take the deload — fatigue signals say yes.',
    explanation: 'Your ACWR has been over 1.4 for two weeks and TSB is at -22. **Deload-now.** ...',
    evidence: [
      { label: 'ACWR', value: '1.47', interpretation: 'above sweet spot' },
      { label: 'Weeks since last deload', value: '7', interpretation: 'overdue' },
    ],
    nextSteps: ['Mark next week as deload in /program', 'Skip AMRAP on remaining sessions'],
    alternativeVerdicts: [
      { verdict: 'deload-soon', rationale: "If you can't move the race, finish this week first." },
    ],
    shortReply:
      "Deload now. Your ACWR has been over 1.4 for two weeks running and TSB just hit -22, which is the overreaching threshold.",
  };

  it('accepts a fully-formed valid payload', () => {
    const r = parsePeriodizerResponse(JSON.stringify(validPayload));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.verdict).toBe('deload-now');
      expect(r.data.evidence).toHaveLength(2);
      expect(r.data.nextSteps).toHaveLength(2);
      expect(r.data.alternativeVerdicts).toHaveLength(1);
    }
  });

  it('strips a markdown code fence defensively', () => {
    const fenced = '```json\n' + JSON.stringify(validPayload) + '\n```';
    const r = parsePeriodizerResponse(fenced);
    expect(r.ok).toBe(true);
  });

  it('rejects unknown verdict values', () => {
    const r = parsePeriodizerResponse(
      JSON.stringify({ ...validPayload, verdict: 'do-a-backflip' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('verdict must be'))).toBe(true);
  });

  it('rejects an empty evidence array', () => {
    const r = parsePeriodizerResponse(JSON.stringify({ ...validPayload, evidence: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('evidence'))).toBe(true);
  });

  it('rejects a missing shortReply', () => {
    const { shortReply: _omit, ...rest } = validPayload;
    void _omit;
    const r = parsePeriodizerResponse(JSON.stringify(rest));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('shortReply'))).toBe(true);
  });

  it('rejects an alternativeVerdict with an invalid verdict name', () => {
    const r = parsePeriodizerResponse(
      JSON.stringify({
        ...validPayload,
        alternativeVerdicts: [{ verdict: 'magic', rationale: 'because' }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('treats nextSteps and alternativeVerdicts as optional', () => {
    const { nextSteps: _ns, alternativeVerdicts: _av, ...rest } = validPayload;
    void _ns;
    void _av;
    const r = parsePeriodizerResponse(JSON.stringify(rest));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.nextSteps).toEqual([]);
      expect(r.data.alternativeVerdicts).toEqual([]);
    }
  });

  it('rejects an over-long headline', () => {
    const r = parsePeriodizerResponse(
      JSON.stringify({ ...validPayload, headline: 'x'.repeat(250) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('headline'))).toBe(true);
  });

  it('rejects an evidence entry with missing label', () => {
    const r = parsePeriodizerResponse(
      JSON.stringify({
        ...validPayload,
        evidence: [{ value: '1.47', interpretation: 'above sweet spot' }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('evidence[0].label'))).toBe(true);
  });
});
