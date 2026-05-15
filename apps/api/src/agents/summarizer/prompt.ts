// Summarizer agent — system prompt + dynamic user-prompt builder.
//
// The Summarizer produces a structured weekly digest: training summary,
// strength trend, running/cardio, load + recovery, active limitations,
// looking-ahead. It is intentionally a RECONCILIATION + PRESENTATION
// specialist — not first-principles reasoning. The weeklyReview workflow
// calls Periodizer (for verdict) and (when there are active injuries)
// Coach for limitations summary, then feeds those outputs INTO the
// Summarizer's user prompt as pre-built specialist input.
//
// Static-vs-dynamic convention:
//   - System prompt: role, section schema, tone, output format. Constant.
//   - User prompt: raw signals for the week + specialist outputs.

export const SUMMARIZER_SYSTEM_PROMPT = `# Role

You are the weekly-review summarizer for Martin's Wendler 5/3/1 PWA. The user prompt routes you raw training signals for one week (Monday–Sunday) plus structured input from other specialists (Periodizer's verdict, Coach's active-limitations note when applicable). Your job is to turn this into a SHORT, COACH-TONED narrative the user reads on Sunday evening or Monday morning to understand how the week landed.

You are reconciliation and presentation. Do NOT generate first-principles training advice the specialists didn't supply — if Periodizer says "deload-now", you weave that in; you don't independently second-guess it.

# Sections

You MUST produce exactly the six sections below in this order, in the \`sections\` array. Skip a section's MARKDOWN body (leave it empty string) only when there's truly nothing to say (e.g. \`Active limitations\` when there are none). The heading stays.

1. \`Training summary\` — sessions logged, days trained, broad stroke ("3 lift days hit, 2 long runs, 1 missed accessory day"). ≤ 2 short paragraphs.
2. \`Strength trend\` — key main-lift work, any AMRAP PRs, e1RM trend if signalled. Concrete numbers. ≤ 2 paragraphs.
3. \`Running + cardio\` — total mileage, longest run, HR-zone distribution if available, modality mix. Empty body OK when the week had no cardio.
4. \`Load + recovery\` — TSB / CTL / ACWR direction this week, recovery entry averages, integrate Periodizer's verdict + headline. ≤ 2 paragraphs.
5. \`Active limitations\` — when the Coach input is present, summarise it in 2-4 sentences. Otherwise emit empty body (heading still rendered).
6. \`Looking ahead\` — what next week looks like given the verdict + the active block. ≤ 2 sentences. Action-oriented.

# Highlights

Also produce a flat \`highlights\` array — 2-4 short bullets fit for a chip strip at the top of the card. PRs, percentage shifts ("Weekly volume +12% vs trailing 4-week"), milestones ("First sub-5:00/km long run"). Skip the bullet if a candidate isn't genuinely notable; an empty array is acceptable.

# Tone

- Speak TO Martin in second person ("you", "your").
- Be specific. Cite numbers, not vibes. "Top set bench 110×7" beats "good bench session".
- Stay short. The card lives on Today/Stats; long-form goes in chat.
- Markdown OK: short bullets, occasional bold for emphasis. No tables. No code blocks.

# Output format — STRICT JSON

Return exactly one JSON object. No surrounding prose, no markdown, no code fences.

Schema:

{
  "weekStart": "YYYY-MM-DD",
  "weekEnd": "YYYY-MM-DD",
  "sections": [
    { "heading": "Training summary", "markdown": "..." },
    { "heading": "Strength trend", "markdown": "..." },
    { "heading": "Running + cardio", "markdown": "..." },
    { "heading": "Load + recovery", "markdown": "..." },
    { "heading": "Active limitations", "markdown": "..." },
    { "heading": "Looking ahead", "markdown": "..." }
  ],
  "highlights": ["string", ...]
}

Rules:
- \`weekStart\` and \`weekEnd\` must echo the values from the user prompt verbatim.
- \`sections\` must contain exactly 6 entries with the exact headings above in the exact order above.
- \`highlights\` length 0-4.
- Section markdown bodies ≤ 800 characters each.
`;

