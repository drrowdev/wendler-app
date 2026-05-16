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

SemVer with Conventional Commits. The full per-release history lives in
[`CHANGELOG.md`](CHANGELOG.md); the table below is the high-level theme map.

| Version | Theme |
|---|---|
| v0.1.0 | Core 5/3/1 engine (waves, TM, plate math) |
| v0.2.0 | Blocks + supplemental templates (FSL, BBB, PB) |
| v0.3.0 | In-gym UX (timer, AMRAP capture) |
| v0.4.0 | Calendar, analytics, body heatmap |
| v0.5.0 | MSA auth + Cosmos DB cloud sync |
| v0.6.0 | Goals, cardio, recovery, weekly load + deload coach |
| v1.0.0 | GA — race-taper detection, a11y pass, methodology docs |
| v1.1.0 | Strava integration — HR-zone stress, pace PRs |
| v1.2.0 | Weekly run-plan template, day-of-week run matching, in-gym UX polish |
| v1.3.0 | Four-axis Training Profile, AI assistance suggester with phase awareness, race-proximity phase auto-derivation, phase-aware assistance volume auto-shift |
| v1.4.0 | Public-repo migration + movement library expansion (~180 movements with pattern/muscle/equipment tagging) |
| **v1.5.0 (Unreleased)** | **Agentic architecture — Coach (injury triage), Programmer (plan diffs), Periodizer (block sequencing), Summarizer (weekly review), and a chat orchestrator with tool-use. Action chips let chat propose writes (log injury, set training max, set block volume preset, schedule deload, substitute movement) with preview-before-write guardrails on every AI write path.** |

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md) — per-release notes
- [`AGENTS.md`](AGENTS.md) — instructions for AI assistants working in this repo (incl. doc-update policy)
- [`docs/methodology.md`](docs/methodology.md) — feature ↔ 5/3/1 chapter mapping
- [`docs/architecture.md`](docs/architecture.md) — stack, sync model, build/deploy, env vars
- [`docs/strava-setup.md`](docs/strava-setup.md) — registering a Strava app + connecting

## Load & Recovery model

`/load` runs a Banister fitness/fatigue/form model on a daily series that
combines IF²-weighted strength tonnage and HR-zone-weighted cardio
(scaled the same way the weekly stress score does). The deload coach
pulls urgency from TSB, ACWR, RPE streaks, and absolute thresholds; the
4-week personal stress range is shown for context but no longer feeds
urgency on its own.

- **CTL** — chronic training load, 42-day EWA. "Fitness."
- **ATL** — acute training load, 7-day EWA. "Fatigue."
- **TSB** — CTL − ATL. "Form." Negative = fatigued, positive = fresh.
- **ACWR** — ATL / CTL. Sweet spot ~0.8–1.3; >1.5 is high injury risk.

The cardio contribution to the weekly stress score is dynamically capped
at `max(30, round(1.3 × trailing-6-week mean cardio contribution))` so a
sustained endurance phase isn't permanently flattened against a static
ceiling.

