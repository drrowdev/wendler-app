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

SemVer with Conventional Commits.

| Version | Theme |
|---|---|
| v0.1.0 | Core 5/3/1 engine (waves, TM, plate math) |
| v0.2.0 | Blocks + supplemental templates (FSL, BBB, PB) |
| v0.3.0 | In-gym UX (timer, AMRAP capture, joker sets) |
| v0.4.0 | Calendar, analytics, body heatmap |
| v0.5.0 | MSA auth + Cosmos DB cloud sync |
| v0.6.0 | Goals, cardio, recovery, weekly load + deload coach |
| **v1.0.0** | **GA — race-taper detection, a11y pass, methodology docs** |
| v1.1.0+ | Integrations (Garmin, GPX/FIT, Apple Health) |

## Documentation

- [`docs/methodology.md`](docs/methodology.md) — feature ↔ 5/3/1 chapter mapping
- [`docs/architecture.md`](docs/architecture.md) — stack, sync model, build/deploy

