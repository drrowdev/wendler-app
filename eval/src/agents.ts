// Eval harness — agent registry.
//
// Each specialist exposes:
//   - a system prompt (static)
//   - a parser (raw text → discriminated-union result)
//   - default model + sampling params
//
// The runner uses this to drive the cassette/live call cycle uniformly
// across all specialists.

import { CoachAgent, PeriodizerAgent } from '@wendler/domain';

type CoachResponse = ReturnType<typeof CoachAgent.parseCoachResponse> extends
  | { ok: true; data: infer T }
  | { ok: false; errors: string[] }
  ? T
  : never;
type PeriodizerResponse = ReturnType<typeof PeriodizerAgent.parsePeriodizerResponse> extends
  | { ok: true; data: infer T }
  | { ok: false; errors: string[] }
  ? T
  : never;

export interface AgentDef<T> {
  name: string;
  systemPrompt: string;
  defaultModel: string;
  defaultMaxTokens: number;
  defaultTemperature: number;
  parse(raw: string): { ok: true; data: T } | { ok: false; errors: string[] };
}

export const AGENTS = {
  coach: {
    name: 'coach',
    systemPrompt: CoachAgent.COACH_SYSTEM_PROMPT,
    defaultModel: 'claude-haiku-4-5',
    defaultMaxTokens: 4000,
    defaultTemperature: 0.2,
    parse: (raw: string) => CoachAgent.parseCoachResponse(raw),
  } satisfies AgentDef<CoachResponse>,
  periodizer: {
    name: 'periodizer',
    systemPrompt: PeriodizerAgent.PERIODIZER_SYSTEM_PROMPT,
    defaultModel: 'claude-haiku-4-5',
    defaultMaxTokens: 4000,
    defaultTemperature: 0.2,
    parse: (raw: string) => PeriodizerAgent.parsePeriodizerResponse(raw),
  } satisfies AgentDef<PeriodizerResponse>,
} as const;

export type AgentName = keyof typeof AGENTS;
