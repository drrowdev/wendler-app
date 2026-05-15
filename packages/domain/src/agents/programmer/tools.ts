// Programmer agent tool spec — Phase 3 chat tool-use registration.
//
// Used by the chat orchestrator to delegate "what should I do this session /
// week / block?" style questions to the Programmer specialist. The chat
// context already includes the user's current block + schedule + library, so
// the tool input is intentionally narrow — Claude decides the slice.

import type { AgentToolSpec } from '../types';

export const PROGRAMMER_TOOL_SPEC: AgentToolSpec = {
  name: 'consult_programmer',
  description:
    "Consult the Wendler 5/3/1 programming specialist for assistance " +
    'selection, set/rep prescription, "what should this session look like?", ' +
    'movement-substitution from the library, or block-shape questions. ' +
    "Returns concrete picks grounded in the user's actual training profile " +
    "(TM%, anchor block, 2 main + 1 accessory days, marathon-prep flavor) " +
    "and the active assistance volume budget. Use this for anything that " +
    "would normally be answered by hitting Suggest in the block editor — " +
    "session planning, accessory swaps, deload structure, week-to-week " +
    "variation. Do NOT invent set/rep schemes yourself when this tool is " +
    'available.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          "The user's programming question, copied or paraphrased. Be " +
          'specific about scope — "Wednesday session", "this week", "next ' +
          'block".',
      },
      scope: {
        type: 'string',
        description:
          'Time scope of the request. Omit when not implied by the question.',
        enum: ['session', 'week', 'block', 'multi-block'],
      },
      mainLiftFocus: {
        type: 'string',
        description:
          'Specific main lift the question is about, if any. Omit otherwise.',
        enum: ['bench', 'squat', 'deadlift', 'press'],
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};
