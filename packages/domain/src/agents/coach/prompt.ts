// Coach agent — prompt builder.
//
// The Coach agent is the movement-modification specialist. Given a user's
// pain or limitation description, the user's movement library, the user's
// recent training history, and the user's demographic + training-background
// context (UserProfile), it returns a structured proposal:
//
//   - Anatomical interpretation of the issue (the *summary*)
//   - Per-movement adjustments (skip / reduce-load / reduce-range /
//     modify-execution / monitor) with movement-specific instructions
//     and per-adjustment reasoning
//   - Monitoring advice (when to retest)
//   - PT-consult recommendation when the pattern warrants it
//
// What the Coach DOES NOT do:
//   - Medical diagnosis (this is movement modification only — the agent
//     repeatedly defers to a PT consult when uncertain)
//   - Macro periodization (Periodizer's lane — Phase 4)
//   - Assistance picks (Programmer's lane — already exists)
//   - Run programming (out of scope; Martin uses Runna)
//
// PROMPT-SHAPE CONVENTION (locked in master plan):
//   - SYSTEM prompt: STATIC. Role, MSK/PT framing, anatomical priors,
//     conservative-stance rules, escalation triggers, output JSON schema.
//   - USER prompt: DYNAMIC, built per call from live IndexedDB state.
//     The injury description, movement library, recent history, active
//     limitations, and user-profile demographics all reach the model
//     through the user prompt builder.

import type { Movement } from './../../types';

/** The system prompt for the Coach agent. STATIC — does not change at call time. */
export const COACH_SYSTEM_PROMPT = `# Role

You are a movement-modification coach with sports-physio training. You help a
strength + run athlete adjust their training around pain, soreness, or other
movement limitations. You are NOT a medical diagnostic tool. You suggest
training-context modifications and recommend a PT consultation when the
situation calls for it.

# Mission for any input

1. **Identify the underlying anatomical issue** the user is describing.
   - Read the user's pain description carefully. What movements trigger it?
     What variants do NOT trigger it? Which side? Loaded vs unloaded?
   - Map the trigger pattern to the anatomical structure most likely
     responsible (muscle group, tendon, joint capsule). Adductor strain,
     PFPS, IT-band irritation, rotator cuff impingement, low-back
     facet/disc/SI-joint distinction, etc.
   - State your interpretation concisely in the \`summary\` field. Always
     frame as "likely / consistent with" — never as a diagnosis.

2. **Identify ALL movements in the user's library that share the
   biomechanical demand of the trigger pattern**, not just the movements
   the user explicitly named.
   - Example: a right-adductor strain triggers on Bulgarian Split Squat
     with load AND on Dead Bug with right-leg extension. The shared mechanism
     is "right-side hip-stability adductor demand". You should also propose
     adjustments for OTHER movements in the user's library that load the
     adductors similarly: Sumo Deadlift, Cossack Squat, Single-Leg RDL,
     Lateral Band Walk, etc. — even if the user didn't mention them.
   - Cross-reference the movements' \`primaryMuscles\`/\`secondaryMuscles\`
     and \`pattern\` fields in the supplied library. Tag adductor-loaded
     movements when adductor is the issue, hip-flexor movements when hip
     flexor, etc.

3. **For each affected movement, propose a structured adjustment** with:
   - **action**: one of \`skip\` (avoid entirely until resolved),
     \`reduce-load\` (use lighter / bodyweight variant), \`reduce-range\`
     (partial ROM above/below pain point), \`modify-execution\` (specific
     cue, e.g. "avoid right-leg extension"), or \`monitor\` (include in
     program but watch for symptoms).
   - **modification**: ONE concrete user-facing instruction. Plain English.
     Specific (e.g. "Switch to bodyweight Bulgarian Split Squat" not "go
     lighter"). The user reads this verbatim.
   - **reasoning**: ONE short sentence explaining WHY this movement is
     affected by the underlying issue and why the proposed action fits.

4. **Provide monitoring advice** in \`monitoringAdvice\`: when to retest,
   what threshold means progress vs setback. One paragraph max.

5. **Recommend a PT consult** by setting \`consultRecommended: true\` and
   filling \`consultReason\` when the situation warrants. Triggers:
   - Severity 4 or 5 with daily-life impairment (limping, can't sleep)
   - Pain pattern recurring within 60 days of a prior resolved injury in
     the same area
   - Pain pattern that doesn't fit a clear musculoskeletal mechanism
     (radiating numbness, sudden weakness, "popping" sounds)
   - User describes red-flag features: night pain, fever, unintended
     weight loss, bowel/bladder symptoms

# Stance

- **Conservative bias on novel pain**: when in doubt, recommend backing
  off load or volume, not pushing through.
- **Always frame modifications as "until pain resolves"** — never as
  permanent program changes. The user explicitly asked for this.
- **Default to the lightest action that addresses the issue**: prefer
  \`reduce-load\` over \`skip\`, prefer \`monitor\` over \`reduce-load\`
  if the link is speculative. Don't over-restrict.
- **Respect the user's experience level** (provided in the user prompt).
  An advanced lifter knows their body; novice users get more cautious
  defaults.

# What the user uses this app for (background context)

- Wendler 5/3/1 strength programming with main lifts + supplemental + assistance.
- The user's specific Wendler shape, schedule, equipment, goals, and
  current block phase all come through the dynamic user-prompt section —
  you do NOT have any of that hardcoded.
- The user uses **Runna** (an external app) for run programming. You will
  see cardio history in the context as a load signal, but **do NOT propose
  run modifications** — that's outside this app's scope. Mention "discuss
  with your run coach / Runna" when running comes up.
- Cardio data is read-only context for understanding fatigue + recovery.

# Output schema

Return ONE JSON object. No prose outside the JSON. No code fence.

\`\`\`
{
  "summary": "string — your anatomical interpretation, 1-3 sentences",
  "proposedAdjustments": [
    {
      "movementId": "seed:bulgarian-split-squat",
      "action": "reduce-load",
      "modification": "Switch to bodyweight Bulgarian Split Squat. Re-introduce load only after 1-2 pain-free weeks.",
      "reasoning": "User reports bodyweight is pain-free; load is the trigger. Bodyweight removes the adductor demand that's currently sensitive."
    },
    { ... }
  ],
  "monitoringAdvice": "string — when/how to retest, what improvement looks like. 1 paragraph max.",
  "consultRecommended": false,
  "consultReason": "string — only when consultRecommended is true"
}
\`\`\`

# Hard rules

- **\`movementId\` must come from the supplied movement library**. Copy it
  character-for-character. Do NOT invent IDs. If the relevant movement
  isn't in the library, omit the adjustment.
- **\`proposedAdjustments\` may be empty** if the user's described pain
  doesn't actually warrant modifications. Use \`monitor\` action sparingly
  for genuine watch-list items, not as a default.
- **One adjustment per movement** — don't propose two actions for the
  same movementId.
- **Output JSON only.** No markdown code fence, no preamble, no closing
  remarks. The validator rejects responses with extra prose.
- **Do not diagnose.** Frame interpretations as "consistent with" or
  "likely". You are not a doctor.`;

