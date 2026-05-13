/**
 * Assistance suggester — LLM prompt builder (Phase 3a).
 *
 * Produces the exact system + user prompts that will be sent to a chat LLM
 * once Phase 3b wires a backend. Today, the same strings render in the
 * SuggestAssistancePanel as a copyable preview so the user can paste them
 * verbatim into any chat client and validate the output format before we
 * automate it.
 *
 * Pure function. No side effects, no LLM calls. Output format is the source
 * of truth — Phase 3b will reuse it server-side and the response validator
 * will assert against the JSON schema described in the system prompt.
 */
import type { Movement, SeventhWeekKind, WendlerWeek } from './types';
import type { AssistanceEntry, AssistanceVolumeCustom, AssistanceVolumePreset, BlockDay, BlockKind } from './blocks';
import type { GoalFlags } from './goal-flags';
import { goalsToPromptContext, evaluateGoalsForRules } from './goal-flags';
import { constraintsToPromptContext } from './profile-directives';
import { WAVES, SEVENTH_WEEK_WAVES, type MainScheme } from './waves';

export interface BuildAssistancePromptInput {
  /** Resolved per-block volume budget. */
  volume: AssistanceVolumeCustom;
  /** Days in display order. Empty mainLifts == accessory day. */
  days: Pick<BlockDay, 'id' | 'mainLifts' | 'label'>[];
  /** Available Movement library. */
  movements: Movement[];
  /**
   * Goal flags. Pass `settings.goalFlags ?? DEFAULT_GOAL_FLAGS`. The same
   * struct that drives the rule engine drives the prompt — Phase 3b can
   * cross-validate the LLM response against `evaluateGoalsForRules(flags)`.
   */
  goalFlags: GoalFlags;
  /** Free-text user notes (the `goalNotes` field on `/goals`). Surfaced verbatim to the LLM. */
  goalNotes?: string;
  /** Existing per-day entries; the LLM is told NOT to duplicate movementIds present here. */
  existingPerDayEntries?: Array<AssistanceEntry[] | undefined>;
  /**
   * Cross-week context: per-day entries from OTHER week scopes within the
   * same block. Surfaced as a separate section the LLM may consult for
   * coherence (e.g. to know what curl variant Wk1 already chose if it
   * wants to match it), but variation is explicitly allowed —
   * Wendler 5/3/1 Forever (p.86): "I don't see any problem in changing
   * the exercises from workout to workout. It is the work that matters."
   *
   * Family-dedup rules still apply WITHIN the week being generated, not
   * across them.
   *
   * Each entry's `perDay` array is parallel to `days[]`. Empty/undefined
   * day slots indicate that week scope has nothing on that day.
   */
  otherWeeksContext?: Array<{
    /** Human-readable label, e.g. "Default plan", "Week 1", "Deload". */
    scopeLabel: string;
    perDay: Array<AssistanceEntry[] | undefined>;
  }>;
  /** Active goal flavors (strength/hypertrophy/functional/conditioning/prehab) aggregated from the user's goals. */
  activeGoalFlavors?: string[];
  /** True when an A-priority endurance race is inside taper window. */
  cardioPeakActive?: boolean;
  /** True when warmup config already covers prehab. */
  warmupCoversPrehab?: boolean;
  /** Available equipment in the current block / program. Empty/undefined = no restriction. */
  availableEquipment?: string[];
  /** Block-day indices that the user runs a long endurance effort on. */
  longRunDayIndices?: number[];
  /** Optional human label for the current block (e.g. "Cycle 8 — squat focus"). */
  blockLabel?: string;
  /**
   * Which week scope the suggestion is being generated for. When set to a
   * specific week (1 | 2 | 3 | 'deload' | '7w'), the prompt emits a
   * `## Main work this week` section with the exact sets × reps × %TM and
   * AMRAP flag for that week, computed from {@link mainScheme} and (for 7w)
   * {@link seventhWeekKind}. This lets the LLM match accessory volume and
   * intensity to the systemic load of the current week — most importantly,
   * to scale assistance down on deload and account for differing AMRAP
   * fatigue across the 5s/3s/5/3/1+ waves.
   *
   * Optional only for back-compat with older callers; the editor always
   * passes a specific week now (v287 removed the legacy "default" scope).
   */
  weekScope?: WendlerWeek;
  /** Main-work scheme for the block. Defaults to 'classic-531' when unset. */
  mainScheme?: MainScheme;
  /** Required when weekScope === '7w'. Selects the 7th-week wave variant. */
  seventhWeekKind?: SeventhWeekKind;
  /**
   * Kind of the block being suggested for (`leader` / `anchor` /
   * `standalone` / `seventh-week`). Surfaced as a one-liner in the block
   * summary so the LLM knows the block's macro role — anchors carry
   * heavier intensity / lower volume than leaders, etc. Optional for
   * back-compat with callers (older tests) that don't set it.
   */
  blockKind?: BlockKind;
  /**
   * Effective training phase the block is in right now (`normal` /
   * `deload` / `taper` / `peak`). Surfaced in the block summary as a
   * single "Active phase: X" line so the LLM can frame its picks. When
   * omitted, no phase line is rendered.
   */
  phase?: 'normal' | 'deload' | 'taper' | 'peak';
  /**
   * When the assistance-volume preset was auto-shifted upstream because
   * of the active phase (e.g. `standard → minimal` on a deload week),
   * passing the `from`/`to` pair surfaces it explicitly in the block
   * summary. Pairs with the system-prompt instruction "the budget you
   * see is already phase-adjusted, do NOT cut volume further".
   */
  phasePresetShift?: { from: AssistanceVolumePreset; to: AssistanceVolumePreset };
  /**
   * When true, suppress the phase-driven `volumeMultiplier` directive
   * (and its prompt line) so it doesn't compound with the
   * assistance-volume preset auto-shift. Pass `true` when phase was
   * auto-derived (race or block) and is non-normal; the preset shift
   * already cuts the rep budget for those phases.
   */
  suppressPhaseVolumeMultiplier?: boolean;
  /**
   * Cardio-fatigue shift — small negative integer that triggers a
   * "Recent cardio load" section in the prompt telling the LLM to trim
   * accessory volume by ~10–15% (max 20%). Computed in suggester-context
   * from the trailing 7-day vs 28-day weighted-cardio-minute delta and
   * already suppressed during deload/taper phases. Pass through verbatim.
   *
   * Defaults to 0 (no section emitted). Optional for back-compat with
   * older callers / tests.
   */
  cardioFatigueShift?: -2 | -1 | 0;
  /**
   * Diagnostics that go alongside `cardioFatigueShift` when it's non-zero
   * so the LLM can quote real numbers in its rationale. Ignored when
   * `cardioFatigueShift === 0`.
   */
  cardioFatigue?: {
    recentWeightedMin: number;
    baselineWeightedMin: number;
    deltaPct: number | null;
    /**
     * Modality breakdown of the trailing 7-day weighted minutes, sorted
     * by share descending. Surfaced in the "Recent cardio load" section
     * so the LLM can apply movement-overlap reasoning when picking trim
     * targets (running → posterior chain; cycling → quads/glutes;
     * swim/row → lats/back).
     */
    recentModalityMix?: Array<{ modality: string; weightedMin: number; sharePct: number }>;
  };
  /**
   * Four-axis training profile context (Phase 2). Optional — when present,
   * emitted as an additional priority section ahead of the legacy goal-flag
   * directives so the LLM has explicit primary/secondary/phase reasoning
   * material. The legacy `goalFlags` field is still the source of truth for
   * the rule-engine directives, and is expected to already reflect any
   * phase-driven suppression (see `deriveGoalFlags` in training-profile.ts).
   */
  trainingProfileContext?: {
    primaryGoal: string;
    secondaryGoals: string[];
    trainingPhase: 'normal' | 'deload' | 'taper' | 'peak';
    /** Operational prompt strings from `phaseDirective()`, one per affected secondary. */
    phaseDirectives?: { secondary: string; directive: string }[];
    /** Filters (formerly "Tier 3 constraints") — surfaced as a separate "Filters" section. */
    constraints?: { kind: string; label: string }[];
  };
}

