# Instructions for AI assistants

This file is for AI assistants (GitHub Copilot, Claude, Cursor, etc.) working
in this repo. Humans, feel free to read it too — it's also a quick onboarding
crib.

## Project shape

- pnpm workspace (root `pnpm-workspace.yaml`).
- `apps/web` — Next.js 15 PWA, static export (`output: 'export'`),
  Tailwind v4, Dexie 4 (IndexedDB).
- `apps/api` — Azure Functions (Node 20, TS) → SWA managed Functions.
- `packages/domain` — pure TS, vitest, zero deps.
- `packages/db-schema` — shared types between web + api.
- `infra/` — Bicep templates.
- `.github/workflows/` — CI + deploy.

## Doing work in this repo

- **Run tests** before committing: `pnpm test` (recursively runs vitest in
  `packages/domain` — currently the only package with tests).
- **Typecheck**: `pnpm typecheck` runs `tsc --noEmit` in every package, but
  CI runs `tsc` from inside each package directory and that is **stricter**
  in some cases (especially missing required string fields on test fixtures
  and cross-package imports). Before pushing anything that touches
  `packages/domain`, also run `cd packages/domain && npx tsc --noEmit` —
  this matches what CI does and catches the gaps `pnpm typecheck` misses.
- **Build**: `pnpm --filter @wendler/web build` (must succeed for deploy).
- **Always `git push` after `git commit`** — the deployed PWA only updates
  after push (CI builds + ships on push to `main`).
- **Conventional commits** — `feat(scope): …`, `fix(scope): …`, etc.
  Always include the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- **Bump the SW cache** in `apps/web/public/sw.js` (`CACHE = 'wendler-shell-vNNN'`)
  on every meaningful release so installed PWAs evict stale assets.
- **Don't deploy via SWA-CLI** — `swa deploy apps/api` ships pnpm-symlinked
  `node_modules` which the SWA function packager can't unpack and the API
  silently 404s. Push to `main`; the GitHub Actions workflow stages a clean
  `api-bundle/` with `npm install --omit=dev` first.

## Documentation policy (KEEP THIS UP TO DATE)

When you ship anything user-visible or change repo conventions, update the
relevant doc(s) **in the same commit**:

| Change kind | Update |
|---|---|
| New feature, UX change, removal | `CHANGELOG.md` (under `[Unreleased]`, or open a new version section) |
| New env var, schema migration, deploy mechanic | `docs/architecture.md` |
| Strava-flow change | `docs/strava-setup.md` |
| New methodology mapping | `docs/methodology.md` |
| Stack change, release theme | `README.md` versioning table + `## Stack` |
| New AI-assistant convention | this file |
| New analytics card / domain helper | add card to `apps/web/src/components/analytics/`, helper to `packages/domain/src/` (with vitest), wire into `/analytics` page, mention in `CHANGELOG.md` |

When cutting a release:
1. Move `[Unreleased]` items into a new `[X.Y.Z] — YYYY-MM-DD` section in
   `CHANGELOG.md`.
2. Bump the version table in `README.md`.
3. Bump `apps/web/public/sw.js` `CACHE` version.

If any of the above feels unclear or feels like it conflicts with what the
user is asking for, ask before committing.

## Architectural ground rules

- **Local-first**: every write hits Dexie first; cloud sync is opt-in and
  downstream. Never gate UX behind a network call.
- **Append-only with `updatedAt`**: no destructive deletes in domain code;
  UI deletes write `deletedAt` / `tombstones`.
- **Domain functions are pure** — never reach into Dexie or fetch.
- **No telemetry, no analytics scripts.** Nothing leaves the device unless
  the user explicitly enabled cloud sync.
- **Idempotency where it matters**: recovery `id = YYYY-MM-DD`,
  Strava-imported cardio `externalId = 'strava:<id>'` — re-syncs dedupe.
