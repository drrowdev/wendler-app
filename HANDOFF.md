# Wendler-App — Handoff Brief for a New AI Pair

This document is the single-shot context dump you need to continue work on
this codebase. Read it top-to-bottom before touching anything.

---

## 1. Project facts

- **What it is:** A 5/3/1 training app (a PWA) implementing Jim Wendler's
  Forever programming with extensions: per-block scheduling, deload/peak/
  taper auto-derivation from a race calendar, AI-assisted accessory
  suggestion, and an offline-first sync engine.
- **User:** Solo developer/user, training 5/3/1 with endurance running on
  the side. Personal source of truth on the schedule.
- **Repo:** `github.com/drrowdev/wendler-app`, branch `main`.
- **Local path:** `<your-local-repo-path>`.
- **Deployed at:** `red-moss-02386a803.7.azurestaticapps.net`
  (Azure Static Web App `wendler-swa`, deploys via CI on push to `main`).
- **NEVER deploy to it manually from another project.** CI owns it.
- **Always `git push` after `git commit`** — the deployed page only
  updates after push.

## 2. Repo layout

Monorepo, pnpm workspaces, Turborepo. Five projects:

| Path | What it is | Notes |
|------|-----------|-------|
| `apps/web` | Next.js 14 app router PWA frontend | All UI, IndexedDB via Dexie, service worker. |
| `apps/api` | Cloudflare Workers / minimal API surface | Used by the AI suggester. |
| `packages/domain` | Pure TS domain logic (no React, no DB) | Heavily tested with Vitest. **Do business logic here.** |
| `packages/db-schema` | Type definitions for entities (no runtime) | Shared by web + api + domain. |
| (no `packages/ui`) | — | Components live under `apps/web/src/components`. |

## 3. Commands

Everything runs from repo root unless noted.

