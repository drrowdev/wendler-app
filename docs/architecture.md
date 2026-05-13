# Architecture

## Stack

- **Web app**: Next.js 15 (App Router, static export) + TypeScript + Tailwind v4
- **Local store**: IndexedDB via Dexie 4 (`apps/web/src/lib/db.ts`)
- **Domain logic**: `packages/domain` (pure TS, vitest, zero deps)
- **Schema types**: `packages/db-schema` (shared between web + api)
- **API**: Azure Functions (Node 20) bundled into Static Web Apps managed Functions (`apps/api`)
- **Cloud store**: Cosmos DB serverless, container `wendler/sync`, partition `/userId`
- **Auth**: Azure Static Web Apps built-in AAD provider, multi-tenant + personal MSA
- **Hosting**: Azure Static Web Apps Free tier (West Europe), resource group `rg-wendler-app`

## Local-first model

All writes hit IndexedDB first. The user can train fully offline and the PWA
ships an installable manifest + service worker. Sync is opt-in:

1. User signs in with personal MSA via `/.auth/login/aad`.
2. Push: client batches updated rows since `lastSync` and POSTs to
   `/api/sync/push` keyed by deterministic doc id (`{kind}:{id}`).
3. Pull: client GETs `/api/sync/pull?since=<iso>` and applies inbound docs
   with last-write-wins semantics (per-day for recovery rows).

## Schema versions

Dexie migrations live in `apps/web/src/lib/db.ts`. The schema version is
shared via `packages/db-schema/src/index.ts`. Current: **v10**.

| Version | Added |
|---|---|
| 1 | settings, movements, sets, sessions, trainingMaxes |
| 2 | blocks, schedule |
| 3 | painFlags |
| 4 | goals, cardio, recovery, pushSub |
| 5 | programs (multi-block container) |
| 6 | tombstones (soft-delete propagation) |
| 7 | cardio.externalId index (Strava dedup) |
| 8 | block-level assistance + warm-ups |
| 9 | sync push-watermark reset (re-push on app upgrade) |
| 10 | runPlan singleton (recurring weekly cardio template) |

## Service-worker / PWA cache

`apps/web/public/sw.js` defines `CACHE = 'wendler-shell-vNNN'`. **Bump this
version on every meaningful release** so installed PWAs evict stale assets
on the next visit. Network-first for HTML navigations, stale-while-revalidate
for everything else.

## Build & deploy

Triggered on push to `main`:

1. GitHub Actions checks out, sets up pnpm, installs.
2. Workspace tests + typecheck run.
3. `pnpm --filter @wendler/web build` produces `apps/web/out` (static export).
4. API is staged into `api-bundle/` with a clean `npm install --omit=dev`
   (pnpm symlinks break SWA managed Functions — keep this).
5. `Azure/static-web-apps-deploy@v1` ships both.

> **Manual SWA-CLI deploys are discouraged** — `swa deploy apps/api` uploads
> the workspace's pnpm-symlinked `node_modules`, which SWA's function packager
> cannot unpack, and the API silently 404s. If you must deploy locally, stage
> `api-bundle/` first the same way the workflow does.

## Required Application Settings (Azure SWA → Configuration)

These environment variables must exist on the Static Web App for the API
to function. Restoring any of these from scratch? See the matrix below.