export interface BuildSummarizerPromptInput {
  /** ISO date of the Monday of the week being summarized. */
  weekStart: string;
  /** ISO date of the Sunday of the week being summarized. */
  weekEnd: string;
  /** Raw signals for the week, already aggregated by the caller. */
  rawSignals: {
    /** Lift sessions this week. */
    sessions: number;
    /** Sets logged across all sessions. */
    sets: number;
    /** Total tonnage in kg-reps. */
    tonnageKg: number;
    /** Top-set highlights per main lift (already deduped to one per lift). */
    topSets?: Array<{ lift: string; weightKg: number; reps: number; isPR?: boolean }>;
    /** Cardio totals. */
    cardio?: {
      runKm?: number;
      bikeKm?: number;
      cardioMin?: number;
      longestRunKm?: number;
      modalityMix?: Array<{ modality: string; minutes: number; sharePct: number }>;
    };
    /** Recovery entry averages for the week. Values 0-10. */
    recovery?: {
      avgFatigue?: number;
      avgSoreness?: number;
      avgSleepH?: number;
      entryCount: number;
    };
    /** Load signals at end of week. */
    loadEndOfWeek?: {
      tsb?: number;
      ctl?: number;
      atl?: number;
      acwr?: number;
    };
    /** Active block context. */
    activeBlock?: {
      name?: string;
      kind?: string;
      weekInBlock?: number;
      blockLengthWeeks?: number;
    };
    /** Volume vs trailing 4-week baseline (percent delta, e.g. +12.5). */
    volumeDeltaPct?: number;
  };
  /** Periodizer's verdict for this week (run before the Summarizer). */
  periodizer?: {
    verdict: string;
    headline: string;
    shortReply?: string;
  };
  /** Coach's summary of active limitations, if any. */
  coachLimitations?: {
    summary: string;
    activeCount: number;
  };
  /** Brief preview of next week's plan (built by the caller from the program). */
  nextWeekPreview?: string;
}

export interface BuiltSummarizerPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function buildSummarizerPrompt(
  input: BuildSummarizerPromptInput,
): BuiltSummarizerPrompt {
  return {
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    userPrompt: buildSummarizerUserPrompt(input),
  };
}

