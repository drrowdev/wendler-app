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
| Deload week (every 4th) | 5/3/1 deload | Generated automatically when scheduling a block. |
| Joker sets (optional after a strong AMRAP) | *Forever* ch. 6 | Available in session screen as "+ Joker". |
| First Set Last (FSL) | Supplemental — *Forever* ch. 7 | `supplemental.ts` |
| Boring But Big (BBB) 5×10 @ 50–70% TM | Supplemental — *Forever* ch. 7 | `supplemental.ts` |
| Pyramid sets | *Forever* | `supplemental.ts` |
| Periodization Bible (PB) assistance buckets | *Forever* assistance chapter | Push / Pull / Single-leg + core, 25–50 reps each. |
| Block templates: Leviathan, Krypteia, Building the Monolith | *Forever* full programs | `blocks.ts` – pick a template when starting a block. |

## Tracking & analytics

| App feature | 5/3/1 source | Notes |
|---|---|---|
| e1RM estimation (Epley) | Common practice — Jim discusses but doesn't prescribe | `e1rm.ts`. Used for PR detection only, never for TM. |
| PR detection per lift / rep range | Encouraged by Jim ("PR sets") | `pr-detection.ts`. |
| Training Max progression | Wendler's TM bump rules | +2.5 kg upper, +5 kg lower per cycle. User-overridable. |
| Volume & intensity charts | Beyond 5/3/1 — extrapolation | Useful diagnostic. Don't override the program based on charts. |
| Pain flag on movements | Not in 5/3/1 directly, but Jim writes "if it hurts, swap it" | App suggests alternatives if a movement is flagged. |

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

## What this app deliberately does NOT do

- It does not pick supplemental work for you. You choose.
- It does not assume your goals from your data. You set them.
- It does not "auto-deload" — that's still your call after seeing the coach.
- It does not gamify training (no streaks-as-pressure, no badges).
- It does not require an account. Cloud sync is opt-in via personal Microsoft account.