| Name | Purpose | Read in |
|---|---|---|
| `MSAL_CLIENT_ID` | AAD app-reg client id; backend audience-validates `x-id-token` against it. **Must equal the hardcoded value in `apps/web/src/lib/msal-config.ts`.** | `apps/api/src/auth.ts` |
| `OWNER_EMAILS` | Comma/space-separated allowlist. Empty = open. | `apps/api/src/auth.ts` |
| `AUTH_STATE_SECRET` | ≥16 char secret used to HMAC-sign Strava OAuth state | `apps/api/src/auth.ts` |
| `STRAVA_CLIENT_ID` | Strava app client id (from <https://www.strava.com/settings/api>) | `apps/api/src/functions/strava*.ts` |
| `STRAVA_CLIENT_SECRET` | Strava app secret | same |
| `STRAVA_REDIRECT_URI` | `https://<swa-host>/api/strava/callback` | `apps/api/src/functions/stravaConnect.ts` |
| `COSMOS_CONNECTION_STRING` *(or `COSMOS_ENDPOINT` + `COSMOS_KEY`)* | Cosmos credentials | `apps/api/src/cosmos.ts` |
| `COSMOS_DB_NAME` | defaults to `wendler` | same |
| `COSMOS_CONTAINER_NAME` | defaults to `sync` | same |

If `MSAL_CLIENT_ID` is missing → `/api/me` returns `auth check failed: 500`.
If it's wrong → `403` with `verify-failed: …` reason.
If `STRAVA_CLIENT_ID` / `_SECRET` are missing → `/api/strava/status` returns
`{configured: false}` and the Strava panel hides itself entirely.

## Cosmos DB protections

The cloud store is the only piece of irreplaceable state in this stack
(Dexie can be re-pulled, code is in git, the SWA can be redeployed). It
has the following guard-rails — if you tear them down, put them back.

| Layer | Setting | Notes |
|---|---|---|
| **Resource lock** | `CanNotDelete` lock named `cosmos-no-delete` on the Cosmos account | Blocks accidental `az cosmosdb delete` / portal delete. To delete the account you must explicitly remove the lock first. |
| **Backup** | Periodic, **interval 1440 min, retention 168 h (7 days)**, geo-redundant | Free under the Cosmos backup allowance for our data size. Continuous/PITR is overkill for ~1 write/day. |
| **Network** | IP firewall: `<owner home IP>` + `0.0.0.0` (= "Accept connections from within Azure datacenters", needed so SWA managed Functions can still reach Cosmos) | Public access stays `Enabled` but only the listed sources can connect. Update the home-IP rule when ISP rotates it, or drop it and rely on the Azure-DC rule + portal-from-Azure if you don't need direct CLI data-plane access. |
| **Delete alert** | Activity-Log alert `alert-cosmos-delete` → action group `ag-wendler-admin` → email `<your-admin-email>` | Fires on `Microsoft.DocumentDB/databaseAccounts/delete` even if someone bypasses the lock. |
| **Auth** | Local key auth still enabled (`disableLocalAuth: false`); keys live in SWA Configuration as `COSMOS_CONNECTION_STRING` | Switching to Managed Identity is a possible future hardening but requires app changes — not done. |

Recreate from CLI (idempotent):

```pwsh
$acct="<your-cosmos-account-name>"; $rg="rg-wendler-app"
az lock create --name cosmos-no-delete -g $rg --resource-name $acct `
  --resource-type Microsoft.DocumentDB/databaseAccounts --lock-type CanNotDelete
az cosmosdb update -n $acct -g $rg --backup-interval 1440 --backup-retention 168
az cosmosdb update -n $acct -g $rg --ip-range-filter "<your-ip>,0.0.0.0"
az monitor action-group create -g $rg -n ag-wendler-admin --short-name wendlerAdm `
  --action email AdminEmail <your-admin-email>
az monitor activity-log alert create -g $rg -n alert-cosmos-delete `
  --scope (az cosmosdb show -n $acct -g $rg --query id -o tsv) `
  --condition category=Administrative and operationName=Microsoft.DocumentDB/databaseAccounts/delete `
  --action-group (az monitor action-group show -g $rg -n ag-wendler-admin --query id -o tsv)
```

> The Azure portal may surface a "Cosmos free-tier exceeds 1000 RU/s"
> recommendation. **It's a false positive** — this account is serverless
> (no provisioned RU/s), the recommendation is generated from the
> `enableFreeTier` flag alone. Safe to dismiss.

## Load & Recovery domain

`packages/domain/src/load.ts` owns the cross-domain load model and is
pure TS (vitest, zero deps). The page at `apps/web/src/app/load/page.tsx`
wires it together. Two layers run in parallel:

- **Weekly stress score** — IF²-weighted tonnage + HR-zone-weighted
  cardio (Edwards/Lucia weights `0.5/1.0/2.0/4.0/6.0` for Z1..Z5) +
  RPE/fatigue/sleep modifiers, capped per-component. The cardio cap is
  dynamic: `max(30, round(1.3 × trailingMeanCardioContribution(6 weeks)))`,
  excluding the in-progress week so today's session can't self-cap.
- **Banister daily model** — `dailyLoad()` rolls each day's strength +
  cardio + RPE bump into one number, `dailyLoadSeries()` zero-fills
  empty days, and `banister()` runs the standard recursive EWA
  (`today = yesterday + (load_today − yesterday) / τ`) with τ_c=42
  (CTL) and τ_a=7 (ATL). Returns CTL, ATL, TSB=CTL−ATL, ACWR=ATL/CTL,
  plus a `coldStart` flag set when fewer than 14 days carried any load.

`deloadSuggestion()` combines all of this into a `continue` /
`deload-soon` / `deload-now` recommendation. Urgency contributors:

| Signal | Urgency |
|---|---|
| 3+ consecutive RPE-8.5+ sessions | +3 |
| 2 consecutive RPE-8.5+ sessions | +1 |
| Stress score ≥ 90 (absolute) | +2 |
| Stress score ≥ 75 (absolute) | +1 |
| Avg RPE ≥ 9.2 | +2 |
| Avg RPE ≥ 8.5 | +1 |
| ACWR > 1.5 | +2 |
| ACWR > 1.3 (≤ 1.5) | +1 |
| TSB < -30 | +2 |
| TSB < -15 (≥ -30) | +1 |
| Fatigue ≥ 7/10 | +1 |
| Sleep < 6h avg | +1 |
| 6+ weeks since last deload | +2 |
| 4+ weeks since last deload | +1 |

Cold-start (Banister): TSB/ACWR are suppressed. The 4-week rolling
baseline (mean ± SD of weekly stress) is computed and shown for context
but no longer feeds urgency.

## AI assistance suggester

Optional layer on top of the deterministic assistance engine
(`packages/domain/src/assistance-suggest.ts`). Lets the user fill an
entire block's assistance slots at once via Claude, with the
deterministic engine as a guaranteed fallback.

### Pipeline

```
Block editor ──► buildAssistancePrompt() ──► POST /api/suggestAssistance
   │                  (system + user prompt)        │
   │                                                ▼
   │                                          Anthropic Claude
   │                                       (sonnet-4-6, 8k, temp 0.3)
   │                                                │
   ▼                                                ▼
applyToBlock() ◄── validateBlock() ◄── parseAssistanceResponse()
   │                  │
   │           rejects → corrective fallback to deterministic
   ▼                    suggestAssistance() per day
ValidatedDay[] (entries + per-entry rationale chips)
```

### Prompt inputs

`buildAssistancePrompt` (`@wendler/domain`) pulls together:

| Input | Source |
|---|---|
| `volume` (assistance reps target) | `block.assistanceVolume` |
| `days` (per-day main lift + slot count) | `block.days[]` + main-lift slot rules |
| `movements` (whitelisted catalog) | local Dexie `movements` table |
| `goalFlags` + `goalNotes` | `settings.goalFlags` (`goal-flags.ts`) → `goalsToPromptContext()` for natural-language directives |
| `existingPerDayEntries` | already-placed entries on other days, so the model deduplicates |
| `activeGoalFlavors` | flavor coverage from the `goals` table |
| `cardioPeakActive` | race-taper signal from upcoming races |
| `availableEquipment` | block- or program-scoped equipment availability |
| `longRunDayIndices` | `computeLongRunDays(days, runPlan?.slots)` — block-day indices that fall the day before each recurring long-run slot |

The fully built prompt is shown to the user under the Suggest panel
(copy-to-clipboard) for inspection.

### Marathon-aware constraints

When the user has long-run slots in their recurring run plan, the prompt
emits a *Pre-long-run guidance* line for each pre-long-run day. **As of
SW v246 this fires automatically whenever a long run is on the calendar
— independent of the marathon goal flag.** A scheduled long run is
itself sufficient signal; the marathon flag now only governs additional
behaviors (mandatory hip-stability/calf/hamstring slots, quad
downweighting). Current language (commit `de7b784`, SW v245):

> Pre-long-run guidance: on day(s) X (the day before each long run on
> day(s) Y), strongly prefer to avoid loaded lower-body assistance that
> meaningfully fatigues quads, hamstrings, or glutes — this includes
> bilateral back/front squats, Bulgarian split squats, walking and
> reverse lunges, step-ups, pistol squats, and heavy hip thrusts. Light
> hip-stability prehab is preferred (clamshells, banded lateral walks,
> hip abductions, bodyweight glute bridges). If you must include any
> heavier lower-body work, keep it to ≤2 light sets and justify the
> choice in the rationale.

Earlier revisions used an abstract "squat-pattern compounds with
quads-primary" veto that Claude routinely defeated by reclassifying
movements (e.g. BSS as "single-leg, not squat-pattern"). Enumerating by
movement name removed those escape hatches; softening from `FORBIDDEN`
to "strongly prefer to avoid" + rationale obligation was a deliberate
trade — the deterministic engine's `isHeavyLower()` check still acts as
a hard fallback filter.

### Press-day pair-awareness

System-prompt rule #3 (commit `0d06bd3`, SW v244) splits bench and
press into separate bullets and applies the general principle: **avoid
duplicating the main lift's primary mover even when the implement
differs.** Press-day push slot prefers triceps work (dips, skull
crushers, close-grip) over additional vertical pressing.

### Validator (`validateBlock`)

Server returns `200 { ok:false, errors }` rather than 4xx for schema
problems so the client can decide policy. `validateBlock` enforces:

- All entries reference a movement id from the whitelisted catalog
- All `dayIndex` values fall within the block
- Rationales are present and ≤ 120 characters
- Per-day rep totals fall inside the slot's allowed envelope

Failed validation triggers a per-day fallback to the deterministic
`suggestAssistance()` for the affected days only — successfully
LLM-picked days are kept.

### Configuration

| Setting | Where | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Azure SWA → Configuration | Without it the API returns `503 llm-not-configured` and the client silently uses the deterministic engine. |
| `ANTHROPIC_MODEL` / `ANTHROPIC_MAX_TOKENS` / `ANTHROPIC_TEMPERATURE` | Azure SWA → Configuration (optional) | Defaults: `claude-sonnet-4-6`, 8000 tokens, temperature 0.3. |

## Conventions

- All DB writes are **append-only with `updatedAt`**. No destructive deletes
  in domain code; UI deletes set `deletedAt`.
- `id` is always a `crypto.randomUUID()` except where idempotency matters
  (recovery uses `YYYY-MM-DD`; Strava-imported cardio uses `externalId =
  'strava:<activityId>'` and dedupes on it).
- Domain functions are **pure** — never reach into Dexie or fetch.
- Page components own all wiring; hooks own subscriptions.
- No telemetry. No analytics scripts. Nothing leaves the device unless the
  user explicitly enabled cloud sync.