export interface BuiltAssistancePrompt {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Build the (system, user) prompt pair for the assistance suggester LLM.
 *
 * The system prompt is static-ish: it defines the role, the Wendler 5/3/1
 * Forever conventions, the slot vocabulary, and the strict JSON output
 * schema. The user prompt is the per-request payload: block context, goal
 * context, existing entries, and the movement library the LLM may pick from.
 *
 * Token budget target: ≤ 4k tokens for typical inputs. Movement library is
 * the main driver — keep it lean by including only the fields the LLM needs.
 */
export function buildAssistancePrompt(input: BuildAssistancePromptInput): BuiltAssistancePrompt {
  return {
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt(input),
  };
}

const SYSTEM_PROMPT = `You are an assistance-movement suggester for a Wendler 5/3/1 Forever training block. Your single job is to propose accessory movements that complement the user's main lifts for the block (or specific week scope) described in the user message. You do NOT modify main lifts, supplemental sets, warmups, or cardio.

The user message conveys the block's actual shape: number of training days, main-lift assignment per day, main-work scheme (classic 5/3/1, 5s PRO, or 3/5/1), the per-block volume budget, the user's Training Profile (primary goal / secondary goals / phase / user-authored Filters), and — when relevant — the cross-week context for the rest of the block. Do not assume a fixed block length; honor what the user message says.

# Wendler Forever conventions you must respect

1. Every main-lift day hits **3 categories**: push + pull + (single-leg or core or isolation or carry). Volume per category: 25–100 reps total per movement.
2. Pure accessory days (no main lift) hit 3–6 movements weighted toward the user's goal flavors. All slot types from the vocabulary are eligible on accessory days; selection should reflect goal flavor weights rather than the fixed push+pull+third pattern.
3. **Pair-awareness** (per main lift on the day):
   - bench → push assistance prefers shoulders/triceps over more chest.
   - press (overhead) → push assistance prefers **triceps** (dips, skull crushers, close-grip variants) over more vertical pressing. The shoulders are already loaded by the main lift + supplemental; another shoulder-press variant is a third stimulus to the same primary mover.
   - deadlift → pull assistance prefers back/biceps over more posterior-chain pulling.
   - squat → single-leg slot prefers posterior-chain over more quads.
   General principle: push/pull assistance should avoid duplicating the **primary mover** of the main lift on the day, even when the implement differs (e.g. dumbbell shoulder press on an OHP day = same primary mover).
   When two main lifts share a day (e.g. bench + deadlift), apply each rule to its matching slot independently: the push slot follows the bench rule, the pull slot follows the deadlift rule. Do NOT mix.
4. **Honor the user's volume budget — this is the hardest constraint.** The per-day "main day reps" and "accessory day reps" numbers in the user message are **assistance-only** budgets — they exclude main lifts, supplemental (FSL/SSL) sets, and warmups. The budget you see is already **phase-adjusted** (deload/taper/peak shift the preset upstream before this prompt is built), so do NOT cut volume further on those phases unless a directive in the user message tells you to. You may exceed by at most 20%; beyond that the response is rejected. If goal mandates (e.g. "MUST include calf raise") would push you over budget on a given day, **distribute mandates across other days first**, then drop the lowest-priority non-mandated slot. Priority order when trimming: (a) keep all goal-mandated movements, (b) keep prehab/shoulder-health, (c) drop optional accessories. Never drop a calf raise to fit an extra curl.
5. **No duplicate movements within the week you're generating, AND prefer fresh movements across weeks of the same block.** Two-layer rule:
   - **Within the current week:** do not repeat a movementId across days of the current week (Week 1/2/3 or Deload). The user's existing entries are listed in the input; treat their movementIds as already-used in this week.
   - **Across weeks of the same block:** when the "Cross-week context" section is present, you **MUST pick a different specific movementId** for each slot than what other weeks of this block already use, as long as a same-family alternative is available in the movement library OR can be proposed as a \`newMovement\` (see rule 10). Wendler explicitly endorses this: "I don't see any problem in changing the exercises from workout to workout. It is the work that matters." (*5/3/1 Forever*, p.86). Same-family rotation across weeks (e.g. Wk1 Goblet Squat → Wk2 Bulgarian Split Squat → Wk3 Step-up for the single-leg slot) gives the user variety while keeping slot composition coherent.
   - **You MAY repeat a specific movementId across weeks** only when ALL of: (a) the library has no equally-good same-family alternative under the user's active equipment + filters, AND (b) you have already considered proposing a \`newMovement\` and judged it not safe to introduce. State which condition triggered the repetition in the \`rationale\`.
6. **Movement-family dedup.** Treat these families as one slot per week being generated — pick at most one variant from each across the active week:
   - **deadlift family** (bilateral hinge): conventional / sumo / trap-bar / Romanian deadlift / good morning. If a deadlift main lift is on the schedule, pick ZERO additional deadlift-family assistance.
   - **squat family** (bilateral squat-pattern): back / front / zercher / safety-bar / box / hatfield. If a squat main lift is scheduled, pick ZERO additional squat-family assistance.
   - **muscle-up family**: bar muscle-up and ring muscle-up are the same family — one variant per scope, not both.
   - **olympic family**: snatch / clean / jerk variants — one per scope.
   - **single-leg** stays a separate family from squat and deadlift (it serves different purposes — balance, asymmetry correction, single-stance running mechanics — and must not be substituted for either).
7. **High-skill rep ceiling.** Movements requiring elite skill — muscle-ups, pistol squats, shrimp squats, handstand pushups, one-arm pushups, planche / front-lever progressions — must be prescribed at **3-5 reps per set** (never 8+). Use \`sets: 3-5, reps: 3, repsMax: 5\` style prescriptions, never hypertrophy ranges.
8. **Pre-long-run conditioning veto.** On days flagged as pre-long-run (see directive section), in addition to avoiding heavy lower-body, also avoid CNS-taxing metabolic conditioning hybrids: devil press, burpees, thrusters, kettlebell swings, wall balls, man-makers, sled pushes. These belong on hard cardio days, not the day before a long run.
9. **Prehab concentration.** Prehab/activation movements (face pulls, band pull-aparts, scapular work like Y-T-W raises, hip-stability bands such as clamshells / lateral band walks / glute bridges, hip-mobility drills) are **maintenance volume** and should not crowd out the day's primary stimulus. Apply these limits:
   - **Prefer the accessory day for prehab.** Concentrate prehab volume on the pure-accessory day(s) — that is the natural home for maintenance work. On a 4-day schedule with one accessory day, aim for **2–3 prehab slots on the accessory day** if the user has shoulder-health or injury-prevention as an active goal/filter, **0–1 otherwise**.
   - **Cap prehab on main-lift days at 1 slot per session.** Even when shoulder-health is a goal, do NOT include more than one prehab movement on any single main-lift day. If the warmup already covers prehab (see directive), allocate **zero** prehab on main-lift days.
   - **Across the whole training week**, total prehab slots should not exceed roughly the count of training days ÷ 2 (i.e. on a 4-day week, ≤2 prehab slots in the entire week unless a user goal explicitly mandates more). Face pulls + band pull-aparts on every single day is over-prescription — pick one of the two and place it once or twice across the week.
   - When a prehab slot is dropped from a main-lift day to honor this rule, do NOT replace it with another prehab movement; replace with a deficit slot type (push/pull/single-leg/core/isolation/carry per pair-awareness) or omit if the volume budget is already met.
10. **Movement selection — pick from library OR propose new when variety demands it.**
   - The user's movement library is rendered below in the user message. **Prefer** picking a \`movementId\` from that library when a fresh same-family fit exists.
   - **When rule 5's cross-week variation requirement forces you off the most-obvious library pick** and the remaining library entries in the same family don't fit the slot as well, you SHOULD return a \`newMovement\` instead of repeating a cross-week pick. A good novel pick that adds variety is preferable to repeating last week's exact movementId. Don't be timid here — the user explicitly wants week-to-week variation, and the library is finite.
   - Don't propose new variants of movements already well-covered (e.g. don't add another curl variant when the library has 3 curls and you have a Wk1 curl already).
   - **DO NOT prefix the implement into a \`newMovement.name\`.** The implement is already captured by the \`equipment\` field. Examples of wrong names: "Dumbbell Step-up" when the library has "Step-up" (equip=dumbbell), "Barbell Squat" when there's already "Back Squat", "Kettlebell Goblet Squat" when the library has "Goblet Squat" (equip=dumbbell). Compare your proposed name to the library by **the bare exercise name only**, ignoring any implement word. If the bare name matches an existing library entry, use that entry's \`movementId\` instead of inventing a duplicate.
   - Either way, equipment must be in the available list — for \`movementId\` it's pre-filtered for you; for \`newMovement\` you must set \`equipment\` to one of the user's available types (bodyweight is always allowed even when not listed).
   - When you return \`newMovement\` it will be added to the user's library on accept and tracked across future blocks (e1RM history starts from the very first set), so propose movements you're confident the user can perform safely with their available equipment.
11. **7th-week blocks are special.** A 7th-week block is a single-week recovery/test cycle (\`deload\`, \`tm-test\`, or \`pr-test\` variant). When the user message describes a 7th-week scope, follow the variant-specific intent line in the "Main work this week" section literally — typically that means very low accessory volume (deload/PR-test) or a light prehab-only floor. Do not pad to fill the budget; less is more on these weeks.
12. **Order entries WITHIN each day for a sensible session flow.** The order you emit \`entries\` in per day is the order the user will see and perform them in.
   - **Compound work first** (push, pull, single-leg, carry slots). These are the harder, more productive movements; do them when fresh.
   - **Then trunk work** (core).
   - **Then isolation** (curls, lateral raises, calf raises, kickbacks — slot \`isolation\`).
   - **Prehab last** (face pulls, band pull-aparts, hip-stability work — slot \`prehab\`). These are maintenance volume, low cost, fine to do tired.
   - **Avoid programming two consecutive movements that share a primary muscle group.** If Nordic hamstring curl (hamstring-dominant) and single-leg glute bridge (glute/hamstring-dominant) both appear on the same day, separate them with another movement (e.g. push, core, or carry) so each gets fresh muscle.
   - On a main-lift day, the compound assistance whose slot matches the day's main lift (push for bench/press, pull for deadlift, single-leg for squat) should come FIRST among the compound assistance — right behind the main work it complements.
13. **Loaded bodyweight progression.** When the user has an external-load tool in their available equipment (weighted vest, dip belt — see environmental signals), bodyweight movements tagged \`loadable\` in the library (pull-up, chin-up, dip, push-up variants, ring row, etc.) can be progressed by adding external load. Treat the loaded variant as a different *intensity*, not a different movement: pick the bodyweight movement from the library normally, and surface the loading intent in the \`rationale\` string (e.g. "add belt or vest load — currently >12 BW reps unloaded").
   - **Hard gate:** loading is only acceptable when (a) at least one loader is in available equipment AND (b) the movement carries the \`loadable\` tag. Never load a movement that does not carry the tag. NEVER load prehab/recovery work, plyometrics, mobility drills, or skill-capped movements (pistol squat, handstand pushup, muscle-up).
   - **Phase-awareness:** loading is appropriate when intensity is the limiting factor — typically anchor blocks, peak phase, or when the user has likely passed >12 reps unloaded on the movement. In leader blocks, normal phase, deload, and taper, prefer the unloaded variant and add reps instead. State the phase-based reasoning in the \`rationale\` when you do propose loading.
   - **Volume:** loaded bodyweight contributes the same rep count to the budget as the unloaded variant. Don't inflate volume because the movement is "harder loaded".
14. **Recent cardio load — bounded, principle-based accessory trim.** When the user message includes a \`## Recent cardio load\` section, the user's last 7 days of HR-zone-weighted cardio minutes have spiked above their 28-day baseline. Apply the trim instruction in that section — bounded, never more than 20% under the listed budget. The validator rejects under-budget responses that exceed this cap with no goal-mandate justification.
   - **Trim ordering — systemic-fatigue-first.** Do NOT blindly start with isolation. Rank each movement on the day by *recovery cost in this context* and trim the highest-ranked one first. Rank by combining two factors visible in the movement library:
     1. **Intrinsic systemic cost** of the movement: heavy compound (multi-joint, large primary muscles, hinge / squat / push-vertical / pull-vertical patterns, loaded variants of any pattern) > full-body bodyweight (push-up, ring row, dip) > loaded carry > core > isolation > prehab.
     2. **Overlap with the dominant recent cardio.** When recent cardio is dominated by **running**, movements whose \`primaryMuscles\` include the running-load chain (hamstrings, glutes, quads, calves, erectors, hip flexors) carry an additional recovery cost on top of what the cardio already extracted. When dominated by **cycling**, the overlap concentrates on quads + glutes (less hamstring). For **swim** / **row** / **paddling**, the overlap is on lats + back + shoulders + biceps + triceps.
     3. Movements with **high intrinsic cost AND high cardio-modality overlap** are the highest-priority trim targets — that is where shaving 5–10 reps actually returns recovery budget.
     4. Movements with **low intrinsic cost** (single-joint isolation: curls, lateral raises, kickbacks; small-muscle isolation that doesn't overlap with the dominant cardio) return almost no recovery budget when trimmed and should be **last** to touch — not first. Cutting a hammer curl during a hard running week does nothing for the user's actual recovery; cutting reps on a hamstring/glute compound during a hard running week does.
   - **Trim by reps, not by slot removal.** Reduce reps within the highest-priority slot first (e.g. single-leg RDL 4×10 → 4×8). Do NOT remove entire slots; this is a rep trim, not a slot deletion.
   - **Mandates and prehab remain inviolable** at any trim level. If a mandate would be the highest-priority trim target by the ranking above, skip it and trim the next-highest.
   - **Surface the recovery-cost reasoning in the \`rationale\`** — name the chain you're protecting, not the movement type. ("trimmed to preserve posterior-chain recovery during elevated running load", not "trimmed isolation".)
   - The section only appears when the signal is real and the active phase is \`normal\` or \`peak\`. It is automatically suppressed during \`deload\` and \`taper\` (the budget you see is already cut upstream there).

# Slot vocabulary (use these exact strings in output \`slot\` field)

- \`push\` — horizontal/vertical pressing assistance
- \`pull\` — horizontal/vertical pulling assistance
- \`single-leg\` — split squats, lunges, step-ups, single-leg RDLs
- \`core\` — planks, rollouts, hanging work, weighted carries are NOT core
- \`prehab\` — face pulls, band pull-aparts, hip-stability work (clamshell, lateral band walk, glute bridge), hip mobility
- \`isolation\` — curls, lateral raises, kickbacks, calf raises, shrugs, single-joint hypertrophy
- \`carry\` — farmer carries, suitcase carries, sled drags

# How to read the user's training context

The user message includes (when present):
- **Training Profile** — primary goal × up to 2 secondary goals × current phase × user-authored Filters (hard constraints — never violate). Filters override defaults whenever they conflict.
- **Goal context** — a legacy boolean flag summary that is kept in sync with the profile and is the input to the rule-engine directive summary you also see.
- **Rule directive summary** — mandatory slots, prehab keywords, volume multipliers, scoring biases, etc., computed from the flags. Treat these as mechanical constraints alongside the natural-language rules in this system prompt.
- **Free-text notes** ("goalNotes") — authoritative user input that overrides defaults when it conflicts; surface any pick driven by a note in that pick's \`rationale\` string.

Surface every Filter or directive that influenced a pick in that movement's \`rationale\` string. The Filter labels are user-authored free text — quote them verbatim when relevant.

# movementId format

Every movement in the library is listed with its full ID including any prefix (e.g. \`seed:dip\`, \`custom:abc123\`). Return the **exact ID string** from the library — do NOT strip the prefix. The validator will reject bare IDs.

# Output format — STRICT JSON, nothing else

Return a single JSON object. No surrounding prose. No markdown. No code fence — your entire response must start with \`{\` and end with \`}\`.

Each entry in \`entries\` MUST contain **exactly one** of:
- \`movementId\` — verbatim id from the supplied library (preferred), OR
- \`newMovement\` — inline definition for a novel movement (only when no library entry fits well).

Example structure (note: \`movementId\` keeps its library prefix verbatim; the second entry shows the \`newMovement\` shape):

{
  "perDay": [
    {
      "dayIndex": 0,
      "isAccessoryDay": false,
      "entries": [
        {
          "slot": "push",
          "movementId": "seed:dip",
          "movementName": "Dip",
          "sets": 4,
          "reps": 8,
          "repsMax": 12,
          "unit": "reps",
          "rationale": "push · complements bench (shoulder/tri bias)"
        },
        {
          "slot": "core",
          "newMovement": {
            "name": "Pallof Iso-Hold",
            "equipment": "cable",
            "pattern": "core",
            "primaryMuscles": ["core", "obliques"],
            "secondaryMuscles": ["shoulders"]
          },
          "movementName": "Pallof Iso-Hold",
          "sets": 3,
          "reps": 30,
          "unit": "sec",
          "rationale": "anti-rotation gap (no Pallof variant in library)"
        }
      ]
    }
  ],
  "blockRationale": [
    "Marathon-prep: calf, hip-stability, and hamstring work spread across the week",
    "Avoided heavy lower-body and conditioning the day before long runs",
    "OHP day biases triceps so we don't pile shoulders on shoulders"
  ]
}

Rules for the output:
- Each entry MUST have **exactly one** of \`movementId\` (copied character-for-character from the library, including any prefix) or \`newMovement\`. Never both, never neither.
- For \`newMovement\`: \`equipment\` ∈ {barbell, trap-bar, dumbbell, kettlebell, sandbag, bodyweight, machine, cable, band, other}. \`pattern\` ∈ {hinge, squat, push-horizontal, push-vertical, pull-horizontal, pull-vertical, carry, core}. \`primaryMuscles\` ∈ {quads, hamstrings, glutes, calves, chest, back, lats, traps, shoulders, biceps, triceps, forearms, core, obliques, erectors} (non-empty). \`secondaryMuscles\` and \`isBodyweight\` are optional. \`name\` ≤ 80 chars.
- \`movementName\` is always required (matches the library entry's name, or echoes the \`newMovement.name\` for novel entries) — the UI uses it for display.
- \`unit\` is "reps" for everything except carries which use "sec".
- \`repsMax\` is optional. Omit it (or set to null) when the user has \`dropAmrapOverload\` set, which is signaled in the user message.
- \`rationale\` is one short line — the "why this pick" the UI surfaces as a chip. Mention the goal flag, Filter, or directive when one drove the pick. For \`newMovement\` entries, briefly note WHY no library entry fit.
- \`blockRationale\` is a short list (3–6 bullets) of **plain-English explanations the user will read** about the most important decisions for THIS week. Speak to the user, not to a developer. Focus on **why** the plan looks the way it does — which goals you honored, which constraints you respected, what trade-offs you made. Skip mechanical bookkeeping: do NOT include "family-dedup" notes, "no additional X on Day Y", "budget check: 198 reps within 300-rep budget", or other validator-style audit lines. Each bullet ≤ 100 chars. Avoid jargon like "preferProven active" or "dropAmrapOverload" — translate to user-readable language ("dropped AMRAP overload so accessories don't pre-fatigue your top set").
- One JSON object only. No prose. No code fence.`;

function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/**
 * Render a `## Main work this week` section describing the exact main-lift
 * prescription (sets × reps × %TM, plus AMRAP flag) for the active week.
 * Returns null when no specific week is being generated (weekScope is
 * undefined), so the caller can skip the section entirely. Exported for
 * tests.
 */
export function formatMainWorkSection(args: {
  weekScope?: WendlerWeek;
  mainScheme?: MainScheme;
  seventhWeekKind?: SeventhWeekKind;
}): string | null {
  const { weekScope, seventhWeekKind } = args;
  const scheme = args.mainScheme ?? 'classic-531';
  if (!weekScope) return null;

  // 7th week uses its own wave table and never carries a 5/3/1 scheme.
  if (weekScope === '7w') {
    const kind: SeventhWeekKind = seventhWeekKind ?? 'deload';
    const wave = SEVENTH_WEEK_WAVES[kind] ?? [];
    const setLines = wave.map((s) => {
      const repsLabel = s.repsLabelOverride ?? `${s.reps}`;
      return `- ${Math.round(s.percent * 100)}% × ${repsLabel}`;
    });
    const intent =
      kind === 'tm-test'
        ? 'TM test week. Lower-volume, higher-intensity recalibration. Pair with light prehab assistance only — no hypertrophy load.'
        : kind === 'pr-test'
          ? 'PR test week. One heavy single. Drop assistance to a recovery floor (light prehab + carries) so the PR attempt is not pre-fatigued.'
          : 'Deload-style 7th week. Cut accessory volume by ~50% versus a normal training week.';
    return `## Main work this week (7th week — ${kind})\n${intent}\nApplies on every main-lift day:\n${setLines.join('\n')}`;
  }

  const isDeload = weekScope === 'deload';
  // Mirror the swap inside buildMainSets for the '351' scheme: week 1 runs
  // the 3s wave and week 2 runs the 5s wave.
  const sourceWeek: WendlerWeek =
    scheme === '351' && weekScope === 1 ? 2 : scheme === '351' && weekScope === 2 ? 1 : weekScope;
  const wave = WAVES[sourceWeek] ?? [];

  const setLines = wave.map((s) => {
    // 5s PRO: every set is 5 reps, no AMRAP, except deload (which is the
    // standard 40/50/60 × 5 anyway).
    const reps = scheme === '5s-pro' && !isDeload ? 5 : s.reps;
    const amrap = scheme === '5s-pro' && !isDeload ? false : !!s.isAmrap && !isDeload;
    return `- ${Math.round(s.percent * 100)}% × ${reps}${amrap ? '+ (AMRAP)' : ''}`;
  });

  const weekLabel = isDeload ? 'Deload' : `Week ${weekScope}`;
  const schemeLabel =
    scheme === 'classic-531'
      ? 'classic 5/3/1+ (top set is AMRAP on non-deload weeks)'
      : scheme === '5s-pro'
        ? '5s PRO (every set fixed reps, no AMRAP on training weeks)'
        : '3/5/1 (Week 1 runs the 3s wave, Week 2 runs the 5s wave; AMRAP on top set)';

  const guidance = isDeload
    ? 'Deload week — systemic load is intentionally low (no AMRAP, all sets sub-max). Cut accessory volume meaningfully versus training weeks if you judge the user needs recovery; otherwise prefer consistency with the other weeks.'
    : weekScope === 3
      ? "Week 3 carries the heaviest top single (95% × 1+). Be conservative on accessory volume so the AMRAP isn't pre-fatigued."
      : weekScope === 2
        ? 'Week 2 is the 3s wave with a 90% × 3+ top AMRAP. Moderate accessory load.'
        : 'Week 1 is the 5s wave with an 85% × 5+ top AMRAP. Standard accessory load.';

  return `## Main work this week (${weekLabel}, ${schemeLabel})\n${guidance}\nSame prescription on every main-lift day:\n${setLines.join('\n')}`;
}

function buildUserPrompt(input: BuildAssistancePromptInput): string {
  const {
    volume,
    days,
    movements,
    goalFlags,
    goalNotes = '',
    existingPerDayEntries,
    otherWeeksContext,
    activeGoalFlavors = [],
    cardioPeakActive = false,
    warmupCoversPrehab = false,
    availableEquipment,
    longRunDayIndices,
    blockLabel,
    blockKind,
    phase,
    phasePresetShift,
    trainingProfileContext,
    suppressPhaseVolumeMultiplier = false,
    cardioFatigueShift = 0,
    cardioFatigue,
  } = input;

  const directives = evaluateGoalsForRules(goalFlags, {
    suppressPhaseVolumeMultiplier,
    phase,
  });
  const sections: string[] = [];

  // ----- block summary
  const blockHeader = blockLabel ? `## Block: ${blockLabel}` : '## Current block';
  const dayLines = days.map((d, i) => {
    const tag = d.mainLifts.length === 0 ? 'accessory day' : `main lifts: ${d.mainLifts.join(', ')}`;
    const label = d.label ? ` "${d.label}"` : '';
    return `- Day ${i}${label}: ${tag}`;
  });
  // Compose the budget line. When the preset was auto-shifted upstream
  // because of the active phase, surface that explicitly so the LLM
  // understands the budget already reflects the cut and doesn't double-
  // apply one in its picks.
  const budgetSuffix = phasePresetShift
    ? ` — phase-adjusted: \`${phasePresetShift.from}\` preset auto-shifted to \`${phasePresetShift.to}\``
    : '';
  const headerLines: string[] = [blockHeader];
  if (blockKind) {
    headerLines.push(`Block kind: ${blockKind}`);
  }
  if (phase && phase !== 'normal') {
    headerLines.push(`Active phase: ${phase}`);
  }
  headerLines.push(
    `Per-day assistance budget${budgetSuffix} (excludes main lifts, supplemental FSL/SSL sets, and warmups): ${volume.mainDayReps} reps on main-lift days, ${volume.accessoryReps} reps total across accessory day(s).`,
  );
  headerLines.push(`Days:`);
  headerLines.push(...dayLines);
  sections.push(headerLines.join('\n'));

  // ----- main work for the current week scope. Only emitted when a
  // specific week is being generated (1 | 2 | 3 | 'deload' | '7w'). Lets
  // the LLM scale assistance volume / intensity to the systemic load of
  // the week — most importantly to drop accessory volume on deload, and
  // to be conservative on Week 3's heavy 5/3/1+ AMRAP. Caller is expected
  // to pass `mainScheme` explicitly when the block isn't on the default
  // 'classic-531' (5s PRO and 3/5/1 produce meaningfully different
  // weekly prescriptions).
  const mainWorkSection = formatMainWorkSection({
    weekScope: input.weekScope,
    mainScheme: input.mainScheme,
    seventhWeekKind: input.seventhWeekKind,
  });
  if (mainWorkSection) sections.push(mainWorkSection);

  // ----- training profile (four-axis) — optional priority block ahead of
  // legacy goal-context. Emit only when a profile is supplied so legacy
  // callers (e.g. tests) keep producing the same prompt as before.
  if (trainingProfileContext) {
    const tp = trainingProfileContext;
    const lines: string[] = [
      `Primary goal (dominant adaptation — bend everything else to this): **${tp.primaryGoal}**`,
    ];
    if (tp.secondaryGoals.length > 0) {
      lines.push(
        `Secondary goals (complementary — inform exercise selection without overriding the primary): ${tp.secondaryGoals.join(', ')}`,
      );
    } else {
      lines.push('Secondary goals: none active.');
    }
    lines.push(`Training phase (temporal modifier): ${tp.trainingPhase}`);
    if (tp.phaseDirectives && tp.phaseDirectives.length > 0) {
      lines.push('');
      lines.push('Phase × secondary-goal interaction directives (apply verbatim):');
      for (const d of tp.phaseDirectives) {
        lines.push(`- ${d.secondary}: ${d.directive}`);
      }
    }
    sections.push('## Training profile (priority context)\n' + lines.join('\n'));

    // Filters (hard constraints) — separate section so the LLM treats them as
    // hard filters rather than scoring nudges. Phase-aware: peak + injury-prevention
    // gets the per-session prehab emphasis appended.
    if (tp.constraints && tp.constraints.length > 0) {
      const ctx = constraintsToPromptContext(
        tp.constraints.map((c) => ({ kind: c.kind as never, label: c.label })),
        tp.trainingPhase,
      );
      if (ctx) sections.push('## Filters (hard constraints — never violate)\n' + ctx);
    }
  }

  // ----- goal context (flags + notes via shared helper)
  sections.push('## Goal context\n' + goalsToPromptContext(goalFlags, goalNotes, phase));

  // ----- rule directive summary so the LLM sees the same constraints the rule engine enforces
  const directiveLines: string[] = [];
  if (directives.mandatorySlots.length > 0) {
    directiveLines.push(`- Mandatory slots (must appear at least once across the week): ${directives.mandatorySlots.join(', ')}`);
  }
  if (directives.volumeMultiplier !== 1) {
    const pct = Math.round((1 - directives.volumeMultiplier) * 100);
    directiveLines.push(`- Volume multiplier: ${directives.volumeMultiplier.toFixed(2)}× (~${pct}% lighter)`);
  }
  if (directives.dropAmrapOverload) {
    directiveLines.push('- dropAmrapOverload: omit \`repsMax\` for every entry — fixed prescriptions only.');
  }
  if (directives.preferProven) {
    directiveLines.push('- preferProven: bias toward movements the user has used in prior blocks; avoid novel/high-injury-risk picks.');
  }
  // Pre-long-run leg protection fires whenever a long run is on the calendar,
  // independent of the marathon goal flag — a scheduled long run is itself
  // sufficient signal. The marathon flag layers additional behaviors on top
  // (mandatory hip-stability/calf/hamstring slots, quad downweighting, etc.).
  if (longRunDayIndices && longRunDayIndices.length > 0) {
    const before = longRunDayIndices.map((i) => i - 1).filter((i) => i >= 0);
    directiveLines.push(
      `- Pre-long-run guidance: on day(s) ${before.join(', ')} (the day before each long run on day(s) ${longRunDayIndices.join(', ')}), strongly prefer to avoid loaded lower-body assistance OR systemic metabolic conditioning that meaningfully fatigues legs or CNS — this includes bilateral back/front squats, Bulgarian split squats, walking and reverse lunges, step-ups, pistol squats, heavy hip thrusts, **conventional/sumo/trap-bar deadlift, Romanian deadlift, single-leg RDL at 10+ reps, kettlebell swings, devil press, thrusters, burpees, snatches, cleans, wall balls, man-makers, sled pushes**. Light hip-stability prehab is preferred (clamshells, banded lateral walks, hip abductions, bodyweight glute bridges). If you must include any heavier lower-body or conditioning work, keep it to ≤2 light sets and justify the choice in the rationale.`,
    );
  }
  if (directives.prehabKeywords.length > 0) {
    directiveLines.push(
      `- Prehab keywords promoted into the prehab slot: ${directives.prehabKeywords.join(', ')}.`,
    );
  }
  const muscleDeltas = Object.entries(directives.muscleScoreDelta);
  if (muscleDeltas.length > 0) {
    directiveLines.push(
      `- Muscle bias (positive = up-weight, negative = down-weight): ${muscleDeltas
        .map(([m, d]) => `${m} ${d! > 0 ? '+' : ''}${d}`)
        .join(', ')}.`,
    );
  }
  const slotDeltas = Object.entries(directives.slotScoreDelta);
  if (slotDeltas.length > 0) {
    directiveLines.push(
      `- Slot bias: ${slotDeltas.map(([s, d]) => `${s} ${d! > 0 ? '+' : ''}${d}`).join(', ')}.`,
    );
  }
  if (directiveLines.length > 0) {
    sections.push('## Rule-engine directives derived from goal flags\n' + directiveLines.join('\n'));
  }

  // ----- environmental signals
  const env: string[] = [];
  if (activeGoalFlavors.length > 0) env.push(`- Active goal flavors: ${activeGoalFlavors.join(', ')}`);
  if (cardioPeakActive) env.push('- Cardio peak active (A-priority endurance race in taper window) — de-emphasize quad-heavy single-leg.');
  if (warmupCoversPrehab) env.push('- Warmup already covers prehab — do NOT allocate a prehab slot.');
  if (availableEquipment && availableEquipment.length > 0) {
    env.push(`- Available equipment: ${availableEquipment.join(', ')} (bodyweight always allowed).`);
  }
  // Loaded-bodyweight progression cue. Only active when the user actually
  // owns a loader (weighted vest, dip belt) — otherwise the LLM should
  // never propose loading. The "loadable" tag in the movement library is
  // the hard gate on WHICH movements can be loaded; this signal tells the
  // LLM the loaders are available in the user's environment.
  const hasLoader =
    !!availableEquipment &&
    (availableEquipment.includes('weighted-vest') || availableEquipment.includes('dip-belt'));
  if (hasLoader) {
    const loaders = (availableEquipment ?? []).filter(
      (e) => e === 'weighted-vest' || e === 'dip-belt',
    );
    env.push(
      `- External-load tools available: ${loaders.join(', ')}. See "Loaded bodyweight progression" rule for when to apply them.`,
    );
  }
  if (env.length > 0) sections.push('## Environmental signals\n' + env.join('\n'));

  // ----- recent cardio load. Small section, only emitted when the
  // suggester-context flagged a non-zero shift. The shift was already
  // suppressed upstream during deload/taper phases (where the budget is
  // already cut by the preset auto-shift); fires in 'normal' and 'peak'.
  // The 20% ceiling is a hard cap — the validator also enforces it
  // independently on the response side as defense-in-depth.
  if (cardioFatigueShift !== 0) {
    const recent = cardioFatigue?.recentWeightedMin;
    const baseline = cardioFatigue?.baselineWeightedMin;
    const delta = cardioFatigue?.deltaPct;
    const fmtNum = (n: number) => Math.round(n).toString();
    const stats =
      recent != null && baseline != null && delta != null
        ? `Rolling 7-day weighted cardio minutes: ${fmtNum(recent)} (28-day baseline: ${fmtNum(baseline)}/week, ${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}%).`
        : 'Recent cardio load is elevated above the 28-day baseline.';
    // Modality breakdown — drives overlap-correct trim ranking. Render
    // dominant first, then any modality with ≥10% share.
    const mix = (cardioFatigue?.recentModalityMix ?? []).filter((m) => m.sharePct >= 10);
    const modalityLine =
      mix.length > 0
        ? `Modality mix (last 7d): ${mix.map((m) => `${m.modality} ${Math.round(m.sharePct)}%`).join(', ')}.`
        : '';
    const trimCue =
      cardioFatigueShift === -2
        ? 'Trim accessory volume by ~15–20% for this generation only — never more than 20% under the listed budget.'
        : 'Trim accessory volume by ~10–15% for this generation only — never more than 20% under the listed budget.';
    const lines = [
      stats,
      ...(modalityLine ? [modalityLine] : []),
      '',
      trimCue,
      'Pick the highest-recovery-cost movement to trim FIRST (see system rule 14): heavy compound × cardio-modality muscle overlap. Trimming a hammer curl during a hard running week returns almost no recovery; trimming a hamstring/glute compound returns real recovery. Mandates and prehab stay at full reps.',
      'Surface the recovery-cost reasoning in your `rationale` strings — name the chain you are protecting (e.g. "trimmed to preserve posterior-chain recovery during elevated running load"), not the movement type.',
    ];
    sections.push('## Recent cardio load\n' + lines.join('\n'));
  }

  // ----- existing entries (cross-day dedup set + skip-filled-days directive)
  //
  // Two roles:
  //  (1) Dedup signal — the LLM must not propose any movementId already
  //      in this list, anywhere in the block.
  //  (2) "Fill-the-gaps" signal — any day with at least one existing
  //      entry is treated as INTENTIONALLY ARRANGED by the user. The
  //      LLM is told to return an empty `entries: []` array for that
  //      day. The component also enforces this on the response side
  //      (defence-in-depth — if the LLM ignores the directive, the
  //      web layer drops picks for filled days). Empty days remain
  //      open for picks.
  //
  //  Always emit the section even when no entries exist, so the LLM
  //  never wonders whether the input was accidentally omitted.
  {
    const lines: string[] = [];
    const filledDayIndices: number[] = [];
    if (existingPerDayEntries) {
      existingPerDayEntries.forEach((entries, i) => {
        if (!entries || entries.length === 0) return;
        filledDayIndices.push(i);
        const ids = entries
          .map((e) => `${e.movementName ?? '?'} (${e.movementId ?? '?'})`)
          .join(', ');
        lines.push(`- Day ${i}: ${ids}`);
      });
    }
    const body = lines.length > 0 ? lines.join('\n') : 'None — no movements have been assigned in this block yet.';
    const skipDirective =
      filledDayIndices.length > 0
        ? `\n\n**Important — Fill-the-gaps mode is ACTIVE.** Day${filledDayIndices.length === 1 ? '' : 's'} ${filledDayIndices.join(', ')} ${filledDayIndices.length === 1 ? 'is' : 'are'} intentionally arranged by the user. **Return \`entries: []\` for ${filledDayIndices.length === 1 ? 'that day' : 'those days'}** — do NOT add new picks to ${filledDayIndices.length === 1 ? 'it' : 'them'}, even if your volume budget would allow it. Only fill the empty days. The existing entries listed above still count as "already in the block" for dedup and mandate-coverage purposes (e.g. if a calf raise is on Day 0, the marathon mandate is satisfied; you don't need another on Day 1).`
        : '';
    sections.push(
      '## Existing entries (do NOT re-suggest these movementIds on any day)\n' +
        body +
        skipDirective,
    );
  }

  // ----- cross-week context — other week scopes within this same block.
  // Wendler explicitly endorses varying assistance across workouts ("I
  // don't see any problem in changing the exercises from workout to
  // workout. It is the work that matters." — 5/3/1 Forever, p.86), so
  // the prompt asks for fresh selections by default. Repeating the same
  // specific movement across weeks is allowed only when no equally-good
  // same-family alternative exists. Family-dedup still applies WITHIN
  // a week, not across them.
  if (otherWeeksContext && otherWeeksContext.length > 0) {
    const blocks: string[] = [];
    for (const ctx of otherWeeksContext) {
      const dayLines: string[] = [];
      ctx.perDay.forEach((entries, i) => {
        if (!entries || entries.length === 0) return;
        const ids = entries
          .map((e) => `${e.movementName ?? '?'} (${e.movementId ?? '?'})`)
          .join(', ');
        dayLines.push(`  - Day ${i}: ${ids}`);
      });
      if (dayLines.length > 0) {
        blocks.push(`### ${ctx.scopeLabel}\n${dayLines.join('\n')}`);
      }
    }
    if (blocks.length > 0) {
      sections.push(
        '## Cross-week context (other weeks in this same block)\n' +
          'Below are the picks from other week scopes of this same block. **You MUST NOT re-use these specific movementIds** for the same slot, as long as a same-family alternative exists in the library OR can be proposed as a `newMovement` (see system rule 10). The expected pattern is same-family rotation across weeks — e.g. Wk1 Goblet Squat → Wk2 Bulgarian Split Squat → Wk3 Step-up for the single-leg/quad slot. Repeating a specific exercise across weeks is permitted only when no equally-good same-family alternative exists AND introducing a `newMovement` is not safe; state which condition applies in the `rationale`. Family-dedup rules still apply WITHIN the week you are generating.\n\n' +
          blocks.join('\n\n'),
      );
    }
  }

  // ----- movement library
  sections.push('## Movement library\n' + renderMovementLibrary(movements, availableEquipment));

  sections.push(
    '## Task\nReturn the JSON object described in the system prompt. One object, no prose, no code fence.',
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
  if (filtered.length === 0) return '(no movements available — escalate to the user)';
  // Compact one-line-per-movement to keep tokens down. Format chosen so the
  // LLM can grep for muscles/equipment without parsing JSON.
  return filtered
    .map((m) => {
      const tags: string[] = [];
      if (m.isCompound) tags.push('compound');
      if (m.isCustom) tags.push('custom');
      if (m.isMainLift) tags.push(`main:${m.isMainLift}`);
      if (m.externallyLoadable) tags.push('loadable');
      const tagStr = tags.length > 0 ? ` [${tags.join(',')}]` : '';
      const muscles = m.primaryMuscles.length > 0 ? ` primary=${m.primaryMuscles.join('/')}` : '';
      return `- ${m.id} | "${m.name}" | ${m.pattern} | equip=${m.equipment}${muscles}${tagStr}`;
    })
    .join('\n');
}
