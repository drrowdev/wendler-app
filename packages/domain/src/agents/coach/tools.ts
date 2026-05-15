// Coach agent tool spec — Phase 3 chat tool-use registration.
//
// When the chat orchestrator hits the LLM, this spec is one of the tools it
// declares so Claude can decide to consult the Coach for any pain / soreness
// / movement-modification question that arises in conversation.
//
// The dispatch (apps/api/src/functions/chat-tools.ts) builds a focused
// chat-context-aware Coach call from the tool input + the snapshot the
// chat already has on hand. The result text is folded back into Claude's
// reasoning context for the final reconciled answer.

import type { AgentToolSpec } from '../types';

export const COACH_TOOL_SPEC: AgentToolSpec = {
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
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          "The user's pain / injury question, copied or paraphrased from " +
          'their chat message. Include relevant context (e.g. "since last ' +
          'Tuesday\'s squat session", "during eccentrics only").',
      },
      area: {
        type: 'string',
        description:
          'Body area if the user named one (e.g. "right adductor", ' +
          '"left elbow", "lower back"). Omit when not stated.',
      },
      severity: {
        type: 'number',
        description:
          'Severity 1-5 if the user gave one (1=twinge, 3=limits ' +
          'performance, 5=stop). Omit when unknown.',
      },
      affectedMovementIds: {
        type: 'array',
        description:
          "Library movementIds (with prefix, e.g. 'seed:bulgarian-split-" +
          "squat') the user said are affected. Omit when not specified.",
        items: { type: 'string' },
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};
