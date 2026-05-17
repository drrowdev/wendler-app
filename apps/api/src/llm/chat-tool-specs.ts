// Anthropic tool-spec definitions for chat tool-use orchestration (Phase 3).
//
// These are the concrete shapes Anthropic's messages.create({ tools }) API
// expects. They mirror the AgentToolSpec entries in the domain package
// (packages/domain/src/agents/<name>/tools.ts) — kept in lockstep here so
// the API layer can pass them straight to the SDK without importing across
// the Node16/ESM boundary into @wendler/domain (same mirror pattern as
// apps/api/src/llm/validate.ts).

export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export const COACH_TOOL_SPEC: AnthropicToolSpec = {
  name: 'consult_coach',
  description:
    "Consult the MSK / movement-modification coach for advice about pain, " +
    "soreness, post-injury return-to-training, or any \"should I keep " +
    "training X / how do I work around Y?\" question. Returns an anatomical " +
    "interpretation plus 1-3 concrete movement modifications grounded in " +
    "the user's actual library and current programming. Use this whenever the " +
    "user mentions pain, discomfort, \"something feels off\", flare-ups, " +
    "or asks whether a movement is safe to keep doing right now. Do NOT " +
    "invent injury advice yourself when this tool is available.",
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          "The user's pain / injury question, copied or paraphrased from " +
          'their chat message.',
      },
      area: {
        type: 'string',
        description:
          'Body area if the user named one (e.g. "right adductor"). Omit when not stated.',
      },
      severity: {
        type: 'number',
        description: 'Severity 1-5 if the user gave one. Omit when unknown.',
      },
      affectedMovementIds: {
        type: 'array',
        description: "Library movementIds (with prefix) the user said are affected.",
        items: { type: 'string' },
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

export const PROGRAMMER_TOOL_SPEC: AnthropicToolSpec = {
  name: 'consult_programmer',
  description:
    "Consult the Wendler 5/3/1 programming specialist for assistance " +
    'selection, set/rep prescription, "what should this session look like?", ' +
    'movement-substitution from the library, or block-shape questions. ' +
    "Returns concrete picks grounded in the user's actual training profile " +
    "and the active assistance volume budget. Use this for anything that " +
    "would normally be answered by hitting Suggest in the block editor. " +
    "Do NOT invent set/rep schemes yourself when this tool is available.",
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: "The user's programming question, copied or paraphrased.",
      },
      scope: {
        type: 'string',
        description: 'Time scope of the request. Omit when not implied.',
        enum: ['session', 'week', 'block', 'multi-block'],
      },
      mainLiftFocus: {
        type: 'string',
        description: 'Specific main lift the question is about, if any.',
        enum: ['bench', 'squat', 'deadlift', 'press'],
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

export const PERIODIZER_TOOL_SPEC: AnthropicToolSpec = {
  name: 'consult_periodizer',
  description:
    "Consult the periodization specialist for deload-timing decisions, " +
    "block-to-block transitions, race-week tapers, return-from-layoff " +
    "ramps, and \"is my training too hot / too cold?\" questions. Use this " +
    "for any question that's about WHEN or HOW MUCH (taper, deload, peak), " +
    "not WHAT (movement selection — that's the programmer).",
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: "The user's periodization question." },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

export const SUMMARIZER_TOOL_SPEC: AnthropicToolSpec = {
  name: 'summarize_week',
  description:
    'Generate a structured summary of a recent training week (or the ' +
    'current one). Use this when the user asks "how was last week?" or ' +
    'any digest / recap question.',
  input_schema: {
    type: 'object',
    properties: {
      weekStart: {
        type: 'string',
        description: 'ISO date (YYYY-MM-DD) for the Monday of the week to summarize.',
      },
    },
    additionalProperties: false,
  },
};

/**
 * Tool spec for `propose_edit` — the structured multi-op edit primitive.
 *
 * The model emits this tool_use to surface a coordinated plan of
 * up-to-10 operations on the user's program data. The chat handler
 * captures the tool input verbatim, validates it via
 * parseEditProposal, and emits it to the client as an action_chips
 * event. The orchestrator then synthesizes an ack tool_result back to
 * the model ("Proposal emitted for user review.") so the turn can
 * end cleanly.
 *
 * This tool does NOT call out to a sub-agent — it's a structured
 * EMISSION primitive. The user reviews + commits in the
 * EditProposalSheet UI.
 *
 * Each operation kind is documented in the input_schema's operations
 * array — the validator (edit-proposal-parse.ts) enforces the same
 * shape. KEEP IN LOCKSTEP when adding op kinds.
 */
export const PROPOSE_EDIT_TOOL_SPEC: AnthropicToolSpec = {
  name: 'propose_edit',
  description:
    'Emit a coordinated multi-op edit proposal for the user to review. ' +
    'Use this for ANY concrete program change recommendation (training-max ' +
    'tweaks, volume-preset shifts, assistance trims/swaps/adds/removes, ' +
    'deload scheduling). The user sees the WHOLE plan as a diff with ' +
    'per-op accept / decline / modify before any write happens. Prefer ' +
    'one proposal with multiple coordinated operations over many small ' +
    'unrelated ones. Skip this tool entirely for purely informational ' +
    'replies or when you have not actually done the analysis to back a ' +
    'recommendation.',
  input_schema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'Imperative ≤ 35 char summary used as the chip button label.',
      },
      headline: {
        type: 'string',
        description:
          'One-sentence summary of the WHOLE plan the user sees above the op list. ≤ 200 chars.',
      },
      reason: {
        type: 'string',
        description:
          '1-2 sentence rationale for the WHOLE plan — why these changes together, why now. ≤ 500 chars.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'Relative confidence in the plan. Used by the UI for visual toning. Treat as relative ordering, not absolute probability.',
      },
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        description:
          'Ordered list of 1-10 typed operations. Each must include a ' +
          'unique `id`, a `kind` from the controlled vocabulary, a `label` ' +
          '(≤ 80 chars), an optional `rationale`, plus kind-specific fields. ' +
          'See per-kind shapes below.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable id within the proposal.' },
            kind: {
              type: 'string',
              enum: [
                'set_training_max',
                'set_block_volume_preset',
                'trim_assistance_entry',
                'swap_assistance_movement',
                'add_assistance_entry',
                'add_movement_to_library',
                'add_cardio_plan_slot',
                'remove_assistance_entry',
                'schedule_deload',
                'skip_day_in_week',
              ],
            },
            label: { type: 'string', description: 'Per-op row label. ≤ 80 chars.' },
            rationale: { type: 'string', description: 'Optional per-op why.' },

            // set_training_max
            lift: {
              type: 'string',
              enum: ['squat', 'bench', 'deadlift', 'press'],
              description: 'set_training_max only.',
            },
            newTrainingMaxKg: {
              type: 'number',
              description: 'set_training_max only. Will be rounded to 0.5 kg.',
            },

            // set_block_volume_preset
            preset: {
              type: 'string',
              enum: ['minimal', 'standard', 'high'],
              description: 'set_block_volume_preset only.',
            },

            // trim / swap / add / remove — block + day + entry targeting
            blockId: {
              type: 'string',
              description: 'Optional — defaults to the active block.',
            },
            dayId: {
              type: 'string',
              description:
                'Stable day id from the active block plan. Required for trim / swap / add / remove ops. Copy verbatim from the snapshot.',
            },
            entryId: {
              type: 'string',
              description:
                'Stable entry id within the day. Required for trim / swap / remove ops.',
            },
            movementName: {
              type: 'string',
              description: 'Display name. Required for trim / add / remove ops.',
            },

            // trim_assistance_entry
            newSets: { type: 'integer', minimum: 1, description: 'trim_assistance_entry only.' },
            newReps: { type: 'integer', minimum: 1, description: 'trim_assistance_entry only.' },
            newRepsMax: {
              type: 'integer',
              minimum: 1,
              description: 'trim_assistance_entry only. Must be >= newReps when present.',
            },

            // swap_assistance_movement
            currentMovementId: {
              type: 'string',
              description: 'swap_assistance_movement only. Copy verbatim from the snapshot.',
            },
            currentMovementName: {
              type: 'string',
              description: 'swap_assistance_movement only.',
            },
            newMovementId: {
              type: 'string',
              description: 'swap_assistance_movement only. Must exist in the user library.',
            },
            newMovementName: {
              type: 'string',
              description: 'swap_assistance_movement only.',
            },

            // add_assistance_entry
            movementId: {
              type: 'string',
              description: 'add_assistance_entry only. Must exist in the user library.',
            },
            category: {
              type: 'string',
              enum: ['push', 'pull', 'single-leg', 'core', 'prehab', 'isolation', 'carry'],
              description: 'add_assistance_entry only.',
            },
            sets: { type: 'integer', minimum: 1, description: 'add_assistance_entry only.' },
            reps: { type: 'integer', minimum: 1, description: 'add_assistance_entry only.' },
            repsMax: {
              type: 'integer',
              minimum: 1,
              description: 'add_assistance_entry only. Must be >= reps when present.',
            },
            unit: {
              type: 'string',
              enum: ['reps', 'sec'],
              description: 'add_assistance_entry only. Defaults to "reps".',
            },

            // skip_day_in_week
            weeks: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['1', '2', '3', 'deload', '7w'],
              },
              minItems: 1,
              description:
                'skip_day_in_week only. Which weeks of the block to skip the day in. At least one required; multi-week skips are encouraged (e.g. ["2","3","deload"] for a taper).',
            },
            dayLabel: {
              type: 'string',
              description:
                'skip_day_in_week only. Display label for the day (echo of the BlockDay label) so the UI can render it without a Dexie lookup.',
            },
            skipReason: {
              type: 'string',
              enum: ['cardio-replacement', 'rest-day', 'travel', 'fatigue', 'pain', 'other'],
              description: 'skip_day_in_week only. Why the day is skipped.',
            },
            skipNote: {
              type: 'string',
              description:
                'skip_day_in_week only. Free-text user-visible note (e.g. "Z2 bike 60 min"). ≤ 200 chars.',
            },

            // add_movement_to_library
            tempMovementId: {
              type: 'string',
              pattern: '^tmp:[a-z0-9-]+$',
              description:
                'add_movement_to_library only. Temp id you invent for this op; must match ^tmp:[a-z0-9-]+$ (e.g. "tmp:banded-clamshell"). Use the SAME tempMovementId as `movementId` on any sibling add_assistance_entry op that should reference the new library entry.',
            },
            name: {
              type: 'string',
              description:
                'add_movement_to_library only. Display name (e.g. "Banded Clamshell"). ≤ 80 chars. The apply path rejects exact-normalized-name duplicates and soft-falls-back to the existing entry on a race-condition match.',
            },
            primaryMuscles: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'quads',
                  'hamstrings',
                  'glutes',
                  'calves',
                  'adductors',
                  'chest',
                  'back',
                  'lats',
                  'traps',
                  'shoulders',
                  'biceps',
                  'triceps',
                  'forearms',
                  'core',
                  'obliques',
                  'erectors',
                ],
              },
              minItems: 1,
              description:
                'add_movement_to_library only. At least one. Used for filtering + dedup against existing library entries. If unsure, ASK the user instead of guessing.',
            },
            secondaryMuscles: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'quads',
                  'hamstrings',
                  'glutes',
                  'calves',
                  'adductors',
                  'chest',
                  'back',
                  'lats',
                  'traps',
                  'shoulders',
                  'biceps',
                  'triceps',
                  'forearms',
                  'core',
                  'obliques',
                  'erectors',
                ],
              },
              description:
                'add_movement_to_library only. Optional secondary muscles for completeness.',
            },
            equipment: {
              type: 'string',
              enum: [
                'barbell',
                'trap-bar',
                'dumbbell',
                'kettlebell',
                'sandbag',
                'bodyweight',
                'machine',
                'cable',
                'band',
                'weighted-vest',
                'dip-belt',
                'other',
              ],
              description:
                'add_movement_to_library only. Defaults to bodyweight if omitted.',
            },
            pattern: {
              type: 'string',
              enum: [
                'hinge',
                'squat',
                'push-horizontal',
                'push-vertical',
                'pull-horizontal',
                'pull-vertical',
                'carry',
                'core',
              ],
              description: 'add_movement_to_library only. Required.',
            },
            isCompound: {
              type: 'boolean',
              description:
                'add_movement_to_library only. True only for multi-joint free-weight movements that could carry a training max. Almost always FALSE for prehab/isolation/mobility.',
            },
            externallyLoadable: {
              type: 'boolean',
              description:
                'add_movement_to_library only. True if the movement accepts vest/belt/loaded-DB external loading. Never set true for prehab/recovery/mobility/plyo or already-loaded movements (BB/DB/KB).',
            },
            cues: {
              type: 'string',
              description:
                'add_movement_to_library only. Optional short technique cues from the user. ≤ 300 chars.',
            },
            dedupHint: {
              type: 'string',
              description:
                'add_movement_to_library only. One-line note explaining which existing library entries you considered before proposing this new one (e.g. "Closest existing: Side-lying Clamshell (band, glutes) — different setup so not equivalent."). Builds the user\'s trust in your dedup check. ≤ 300 chars.',
            },

            // add_cardio_plan_slot
            dayOfWeek: {
              type: 'integer',
              minimum: 0,
              maximum: 6,
              description:
                'add_cardio_plan_slot only. ISO weekday — 0=Mon … 6=Sun.',
            },
            modality: {
              type: 'string',
              enum: ['run', 'bike', 'swim', 'row', 'walk', 'padel', 'other'],
              description:
                'add_cardio_plan_slot only. Modality of the planned cardio session.',
            },
            planKind: {
              type: 'string',
              enum: [
                'rest',
                'easy',
                'long',
                'quality',
                'recovery',
                'race-pace',
                'z2',
                'intervals',
                'cross',
              ],
              description:
                'add_cardio_plan_slot only. Planned-session kind. Note the field is `planKind` not `kind` to avoid colliding with the op-discriminator `kind`.',
            },
            durationMin: {
              type: 'integer',
              minimum: 1,
              maximum: 600,
              description:
                'add_cardio_plan_slot only. Optional planned duration in minutes.',
            },
            notes: {
              type: 'string',
              description:
                'add_cardio_plan_slot only. Optional free-text note (e.g. "60 min indoor trainer"). ≤ 200 chars.',
            },
            linkedToActiveBlock: {
              type: 'boolean',
              description:
                'add_cardio_plan_slot only. When true (default), the slot is auto-removed when the active block completes — use this for taper-week cardio replacements paired with skip_day_in_week. Pass false ONLY when the user explicitly wants the slot to persist beyond the current block.',
            },
            appliesToWeeks: {
              type: 'array',
              items: { type: 'string', enum: ['1', '2', '3', 'deload', '7w'] },
              description:
                'add_cardio_plan_slot only. When the cardio slot is replacing a strength day for SPECIFIC weeks of the block (e.g. paired with skip_day_in_week.weeks = ["2", "3", "deload"]), pass the SAME weeks here so the cardio slot only shows on /calendar during those weeks. Apply resolves to a date range bounded by the linked block. Omit when the slot should run every week of the block. MUST match the paired skip op exactly when both are emitted.',
            },
          },
          required: ['kind', 'label'],
          additionalProperties: false,
        },
      },
    },
    required: ['label', 'headline', 'reason', 'operations'],
    additionalProperties: false,
  },
};

export const CHAT_TOOL_SPECS: AnthropicToolSpec[] = [
  COACH_TOOL_SPEC,
  PROGRAMMER_TOOL_SPEC,
  PERIODIZER_TOOL_SPEC,
  SUMMARIZER_TOOL_SPEC,
  PROPOSE_EDIT_TOOL_SPEC,
];
