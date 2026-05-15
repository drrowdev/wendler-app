// Periodizer agent — system prompt + dynamic user-prompt builder.
//
// The Periodizer is the macro-structure specialist. It reasons about WHEN
// and HOW MUCH (deloads, tapers, peaks, return-from-layoff ramps) — never
// about WHAT (assistance selection — that's the Programmer's job). It
// reads the same training data snapshot the chat agent has plus a small
// set of pre-computed signals (Banister CTL/ATL/TSB, rolling ACWR, weeks
// since last deload, upcoming priority races) and returns a structured
// verdict the UI can surface AND a short conversational reply the chat
// agent can fold into its reconciliation.
//
// Static-vs-dynamic convention:
//   - System prompt: role, Wendler conventions, ACWR/TSB anchors, output
//     schema. Constant.
//   - User prompt: built per-call from IndexedDB — current block + cursor,
//     last-deload date, upcoming races, raw load signals, recent training
//     summary, active limitations, user profile.

export const PERIODIZER_SYSTEM_PROMPT = `# Role

You are the periodization specialist for Martin's Wendler 5/3/1 PWA. The user-prompt routes you one specific question about MACRO STRUCTURE — when to deload, how to taper for a race, how to ramp back from a layoff, whether to extend a block, whether form/fatigue signals warrant a change. You do NOT prescribe specific assistance picks; that is the Programmer's lane.

# Wendler periodization anchors

- **Leader / Anchor cycle.** Leaders are higher-volume / lower-intensity blocks (5s PRO, 3s PRO, FSL/BBB supplemental). Anchors are higher-intensity / lower-volume blocks (5/3/1 + AMRAP, FSL/SSL supplemental). Standard cadence: 2 Leaders → 1 Anchor → 7th-week protocol → repeat.
- **7th-week protocols.** Three variants: \`deload\` (default — light singles, no AMRAP), \`tm-test\` (test current TM is sustainable), \`pr-test\` (singles working up). Use after every 2 Leaders + 1 Anchor (~6 weeks of normal-volume training).
- **Block default length.** 3 weeks of normal-volume work, then a 7th-week block. After 2 consecutive normal-volume blocks (6 weeks), a deload becomes the default 7th-week pick unless the user explicitly opts otherwise.
- **Taper for races.** A-priority race: 2 weeks of progressive volume cuts before race day (week-out ~70% normal volume, race-week ~40-50%), intensity preserved (top-set %TM unchanged). B-priority: 1 week light. C-priority: train through.
- **Return from layoff.** %TM cut proportional to time off — see the app's \`return-plan\` heuristic. <1 week off: no cut. 1-2 weeks: -5%. 2-4 weeks: -10%. >4 weeks: -15-20% + first cycle is a Leader (no AMRAP), no matter what block-kind the program said next.

# Load signal anchors

The user prompt includes pre-computed signals. Treat them as ground truth — don't recompute:
- **TSB (Training Stress Balance)** in arbitrary units. >+5 = fresh / overshoot, 0 to -10 = productive load, -10 to -20 = high fatigue, < -20 = overreaching. ACUTE form signal.
- **ACWR (uncoupled rolling 7d / prior 28d).** Sweet spot 0.8-1.3. <0.5 = undertraining (or detraining). 1.3-1.5 = stretched. >1.5 = high injury risk.
- **CTL (chronic load, 42d EWMA)** and **ATL (acute load, 7d EWMA)**. Trend, not threshold. Falling CTL during in-season = detraining.
- **Weeks since last deload.** ≥ 6 weeks with no deload + a non-Anchor next block = strong deload signal. ≥ 8 weeks = mandatory unless the user is mid-taper.

# How to handle the user's actual flavor

Martin's locked anchors (the user prompt will repeat the relevant ones):
- TM at 85% of true 1RM. Don't suggest changing this unless he asks.
- Marathon-prep is a primary secondary goal. Cardio is programmed externally in Runna — read it as a load signal in your reasoning, but never prescribe runs.
- 3 lift days/week (2 main + 1 accessory). 7th-week protocols use the same schedule.
- No cables in the gym (irrelevant to your lane but listed so you don't suggest substitutions outside it).

# Verdict vocabulary (use ONE of these in output \`verdict\`)

- \`deload-now\` — recommend taking the 7th-week deload starting next session.
- \`deload-soon\` — keep going this week but next block should be a deload; flag the trigger.
- \`continue\` — current plan is on track; no structural change needed.
- \`taper-now\` — begin the race-prep taper this week (race is ≤ 2 weeks away).
- \`ramp-up\` — return-from-layoff ramp; %TM cut + extra Leader block.
- \`tm-test\` — recommend a 7th-week TM-test protocol (e.g. after a clean Anchor with strong AMRAPs).
- \`extend-block\` — extend the current block one extra week (rare; only when signals look excellent and the user has time).

If multiple verdicts apply, pick the most actionable one and note the others in \`alternativeVerdicts\`.

# Output format — STRICT JSON

Return exactly one JSON object. No surrounding prose, no markdown, no code fences. Your entire response must start with \`{\` and end with \`}\`.

Schema:

{
  "verdict": "deload-now" | "deload-soon" | "continue" | "taper-now" | "ramp-up" | "tm-test" | "extend-block",
  "headline": "string — one user-facing sentence summarising the verdict, ≤ 110 chars",
  "explanation": "markdown — 2-4 paragraph reasoning the user reads in the UI",
  "evidence": [
    { "label": "string — short label (e.g. 'ACWR', 'Weeks since last deload')",
      "value": "string — the actual value as the user sees it (e.g. '1.47', '5')",
      "interpretation": "string — one short clause (e.g. 'above sweet spot', 'at the cusp')" }
  ],
  "nextSteps": [
    "string — concrete action the user can take, written imperatively (e.g. 'Mark next week as deload in /program')"
  ],
  "alternativeVerdicts": [
    { "verdict": "<same union as above>", "rationale": "string — one short clause why this is a runner-up" }
  ],
  "shortReply": "string — natural-language reply suitable for direct chat-tool embedding, ≤ 350 words, plain prose with light markdown. Speak TO Martin in second person ('your', 'you')."
}

Rules for the output:
- \`verdict\` is required and must be one of the seven values above.
- \`headline\` is the chip the UI shows above the explanation; write it like a coach's one-liner, not a status code.
- \`explanation\` is the long-form reasoning. Use markdown headings sparingly (max one **bold** lead-in per paragraph). Cite specific evidence values inline.
- \`evidence\` must include at least one entry — the signal that drove the verdict. Keep the array to ≤ 6 entries; ranked most-important first.
- \`nextSteps\` ≤ 5 entries. Each one a concrete action the user can take in the app or in training, not an abstract observation.
- \`alternativeVerdicts\` is optional. Use it when two verdicts were genuinely close.
- \`shortReply\` is what the chat orchestrator weaves into its reconciled answer when this agent is consulted as a tool. Keep it self-contained — the chat user may see it directly. Do NOT include JSON, code fences, or chip-style markup in \`shortReply\`.
- Never make up training data. If a signal isn't in the user prompt, say so ("I don't see recent recovery entries to confirm fatigue trend") rather than guessing.
`;

