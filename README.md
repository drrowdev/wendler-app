# Wendler 5/3/1 PWA

A personal progressive web app for programming and logging training around Jim Wendler's
5/3/1 methodology. Built for desktop planning + iPhone in-gym logging.

## Stack

- Next.js 15 (App Router) + TypeScript + React 19
- Tailwind CSS + shadcn/ui
- Dexie.js (IndexedDB) for local-first storage
- Azure Static Web Apps + Azure Functions (Node 20, TS)
- Azure Cosmos DB for NoSQL (free tier)
- MSAL.js for optional Microsoft personal account sign-in (sync only)

## Repository layout

```
apps/
  web/        Next.js PWA
  api/        Azure Functions (TS)
packages/
  domain/     Shared 5/3/1 calculation logic + types
  db-schema/  Dexie + Cosmos schemas + sync mappers
infra/        Bicep templates
.github/      CI/CD workflows
```

## Development

```bash
pnpm install
pnpm dev      # runs the web app at http://localhost:3000
pnpm build
pnpm test
```

Node 20.18+ and pnpm 10+ required.

## Versioning

SemVer with Conventional Commits. See `plan.md` (in the session workspace) for the
versioned milestone breakdown.
