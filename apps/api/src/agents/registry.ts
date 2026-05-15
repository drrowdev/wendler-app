// Agent registry — central directory of installed specialist agents.
//
// Used by:
//   - Phase 1: discovery / logging. Currently only the Programmer agent
//     is registered.
//   - Phase 3: the chat tool-use orchestrator iterates the registry to
//     build the tool-spec list it passes to Anthropic.
//   - Future phases: weekly-review workflow + admin views.
//
// Each entry records the agent's name, a human-readable description,
// and a version (semantic-ish — bump when the agent's contract or system
// prompt changes meaningfully).

export interface AgentRegistration {
  name: string;
  description: string;
  /** Semver-ish — bump major when the input/output shape changes. */
  version: string;
  /** Whether the agent ships as a callable HTTP endpoint today. */
  httpAvailable: boolean;
}

export const REGISTERED_AGENTS: AgentRegistration[] = [
  {
    name: 'programmer',
    description:
      'Picks Wendler 5/3/1 assistance work (sets, reps, supplemental targeting) for a block, ' +
      'respecting volume budgets, goal flags, equipment, cross-week dedup, and active limitations.',
    version: '1.0.0',
    httpAvailable: true,
  },
  {
    name: 'coach',
    description:
      'Movement-modification coach with sports-physio training. Identifies the underlying ' +
      'anatomical issue from a pain description, maps its biomechanical demand across the ' +
      'user\'s library, proposes per-movement adjustments, recommends a PT consult when warranted.',
    version: '1.0.0',
    httpAvailable: true,
  },
  {
    name: 'periodizer',
    description:
      'Periodization specialist for deload timing, block-to-block transitions, race-week tapers, ' +
      'return-from-layoff ramps. Phase 4 ships the implementation.',
    version: '0.0.0',
    httpAvailable: false,
  },
  {
    name: 'summarizer',
    description:
      'Generates structured weekly training summaries (metrics + commentary). Phase 4 ships ' +
      'the implementation.',
    version: '0.0.0',
    httpAvailable: false,
  },
];

export function getAgent(name: string): AgentRegistration | undefined {
  return REGISTERED_AGENTS.find((a) => a.name === name);
}