export interface BuildPeriodizerPromptInput {
  /** The user's question for the periodizer. Free text. */
  question: string;
  /** Today's local-time ISO date for "weeks-since" arithmetic in the reply. */
  today: string;
  /** Optional human-readable label for the user's current spot (e.g. "Anchor block, Week 2, Day 1"). */
  cursorLabel?: string;
  /** Current block kind + week scope if known. */
  activeBlock?: {
    name?: string;
    kind?: 'leader' | 'anchor' | 'standalone' | 'seventh-week';
    weekInBlock?: number; // 1 / 2 / 3 / 'deload' (encoded as the week number 4)
    blockLengthWeeks?: number;
    startedAt?: string; // ISO date
  };
  /** Date of the user's last fully-completed deload week, if known. */
  lastDeloadAt?: string;
  /** Upcoming priority races. */
  upcomingRaces?: Array<{
    name: string;
    date: string; // ISO date
    distanceKm?: number;
    priority?: 'A' | 'B' | 'C';
  }>;
  /** Pre-computed Banister + ACWR signals. Values may be null when the data history is too short. */
  loadSignals?: {
    /** Training stress balance, arbitrary units. */
    tsb?: number | null;
    /** Chronic training load (42-day EWMA). */
    ctl?: number | null;
    /** Acute training load (7-day EWMA). */
    atl?: number | null;
    /** Rolling-uncoupled ACWR (last 7d / prior 28d, no overlap). */
    acwr?: number | null;
    /** Same value with the simple rolling ratio that's NOT uncoupled — for reference. */
    acwrSimple?: number | null;
  };
  /** Recent recovery entries (last 14d, most recent first). Values on 0-10 Borg scale. */
  recentRecovery?: Array<{
    date: string;
    fatigue?: number;
    soreness?: number;
    sleepH?: number;
  }>;
  /** Short prose summary of the last 4 weeks of training (built by the caller). */
  recentTrainingSummary?: string;
  /** Active injuries / limitations — affects whether ramps / deloads should be conservative. */
  activeLimitations?: Array<{ area: string; severity: number; summary?: string }>;
  /** User profile — age / experience flavor for ramp-up timing. */
  userProfile?: {
    ageYears?: number;
    sex?: 'male' | 'female';
    trainingExperience?: 'novice' | 'intermediate' | 'advanced' | 'elite';
    yearsLifting?: number;
    yearsRunning?: number;
  };
}

export interface BuiltPeriodizerPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function buildPeriodizerPrompt(
  input: BuildPeriodizerPromptInput,
): BuiltPeriodizerPrompt {
  return {
    systemPrompt: PERIODIZER_SYSTEM_PROMPT,
    userPrompt: buildPeriodizerUserPrompt(input),
  };
}

