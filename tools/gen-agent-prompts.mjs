// Generates docs/agent-prompts.md by calling each agent's prompt builder
// with a representative synthetic input. Run on demand:
//   node tools/gen-agent-prompts.mjs
// Re-run after any prompt change. The output is the actual prompt text
// the agents see — the only manually-authored part is the synthetic
// input below.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const coachMod = await import(pathToFileURL(join(repoRoot, 'packages/domain/src/agents/coach/prompt.ts')).href);
const periodizerMod = await import(pathToFileURL(join(repoRoot, 'packages/domain/src/agents/periodizer/prompt.ts')).href);
const summarizerMod = await import(pathToFileURL(join(repoRoot, 'packages/domain/src/agents/summarizer/prompt.ts')).href);
const programmerMod = await import(pathToFileURL(join(repoRoot, 'packages/domain/src/assistance-prompt.ts')).href);
const { buildCoachPrompt } = coachMod;
const { buildPeriodizerPrompt } = periodizerMod;
const { buildSummarizerPrompt } = summarizerMod;
const { buildAssistancePrompt } = programmerMod;

// Pull chat orchestrator SYSTEM_PROMPT_BASE from source (it lives in apps/api).
const chatSrc = readFileSync(join(repoRoot, 'apps/api/src/functions/chat.ts'), 'utf8');
const m = chatSrc.match(/const SYSTEM_PROMPT_BASE = `([\s\S]*?)`;/);
const chatSystemPrompt = m ? m[1].replace(/\\`/g, '`').replace(/\\\$/g, '$') : '(NOT FOUND)';

const sampleMovements = [
  { id: 'seed:bench-press', name: 'Bench Press', equipment: 'barbell', pattern: 'push-horizontal', isMainLift: true, isCompound: true, externallyLoadable: true, primaryMuscles: ['chest'], secondaryMuscles: ['triceps', 'shoulders'] },
  { id: 'seed:bulgarian-split-squat', name: 'Bulgarian Split Squat', equipment: 'dumbbell', pattern: 'squat', isCompound: true, externallyLoadable: true, primaryMuscles: ['quads', 'glutes'], secondaryMuscles: ['adductors', 'hamstrings'] },
  { id: 'seed:sumo-deadlift', name: 'Sumo Deadlift', equipment: 'barbell', pattern: 'hinge', isCompound: true, externallyLoadable: true, primaryMuscles: ['glutes', 'adductors'], secondaryMuscles: ['hamstrings', 'erectors'] },
  { id: 'seed:goblet-squat', name: 'Goblet Squat', equipment: 'dumbbell', pattern: 'squat', isCompound: true, primaryMuscles: ['quads'], secondaryMuscles: ['glutes', 'adductors'] },
  { id: 'seed:dip', name: 'Dip', equipment: 'bodyweight', pattern: 'push-vertical', isCompound: true, externallyLoadable: true, primaryMuscles: ['triceps', 'chest'] },
  { id: 'seed:face-pull', name: 'Face Pull', equipment: 'band', pattern: 'pull-horizontal', primaryMuscles: ['shoulders'], secondaryMuscles: ['traps'] },
];

const coach = buildCoachPrompt({
  injury: { area: 'right adductor', severity: 4, description: 'Pain on loaded Bulgarian split squat and on right-leg deadbug extension. Pain-free at bodyweight.', initialMovementIds: ['seed:bulgarian-split-squat'] },
  movements: sampleMovements,
  availableEquipment: ['barbell', 'dumbbell', 'band'],
  userProfile: { ageYears: 41, sex: 'male', heightCm: 184, trainingExperience: 'advanced', yearsLifting: 12, yearsRunning: 6 },
  recentTrainingSummary: 'Last 4 weeks: 12 lift sessions, marathon block, 4 long runs (16-22 km). No prior adductor history.',
  currentBlockPlan: {
    blockName: 'Leader 1 (Marathon prep)',
    days: [
      { dayLabel: 'Day 1 · Squat', assistance: [{ movementId: 'seed:bulgarian-split-squat', movementName: 'Bulgarian Split Squat' }, { movementId: 'seed:face-pull', movementName: 'Face Pull' }] },
      { dayLabel: 'Day 2 · Bench', assistance: [{ movementId: 'seed:dip', movementName: 'Dip' }] },
      { dayLabel: 'Day 3 · Deadlift', assistance: [{ movementId: 'seed:sumo-deadlift', movementName: 'Sumo Deadlift' }] },
    ],
  },
});

const periodizer = buildPeriodizerPrompt({
  question: 'I just finished week 3 of my Anchor block, AMRAPs felt good but my running is up. Should I deload next week or push into another Leader?',
  today: '2026-05-16',
  cursorLabel: 'Anchor 1, Week 3 complete',
  activeBlock: { name: 'Anchor 1', kind: 'anchor', weekInBlock: 3, blockLengthWeeks: 3, startedAt: '2026-04-26' },
  lastDeloadAt: '2026-03-29',
  upcomingRaces: [{ name: 'Helsinki Marathon', date: '2026-08-23', distanceKm: 42.2, priority: 'A' }],
  loadSignals: { tsb: -12.5, ctl: 78.2, atl: 90.7, acwr: 1.34 },
  recentRecovery: [
    { date: '2026-05-15', fatigue: 6, soreness: 5, sleepH: 7.2 },
    { date: '2026-05-14', fatigue: 5, soreness: 4, sleepH: 7.8 },
    { date: '2026-05-13', fatigue: 7, soreness: 6, sleepH: 6.5 },
  ],
  userProfile: { ageYears: 41, sex: 'male', trainingExperience: 'advanced', yearsLifting: 12, yearsRunning: 6 },
});

const summarizer = buildSummarizerPrompt({
  weekStart: '2026-05-11',
  weekEnd: '2026-05-17',
  rawSignals: {
    sessions: 3, sets: 24, tonnageKg: 14820,
    topSets: [{ lift: 'Bench', weightKg: 110, reps: 7, isPR: true }, { lift: 'Squat', weightKg: 150, reps: 5 }],
    cardio: { runKm: 48.2, longestRunKm: 22.0, cardioMin: 295 },
    recovery: { avgFatigue: 6.0, avgSoreness: 4.8, avgSleepH: 7.1, entryCount: 6 },
    loadEndOfWeek: { tsb: -12.5, ctl: 78.2, atl: 90.7, acwr: 1.34 },
    activeBlock: { name: 'Anchor 1', kind: 'anchor', weekInBlock: 3, blockLengthWeeks: 3 },
    volumeDeltaPct: 12.4,
  },
  periodizer: {
    verdict: 'deload-soon',
    headline: 'Deload after this week — ACWR has climbed and weeks-since-deload is at 6.',
    shortReply: 'Your ACWR is 1.34 and you have not deloaded in 6 weeks. Finish this block clean, then take a 7th-week deload before starting the next leader.',
  },
  nextWeekPreview: '7th-week deload (3 light sessions, no AMRAP, ~50% accessory volume).',
});

const programmer = buildAssistancePrompt({
  volume: { mainDayReps: 300, accessoryReps: 200 },
  days: [
    { mainLifts: ['squat'], label: 'Day 1' },
    { mainLifts: ['bench'], label: 'Day 2' },
    { mainLifts: ['deadlift'], label: 'Day 3' },
  ],
  movements: sampleMovements,
  goalFlags: { marathon: true, hypertrophy: false, aesthetics: false, longevity: true, pain: false },
  goalNotes: 'Marathon in 14 weeks. Keep posterior chain robust, prefer light accessory work the day before long runs.',
  activeGoalFlavors: ['marathon', 'longevity'],
  availableEquipment: ['barbell', 'dumbbell', 'band'],
  longRunDayIndices: [3],
  blockLabel: 'Leader 1 (Marathon prep)',
  blockKind: 'leader',
  phase: 'normal',
  weekScope: 1,
  mainScheme: 'classic-531',
});

const out = [];
out.push('# Agent prompts — full system + example user prompts');
out.push('');
out.push('> Auto-generated by `tools/gen-agent-prompts.mjs`. Re-run after any prompt change.');
out.push('');
out.push('> System prompts are STATIC (the literal string the agent receives every call). User prompts are DYNAMIC (built per-call from live IndexedDB state); the examples below show one concrete realisation with representative synthetic input — see each agent\'s `BuildXxxPromptInput` interface in `packages/domain/src/agents/` for the full input shape.');
out.push('');
out.push('## Agent overview');
out.push('');
out.push('| Agent | Endpoint | Model default | Job |');
out.push('|---|---|---|---|');
out.push('| Coach | `POST /api/workflows/analyzeInjury` | `claude-haiku-4-5` (override: `ANTHROPIC_COACH_MODEL`) | Analyse a logged injury → per-movement adjustments. |');
out.push('| Programmer | `POST /api/suggestAssistance` | `claude-sonnet-4-6` (override: `ANTHROPIC_MODEL`) | Fill assistance for a Wendler 5/3/1 block. |');
out.push('| Periodizer | `POST /api/agents/periodize` | `claude-sonnet-4-6` | Macro structure verdict (deload-now / taper-now / continue / …). |');
out.push('| Summarizer | `POST /api/agents/summarize` | `claude-sonnet-4-6` | Weekly review on `/stats`. Reconciles Periodizer + Coach inputs. |');
out.push('| Chat orchestrator | `POST /api/chat` | `claude-sonnet-4-6` (override: `ANTHROPIC_MODEL`) | The `/chat` page; can emit action chips + call the four specialists as tools. |');
out.push('');

function agentBlock(title, description, sys, exampleUserPrompt) {
  out.push('---');
  out.push('');
  out.push(`# ${title}`);
  out.push('');
  out.push(description);
  out.push('');
  out.push('## System prompt (static)');
  out.push('');
  out.push('```text');
  out.push(sys);
  out.push('```');
  out.push('');
  if (exampleUserPrompt) {
    out.push('## Example rendered user prompt');
    out.push('');
    out.push('```text');
    out.push(exampleUserPrompt);
    out.push('```');
    out.push('');
  }
}

agentBlock(
  'Coach',
  'Movement-modification specialist. Reads the user\'s injury description + library + recent training + (optionally) the active block plan, and returns a JSON object with `summary`, `proposedAdjustments[]`, `monitoringAdvice`, `consultRecommended`, `consultReason`. Source: `packages/domain/src/agents/coach/prompt.ts`.',
  coach.systemPrompt,
  coach.userPrompt,
);

agentBlock(
  'Programmer (AI assistance suggester)',
  'Fills assistance picks for a Wendler 5/3/1 block. Input: per-block volume budget, per-day main-lift assignment, movement library, training profile, active limitations, cardio-fatigue signal, optional cross-week context. Output: per-day `entries[]` with movement / sets / reps / rationale, plus `blockRationale[]`. Source: `packages/domain/src/assistance-prompt.ts` (re-exported under `agents/programmer/`).',
  programmer.systemPrompt,
  programmer.userPrompt,
);

agentBlock(
  'Periodizer',
  'Macro-structure specialist. Input: the user\'s question, today\'s date, active block, last deload date, upcoming races, pre-computed Banister/ACWR signals, recent recovery, active limitations. Output: a verdict from a fixed vocabulary (`deload-now` / `deload-soon` / `continue` / `taper-now` / `ramp-up` / `tm-test` / `extend-block`) plus headline, explanation, evidence, next-steps. Source: `packages/domain/src/agents/periodizer/prompt.ts`.',
  periodizer.systemPrompt,
  periodizer.userPrompt,
);

agentBlock(
  'Summarizer',
  'Weekly-review reconciler. Input: aggregated raw signals for one ISO week + Periodizer\'s verdict + (optionally) Coach\'s active-limitations summary. Output: structured JSON with 6 sections (Training summary / Strength trend / Running + cardio / Load + recovery / Active limitations / Looking ahead) plus a flat `highlights[]` array. Source: `packages/domain/src/agents/summarizer/prompt.ts`.',
  summarizer.systemPrompt,
  summarizer.userPrompt,
);

agentBlock(
  'Chat orchestrator',
  'The `/chat` page. Grounded in a training-data snapshot built from IndexedDB. Can call Coach / Programmer / Periodizer / Summarizer as Anthropic tools (`consult_coach`, `consult_programmer`, `consult_periodizer`, `summarize_week`). Emits a sidecar `<actions>` JSON block when it has a concrete recommendation; the server intercepts the tag before flushing prose to the client. Source: `apps/api/src/functions/chat.ts`. The user prompt is the conversation messages array plus a small header injection (date + current page); the snapshot itself is appended to the system prompt at runtime.',
  chatSystemPrompt,
  '(The chat user prompt is the messages[] array, not a single rendered string. The training-data snapshot is appended to the system prompt at runtime. See `buildChatContext` in `apps/web/src/lib/chat-context.ts` for what goes into the snapshot.)',
);

writeFileSync(join(repoRoot, 'docs/agent-prompts.md'), out.join('\n'), 'utf8');
console.log('Wrote docs/agent-prompts.md');