- **Manual user overrides are sticky** — see `planMatch === 'manual'` for
  the run-plan-matching pattern. Re-derivers must skip these rows.

## Common pitfalls

- **MSAL client id is hardcoded** in `apps/web/src/lib/msal-config.ts`. The
  backend `MSAL_CLIENT_ID` env var **must** equal it; otherwise auth returns
  403/500. See `docs/architecture.md` for the full env-var matrix.
- **AAD app-reg "Display name"** in Azure portal is what users see in the
  sign-in popup. If it gets renamed (e.g. by a sibling project's deploy),
  rename it back via Azure Portal → App registrations → Branding.
- **`apps/api/host.json` extension bundle is `[4.*, 5.0.0)`** — do not bump
  to v5 without checking SWA managed-Functions compatibility.
- **Strava metadata is sparse**: third-party apps (Runna, Garmin Connect
  bridge) typically push generic activity names with no description or
  `workout_type`. Don't build matching logic that relies on richer metadata
  unless you've verified it shows up via `/api/strava/inspect`.

## When in doubt

Read the relevant `docs/` page first. If still unclear, ask the user
rather than guessing — this is a personal project where alignment matters
more than throughput.

## Where things live

- **`/analytics` page** — `apps/web/src/app/analytics/page.tsx` is a thin
  orchestrator. All charts/tables live in
  `apps/web/src/components/analytics/<Name>Card.tsx`. Each card is
  prop-driven and self-contained so it can be reordered, hidden, or used
  outside the page without rewiring. Add a new card by writing the
  component + (if needed) a pure aggregator in
  `packages/domain/src/cardio-analytics.ts` or `analytics.ts`, then
  importing it into `page.tsx` under the appropriate mode gate
  (`showStrength` / `showCardio`).
- **Cardio domain helpers** live in
  `packages/domain/src/cardio-analytics.ts` — pure, vitest-covered, no
  Dexie / `db-schema` value imports.
- **Training Profile + AI assistance suggester (v1.3.0 work).** The
  four-axis profile (primary goal × secondary toggles × phase × race
  calendar) lives in `packages/domain/src/training-profile.ts` —
  `effectiveTrainingPhase`, `effectiveTrainingPhaseInfo` (returns
  `{ phase, source: 'manual' | 'race' | 'block' }`), `autoPhaseFromRace`,
  `deriveGoalFlags`. Race proximity windows: A or B priority ≤14d →
  `taper`; A 15–28d → `peak`; B 15–21d → `peak`; manual
  `trainingPhaseManual` always wins; dismissing the peaking banner opts
  a race out of auto-derivation. **Block-derived deload**: when the
  active block is `kind: 'seventh-week'` with
  `seventhWeekKind === 'deload'`, phase auto-derives to `deload` at the
  GoalFlags layer. Precedence: manual > race > block > normal.
  **No-silent-automation UX**: `PhaseAutoBadge` is mounted on the block
  editor header, `/goals`, and the AI suggester header whenever
  `source !== 'manual'` and `phase !== 'normal'`; `PhaseAutoToast` fires
  a one-time per (source, phase) bucket banner via localStorage. The
  `volumeMultiplier` directive is suppressed when phase is auto-derived
  to non-normal (avoids compounding with the preset auto-shift).
  Per-week derivation uses
  `weekStartDate(anchor, weeksBeforeDeload, weekScope)` in `blocks.ts`
  — the anchor is the **earliest `performedAt` of any session in the
  block**, not `block.startedAt`. The visible-week Assistance volume
  chip is auto-shifted by
  `effectiveAssistanceVolumeForPhase(stored, phase)` — deload→`minimal`,
  taper→`minimal`, peak→demote one tier, normal→unchanged, custom→never.
  The AI suggester
  (`apps/web/src/components/SuggestAssistanceForBlock.tsx`) uses the
  same effective preset, so what the chip shows is what the LLM sees.
  See `HANDOFF.md` at the repo root for a full cross-tool brief.