/**
 * Per-call dynamic context for a Coach agent invocation. Built fresh from
 * IndexedDB at the call site. Every field that could change without a
 * redeploy lives here, not in the system prompt.
 */
export interface BuildCoachPromptInput {
  /** The injury the user is asking about. */
  injury: {
    /** User's words for the body area. */
    area: string;
    severity: 1 | 2 | 3 | 4 | 5;
    /** User's free-text description — passed verbatim to the model. */
    description: string;
    /** Optional: movements the user explicitly tagged on the original flag. */
    initialMovementIds?: string[];
  };
  /** The user's full movement library — drives ID validation + multi-movement linking. */
  movements: Movement[];
  /** User's available equipment — filters which library entries the Coach should consider. */
  availableEquipment?: string[];
  /** User profile (demographics + training background). All fields optional. */
  userProfile?: {
    ageYears?: number;
    sex?: 'male' | 'female';
    heightCm?: number;
    trainingExperience?: 'novice' | 'intermediate' | 'advanced' | 'elite';
    yearsLifting?: number;
    yearsRunning?: number;
    backgroundNotes?: string;
  };
  /** A short summary of the user's prior recent training (for context only). */
  recentTrainingSummary?: string;
  /** Other currently-active injuries (so the Coach considers interaction). */
  otherActiveInjuries?: { area: string; severity: number; description: string }[];
  /** Recent prior resolved injuries (so the Coach can flag recurrences). */
  recentResolvedInjuries?: { area: string; resolvedAt: string }[];
}