| Task | Command |
|------|---------|
| Typecheck all | `pnpm typecheck` |
| Strict typecheck (matches CI) | `cd packages/domain && npx tsc --noEmit` (the `--noEmit` config picks up tests; `pnpm typecheck` doesn't always) |
| Run domain tests | `pnpm -F @wendler/domain test` |
| Lint | `pnpm lint` |
| Web app dev | `pnpm -F @wendler/web dev` |

There is no `pnpm test` at the workspace root and no test script in
`@wendler/web`. Domain has 723+ tests (Vitest). Web/api have none today.

## 4. Service-worker bump rule

**Every meaningful release MUST bump the SW cache version**:
`apps/web/public/sw.js` → `const CACHE = 'wendler-shell-vNNN';`

If you skip this, installed PWAs serve stale assets after deploy. Current
value at handoff: **v466**.

## 5. CHANGELOG rule

`CHANGELOG.md` at repo root. Append to `## [Unreleased]` for any user-
visible change. Keep entries dense and concrete (rep numbers, mapping
tables, exact phase names). Prior entries set the tone — match it.

## 6. Commit conventions

- Imperative, no scope prefix necessary (the repo's history mixes both).
- Always include the trailer:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
- Multi-paragraph commit messages are normal here. Use them.

## 7. Key domain concepts

These appear constantly. Internalize before editing.

### 7.1 Block / week / day

- A **ProgramBlock** is a 3- or 5-week training cycle (`weeksBeforeDeload`
  + optional deload week + optional 7th week). Variants: `leader`,
  `anchor`, `standalone`, `seventh-week`.
- `block.startedAt` is when the user *activated* the block. NOT necessarily
  the first training day. **Don't use it as a calendar anchor.**
- The actual calendar anchor is the earliest `performedAt` across
  `sessions.where('blockId').equals(block.id)`. Falls back to "now" when
  no sessions are logged yet.
- **`weekStartDate(anchor, weeksBeforeDeload, weekScope)`** in
  `packages/domain/src/blocks.ts` resolves "what's the calendar start
  date of week N (or 'deload')?". Returns `undefined` for `'default'` /
  `'7w'` scopes.

### 7.2 Training Profile (the "four-axis" model)

Lives at `packages/domain/src/training-profile.ts`. The user's
strategic preferences:

- `primaryGoal`: e.g. `marathon-prep`, `general-strength`.
- `secondaryGoals` (Tier 2): toggleable, phase-suppressible. Examples:
  `real-life-strength`, `functional-movement`, `isolation-emphasis`,
  `injury-prevention`.
- `constraints` (Tier 3): user-authored "do-not-program" filters. Hard
  filters that never compete with goals for slot budget.
- `trainingPhase`: `normal | deload | taper | peak`.
- `trainingPhaseManual: boolean`: if true, the manual phase wins over
  any auto-derivation.

### 7.3 Phase auto-derivation

The exposed entry points are `effectiveTrainingPhase(profile, races, now, activeBlock?)` (back-compat — just returns the phase) and `effectiveTrainingPhaseInfo(...)` (returns `{ phase, source }` where `source: 'manual' | 'race' | 'block'` — drives the visible "Auto · …" badge UI).

**Precedence (highest first):**

1. `profile.trainingPhaseManual === true` → manual override wins.
2. **Race-driven peak/taper** (`autoPhaseFromRace` in `training-profile.ts`). Windows:
   - A or B priority race ≤14d → `'taper'`
   - A priority, 15–28d → `'peak'`
   - B priority, 15–21d → `'peak'`
   - C priority: never auto-fires
   - A race opted out via `race.taperActions?.competitionPeakingActivated?.dismissedAt` is ignored.
3. **Block-derived deload**: when `activeBlock.kind === 'seventh-week'` and `activeBlock.seventhWeekKind === 'deload'`, phase auto-derives to `'deload'`. The 2-completed-Leader cadence gate that decides *when* to insert a 7th-week deload block lives in `nextSeventhWeekRecommendation` (see § 7.6) — by the time the block exists and is active, the deload is warranted.
4. Profile fallback (`profile.trainingPhase`), tagged source `'manual'`.

**Important:** the suggester now passes a per-week date (anchored to the first session), not `Date.now()`. So Wk2 of an anchor block can be in `peak` while Wk1 is `normal`. The block-derived deload signal is per-block, not per-week.

**No-silent-automation UX rule.** Whenever the app auto-derives phase (`source: 'race' | 'block'`), a visible amber `PhaseAutoBadge` is rendered next to the block name, on `/goals`, and in the suggester header. A one-time first-encounter toast (`PhaseAutoToast`) fires once per (source, phase) bucket via `localStorage:wendler:phase-auto-toast-seen:v1`. The user is never silently moved into a non-normal phase.

### 7.4 GoalFlags + Directives

`packages/domain/src/goal-flags.ts`. The legacy axis of the suggester:
boolean flags (`marathon`, `realLifeStrength`, `bigArms`, `deload`,
`competitionPeaking`, `mobilityFocus`) that drive `RuleDirectives`.
Phase modulates these via `volumeMultiplier` (taper × 0.6, peak × 0.75)
which scales LLM-recommended set counts.

`deriveGoalFlags(profile, races, now)` returns
`{ flags, phase, effectiveSecondaries, phaseDirectives }`. Use this in
preference to manipulating flags directly.

### 7.5 Assistance volume

`packages/domain/src/blocks.ts`. Three presets, calibrated against Wendler 5/3/1 Forever (re-read end-to-end in v278):

| Preset | mainDayReps | accessoryReps | accessoryMovements | Forever mapping |
|--------|-------------|---------------|-------------------|-----------------|
| minimal | 75 | 225 | 7 | 7th-Week Protocol floor (25+25+25) |
| standard | 120 | 300 | 10 | BBB/Leader range |
| high | 150 | 450 | 14 | Anchor/FSL upper end |

Or a custom object `{ preset: 'custom', mainDayReps, accessoryReps, accessoryMovements }`.

**`defaultAssistanceVolumeForKind(kind, seventhWeekKind?)`** — sensible
default preset per block kind, mirroring Wendler Forever's
volume/intensity shape:

- **leader** → `'standard'` — Leader = *volume* block for the main lifts
  (5s PRO + heavy supplemental like BBB 5×10, SSL). Supplemental
  already provides massive systemic load; stacking `high` assistance
  on top is over-prescription.
- **anchor** → `'high'` — Anchor = *intensity* block (classic 5/3/1
  with AMRAP, lighter supplemental — often FSL 3–5×5 or none). Short
  main work leaves room for accessory variety. (Flipped from `standard`
  in v276 after re-reading Wendler.)
- **standalone** → `'standard'` (no Leader/Anchor cadence — neutral)
- **7th-week** (any variant) → `'minimal'` (recovery/test cycle)

**`effectiveAssistanceVolumeForPhase(stored, phase)`** — phase-aware
preset shift. Peak and taper are NOT symmetric:

- `normal` → unchanged
- `deload` → `'minimal'`
- `taper` → `'minimal'` (race ≤14d, recovery)
- `peak` → `'high'` → `'standard'` only; `'standard'` and `'minimal'`
  stay put (race 15–28d A / 15–21d B, sharpening — still training).
- Custom volumes are never auto-shifted.

`goalsToPromptContext(flags, notes, phase?)` emits different prose for
`peak` vs `taper`:

- **Peak** prose: "still training, drop AMRAP overload, volume modestly
  reduced". Variation across weeks is fine — Wendler 5/3/1 Forever p.86:
  *"I don't see any problem in changing the exercises from workout to
  workout. It is the work that matters."*
- **Taper** prose: "recovery, not training, maintenance only, prehab +
  light isolation, do NOT introduce novel movements".
- 2-arg legacy signature preserved for back-compat.

`evaluateGoalsForRules(flags, opts?)` accepts an optional `phase` so
the `preferProven` directive (set by `flags.competitionPeaking`) only
fires in **taper** (≤14d, novelty before a race is risky), not in
**peak** (still training, variation is fine). Without `phase`, the
legacy combined behavior is preserved.

The AI suggester (`apps/web/src/components/SuggestAssistanceForBlock.tsx`)
threads phase through both the prompt builder and the deterministic
fallback's `evaluateGoalsForRules` call, so the LLM and the fallback
see the same peak/taper-aware directives.

### 7.6 The AI suggester

Component: `apps/web/src/components/SuggestAssistanceForBlock.tsx`.
Calls `apps/api` which proxies to Claude. Features:

- Per-week scope (Wk1 / Wk2 / Wk3 / Deload, each programmed
  independently — the legacy "default" tab was removed in v287; the
  per-day `day.assistance` list still exists in storage as a vestigial
  field but is no longer surfaced in the UI).
- Cross-week awareness: when generating Wk2, the prompt includes a
  summary of what's already in Wk1 (and vice versa).
- Per-week phase: anchored to first-session date in the block (see 7.1).
- Per-week main-work context: `formatMainWorkSection` in
  `assistance-prompt.ts` emits a "## Main work this week" block with
  set/rep/%TM scheme + week-specific guidance ("be conservative"
  on Wk3, "cut volume meaningfully" on deload, etc.).
- Prehab concentration rule: caps face pulls / band pull-aparts /
  scapular work. Concentrate on the dedicated accessory day; ≤1 per
  main-lift session; whole-week ceiling ≈ training-days/2; replaced
  prehab → deficit slot, never another prehab.
- Phase-aware preset shift: the visible `BlockAssistanceVolumePanel`
  chip auto-shifts per week; the suggester uses the same effective
  preset. The amber "auto · {phase} → {preset}" badge surfaces the
  shift.

### 7.7 Sync engine

`apps/web/src/lib/sync.ts`. **Last-Write-Wins on `updatedAt`** for all
mutable rows (block/program/goal/cardio/race). This matters because:
historically, mid-delete sync pulls would resurrect just-deleted rows
(commit `272e1eb` fixed this).

When you delete client-side, the row is upserted with a tombstone
`deletedAt` and pushed. Sync respects tombstones.

## 8. Recent shipped work (latest first)

| SHA | SW | Summary |
|-----|----|---------|
| _pending_ | v272 | Block-derived deload phase + "no silent automation" UX: `effectiveTrainingPhaseInfo` exposes `{ phase, source }`; 7th-week deload blocks auto-derive `phase: 'deload'`. New `PhaseAutoBadge` + `PhaseAutoToast` surfaces on block editor, `/goals`, and suggester header. `volumeMultiplier` suppressed when phase was auto-derived (avoids compounding with preset auto-shift). |
| `81495ad` | v271 | Phase-aware auto-shift for assistance volume chip (visible + LLM both). |
| `17dabce` | v270 | Anchor per-week phase derivation to first session, not block activation. `weekStartDate` API: `(anchor, weeksBeforeDeload, weekScope)`. |
| `bf85d4a` | — | CI typecheck fix: missing `createdAt` on a test fixture. |
| `79acb46` | v269 | Per-week phase auto-derivation from race calendar (initial). |
| `4aa8433` | v268 | Prehab concentration rule. |
| `6041d48` | v267 | Per-week main-work context section. |
| `272e1eb` | v266 | Sync LWW guard for mutable rows. |
| `afc11c8` | v265 | Cross-week awareness within the same block. |
| `c22ce3c` | v264 | Clarify Filters help text on `/goals`. |
| `63773c9` | v263 | Rename Tier 1/2/3 → Primary/Secondary/Filters in UI. |
| `9771ce6` | v262 | LLM may propose novel movements, auto-add to library on accept. |
| `1ed2477` | v261 | Sharpen `real-life-strength` vs `functional-movement`. |

(Older commits handled the original Tier rename, removing built-in
constraints, and the four-axis profile editor on `/goals`. Constraints
are now user-authored only — there's no built-in vocabulary.)

## 9. Open / parked items

- **`free-text secondary goals`** — explicitly rejected for v1. There's
  a "request a new secondary goal" CTA in the UI that captures real
  demand instead. Don't add free-text without a redesign.
- **`ProgramBlock.weeksBeforeDeload` is vestigial.** Survives in the
  schema for sync-compat but is no longer semantically meaningful. The
  in-block deload-week concept was fully eliminated in v453 (see
  CHANGELOG): `includesDeload` is GONE from `ProgramBlock`, and 7th-week
  deload is now strictly a separate block (`kind: 'seventh-week'`,
  `seventhWeekKind: 'deload'`). Treat `weeksBeforeDeload` as opaque.
- **Generalize the 7th-week cadence rule?** Today `nextSeventhWeekRecommendation`
  only fires the deload prompt after 2+ completed *Leader* blocks (matches
  Wendler's macro shape). If you ever want "any 2 consecutive completed
  non-7w blocks → deload prompt" regardless of kind, that's a one-line
  change in `seventh-week.ts`. We explicitly chose to keep the
  Leader/Anchor-specific behavior in the v272 work.
- **Voice + in-session AI (proactive Layer 5)** — explicitly **on hold**
  pending real-usage feedback on Layers 1–4 (page-aware prompts, daily
  brief, event triggers, persistent memory). Consumption cost was the
  trigger for pausing; revisit once trigger value is established.

## 10. Anti-patterns to avoid

- ❌ Using `block.startedAt` as a calendar anchor. Use the first-session
  derivation pattern shown in `SuggestAssistanceForBlock.tsx` and
  `BlockAssistanceVolumePanel.tsx`.
- ❌ Adding logic to `apps/web` that belongs in `packages/domain`.
  The domain package is heavily tested; the web layer isn't.
- ❌ Trusting `pnpm typecheck` alone before push. Use
  `cd packages/domain && npx tsc --noEmit` for a CI-equivalent check.
  (CI caught a missing `createdAt` field that local `pnpm typecheck`
  silently passed; see `bf85d4a`.)
- ❌ Forgetting to bump the SW cache version. PWA caching will bite.
- ❌ Forgetting to `git push`. The deployed app won't update on
  `git commit` alone.
- ❌ Mutating block-level state from a per-week chip. The phase-aware
  preset shift is *display-only* unless the user clicks. Clicking
  persists block-level (overrides the auto everywhere).

## 11. Files most likely to need editing next

- `packages/domain/src/training-profile.ts` — phase logic, secondary-goal
  suppression matrix.
- `packages/domain/src/assistance-prompt.ts` — the LLM prompt template
  (system + user). Section formatters live here.
- `packages/domain/src/assistance-suggest.ts` — deterministic fallback
  suggester (used when the API call fails).
- `packages/domain/src/goal-flags.ts` — the legacy boolean-flag axis +
  RuleDirectives.
- `packages/domain/src/blocks.ts` — `weekStartDate`,
  `effectiveAssistanceVolumeForPhase`, presets, defaults.
- `apps/web/src/components/SuggestAssistanceForBlock.tsx` — the AI
  suggester React component (button, prompt assembly, apply logic).
- `apps/web/src/components/BlockAssistanceVolumePanel.tsx` — the
  Assistance volume chip strip + custom input.
- `apps/web/src/components/BlockPlanEditor.tsx` — the per-day editor
  that hosts the suggester and per-week tab strip.

## 12. Memorable test fixtures / patterns

- **Race factory in tests** must include `createdAt` AND `updatedAt`
  (both required strings on `RaceLike`). Stub example:
  ```ts
  function race(overrides: Partial<RaceLike> & Pick<RaceLike, 'date'>): RaceLike {
    return {
      id: 'r-test',
      name: 'Test Race',
      priority: 'A',
      kind: 'half-marathon',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }
  ```
- **`Date.now()` in domain code is forbidden in functions that take a
  `now` parameter** — always thread the date through. The suggester
  now passes a per-week target date, not `new Date()`.

## 13. Quick smoke test before any release

1. `cd packages/domain && npx tsc --noEmit` — clean.
2. `pnpm -F @wendler/domain test` — all green (~720 tests in ~3s).
3. `pnpm lint` — no warnings.
4. Bump `apps/web/public/sw.js` cache version.
5. Add CHANGELOG entry under `## [Unreleased]`.
6. `git add -A && git commit -m "..." -m "Co-authored-by: ..." && git push`.
7. (Optional) `gh run list --branch main --limit 2` to confirm CI.

## 14. Where to look for "why did we do it that way?"

The best signal is the commit history (`git log --oneline`) followed by
the CHANGELOG. Both are written for future-you. The commits since
`fc8ba3c` (the four-axis Training Profile editor) tell the entire arc
of the recent assistance-suggester refinements.

---

End of handoff. Anything not covered here, ask the user before guessing.
