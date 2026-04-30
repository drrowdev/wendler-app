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
shared via `packages/db-schema/src/index.ts`. Current: **v4**.

| Version | Added |
|---|---|
| 1 | settings, movements, sets, sessions, trainingMaxes |
| 2 | blocks, schedule |
| 3 | painFlags |
| 4 | goals, cardio, recovery, pushSub |

## Build & deploy

Triggered on push to `main`:

1. GitHub Actions checks out, sets up pnpm, installs.
2. Workspace tests + typecheck run.
3. `pnpm --filter @wendler/web build` produces `apps/web/out` (static export).
4. API is staged into `api-bundle/` with a clean `npm install --omit=dev`
   (pnpm symlinks break SWA managed Functions — keep this).
5. `Azure/static-web-apps-deploy@v1` ships both.

## Conventions

- All DB writes are **append-only with `updatedAt`**. No destructive deletes
  in domain code; UI deletes set `deletedAt`.
- `id` is always a `crypto.randomUUID()` except where idempotency matters
  (recovery uses `YYYY-MM-DD`).
- Domain functions are **pure** — never reach into Dexie or fetch.
- Page components own all wiring; hooks own subscriptions.
- No telemetry. No analytics scripts. Nothing leaves the device unless the
  user explicitly enabled cloud sync.
