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

export const CHAT_TOOL_SPECS: AnthropicToolSpec[] = [
  COACH_TOOL_SPEC,
  PROGRAMMER_TOOL_SPEC,
  PERIODIZER_TOOL_SPEC,
  SUMMARIZER_TOOL_SPEC,
];
