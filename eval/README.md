# Wendler eval harness

Regression harness for the specialist AI agents (Coach, Periodizer, Programmer, Summarizer).

## Quick start

```bash
# Pure replay against cached cassettes (offline, free, ~10s).
pnpm eval

# Same, but fail if any cassette is stale (prompt hash drift).
pnpm eval:strict

# Refresh cassettes from live Anthropic API (costs tokens, ~1 min).
ANTHROPIC_API_KEY=sk-ant-... pnpm eval:refresh
```

## Adding a test case (5 min)

1. **Drop a fixture** in `fixtures/<agent>/`. JSON file with a name, description, and `input` (the agent's input shape).
2. **Drop golden assertions** in `golden/<agent>/<name>.assertions.json`. Describe what should be true about the response (shape, element rules, ordering).
3. Run `pnpm eval:refresh` once to capture the cassette. Commit fixture + golden + cassette together.
4. From then on, `pnpm eval` replays in <1s per case.

## What to assert

**Do** assert:
- Output shape (required fields present, counts in expected range).
- Specific elements appear or are absent (e.g. "Bulgarian split squat must have an adjustment", "goblet squat must NOT have one").
- Ordering invariants (in-block movements first, descending confidence).
- Hard rules (Coach mustn't propose adjustments to library exclusions; Periodizer's verdict must be in the enum).

**Don't** assert:
- Exact text matches on summaries / rationales (model is non-deterministic).
- Specific confidence labels unless the case is unambiguous.

## Workflow when you edit a prompt

1. Edit the system prompt.
2. `pnpm eval` — see what breaks.
3. Either:
   - **Fix the prompt** if regressions are unintended.
   - **Update goldens** if behavior changed intentionally (PR description should explain).
4. `pnpm eval:refresh` — recapture cassettes under the new prompt.
5. Commit everything: prompt change + golden updates + cassette diffs.

## Scope

v1 covers specialists with strict JSON output (Coach, Periodizer, Programmer, Summarizer). The chat orchestrator is out of scope — its multi-turn streaming + tool-use surface needs a different harness shape.

See `wendler-eval-harness-plan.md` in the Clawpilot scratchpad for the design rationale.
