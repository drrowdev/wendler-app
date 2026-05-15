import { describe, it, expect } from 'vitest';
import { COACH_TOOL_SPEC } from './coach/tools';
import { PROGRAMMER_TOOL_SPEC } from './programmer/tools';
import { PERIODIZER_TOOL_SPEC } from './periodizer/tools';
import { SUMMARIZER_TOOL_SPEC } from './summarizer/tools';
import type { AgentToolSpec } from './types';

const ALL_SPECS: AgentToolSpec[] = [
  COACH_TOOL_SPEC,
  PROGRAMMER_TOOL_SPEC,
  PERIODIZER_TOOL_SPEC,
  SUMMARIZER_TOOL_SPEC,
];

describe('agent tool specs (Phase 3)', () => {
  it('all specs share unique snake_case tool names', () => {
    const names = ALL_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('every spec has a non-trivial description that mentions when to use it', () => {
    for (const spec of ALL_SPECS) {
      expect(spec.description.length).toBeGreaterThan(80);
      // Anthropic's tool-routing leans heavily on the description; we want
      // at least one usage trigger word in each.
      expect(spec.description.toLowerCase()).toMatch(/use this|consult|generate/);
    }
  });

  it('every spec input_schema is a typed object with at least one property', () => {
    for (const spec of ALL_SPECS) {
      expect(spec.inputSchema.type).toBe('object');
      expect(Object.keys(spec.inputSchema.properties).length).toBeGreaterThan(0);
      // additionalProperties should be locked off so the model can't smuggle
      // unsupported fields through.
      expect(spec.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('Coach spec accepts the fields the dispatch reads (question/area/severity/affectedMovementIds)', () => {
    const props = COACH_TOOL_SPEC.inputSchema.properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['question', 'area', 'severity', 'affectedMovementIds']),
    );
    expect(COACH_TOOL_SPEC.inputSchema.required).toEqual(['question']);
    expect(props.affectedMovementIds!.type).toBe('array');
    expect(props.affectedMovementIds!.items?.type).toBe('string');
  });

  it('Programmer spec accepts the routing-relevant enums (scope, mainLiftFocus)', () => {
    const props = PROGRAMMER_TOOL_SPEC.inputSchema.properties;
    expect(props.scope?.enum).toEqual(['session', 'week', 'block', 'multi-block']);
    expect(props.mainLiftFocus?.enum).toEqual(['bench', 'squat', 'deadlift', 'press']);
    expect(PROGRAMMER_TOOL_SPEC.inputSchema.required).toEqual(['question']);
  });

  it('Phase-4 specs (periodizer, summarizer) are still well-formed even though dispatch is stubbed', () => {
    expect(PERIODIZER_TOOL_SPEC.inputSchema.required).toEqual(['question']);
    // summarize_week's only field is optional weekStart.
    expect(SUMMARIZER_TOOL_SPEC.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(SUMMARIZER_TOOL_SPEC.inputSchema.properties)).toEqual(['weekStart']);
  });
});
