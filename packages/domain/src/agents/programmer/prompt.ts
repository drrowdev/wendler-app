// Programmer agent — prompt builder.
//
// The Programmer agent is the existing `suggestAssistance` LLM-grounded
// system, formalised as a first-class agent. Its job: pick assistance work
// for a Wendler 5/3/1 block (sets, reps, AMRAP flags, supplemental targeting)
// from the user's movement library, respecting:
//   - Wendler 5/3/1 conventions (TM%, AMRAP+3 rule, supplemental shapes,
//     Leader/Anchor preset shift, deload/taper auto-shift)
//   - Per-block volume budgets (preset → preset-shift → cardio-fatigue trim)
//   - Goal flags + Training Profile filters (primary/secondary goals)
//   - Cross-week dedup + family-dedup (rotate within same family week-to-week)
//   - Available equipment (filters the library by `equipment` field)
//   - Active limitations (Phase 2: per-injury adjustments the user accepted)
//
// What the Programmer agent does NOT do:
//   - Anatomical reasoning about injuries (that's Coach's job — Phase 2)
//   - Macro periodization (deload timing, taper scheduling — Periodizer in Phase 4)
//   - Run programming (Martin uses Runna for that; cardio history is a
//     load signal only)
//   - Diagnostic advice (no agent in this app does diagnostics)
//
// Prompt-shape convention (locked in master plan):
//   - SYSTEM prompt: STATIC. The 14 system rules, the slot vocabulary, the
//     output JSON schema, the Wendler conventions (these don't change
//     between calls).
//   - USER prompt: DYNAMIC, built per call from the live IndexedDB state.
//     TM%, goals, schedule, equipment, library, recent history, active
//     limitations — every per-call value reaches the model through the user
//     prompt builder.
//
// Implementation is still in `packages/domain/src/assistance-prompt.ts`;
// this module re-exports under the canonical `agents/programmer/` path so
// future workflows + tool-use orchestrators can import the agent's
// prompt-shape from one consistent place.

export {
  buildAssistancePrompt,
  formatMainWorkSection,
  type BuildAssistancePromptInput,
  type BuiltAssistancePrompt,
} from '../../assistance-prompt';
