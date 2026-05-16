# 5/3/1 Methodology Mapping

This document maps each feature of the app to the corresponding chapter or
principle from Jim Wendler's *5/3/1 Forever* (and the original 5/3/1 manual).
The goal is transparency: every recommendation the app makes traces back to
a documented Wendler concept (or, where the app extrapolates beyond what
Jim writes, that's flagged explicitly).

## Core principles

| App feature | 5/3/1 source | Notes |
|---|---|---|
| Training Max set to 85–90% of true 1RM | "Start too light" — *5/3/1 Forever* ch. 1 | Default 90%; user can lower to 85%. |
| Four main lifts (Squat, Bench, Deadlift, OHP) | The Big Four | Hardcoded as `MAIN_LIFTS`. |
| Rounding weights to nearest 2.5 kg / 5 lb | Plate math chapter | `rounding.ts` — both kg and lb supported. |
| Wave structure 5/3/1 + optional 5s PRO | Chapters 3–4 | `waves.ts` produces sets per week per lift. |
| AMRAP "+" sets on top set of weeks 1–3 | Original 5/3/1 | Toggleable per program (5s PRO disables). |
| Deload week (7th-week protocol) | 5/3/1 deload & *Forever* leader/anchor cadence | After **2 consecutive normal-volume blocks (~6 weeks)** a deload becomes the default 7th-week pick. The app never auto-schedules it — the user picks `deload` / `tm-test` / `pr-test` when starting the 7th-week block. The Coach agent can also propose a `schedule_deload` action chip from chat. |
| Joker sets (optional after a strong AMRAP) | *Forever* ch. 6 | Not implemented. |
| First Set Last (FSL) | Supplemental — *Forever* ch. 7 | `supplemental.ts` |
| Boring But Big (BBB) 5×10 @ 50–70% TM | Supplemental — *Forever* ch. 7 | `supplemental.ts` |
| Pyramid sets | *Forever* | `supplemental.ts` |
| Periodization Bible (PB) assistance buckets | *Forever* assistance chapter | Push / Pull / Single-leg + core, 25–50 reps each. |
| AI-assisted assistance picker | **Extrapolation** — not in 5/3/1 | The Programmer agent (Claude Sonnet) fills every training day in a block at once, constrained by a deterministic validator. Training-profile axes (primary goal × secondary toggles × phase × race calendar) and pre-long-run-day awareness shape the picks. Per-entry rationales (≤120 chars) are surfaced inline. The deterministic `suggestAssistance()` engine acts as a guaranteed fallback. |
| Block templates: Leviathan, Krypteia, Building the Monolith | *Forever* full programs | `blocks.ts` – pick a template when starting a block. |

## Tracking & analytics

| App feature | 5/3/1 source | Notes |
|---|---|---|
| e1RM estimation (Epley) | Common practice — Jim discusses but doesn't prescribe | `e1rm.ts`. Used for PR detection only, never for TM. |
| PR detection per lift / rep range | Encouraged by Jim ("PR sets") | `pr-detection.ts`. |
| Training Max progression | Wendler's TM bump rules | +2.5 kg upper, +5 kg lower per cycle. User-overridable. |
| Volume & intensity charts | Beyond 5/3/1 — extrapolation | Useful diagnostic. Don't override the program based on charts. |
| Injury / movement-limitation tracking | Not in 5/3/1, but "if it hurts, swap it" | The Coach agent (Claude Haiku 4.5) analyses a logged injury against the user's library + active block and proposes per-movement adjustments (`skip` / `reduce-load` / `reduce-range` / `modify-execution` / `monitor`). The user accepts or declines each one individually with a preview of what changes before any write. Active limitations show on every training surface via a persistent banner. PainFlag was the v0.x predecessor — superseded by the Injury record. |

## Cross-domain (v0.6.0)

| App feature | 5/3/1 source | Notes |
|---|---|---|
| Goals (PR / race / body-comp / habit) | Jim recommends always having a goal | Free-form; deadline drives taper. |
| Cardio logging | Jim is pro-conditioning; mode/duration up to lifter | Modality + duration + RPE; powers weekly load. |
| Recovery (sleep, HRV, fatigue, soreness, mood) | Implicit — Jim emphasizes recovery without prescribing tracking | One entry per day, sliders 1–10. |
| Weekly stress score | **Extrapolation** — not in 5/3/1 | Transparent linear formula in `load.ts`. |
| Deload coach | Supports — but not replaces — the 4-week deload | Surfaces flags, never auto-deloads the program. |

## Race taper (v1.0.0)

Jim doesn't prescribe a race taper, but the *Forever* chapters on
peaking and "easy weeks" are consistent with what the app suggests:

- **84+ days out**: Off-season — strength priority.
- **29–84 days**: Build — train normally, balance lifting and cardio.
- **15–28 days**: Peak — intensity holds, no novelty.
- **8–14 days**: Taper — drop assistance, hold main lift weight at lower reps.
- **1–7 days**: Race week — cut volume sharply, keep a few crisp efforts.
- **0 days**: Race day — no training.

These are heuristics, not prescriptions. The app never adjusts your
program automatically — it just shows the recommendation.

## Training Profile + phase auto-derivation (v1.3.0)

The four-axis training profile lives in
`packages/domain/src/training-profile.ts`:

- **Primary goal** — strength / hypertrophy / longevity / endurance / aesthetics.
- **Secondary toggles** — additive flavors (e.g. always-include core, hip-stability prehab).
- **Phase** — `normal` / `peak` / `taper` / `deload`. Derived in this order: manual override > race proximity > block kind > normal.
- **Race calendar** — A/B/C priority races drive both taper logic and phase auto-shift.

Race-proximity windows: A or B priority ≤14d → `taper`; A 15–28d →
`peak`; B 15–21d → `peak`. Block-derived: when the active block is
`kind: 'seventh-week'` with `seventhWeekKind === 'deload'`, phase
auto-derives to `deload`. The visible-week Assistance volume chip is
auto-shifted by `effectiveAssistanceVolumeForPhase()` (deload →
`minimal`, taper → `minimal`, peak → demote one tier).

**No-silent-automation UX**: a `PhaseAutoBadge` is shown on the block
editor header, `/goals`, and the AI suggester header whenever the phase
is auto-derived (not manual); a one-time toast fires the first time
each (source, phase) bucket becomes active. The user can always
dismiss or override.

## Agentic architecture (v1.5.0)

The app's AI surface is split into four specialist agents plus a chat
orchestrator. Each agent has a single responsibility, a typed input/
output contract, and a deterministic fallback or no-op path. All
agent calls go through the user's own Anthropic API key (server-side)
— nothing leaves the device if the key isn't configured.

| Agent | Model | Job |
|---|---|---|
| **Programmer** | Claude Sonnet | Fill an entire block's assistance slots with rationale chips. Validator-checked, deterministic fallback per-day. |
| **Coach** | Claude Haiku 4.5 | Analyse a logged injury against the user's library + active block; propose per-movement adjustments (skip / reduce-load / reduce-range / modify-execution / monitor). Plan-aware: knows what's actually scheduled. |
| **Periodizer** | Claude Sonnet | Sequence blocks within a program — leader/anchor cadence, 7th-week kind, race-driven taper insertion. |
| **Summarizer** | Claude Sonnet | Weekly review: what happened, what's trending, what to watch. Rendered on `/stats`. |
| **Chat orchestrator** | Claude Sonnet (tool-use) | The `/chat` page. Grounded in a training-data snapshot. Can emit "action chips" proposing writes the user explicitly approves. |

**Action chips** (chat → user-approved writes):

| Kind | Effect |
|---|---|
| `log_injury` | Opens the InjurySheet pre-filled, then runs the Coach analysis. |
| `set_training_max` | Writes a new TrainingMaxRecord (history preserved). |
| `set_block_volume_preset` | Switches the active block's assistance preset (minimal / standard / high). |
| `schedule_deload` | Inserts a 7th-week deload block right after the active block. |
| `substitute_movement` | Swaps one assistance entry on a specific day, preserving sets × reps. |

Every chip shows a **before/after preview** in the user's UI before
applying — kg deltas for TMs, rep-budget deltas for volume presets,
the exact day + entry for movement swaps, the sequence position for
deload inserts. Nothing writes silently. The injury analysis flow has
its own two-button (Accept / Decline) decision UI per adjustment with
Save disabled until every adjustment is decided.



- It does not pick supplemental work for you. You choose.
- It does not assume your goals from your data. You set them.
- It does not "auto-deload" — that's still your call after seeing the coach.
- It does not gamify training (no streaks-as-pressure, no badges).
- It does not require an account. Cloud sync is opt-in via personal Microsoft account.
- **The AI never writes anything silently.** Every Programmer / Coach / chat-orchestrator write proposes a change with a before/after preview; the user accepts, declines, or modifies. There is no "agent runs in the background and edits your plan" mode.