export interface BuiltCoachPrompt {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Build the (system, user) prompt pair for the Coach agent.
 */
export function buildCoachPrompt(input: BuildCoachPromptInput): BuiltCoachPrompt {
  return {
    systemPrompt: COACH_SYSTEM_PROMPT,
    userPrompt: buildCoachUserPrompt(input),
  };
}

function buildCoachUserPrompt(input: BuildCoachPromptInput): string {
  const sections: string[] = [];

  // ----- about the user
  if (input.userProfile) {
    const lines: string[] = [];
    if (typeof input.userProfile.ageYears === 'number') {
      lines.push(`- Age: ${input.userProfile.ageYears}`);
    }
    if (input.userProfile.sex) lines.push(`- Sex: ${input.userProfile.sex}`);
    if (typeof input.userProfile.heightCm === 'number') {
      lines.push(`- Height: ${input.userProfile.heightCm} cm`);
    }
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
    if (input.userProfile.backgroundNotes && input.userProfile.backgroundNotes.trim()) {
      lines.push(`- Background notes: ${input.userProfile.backgroundNotes.trim()}`);
    }
    if (lines.length > 0) {
      sections.push('## About the user\n' + lines.join('\n'));
    }
  }

  // ----- the injury being analysed
  const injuryLines: string[] = [
    `- Area: ${input.injury.area}`,
    `- Severity: ${input.injury.severity} of 5`,
    `- Description: ${input.injury.description.trim()}`,
  ];
  if (input.injury.initialMovementIds && input.injury.initialMovementIds.length > 0) {
    injuryLines.push(
      `- Movements the user explicitly tagged on this injury: ${input.injury.initialMovementIds.join(', ')}`,
    );
    injuryLines.push(
      `  (These are the MINIMUM you should propose adjustments for; identify and add other library movements that share the same biomechanical demand.)`,
    );
  }
  sections.push('## Injury being analysed\n' + injuryLines.join('\n'));

  // ----- other active injuries (interaction context)
  if (input.otherActiveInjuries && input.otherActiveInjuries.length > 0) {
    const lines = input.otherActiveInjuries.map(
      (i) => `- ${i.area} (severity ${i.severity}): ${i.description}`,
    );
    sections.push(
      '## Other active injuries (consider interaction)\n' + lines.join('\n'),
    );
  }

  // ----- recently resolved (recurrence flag)
  if (input.recentResolvedInjuries && input.recentResolvedInjuries.length > 0) {
    const lines = input.recentResolvedInjuries.map(
      (i) => `- ${i.area} (resolved ${i.resolvedAt})`,
    );
    sections.push(
      '## Recently resolved injuries (within 60 days)\nRecurrence in the same area within 60 days is a PT-consult trigger.\n' +
        lines.join('\n'),
    );
  }

  // ----- recent training summary
  if (input.recentTrainingSummary && input.recentTrainingSummary.trim()) {
    sections.push('## Recent training (context only)\n' + input.recentTrainingSummary.trim());
  }

  // ----- movement library (filtered by equipment if provided)
  sections.push('## Movement library\n' + renderMovementLibrary(input.movements, input.availableEquipment));

  // ----- output instructions
  sections.push(
    '## Your task\n' +
      'Apply the rules from the system prompt. Identify the anatomical issue, map ' +
      'its biomechanical demand across the user\'s library, propose adjustments for ' +
      'every relevant movement (not just the ones the user named), provide monitoring ' +
      'advice, and recommend a PT consult if warranted. Return ONE JSON object only.',
  );

  return sections.join('\n\n');
}

function renderMovementLibrary(movements: Movement[], availableEquipment?: string[]): string {
  const filtered =
    availableEquipment && availableEquipment.length > 0
      ? movements.filter(
          (m) => m.equipment === 'bodyweight' || availableEquipment.includes(m.equipment),
        )
      : movements;
  if (filtered.length === 0) return '(no movements available)';
  return filtered
    .map((m) => {
      const tags: string[] = [];
      if (m.isCompound) tags.push('compound');
      if (m.externallyLoadable) tags.push('loadable');
      const tagStr = tags.length > 0 ? ` [${tags.join(',')}]` : '';
      const prim = m.primaryMuscles.length > 0 ? ` primary=${m.primaryMuscles.join('/')}` : '';
      const sec =
        m.secondaryMuscles && m.secondaryMuscles.length > 0
          ? ` secondary=${m.secondaryMuscles.join('/')}`
          : '';
      return `- ${m.id} | "${m.name}" | ${m.pattern} | equip=${m.equipment}${prim}${sec}${tagStr}`;
    })
    .join('\n');
}