function buildPeriodizerUserPrompt(input: BuildPeriodizerPromptInput): string {
  const sections: string[] = [];

  sections.push(`Today: ${input.today}`);

  if (input.userProfile) {
    const lines: string[] = [];
    if (typeof input.userProfile.ageYears === 'number') lines.push(`- Age: ${input.userProfile.ageYears}`);
    if (input.userProfile.sex) lines.push(`- Sex: ${input.userProfile.sex}`);
    if (input.userProfile.trainingExperience) {
      const yearsLift =
        typeof input.userProfile.yearsLifting === 'number'
          ? ` (${input.userProfile.yearsLifting} yr lifting)`
          : '';
      const yearsRun =
        typeof input.userProfile.yearsRunning === 'number'
          ? ` (${input.userProfile.yearsRunning} yr running)`
          : '';
      lines.push(`- Training experience: ${input.userProfile.trainingExperience}${yearsLift}${yearsRun}`);
    }
    if (lines.length > 0) sections.push(`## About the user\n${lines.join('\n')}`);
  }

  sections.push(`## Question routed to you\n${input.question.trim()}`);

  if (input.activeBlock || input.cursorLabel || input.lastDeloadAt) {
    const lines: string[] = [];
    if (input.cursorLabel) lines.push(`- Current spot: ${input.cursorLabel}`);
    if (input.activeBlock) {
      const ab = input.activeBlock;
      const parts: string[] = [];
      if (ab.name) parts.push(ab.name);
      if (ab.kind) parts.push(`kind=${ab.kind}`);
      if (typeof ab.weekInBlock === 'number') parts.push(`week ${ab.weekInBlock}`);
      if (typeof ab.blockLengthWeeks === 'number') parts.push(`length ${ab.blockLengthWeeks}w`);
      if (ab.startedAt) parts.push(`started ${ab.startedAt}`);
      if (parts.length > 0) lines.push(`- Active block: ${parts.join(' · ')}`);
    }
    if (input.lastDeloadAt) lines.push(`- Last completed deload week ended: ${input.lastDeloadAt}`);
    if (lines.length > 0) sections.push(`## Current program state\n${lines.join('\n')}`);
  }

  if (input.upcomingRaces && input.upcomingRaces.length > 0) {
    const lines = input.upcomingRaces.slice(0, 6).map((r) => {
      const parts = [`${r.date}: ${r.name}`];
      if (typeof r.distanceKm === 'number') parts.push(`${r.distanceKm}km`);
      if (r.priority) parts.push(`priority ${r.priority}`);
      return `- ${parts.join(' · ')}`;
    });
    sections.push(`## Upcoming races\n${lines.join('\n')}`);
  }

  if (input.loadSignals) {
    const s = input.loadSignals;
    const lines: string[] = [];
    if (s.tsb != null) lines.push(`- TSB: ${s.tsb.toFixed(1)}`);
    if (s.ctl != null) lines.push(`- CTL (42d EWMA): ${s.ctl.toFixed(1)}`);
    if (s.atl != null) lines.push(`- ATL (7d EWMA): ${s.atl.toFixed(1)}`);
    if (s.acwr != null) lines.push(`- ACWR (rolling-uncoupled): ${s.acwr.toFixed(2)}`);
    if (s.acwrSimple != null && s.acwrSimple !== s.acwr) {
      lines.push(`- ACWR (simple rolling): ${s.acwrSimple.toFixed(2)} (reference only — use the uncoupled value above for the verdict)`);
    }
    if (lines.length > 0) sections.push(`## Load signals\n${lines.join('\n')}`);
  }

  if (input.recentRecovery && input.recentRecovery.length > 0) {
    const lines = input.recentRecovery.slice(0, 14).map((r) => {
      const parts = [r.date];
      if (r.fatigue != null) parts.push(`fatigue ${r.fatigue}/10`);
      if (r.soreness != null) parts.push(`soreness ${r.soreness}/10`);
      if (r.sleepH != null) parts.push(`sleep ${r.sleepH}h`);
      return `- ${parts.join(' · ')}`;
    });
    sections.push(
      `## Recent recovery (last 14d, most recent first)\nScale: 0-10 Borg-style (1 = fresh / no soreness, 9 = wrecked / severe).\n${lines.join('\n')}`,
    );
  }

  if (input.recentTrainingSummary && input.recentTrainingSummary.trim().length > 0) {
    sections.push(`## Recent training (last 4 weeks)\n${input.recentTrainingSummary.trim()}`);
  }

  if (input.activeLimitations && input.activeLimitations.length > 0) {
    const lines = input.activeLimitations.map((l) => {
      const parts = [`- ${l.area} (severity ${l.severity}/5)`];
      if (l.summary) parts.push(l.summary);
      return parts.join(' — ');
    });
    sections.push(
      `## Active limitations\nThese should make any ramp or deload recommendation more conservative.\n${lines.join('\n')}`,
    );
  }

  return sections.join('\n\n');
}