function buildSummarizerUserPrompt(input: BuildSummarizerPromptInput): string {
  const sections: string[] = [];
  const { rawSignals: r } = input;

  sections.push(`Week being summarised: ${input.weekStart} → ${input.weekEnd}`);

  const overview: string[] = [];
  overview.push(`- Lift sessions: ${r.sessions}`);
  overview.push(`- Sets logged: ${r.sets}`);
  overview.push(`- Tonnage: ${Math.round(r.tonnageKg)} kg`);
  if (typeof r.volumeDeltaPct === 'number') {
    const sign = r.volumeDeltaPct >= 0 ? '+' : '';
    overview.push(`- Volume vs trailing 4-week: ${sign}${r.volumeDeltaPct.toFixed(1)}%`);
  }
  if (r.activeBlock) {
    const parts: string[] = [];
    if (r.activeBlock.name) parts.push(r.activeBlock.name);
    if (r.activeBlock.kind) parts.push(`kind=${r.activeBlock.kind}`);
    if (typeof r.activeBlock.weekInBlock === 'number') parts.push(`week ${r.activeBlock.weekInBlock}`);
    if (typeof r.activeBlock.blockLengthWeeks === 'number') parts.push(`length ${r.activeBlock.blockLengthWeeks}w`);
    if (parts.length > 0) overview.push(`- Active block: ${parts.join(' · ')}`);
  }
  sections.push(`## Training totals\n${overview.join('\n')}`);

  if (r.topSets && r.topSets.length > 0) {
    const lines = r.topSets.map((t) => {
      const pr = t.isPR ? ' · 🏆 PR' : '';
      return `- ${t.lift}: ${t.weightKg}kg × ${t.reps}${pr}`;
    });
    sections.push(`## Top sets per main lift\n${lines.join('\n')}`);
  }

  if (r.cardio) {
    const lines: string[] = [];
    if (typeof r.cardio.runKm === 'number' && r.cardio.runKm > 0) {
      lines.push(`- Run distance: ${r.cardio.runKm.toFixed(1)} km`);
    }
    if (typeof r.cardio.bikeKm === 'number' && r.cardio.bikeKm > 0) {
      lines.push(`- Bike distance: ${r.cardio.bikeKm.toFixed(1)} km`);
    }
    if (typeof r.cardio.cardioMin === 'number' && r.cardio.cardioMin > 0) {
      lines.push(`- Total cardio time: ${Math.round(r.cardio.cardioMin)} min`);
    }
    if (typeof r.cardio.longestRunKm === 'number' && r.cardio.longestRunKm > 0) {
      lines.push(`- Longest run: ${r.cardio.longestRunKm.toFixed(1)} km`);
    }
    if (r.cardio.modalityMix && r.cardio.modalityMix.length > 0) {
      const mix = r.cardio.modalityMix
        .map((m) => `${m.modality} ${Math.round(m.sharePct)}%`)
        .join(', ');
      lines.push(`- Modality mix: ${mix}`);
    }
    if (lines.length > 0) sections.push(`## Cardio\n${lines.join('\n')}`);
  }

  if (r.recovery && r.recovery.entryCount > 0) {
    const lines: string[] = [];
    lines.push(`- Entries this week: ${r.recovery.entryCount}`);
    if (r.recovery.avgFatigue != null) lines.push(`- Avg fatigue: ${r.recovery.avgFatigue.toFixed(1)}/10`);
    if (r.recovery.avgSoreness != null) lines.push(`- Avg soreness: ${r.recovery.avgSoreness.toFixed(1)}/10`);
    if (r.recovery.avgSleepH != null) lines.push(`- Avg sleep: ${r.recovery.avgSleepH.toFixed(1)} h`);
    sections.push(`## Recovery\n${lines.join('\n')}`);
  }

  if (r.loadEndOfWeek) {
    const lines: string[] = [];
    if (r.loadEndOfWeek.tsb != null) lines.push(`- TSB: ${r.loadEndOfWeek.tsb.toFixed(1)}`);
    if (r.loadEndOfWeek.ctl != null) lines.push(`- CTL: ${r.loadEndOfWeek.ctl.toFixed(1)}`);
    if (r.loadEndOfWeek.atl != null) lines.push(`- ATL: ${r.loadEndOfWeek.atl.toFixed(1)}`);
    if (r.loadEndOfWeek.acwr != null) lines.push(`- ACWR: ${r.loadEndOfWeek.acwr.toFixed(2)}`);
    if (lines.length > 0) sections.push(`## Load signals (end of week)\n${lines.join('\n')}`);
  }

  if (input.periodizer) {
    const lines: string[] = [];
    lines.push(`- Verdict: ${input.periodizer.verdict}`);
    lines.push(`- Headline: ${input.periodizer.headline}`);
    if (input.periodizer.shortReply) {
      lines.push('');
      lines.push(`Periodizer's reasoning (use verbatim in the Load + recovery section when relevant):`);
      lines.push(input.periodizer.shortReply);
    }
    sections.push(`## Periodizer specialist input\n${lines.join('\n')}`);
  }

  if (input.coachLimitations && input.coachLimitations.activeCount > 0) {
    sections.push(
      `## Coach specialist input — active limitations\n- ${input.coachLimitations.activeCount} active limitation(s).\n\n${input.coachLimitations.summary}`,
    );
  }

  if (input.nextWeekPreview && input.nextWeekPreview.trim().length > 0) {
    sections.push(`## Next week preview\n${input.nextWeekPreview.trim()}`);
  }

  return sections.join('\n\n');
}
