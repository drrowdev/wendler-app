// Periodizer agent tool spec — registered in Phase 3 so the chat
// orchestrator's tool list is complete from day one. The actual specialist
// implementation ships in Phase 4; until then the dispatch returns a
// "specialist not yet available" tool result and the chat agent reconciles
// around it (typically: answer the parts it can, mention the missing piece).

import type { AgentToolSpec } from '../types';

export const PERIODIZER_TOOL_SPEC: AgentToolSpec = {
  name: 'consult_periodizer',
  description:
    "Consult the periodization specialist for deload-timing decisions, " +
    "block-to-block transitions, race-week tapers, return-from-layoff " +
    "ramps, and \"is my training too hot / too cold?\" questions. Returns " +
    "a concrete recommendation grounded in the user's recent volume + " +
    "intensity + ACWR signals plus any upcoming priority races. Use this " +
    "for any question that's about WHEN or HOW MUCH (taper, deload, peak), " +
    "not WHAT (movement selection — that's the programmer).",
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          "The user's periodization question, copied or paraphrased.",
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};
