// Summarizer agent tool spec — registered in Phase 3 so the chat
// orchestrator's tool list is complete from day one. The actual specialist
// implementation ships in Phase 4; until then the dispatch returns a
// "specialist not yet available" tool result and the chat agent reconciles
// around it.

import type { AgentToolSpec } from '../types';

export const SUMMARIZER_TOOL_SPEC: AgentToolSpec = {
  name: 'summarize_week',
  description:
    'Generate a structured summary of a recent training week (or the ' +
    'current one). Returns key metrics + qualitative coach-style ' +
    'commentary suitable for direct embedding in the chat reply. Use this ' +
    'when the user asks "how was last week?", "what did I do this week?", ' +
    'or any digest / recap question.',
  inputSchema: {
    type: 'object',
    properties: {
      weekStart: {
        type: 'string',
        description:
          'ISO date (YYYY-MM-DD) for the Monday of the week to summarize. ' +
          'Omit to default to the current week.',
      },
    },
    additionalProperties: false,
  },
};
