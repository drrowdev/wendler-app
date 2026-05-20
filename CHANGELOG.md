# Changelog

All notable changes to this app are documented here. The most recent release
is at the top. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

Service-worker cache version (`apps/web/public/sw.js` → `CACHE = 'wendler-shell-vNNN'`)
is bumped on every release so installed PWAs evict stale assets on next visit.

## [Unreleased]

### Fixed — Phantom accessory day on 7th-week deload + race chip on calendar (SW v485)

Two related calendar-rendering issues, both surfacing on the same screenshot of a Half-Marathon training cycle: an empty `Accessory · 7w · Deload` cell on a Friday with no main lifts and no assistance entries, and a Saturday cell showing `🔵 Long` instead of the actual race name on race day.

**Bug 1 — phantom accessory day on the deload block.** The repro: a normal Leader/Anchor block had four day-groups in `schedule.dayGroups` (3 main lift days + 1 accessory day). The user later ran `schedule_deload`, which creates a fresh 7th-week block with `kind: 'seventh-week'` and **no `plan`** of its own. `effectivePlan` then falls back to `schedule.dayGroups`, so the deload block inherits the orphan accessory group. The upcoming projector dutifully emits an `Accessory · 7w · Deload` cell on its weekday — except the 7th-week protocol (Wendler 5/3/1 Forever p.21) explicitly skips supplemental and runs only "limited assistance" alongside the main wave. A pure accessory day on a deload week has literally zero work attached to it and renders as an empty card.

Fix: `projectUpcomingWorkouts` (packages/domain/src/upcoming.ts) now suppresses any group where `block.kind === 'seventh-week'` AND `mainLifts.length === 0`. The cursor still advances past the group so subsequent days project on their correct weekdays. Normal (leader/anchor) blocks are unaffected — an empty accessory day on them might just mean the user hasn't filled in the AI suggestions yet, so it stays visible.

Two domain tests added: one asserts the seventh-week suppression fires for the 4-group case (3 main + 1 empty accessory), one asserts the suppression does NOT bleed into a normal anchor block with the same shape.

**Bug 2 — calendar shows `Long` on race day, not the race name.** `useRaces()` was being fetched and passed to `ProgramTimeline` (the horizontal macrocycle view), but the month-grid never looked at it. So a Half-Marathon scheduled on Saturday June 6 just rendered the planned-cardio chip (`Long`) the recurring cardio plan would otherwise project there. Race day is the most prominent thing that can happen on a calendar date — it needs its own chip.

Fix: the calendar page (`apps/web/src/app/calendar/page.tsx`) now builds `racesByDay` (ISO date → races[], sorted A → B → C). Each cell renders a `🏁 [race name]` chip at the top, in a priority-tinted tone (A=red, B=amber, C=zinc). Clicking the chip deep-links to `/races#<id>`. The planned-cardio chip still renders below — useful if the user logs a shake-out warm-up jog distinct from the race itself. `hasContent` now also considers race-presence so the cell gets the proper border accent.

SW v484 → v485. No data migration; both fixes are pure rendering changes.

### Fixed — Cross-device AI edit clobbering + snapshot staleness (SW v467)

Two related sync bugs surfaced after the chat AI trimmed an assistance entry on desktop and a fresh mobile PWA session subsequently overwrote both the live plan and the day-page snapshot. The user reported: "AI changes were accurately reflected in the desktop but not in the PWA app. Now that I completed the workout the desktop also shows the old amounts."

**Bug 1 — `LegacyDefaultAssistanceMigrator` clobbers via LWW (root cause).** The v287 one-shot migrator promotes legacy `day.assistance` defaults into per-week `assistanceOverrides`. It runs once per browser and writes `block.updatedAt = now` on every block it touches. If the migrator fires on a fresh mobile session BEFORE the first sync pull lands, mobile writes a newer timestamp with the legacy defaults still in place. On the next push, that mobile block beats the desktop's earlier AI edit via last-write-wins, and the next pull on desktop reverts.

Fix: the migrator now **skips any block that already has ANY entry in `assistanceOverrides`** — the presence of overrides means another device (chat AI, manual editor, or another browser's migration) has touched the block more recently than the legacy defaults represent, so overlaying defaults would silently undo that fresher state. Modern blocks (post-v287) always have overrides, so they're no-ops anyway. Legacy blocks that genuinely need migration still get it, but only on a device where no overrides exist yet.

**Bug 2 — `assistanceSnapshot` from a stale device wins on /day.** When mobile's local block was stale, `completeDayWorkout` captured `session.assistanceSnapshot` from the stale plan. That snapshot synced to desktop and the /day page rendered it instead of the (correct) live plan — because the snapshot lookup didn't know it was stale.

Fix: `SessionRecord` now carries `assistanceSnapshotBlockUpdatedAt`, the value of `block.updatedAt` at snapshot capture time. The /day reader compares it to the current `block.updatedAt`; if the block has been edited since the snapshot was taken AND no assistance sets have been logged against the session yet, /day falls through to the live plan. When sets ARE logged, the snapshot is preserved verbatim (real history). Legacy snapshots without the stamp continue to be treated as authoritative for back-compat — no surprise invalidations on past sessions.

New hook `useHasLoggedAssistanceForDay(blockId, week, dayIndex)` returns true iff any assistance set exists across any session row in the day group.

SW v466 → v467. No flag prefix needed; both fixes are non-destructive.

### Added — Native iOS app via Capacitor (apps/ios + iOS-build workflow)

New `apps/ios/` workspace package wraps the deployed PWA in a native iOS shell. The WKWebView loads `red-moss-02386a803.7.azurestaticapps.net` directly, so every CI deploy to `main` reaches the phone instantly — no rebuild, no resign, no TestFlight roll. Bundle ID `com.drrowdev.wendler531`, app name "Wendler 531".

**What's checked in:**

- `apps/ios/package.json` — minimal Capacitor 7 deps (`@capacitor/core`, `@capacitor/ios`, `@capacitor/cli`).
- `apps/ios/capacitor.config.ts` — `appId`, `server.url` (production SWA), `limitsNavigationsToAppBoundDomains: true` to lock the webview to the app domain, dark `backgroundColor` to suppress the white flash on cold start.
- `apps/ios/www/index.html` — placeholder so `cap sync` is happy; never rendered at runtime.
- `apps/ios/.gitignore` — excludes the entire `ios/` Xcode project tree (regenerated by CI).
- `apps/ios/README.md` — distribution playbook for both routes.

**What's NOT checked in:**

- The Xcode project (`ios/App/App.xcodeproj`, Podfile, Info.plist). CI runs `npx cap add ios` fresh on every build via the macOS runner. Keeps the repo OS-agnostic; nothing to break when there's no local Mac.

**CI workflow:** `.github/workflows/ios-build.yml`. Manual trigger (`workflow_dispatch`). Runs on `macos-latest` (free + unlimited on public repos). Builds an unsigned `.ipa` and uploads as a 14-day artifact. The TestFlight upload section is checked in but commented out — flipping requires three new GitHub secrets (`APPSTORE_API_KEY_ID`, `APPSTORE_API_ISSUER_ID`, `APPSTORE_API_PRIVATE_KEY`) and uncommenting the bottom block.

**Distribution route (current): AltStore sideload from Windows.** Free, but builds expire every 7 days. AltServer on the same Wi-Fi as the iPhone auto-refreshes in the background. See `apps/ios/README.md` for the one-time setup.

### Fixed — Monday digest accuracy + warm-up snapshot + bell counts (SW v462–v466)

Tight iteration cycle on the proactive layer after real-world feedback:

- **v462** — Notification bell `useUnreadNotificationCount` now mirrors the `/notifications` inbox filter (skips `readAt`, future `dueAt`, soft-deleted rows). Previously over-counted scheduled future check-ins that the inbox itself hides. Monday digest body also surfaces the raw 4-week baseline number alongside the % delta (e.g. "3 strength sessions (+200% vs 4-wk avg 1.0/wk)") so the math is verifiable when the percentage looks surprising.
- **v463** — Monday digest now folds Strava-imported strength activities (`db.strengthHr` — WeightTraining / Crossfit / HIIT / Workout) into the workout-day count for both windows. Previously these were invisible because they don't write to `db.sets` (only the HR signal is captured).
- **v464** — Chat snapshot emits the barbell warm-up ramp (`settings.warmupPercents / warmupReps`) so the AI never replies "I don't have your warm-up routine."
- **v465** — Monday digest collapses workout days by **local calendar date only** (was a mixed `blockId|week|dayIndex` ⊕ `date:YYYY-MM-DD` key that double-counted any day where some sets had a session and others — like warm-ups — didn't). 3 actual workout days were rendering as 6 sessions.
- **v466** — Chat snapshot also carries the full **structured pre-lifting warm-up** (`settings.preLiftingWarmup.blocks[]`) with every block title, `appliesTo` scope, optional note, and every movement + dose. The barbell ramp is rendered as a sub-section under the same `## Warm-up protocol` heading. AI can now reason about mobility / activation / per-day filters, not just the 40/60/80 % ramp.

Each version flagged via `wendler:monday-digest-emitted:v{n}` so corrected digests re-emit even if a previous version already fired for the week.

### Added — Injuries in chat snapshot + suggester limitations notice (SW v456)

The chat AI was running blind to injuries — `db.injuries` was loaded for the InjurySheet workflow but never folded into the chat context blob. So `"which movements aggravate my adductor?"` couldn't be answered, and AI-generated assistance suggestions ignored active limitations even though the server-side `forbiddenMovementIds` ban was silently dropping them.

- `## Active limitations` block in `buildContextBlob`: each unresolved injury rendered with area, severity, optional `consult-recommended` flag, description, coach summary, accepted adjustments (`avoid X`, `swap X→Y`, `modify X`) with movement names resolved from the library, and monitoring advice. Resolved injuries are intentionally omitted — they're history, not active context.
- Lead-in instructs the AI to cross-reference the affected list AND reason about movement pattern + primary muscles vs the injury area when asked.
- `SuggestAssistanceForBlock` now renders an amber `"Honoring N active limitation(s)"` notice before the Generate button so users see WHY the suggester is filtering — the silent ban was confusing.

### Fixed — Chat UX polish: + New chat persistence, propose_edit rejection visibility, entry-id hash drop (SW v457–v459)

- **v457** — `chatId` + `chatUserTouched` state hoisted from `ChatDrawer` to `ChatFab` (the parent stays mounted across drawer toggles + route changes). Previously a `+ New chat` selection was wiped when the drawer remounted on next open — the auto-select-most-recent effect re-ran and stomped the user's intent.
- **v458** — Server emits a new `proposal_rejected` SSE event when `parseEditProposal` rejects a `propose_edit` tool call (typically a guessed `entryId` or no-op preset). Client appends an inline blockquote warning to the assistant message so the user sees WHY no proposal chip rendered when the AI's prose claimed there was one. System prompt also tightened with an explicit prose-vs-tool rule: "if you mention 'proposal' / 'changes below', you MUST have called `propose_edit` with a valid input — use the exact `entryId` from the snapshot."
- **v459** — Removed the `(entry <code>...</code>)` suffix from `TrimEntryDiff` in `EditProposalSheet`. The 8-char hash was user-noise; the movement name alone identifies the row.

### Removed — `includesDeload` field eliminated repo-wide (SW v453)

Continuation of the deload-week deprecation: the field is now completely gone from `ProgramBlock`, the snapshot writers, the suggester input shape, and every consumer. Dexie `v24` upgrade strips it from existing block rows in IndexedDB. `LegacyDeloadMigrator` component was deleted — there's nothing left to migrate. The 7th-week deload remains as a first-class **separate block type** in the program timeline; what's gone is the bolt-on "this 3-week block also has a deload column" flag, which had become a footgun every time the suggester / chat snapshot forgot to honor it.

### Added — Proactive AI layer (SW v446–v455) — the "Jarvis" stack

A four-layer pivot from "AI when you open the chat" to "AI that pings you with context-aware nudges." Settings flag `dailyBriefEnabled` (default on) short-circuits Layers 2 and parts of 3.

**Layer 1 — Page-aware chat prompts (v449).** The chat composer's initial suggestion chips now depend on which page you opened the drawer from. From `/recovery/injuries` you get prompts like "What movements should I avoid?"; from `/day` you get "How was last week?"; from `/stats` you get "What's my biggest weak point?". Cuts blank-prompt friction.

**Layer 2 — Daily training brief (v450).** Runs at most once per local day on first interaction. Pure data — no LLM call. Surfaces a notification with the day's plan, deload signal, fatigue trajectory, next race countdown. `dailyBriefEnabled` setting in /settings → AI Coach.

**Layer 3 — Event triggers (v447, v448, v454, v455).**
- **Injury log (v447)** — when the user logs an injury via the InjurySheet, the Coach agent now does a proactive review of the active block and proposes adjustments inline in the same sheet (with the v378 preview-before-write pattern).
- **Scheduled follow-ups (v448)** — when the AI says "let me check in in 3 days about your knee", a `Notification` row is created with `dueAt = now + 3d` and surfaces in the inbox once due. PA-style cadence; user can complete or dismiss.
- **AMRAP +5 reps → TM bump suggestion (v454)** — if the last main-lift AMRAP exceeded the prescribed reps by 5+, a `set_training_max` chip is queued for next opening of the chat.
- **Race added + block completed + welcome-back (v455)** — three additional triggers: when the user adds a race within 16 weeks (Periodizer offers a taper plan), when a block reaches its final completed day (Summarizer surfaces a weekly review), and when the user returns after 14+ days idle (returning-user trigger nudges a soft restart instead of dumping them back into wave 1 wk 1).

**Layer 4 — Persistent AI memory (v451).** New `memories` Dexie table. The AI can `remember` user-stated facts via the existing tool-use channel (e.g. "user's next A-priority race is in 4 weeks and they want Z2-heavy training weeks"). Memories surface in every snapshot under `## User memory` so they persist across chat threads. User can edit/delete from a new `/settings → AI memory` panel.

**Layer 5 — Voice + in-session AI** is explicitly **on hold** pending real usage of layers 1–4.

### Added — Deload-week phase auto-derive + snapshot fixes (SW v446)

Closes HANDOFF's open-backlog item "auto-derive `phase = 'deload'` from the visible block week at the GoalFlags layer." When the visible block week is the 7th-week deload, the derived training phase is now `deload`. The `volumeMultiplier` directive is suppressed in that phase to avoid compounding with the new preset auto-shift. User is notified on every automatic phase change via the notification inbox — no silent overrides.

### Added — Cardio plan: dynamic slot scope + diagnostics + chat ops (SW v428–v445)

Multi-version arc rebuilding cardio planning from "static date ranges" → "block-anchored, modality-first, AI-editable."

- **v429–v430** — `add_cardio_plan_slot` `propose_edit` op. AI can pair a `skip_day_in_week` with a Z2 bike replacement in one proposal. Block-linked slots auto-remove on block completion.
- **v432** — Re-openable applied proposals (audit history surfaces in /diagnostics) + week-scoped slots (a slot can target `weeks: [2, 3]` instead of an effectiveFrom/Until date range).
- **v435–v438** — `remove_cardio_plan_slot` op with live preview (server tells the user EXACTLY which slot rows will be deleted before they tap Apply) + apply now deletes ALL matches by `(dayOfWeek, modality)` instead of just the first.
- **v439–v444** — `/diagnostics` page for inspecting AI writes (full apply audit trail per proposal); inline `startedAt` editor for blocks; sync mapper preserves all slot fields on pull.
- **v445** — Dynamic slot scope resolution: `appliesToWeeks` is canonical; the static `effectiveFrom/Until` cache is only consulted for legacy slots. `block.startedAt` is now stamped on first session of the block (was previously set at block-create time, which broke calendar math when a block sat unstarted for weeks).

### Added — Program timeline view + skip-day-aware UI (SW v411–v414)

Calendar page got a `[Calendar | Timeline]` toggle. Timeline renders the entire program as a horizontal block sequence with skip-hatching on skipped weeks, an active-week chip, and per-block TM deltas hovering over each title. Built on a pure `buildTimelineModel` (9 tests) so the same model can later drive `/year-review` and other visualizations.

### Fixed — Chat snapshot accuracy under per-week assistance store (SW v415–v425)

Multi-version cleanup after the v422 storage flatten (`BlockPlan.assistance[]` → per-week store keyed by `(blockId, week)`). The chat snapshot, EditProposalSheet "before" lookup, BringMovements migration, duplicateDay, and injury workflow surfaces all had separate readers that were still reading the old shape. Each was fixed in a small commit; v418 caught three additional misreads (empty-day, this-week scoping, exclusion-as-problem).

### Added — `add_movement_to_library` propose_edit op (SW v407–v409)

(Already documented above — entry below.)



Lets the chat AI propose adding a missing movement to the user's library inside a `propose_edit` proposal, with the same accept/decline/modify UX as every other op. Closes the loop on "I couldn't add Banded Clamshell because it's not in your library" — instead of telling the user to bounce to `/movements/new` and back, the AI proposes the library entry alongside the chained `add_assistance_entry` op and the user approves both in one sheet.

**Architecture** — three layers:

1. **L1 / data plumbing** (v407):
   - New `AddMovementToLibraryEditOp` in `packages/db-schema`. Fields: `tempMovementId` (must match `^tmp:[a-z0-9-]+$`), `name`, `category`, `primaryMuscles` (required, `MuscleGroup` enum), `secondaryMuscles?`, `equipment?`, `pattern`, `isCompound?`, `externallyLoadable?`, `cues?`, `dedupHint?`.
   - Parser (domain + apps/api mirror) validates against domain enums and rejects malformed temp ids. 4 new tests added — 16/16 green.
   - Apply orchestrator threads a mutable `tempIdMap: Map<string, string>` through the per-op loop. `add_movement_to_library` runs at `APPLY_ORDER` slot 4 (BEFORE `add_assistance_entry` at slot 5), populates the map, and the chained add op resolves its `movementId === 'tmp:<slug>'` against the map at apply time.
   - **Exact-name dedup is hard at apply time** — if a normalized-name match already exists, the library op soft-falls-back (no insert) and records `reusedExistingMovementId` in the audit detail. Handles the race where parallel sync added the same movement after the user accepted.

2. **L2 / AI wiring** (v408):
   - Chat snapshot in `useChat.ts` now emits a "Movement library" section: every entry compact-formatted as `- Name (id=…; pattern; muscles; equipment, +tags)`, sorted by pattern then name. The lead-in line instructs the AI to scan this section before proposing the op and skip when a match exists by name OR pattern + primary-muscle overlap.
   - System-prompt op vocab documents the new kind with all field constraints + an explicit "ASK if unsure about primaryMuscles" rule.
   - Tool spec (`chat-tool-specs.ts`) lists the kind in the enum and adds the JSON-schema for every new field with enum constraints matching `MuscleGroup` / `MovementPattern` / `EquipmentType`.

3. **L3 / rich UI** (v409):
   - `AddMovementToLibraryDiff` in `EditProposalSheet.tsx` shows the proposed movement with editable `primaryMuscles` chip widget (every `MuscleGroup` toggleable; last muscle locked since apply requires ≥ 1).
   - Renderer-side fuzzy dedup scan: Levenshtein ≤ 2 on normalized names (catches typos + spacing) OR same `pattern` + ≥ 60% Jaccard overlap on primary muscles. Top 3 candidates surface in an amber warning banner.
   - "Use this instead" link declines the library op AND rewrites every sibling `add_assistance_entry` whose `movementId === op.tempMovementId` to point at the chosen existing movement. New `onUseExistingLibraryMovement` callback threaded `EditProposalSheet → OpRow → OpDiff → AddMovementToLibraryDiff`.

**User preferences captured during planning**:
- `primaryMuscles` is editable in the accept-row (confirmed by user 2026-05-16).
- Race-condition handling: soft fail-back into "used existing X" (confirmed).
- No AI-created badge — library entries from the AI are indistinguishable from manually-created ones (`isCustom: true`, id shape `custom:<nanoid8>` — same as `/movements/new`).

Tests: 16/16 propose_edit parser tests green. Build green. SW v406 → v409 (one bump per L1/L2/L3 commit).

### Added — Skip-day-in-week awareness in NextUpCard + /program/block + chat snapshot (SW v406)

Closes the loop on the `skip_day_in_week` `EditOperation` (shipped in v403): the skip flag now actually changes how the rest of the app renders and reasons.

- New domain helpers `isDaySkipped(plan, week, dayId)` + `getDaySkip(plan, week, dayId)` in `packages/domain/src/blocks.ts` — pure reads of `plan.dayOverridesByWeek`.
- `advanceScheduleAfterDay` (apps/web/src/lib/completeDayWorkout.ts) loops past slots flagged skipped. The cursor walks straight from Day 2 to next week's Day 1 when Day 3 is skipped — no manual intervention needed.
- `NextUpCard` builds a `skippedGiThisWeek` set and treats skipped days identically to completed days in its candidate scan (`isUnavailable` predicate). A self-heal effect auto-advances the cursor when it lands on a skipped slot (e.g. after chat AI marks the current day skipped mid-week).
- `BlockPlanEditor` `DayCard` shows a rose "Skipped" pill in the header + a rose-toned "Skipped this week" banner above the lift list when `isDaySkipped(plan, weekScope, day.id)`.
- Chat snapshot emits a per-day `SKIPPED in: Wk 2 · Wk 3 (cardio-replacement: Z2 bike 60 min)` line so the AI doesn't propose trim/swap ops on already-skipped weeks.

### Changed — Preview-before-write guardrails on all chat actions + Apply skips (SW v379)

Extends the v378 InjurySheet diff-preview pattern to every remaining surface where AI can write user data. Each AI action now shows a concrete before/after view *before* anything is persisted, so the user always has explicit accept/decline on the actual change — not just on the AI's recommendation.

**Chat action chips** (`apps/web/src/components/ChatActionChips.tsx`) — replaced one-line confirm bodies with per-kind preview components that pull live data from Dexie:

- `set_training_max`: shows current TM (latest `TrainingMaxRecord` for that lift), proposed TM, kg delta + %, and top-set kg at the user's tmPercent (default 85%) for both before/after.
- `set_block_volume_preset`: looks up the active block (or `action.blockId`), renders current vs proposed preset side-by-side with main-day + accessory rep budgets and a delta callout. Notes that existing scheduled entries aren't modified — the new budget kicks in next assistance generation.
- `schedule_deload`: renders the program's block sequence with the active block highlighted and a "new" row showing exactly where the deload lands (next sequenceIndex). Confirms the active block isn't touched.
- `substitute_movement`: walks the targeted block's plan, lists the affected entry with sets × reps preserved, and surfaces collateral hits (the same movementId on other days in the same block) so the user knows the swap is single-day not block-wide. Handles "nothing to swap" with an explicit amber warning so the user doesn't tap Apply expecting a change that won't happen.

**`/recovery/injuries` "Apply skips" retry button** (`apps/web/src/app/recovery/injuries/page.tsx`) — was running immediately with no preview. Split into:

- `buildSkipPlan()`: pure computation that returns the proposed source→target swaps plus affected entries per day (same heuristic: same-pattern, primary-muscle-disjoint, bodyweight preferred).
- "Preview & apply skips" button (renamed from "Apply skips to block plan"): opens an inline emerald-tinted preview card showing every planned swap with its affected day labels + sets × reps. Cancel / Apply these swaps buttons.
- `confirmApply()`: only writes after the user confirms.

Tests still 928/928. SW bumped 378 → 379.


### Changed — Public repo hygiene + chat action audit log (SW v366)

Two follow-ups bundled together:

**1. Privacy: scrubbed user's first name from the public repo.** Now that the repo is public, the user's name had been leaking through in CHANGELOG.md entries and (more importantly) in the system prompts every specialist agent + the chat orchestrator send to Anthropic. Replaced with "the user" / "the user's" throughout. Also flipped the one stray "his" → "their" pronoun in the chat system prompt. Files touched:
- `CHANGELOG.md`
- `packages/domain/src/agents/{coach,programmer,periodizer,summarizer}/{prompt,tools}.ts`
- `apps/api/src/agents/{periodizer,summarizer}/prompt.ts` (mirror)
- `apps/api/src/llm/chat-tool-specs.ts`, `apps/api/src/llm/chat-tools.ts`
- `apps/api/src/functions/chat.ts`

The GH username in HANDOFF.md was kept — it's part of the public repo URL itself, no additional information leaked. `README.md` was already clean.

**2. Audit trail for chat AI actions.** Every applied action chip now records a structured audit on the chip itself AND posts a centralised notification entry, so troubleshooting "what did the AI do?" is one tap to the inbox.

Schema additions on `ChatAction` (optional, no Dexie migration):
- `appliedDetails?: ChatActionApplyDetails` — discriminated union, one shape per action kind. Captures before/after state at apply time so the change is reconstructible:
  - `log_injury`: `{ injuryId }`
  - `set_training_max`: `{ recordId, lift, previousKg?, newKg }`
  - `set_block_volume_preset`: `{ blockId, previousPreset?, newPreset }`
  - `schedule_deload`: `{ newBlockId, programId?, sequenceIndex }`
  - `substitute_movement`: `{ blockId, dayId, entryId, previousMovementId, previousMovementName, newMovementId, newMovementName }`
- `applyError?: string` — when a handler hard-fails (e.g. "Day id not found", "Replacement movement not in library"), the error is now stashed on the chip itself. Status stays `pending` so the user can retry from the same button, but the failure message renders inline under the label.

Each handler captures the pre-mutation state, applies the write, then calls a centralised `markApplied(...)` helper that:
- Persists `appliedDetails` on the chip.
- Writes a `Notification` row (channel `ai-action`, severity `success`, title = chip label, body = human-readable summary, `context` payload = full structured details).
- Uses a stable id `chat-action:<actionId>` so reapplies dedupe naturally.

New `NotificationChannel` value `ai-action` registered + labelled in the inbox UI.

The applied state on the chip in chat now shows the audit one-liner under the "Applied: …" line (e.g. "Squat: 142.5 kg (was 140.0)", "Bulgarian Split Squat → Goblet Squat"). The full structured payload is in the notification's `context`.

### Added — Chat action chips v2: schedule_deload + substitute_movement + plan-aware snapshot (SW v365)

Two new action types covering the two most-asked workflows from the v1 chat tests, plus an enhancement to the chat snapshot so the AI can target specific assistance entries by id.

**Chat snapshot now includes the active block plan.** The training-data snapshot the chat orchestrator builds on every send now appends an "Active block plan" section listing the active block's days (with stable day ids) and every assistance entry (with movementId, sets×reps, category). Without this the AI couldn't reliably target a substitution; with it the model can write a chip referencing the exact entry to swap. Source: `apps/web/src/lib/useChat.ts → buildContextBlob`.

**`schedule_deload` action.** Use case: "should I deload soon?" → Periodizer says deload-soon → chip appears. Apply creates a 7th-week deload block (`kind: 'seventh-week'`, `seventhWeekKind: 'deload'`) sequenced right after the currently-active block in the same program. Conservative: doesn't truncate the active block — the user finishes the current week as planned and the deload becomes active when the current block is marked done. Confirm modal explains the placement.

**`substitute_movement` action.** Use case: "my right adductor hurts during Bulgarian split squats" → Coach proposes step-up → chip appears with exact source + replacement movementIds. Apply swaps the entry's movementId + movementName on the targeted day (matched by `dayId` preferred, `dayIndex` fallback). Existing sets × reps × category preserved. Validation hard-fails when:
- the replacement isn't in the user's library
- no entry matches the source movementId on the resolved day
- source and replacement movementId are identical

**Server prompt:** chat system prompt gets a section per new kind, with explicit "skip the chip when uncertain about the params" guidance. The substitute_movement section instructs the model to copy movement ids verbatim from the "Active block plan" section so the handler always finds the target.

**Tests:** 928 (was 922 + 6 new — schedule_deload happy path + reason required, substitute_movement happy path + same-id rejection + missing-field rejection + dayIndex out-of-range graceful drop).

Future kinds plug in with the same three-files-per-kind pattern. Next likely adds (deferred until asked): `mark_main_lift_taper`, `apply_recommended_volume_preset`, `create_program_from_template`.

### Added — Chat action chips: apply recommendations with one tap (SW v364)

Chat AI can now emit concrete, applicable recommendations alongside its prose, rendered as buttons under the assistant reply. v1 vocabulary covers three action kinds spanning the Coach / Programmer / Periodizer domains:

- **`log_injury`** — opens the InjurySheet pre-filled with area, severity, description, and affected movementIds. Coach-flagged movement-modification advice becomes a one-tap "Log limitation" button.
- **`set_training_max`** — confirms in a small modal then writes a new TrainingMaxRecord for the proposed lift. The previous TM stays in history; the new value takes effect immediately.
- **`set_block_volume_preset`** — confirms then updates the active block's `assistanceVolume` field (minimal / standard / high). Targets a specific blockId when supplied, falls back to the current active block otherwise.

**Protocol:**
- Chat system prompt gains an "Action chips" section documenting the vocabulary, when to emit, and a strict "no chip when uncertain" rule.
- Model appends `<actions>[...]</actions>` at the very end of its reply.
- Server (`apps/api/src/functions/chat.ts`) intercepts the opener mid-stream so the tag and its JSON never leak into the visible prose, parses the block on `end_turn`, and emits a new SSE event `{ type: 'action_chips', actions: ChatAction[] }`.
- Parser + validator at `apps/api/src/llm/chat-actions-parse.ts` (mirror of `packages/domain/src/agents/chat/chat-actions-parse.ts`). Validates kind, required fields, value ranges, rounds TM kg to nearest 0.5, caps the chip array at 4 entries. Malformed JSON or invalid chips → empty chip array (prose still flows through clean).

**Persistence:**
- New `ChatAction` discriminated union in `@wendler/db-schema` (`log_injury` / `set_training_max` / `set_block_volume_preset`). `ChatMessage.actions?: ChatAction[]`.
- Optional field — no Dexie migration needed. Existing chats unchanged.
- Per-chip state: `status` (`pending` / `applied` / `dismissed`) + `appliedAt` / `dismissedAt` timestamps. Persisted on the parent ChatMessage so chip state survives reload + syncs across devices.

**Client:**
- `useChat` captures the `action_chips` event and persists chips on the assistant message at turn end.
- New `ChatActionChips` component renders under each assistant bubble. Pending chips show as accent-tinted buttons with the chip label + rationale + an explicit dismiss (×). Applied chips collapse to a green "✓ Applied: …" status line; dismissed chips collapse to a grey "— Dismissed: …" line.
- Handlers in `apps/web/src/lib/chat-actions.ts`. `log_injury` opens InjurySheet pre-filled. The other two pop a confirm modal before writing.

**Tests:** 922 (was 909 + 13 parser tests covering happy path, edge cases, every validation branch, lookalike rejections, cap enforcement).

Future kinds (mark deload, substitute movement, start taper) plug in by adding a `ChatAction` union branch + a parser validator + a client handler. Three files per kind.

### Added — Agentic Phase 4: Periodizer + Summarizer + Weekly Review (SW v362)

Final phase of the agentic rollout. Both remaining specialists ship, plus a Weekly Review surface on /stats that runs them as a workflow.

**Periodizer agent (`packages/domain/src/agents/periodizer/`):**
- System prompt: Leader/Anchor cadence, 7th-week protocols, taper conventions, return-from-layoff rules, ACWR sweet spot 0.8–1.3, TSB readiness bands, user's locked flavor anchors.
- Verdict vocabulary: `deload-now` / `deload-soon` / `continue` / `taper-now` / `ramp-up` / `tm-test` / `extend-block`. Strict JSON output (verdict + headline + explanation + evidence[] + nextSteps[] + alternativeVerdicts[] + shortReply).
- Dynamic user prompt: current block + cursor, last-deload date, upcoming priority races, pre-computed Banister/ACWR signals, recent recovery (0-10 Borg scale), recent training summary, active limitations, user profile. No hardcoded user data in the system prompt.
- Default temperature 0.2 — anatomical/structural reasoning, reliability over creativity.
- 17 tests covering prompt-builder branches + validator unhappy paths.

**Summarizer agent (`packages/domain/src/agents/summarizer/`):**
- Reconciliation + presentation specialist. Produces a 6-section narrative (Training summary, Strength trend, Running + cardio, Load + recovery, Active limitations, Looking ahead) + a flat `highlights[]` chip strip.
- Strict JSON output with exact heading order enforced by the validator + caller-supplied `expectedWeekStart` / `expectedWeekEnd` echo check.
- Dynamic user prompt: weekly aggregates (sessions, sets, tonnage, top sets, cardio totals + modality mix, recovery averages, end-of-week load signals) + pre-computed specialist input (Periodizer verdict + headline, Coach limitations summary when applicable).
- 16 tests covering prompt-builder + validator.

**Workflow (`apps/api/src/functions/workflows/weeklyReview.ts`):**
- POST /api/workflows/weeklyReview. Two-stage pipeline:
  1. `runPeriodizer` over a pre-built Periodizer user prompt.
  2. Inject the Periodizer's structured output into the Summarizer prompt (sentinel `<!-- PERIODIZER_INPUT -->` block, with append-fallback).
  3. `runSummarizer` over the assembled prompt, with the week-start/week-end echo guard.
- Returns `AgentResponse<WeeklyReviewResult>`. Failures at either stage propagate with the originating `errorCode`.

**Chat tool-use:** the `consult_periodizer` + `summarize_week` Phase-3 stubs now dispatch real specialist calls (Periodizer → structured runner, Summarizer → chat-flavored prose call against the snapshot). Cross-domain questions like "my knee hurts AND I have a race in 3 weeks" now route Coach + Periodizer in parallel and reconcile cleanly.

**Schema (v19, `packages/db-schema`):**
- New `WeeklyReview` entity (id, weekStart, weekEnd, verdict, headline, sections[], highlights[], generatedAt, updatedAt). Indexed on `weekStart` so the /stats card looks up the latest review in O(1).
- Dexie migration v18→v19, `'weeklyReview'` `SyncKind`, outbound + inbound + tombstone routing, `deleteWithTombstones` support, `useLatestWeeklyReview` + `useAllWeeklyReviews` hooks.

**UI (`apps/web/src/components/WeeklyReviewCard.tsx`, mounted on /stats):**
- Empty state: short pitch + Generate button.
- Generated state: verdict pill, week range, headline, "Generated N min ago", highlights chip strip, 6 expandable section cards (empty bodies hidden), Regenerate button.
- Workflow helper (`apps/web/src/lib/weeklyReview-workflow.ts`) builds both specialist user prompts from IndexedDB (live signals, no hardcoded user data), defaults the window to the most-recent completed Mon-Sun, persists the result with id reuse on regenerate.

**Tests:** 909 (was 876 + 33 new — 17 Periodizer + 16 Summarizer).

Out of scope this ship: Sunday-evening cron (defer until a worker tier exists), email/Teams delivery (defer), long-form macro planning ("plan the next 12 weeks").

This closes the agentic rollout. All four specialists (Coach, Programmer, Periodizer, Summarizer) are live and callable from chat tool-use; structured workflows (analyzeInjury, weeklyReview) ground multi-step orchestration with deterministic stages between LLM calls.

### Fixed — Fatigue/soreness UI now shows the actual 0-10 Borg scale (SW v361)

The underlying schema has always stored fatigue and soreness on a 0-10 Borg-style scale (5 buckets at 1, 3, 5, 7, 9). The input pickers labelled the buttons 1-5 and the Readiness card displayed "/5", so when a chat answer cited "fatigue 7/10" it looked like the AI was making up a different scale. This ship aligns the UI with the actual data.

- `PreWorkoutCheckIn` buttons now show the stored values directly (1, 3, 5, 7, 9) with hint text "1 fresh · 9 wrecked" / "1 none · 9 severe". Dropped the inverted-axis mapping on the "How recovered?" picker — the buttons now read left-to-right from fresh→wrecked, matching the soreness picker.
- `Readiness` card on Today + Profile + Recovery: same change — buckets labelled 1/3/5/7/9 with `/10` displayed in the collapsed summary ("Fatigue 7/10").
- `chat-context.ts` recovery section now carries an explicit "0-10 Borg-style scale" note in the snapshot and renders each value with the `/10` suffix, so Coach / Programmer / chat agents all use the same units the user sees in the UI.

No schema migration needed — stored values were already 1-9 on the 0-10 scale. Existing recovery entries continue to display correctly.

### Fixed — Chat tool-use UX: thread continuation + progress feedback (SW v360)

Two Phase-3 follow-ups from real-use feedback:

1. **Thread didn't continue inline.** Submitting from a fresh `/chat` (no `?id=`) cleared the composer but the URL stayed at `/chat` for the whole 20-30s tool-use turn — until `sender.send()` resolved and `onChatIdChange` fired. With cross-domain questions hitting multiple specialists that meant the user was looking at an empty pane and had to find the new thread in the conversation list. Fixed by watching `sender.id` in a `useEffect` and propagating the moment Dexie persists the new chat row (well before the LLM responds). The URL now updates within a render frame and the user message + tool indicators show up immediately.

2. **No mid-turn progress feedback.** The previous build held the full assistant turn until everything was done, then dumped a single `delta` event. With tool-use turns the user saw a frozen "Consulting specialists…" indicator for 10+ seconds while Claude composed the reconciled reply. Two changes:
   - **Server now streams text tokens.** Switched from `client.messages.create` to `client.messages.stream` and forwards `content_block_delta` text events as SSE `delta` events as they arrive. Per-token streaming is back; intermediate Claude commentary ("Let me consult the coach on that…") streams too, which is fine — it's useful transparency about what the orchestrator is doing.
   - **New `composing_start` SSE event + `ChatTurnPhase` client state.** Phases: `thinking` (initial response, pre-tool-use) → `consulting` (at least one tool dispatch in flight) → `composing` (tools done, waiting for Claude's reconciliation iteration) → `streaming` (text deltas arriving). `StreamingBubble` picks the right "what's happening right now?" copy per phase ("Thinking…" / "Consulting specialists…" / "Composing reply…") and the in-flight tool-call rows now animate (`↻` spins until the matching `tool_use_end` arrives).

### Added — Agentic Phase 3: Chat tool-use orchestration (SW v359)

The chat agent now consults specialist tools instead of doing everything in a single LLM call. Cross-domain freeform questions ("my knee hurts AND I have a race in 3 weeks") get routed to the right specialists in parallel and reconciled into one coherent answer.

**Tool registry (`packages/domain/src/agents/<name>/tools.ts` + `apps/api/src/llm/chat-tool-specs.ts`):**
- `consult_coach` — pain/injury/movement-modification (working dispatch, calls Coach-flavored Claude with the chat snapshot).
- `consult_programmer` — assistance picks, set/rep prescriptions, "what should this session look like?" (working dispatch, calls Programmer-flavored Claude with the chat snapshot + the user's locked flavor anchors).
- `consult_periodizer` — deload timing, taper, race-week structure (registered but Phase-4 dispatch returns "not yet available"; chat agent is told to reconcile around the missing piece).
- `summarize_week` — weekly digests (same — registered, Phase-4 stub).

**Server (`apps/api/src/functions/chat.ts` rewrite + `apps/api/src/llm/chat-tools.ts`):**
- Replaces the single-call chat with a tool-use loop. Hard cap of 6 tool calls per turn. All tool calls in a single Claude turn dispatch in parallel.
- New SSE event types: `tool_use_start { id, name }`, `tool_use_end { id, name, durationMs, inputTokens, outputTokens }`. The existing `delta`/`done`/`error` events are unchanged.
- `done` event now carries totals across the whole turn (`inputTokens`, `outputTokens`, `llmCalls`, `toolCalls`) so cost-per-turn can be observed end-to-end.
- Specialists are mirror-pattern Anthropic calls (Node16/ESM, no domain imports) with their own concise system prompts; `ANTHROPIC_TOOL_MAX_TOKENS` env var caps each at ~1500 tokens to keep parent context healthy.

**System prompt:** explicit routing rules for the chat agent — use specialists liberally for cross-domain questions, single-domain questions still benefit from a specialist call for deeper persona/anatomy/programming priors, pure data lookups skip tools to save latency. Chat agent is the reconciler, not the first-principles authority.

**Client (`apps/web/src/lib/useChat.ts` + `components/ChatPanel.tsx`):**
- `useChatSender` now exposes `toolCalls: ToolCallStatus[]` — id / name / startedAtMs / endedAtMs / token counts. Cleared between turns.
- `StreamingBubble` renders a tool-call timeline above the streaming text: `↻ Coach` while in flight → `✓ Coach (3.2s · 412 tok)` after each `tool_use_end`. Loading-state text says "Consulting specialists…" instead of "Thinking…" while tools are in flight.

**Tests:** 876/876 (6 new — tool-spec shape coverage including the Phase-4 stubs).

Out of scope this ship (Phase 4): Periodizer + Summarizer implementations; SSE streaming of the FINAL assistant text token-by-token (currently emitted as a single `delta` event after the loop terminates — the streaming caret + bubble UX is preserved but per-token streaming is gone for now).

### Added — Agentic Phase 2: PainFlag → Injury escalation (SW v358)

Final Phase 2 ship. Closes the loop from per-set pain flagging at training time → tracked, Coach-analysed Injury → suggester routing.

**`PainFlagModal`:** When the user picks severity ≥ 3, an amber "Make this an active limitation?" callout appears below the note field with a "Save flag + open Coach for limitation →" button. Clicking it saves the per-set pain flag normally AND signals escalation back to the caller via a new `escalate?: boolean` field on `PainFlagValue`.

**`/day` page:** New `escalateInjury` state captures the area / severity / note + bound `movementId` from the lift's pain flag. When set, an `InjurySheet` opens pre-filled via its existing `origin` prop — the user picks any additional affected movements (deadbug et al.), tweaks the description, and runs Coach analysis without re-typing the basics.

Together with v356/v357 this means: flag pain on a set → escalate from the same modal → Coach proposes per-movement adjustments → accept individually → suggester routes around them on the next assistance generation → AssistanceTrack shows the modification chip at training time. End-to-end, all on-device data, no hardcoded movement IDs anywhere in the path.

### Added — Agentic Phase 2: Coach agent injury → suggester wiring (SW v357)

Closes the loop on Phase 2: the Programmer agent (assistance suggester) now reads accepted Coach adjustments and routes around them every generation. Live banner + per-entry chip surface the same modifications at training time so the user never trains a movement an active limitation said to skip / load less / shorten range on.

**Suggester prompt (`packages/domain/src/assistance-prompt.ts`):**
- New `activeLimitations` input (per-call, built upstream from `useActiveInjuries()`). Each limitation contributes area + severity + Coach summary + accepted per-movement adjustments (`skip` / `reduce-load` / `reduce-range` / `modify-execution` / `monitor`).
- New user-prompt section `## Active limitations` rendered when any active injury exists. Skipped movementIds are called out in their own line for the LLM and the validator to consume identically.
- New system rule **15: Active limitations are inviolable.** Per-action behaviour:
  - `skip` — never include the listed movementId; substitute a same-family alternative.
  - `reduce-load` / `reduce-range` / `modify-execution` — include but surface the modification text in the per-entry `rationale` chip; never pick a heavier or higher-skill same-family variant.
  - `monitor` — fine to include, but don't stack another fatiguing variant of the same primary mover on the same day.
  - Cross-family substitution explicitly encouraged.

**Validator (`packages/domain/src/assistance-response.ts` + `apps/api/src/llm/validate.ts` mirror):**
- New `forbiddenMovementIds` option. When the LLM returns a movementId on the user's accepted skip list, the response is rejected with a system-rule-15 error. Same defense-in-depth pattern as `crossWeekUsedMovementIds`.

**Server (`apps/api`):**
- `runProgrammer` accepts `forbiddenMovementIds` and passes it to the validator.
- `POST /api/agents/programmer` and `POST /api/suggestAssistance` both forward the field from the request body.

**Client (`apps/web`):**
- `SuggestAssistanceForBlock.tsx` reads `useActiveInjuries()`, builds the `activeLimitations` payload (with looked-up movement names) + `forbiddenMovementIds` skip list, threads them into both `buildAssistancePrompt` call sites and into the API request body. Original generate + corrective-retry paths both get the skip list so the retry can't accidentally re-propose a skipped movement.
- `AssistanceTrack.tsx` per-entry row matches each entry's `movementId` against active injuries and renders an amber chip (`⚠ {action}`, `title=` modification text) next to the prescription summary, plus an inline modification banner inside the expanded entry. Means the user sees the limitation at training time, not just on `/recovery/injuries`.

**Tests:** 870/870 (7 new — 3 prompt-builder cases for the limitations section + 4 validator cases for `forbiddenMovementIds`).

Notes: feature is fully driven by data on the user's device — no hardcoded movement IDs anywhere in the prompt/validator path. When no active injuries exist, behaviour is unchanged from v356.

### Added — Agentic Phase 2: Coach agent + injury feature (SW v356)

First user-visible agent ship. New `Injuries` surface lets the user log a limitation (area, severity, free-text description, affected movements), have a Coach agent (MSK/PT framing, Anthropic Claude, temperature 0.2) propose per-movement adjustments grounded in the live movement library + active programming + recently resolved injuries, then accept/decline each proposal individually. Active limitations surface as a persistent amber banner on Today + Day, with a sheet to mark resolved.

**Schema (v18, `packages/db-schema/src/types.ts`):**
- New `Injury` entity: `area`, `severity (1-5)`, `description`, `affectedMovementIds[]`, AI-generated `summary`, `adjustments: InjuryAdjustment[]`, `monitoringAdvice`, `consultRecommended` + `consultReason`, `startedAt`, `resolvedAt`, standard CRDT/sync fields.
- `InjuryAdjustment`: `movementId`, `action` (`skip` | `reduce-load` | `reduce-range` | `modify-execution` | `monitor`), `modification` (text), `reasoning`, `status` (`proposed` | `accepted` | `declined`), `proposedAt` / `acceptedAt` / `declinedAt`, `userEdited?`.
- Dexie migration v17→v18 in `apps/web/src/lib/db.ts`; `injuries` store keyed on `id, area, startedAt, resolvedAt, updatedAt`.

**Coach agent (`packages/domain/src/agents/coach/`):**
- Static system prompt: MSK/PT advisor role (NOT diagnostic), conservative-bias framing, anatomical priors, Runna-runs-elsewhere context, output schema.
- Dynamic user prompt sections (built per call from IndexedDB): About the user (DOB→age, sex, height, training experience), the current injury, other active injuries, recently resolved injuries (recurrence flag), recent training, equipment-filtered movement library.
- `parseCoachResponse` validator: enforces `summary`, `proposedAdjustments` schema, no duplicate `movementId`s, `consultReason` required when `consultRecommended=true`.
- 20 tests cover happy path, code-fence stripping, every error branch, About-the-user injection, equipment filtering, recurrence detection.

**Server-side (`apps/api/src/`):**
- Mirror of domain in `agents/coach/` (Node16/ESM mirror pattern). Default temperature 0.2 via `ANTHROPIC_COACH_TEMPERATURE`.
- HTTP endpoint `POST /api/agents/coach`.
- Deterministic `findSubstitution` heuristic in `agents/programmer/substitution.ts` — pattern + primary-muscle overlap scoring; skips for monitor/reduce-range/modify-execution actions.
- `analyzeInjury` workflow at `POST /api/workflows/analyzeInjury` — Coach call → `findSubstitution` per accepted action → `InjuryAnalysisResult` (Coach proposal + library-grounded alternatives).
- `apps/api/src/agents/registry.ts` now lists `programmer` + `coach`.

**Client UI (`apps/web/src/components/injury/` + `app/recovery/injuries/`):**
- `InjurySheet` — modal with two-step flow: capture form (area combobox with custom "other", severity 1-5, description, movement multi-select) → proposal review (per-adjustment Accept/Decline, Accept all/Decline all, alternatives expandable, monitoring + PT-consult callouts).
- `injury-workflow.ts` — client wrapper that builds the Coach user prompt + library payload from IndexedDB and posts to the workflow endpoint.
- `ActiveLimitationsBanner` — amber strip mounted on Today + Day; tapping opens a sheet listing all active injuries with a per-injury "Mark resolved" CTA + link to history.
- `/recovery/injuries` page — Active + Resolved sections, "+ Log limitation" entry point, per-injury detail (accepted/declined adjustments, monitoring, consult-recommended banner, reopen, delete with tombstone).
- New `Injuries` row in `/more`.

**Sync:**
- `'injury'` added to `SyncKind`; outbound collect, inbound apply, tombstone routing all wired in `apps/web/src/lib/sync.ts`.
- `deleteWithTombstones` (`apps/web/src/lib/delete.ts`) supports `injury`.
- `useAllInjuries()` + `useActiveInjuries()` hooks in `apps/web/src/lib/hooks.ts`.

Notes: prompts contain zero hardcoded user data — system prompts hold role + schema + anatomical priors; everything user-specific (TM%, goals, schedule, equipment, library, recent history, active limitations, profile) is constructed per call from IndexedDB. Tests: 863/863.

### Added — Agentic Phase 1: agent contract foundation (SW v355)

Refactor-only ship. No user-visible change. Establishes the type-level + module-level scaffolding the rest of the agentic rollout (Phases 2–4) builds on. Reviewed against the master plan in `~/.copilot/session-state/.../files/agentic-master-plan.md`.

**Contract types (`packages/domain/src/agents/types.ts`):**
- `AgentResponse<T>` discriminated union (`{ ok: true, data, ... }` or `{ ok: false, errorCode, errors, ... }`)
- `AgentErrorCode`: `'validation-failed' | 'llm-unreachable' | 'llm-timeout' | 'llm-refused' | 'rate-limited' | 'bad-input' | 'unknown'`
- `AgentUsage` (tokens + latency telemetry)
- `AgentToolSpec` (Phase 3 prep — tool-use orchestration schema)
- `agentSuccess()` / `agentError()` constructor helpers
- 8 new tests covering discriminated-union narrowing + exhaustive error-code coverage

**Programmer agent namespace (`packages/domain/src/agents/programmer/`):**
- `prompt.ts` re-exports `buildAssistancePrompt` from the existing `assistance-prompt.ts` under the canonical agent path
- `response.ts` re-exports `parseAssistanceResponse` + the LLM response types
- `index.ts` exports `AGENT_NAME` + `AGENT_DESCRIPTION` for registry/logging
- Existing `assistance-prompt.ts` / `assistance-response.ts` stay in place — the agent namespace is a re-export layer for now. Future phases can physically move the files if useful.

**Server-side runner (`apps/api/src/agents/programmer/runner.ts`):**
- New `runProgrammer(input): Promise<AgentResponse<ProgrammerSuccessData>>` extracted from the legacy `suggestAssistance` HTTP handler
- Pure function — also callable from server-side workflows (Phase 2's `analyzeInjury` will call it directly to ground substitution proposals) without an HTTP hop
- Local `AgentResponse` types mirror domain (kept in `apps/api/src/agents/types.ts` because Azure Functions on Node16 module resolution can't consume the domain package's ESM imports — same pattern as the existing `apps/api/src/llm/validate.ts` mirror)

**Registry (`apps/api/src/agents/registry.ts`):**
- `REGISTERED_AGENTS` array. Currently lists only `programmer`. Phase 2 adds `coach`; Phase 4 adds `periodizer` + `summarizer`. Phase 3's chat tool-use will iterate this to build the tool specs.

**HTTP endpoints:**
- New `POST /api/agents/programmer` returns the unified `AgentResponse<ProgrammerSuccessData>`
- Existing `POST /api/suggestAssistance` kept for back-compat with the current web client — now delegates to `runProgrammer` underneath and maps the agent response back to the legacy success/error shape
- `apps/api/package.json` `main` glob updated to `dist/src/functions/**/*.js` so nested function modules are discovered by Azure Functions runtime

**Client helper (`apps/web/src/lib/agents.ts`):**
- `callProgrammer(input): Promise<AgentResponse<ProgrammerSuccessData>>` — clean typed wrapper around the new HTTP endpoint
- Existing `SuggestAssistanceForBlock` UI still uses the legacy `/api/suggestAssistance` route; migration to `callProgrammer` happens during Phase 2 or 3

**What this DOES NOT do (Phase 1 boundary):**
- No new agents (Coach lands in Phase 2)
- No chat refactor — chat keeps its current SSE shape. The chat-side `AgentResponse` refactor is folded into Phase 3 (where the tool-use orchestration loop is built; doing it twice would be wasted work)
- No new behaviour for the user

### Tests
- 843/843 passing (8 new contract tests added)
- API typecheck + build clean
- Web lint + build clean

### Next
Phase 2 (Coach agent + injury feature) begins once you give the go. Detailed plan: `files/phase-2-coach-injury.md`.

### Added — Agentic-architecture prerequisites (SW v353)

Two prerequisite cleanup commits land before Phase 1 of the agentic rollout. No agent code yet — these are data-quality + user-context foundations the agents will rely on.

**Movement library cleanup (Prereq 1):**
- New `adductors` value in the `MuscleGroup` enum. The previous enum had no first-class way to tag adductor involvement, which would have hurt Coach agent quality for adductor-related injuries.
- 30 seed movements now have additional/fixed secondary-muscle tags:
  - **Adductors added** on 10 movements: Sumo Deadlift, Cossack Squat, Bulgarian Split Squat, Reverse Lunge, Single-Leg RDL, Front Rack Lunge, Kettlebell Lunge, Pistol Squat, Jumping Lunge, Copenhagen Plank, Front-Foot-Elevated Split Squat, Curtsy Lunge, Dead Bug.
  - **Core added** on 8 standing pressing / curl / extension variants (DB Shoulder Press, Arnold Press, Lateral Raise, Tricep Pushdown, Overhead Tricep Extension, Russian Twist, Lateral Band Walk, EZ-Bar Overhead Tricep Extension).
  - **Erectors added** on 7 Olympic / dynamic-hinge variants (Power Snatch, Squat Snatch, DB Snatch, DB Clean, KB Snatch, KB Clean, Sandbag Clean).
  - **Other stabilizer tags** on Hammer Curl, Hollow Body Hold, EZ-Bar Skull Crusher.
- Validators in `assistance-response.ts` (domain) and `apps/api/src/llm/validate.ts` (mirror) updated to accept the new enum value.
- New doc-comment at the top of `seed-movements.ts` documents the muscle-tagging convention (primary = prime movers; secondary = stabilizers/synergists).

**UserProfile entity (Prereq 2):**
- New `userProfile` singleton table (schema v17). Fields: `dateOfBirth`, `sex` (male/female), `heightCm`, `trainingExperience` (novice/intermediate/advanced/elite), `yearsLifting`, `yearsRunning`, `backgroundNotes` (free text). All optional.
- New `useUserProfile()` hook + Dexie migration + sync wiring (LWW like `chats`).
- New `AboutYouCard` component at the top of `/profile`. Replaces the old `BodyweightCard` mount — bodyweight is now entered here and writes a `RecoveryEntry` for today (preserves the per-day history that `effectiveLoadKg` depends on). One UI surface for current bw, time-series preserved for e1RM calculations.
- All demographic data is local + synced via the existing LWW pipeline (same trust boundary as training data). Never sent to third parties; sent to Claude only as part of agent context.

This data will feed the Coach agent's anatomical reasoning (sex-/age-modulated injury patterns), the Programmer agent's conservatism on TM% and deload frequency, and the Periodizer/Summarizer's narrative context. Phase 1 of the agentic rollout begins next.

### Tests
- 835/835 passing.

### Changed — Suggester: structural variety, not temperature-driven (SW v352)

A bug-class fix to the assistance-suggester's variety mechanism. Previously it leaned on temperature to introduce variation between regenerations; that's the wrong lever for strict-JSON output and was producing diminishing returns.

- **Temperature dropped from 0.5 → 0.3.** Structured-output guidance for strict-schema tasks sits in the 0.0–0.3 band. Higher temperatures don't translate cleanly to "more varied selections" — they translate to "more varied tokens", which manifests as movementId drift (`seed:bench-press` → `seed:bench_press`), JSON schema deviations, and creative departures from the library when an OK match exists. The validator catches these, but retries cost latency.
- **Movement library is now per-generation shuffled** via `librarySeed` (Fisher–Yates with a mulberry32 RNG keyed on the seed). The client mints a fresh seed each time the user clicks Generate and passes it through `buildAssistancePrompt`. Same seed → identical shuffle (so tests are deterministic); fresh seed every Generate → a different list order each time → the LLM's primacy bias for "first OK match per slot" no longer biases results. This is the *real* variety lever; temperature was a noisy proxy.
- **Cross-week dedup prompt reframed from neutral to directive.** Was: *"Below are the picks from other week scopes … you MUST NOT re-use these movementIds."* Now: *"**These movementIds are already used in other weeks of this block — actively AVOID picking them again** and explore alternatives in the same pattern/muscle family."* The "actively avoid" framing gives the model a stronger anchoring instruction that doesn't depend on token randomness.
- **No system-prompt changes beyond cross-week wording.** The 13 system rules, mandatory-slot logic, family-dedup, and validator constraints all remain intact.

The hard cross-week validator (system rule 5) and the corrective-retry logic from v329 remain — variety is encouraged via the three structural mechanisms above and *enforced* by the validator. Worst case is unchanged: same picks across weeks when no same-family alternative exists.

### Tests
- 835/835 passing. 1 new test locks the seeded-shuffle contract in (same seed → same order; different seed → different order; shuffled set always contains the same movements as unshuffled). 2 existing cross-week-prompt tests updated to match the new directive wording.

### Added — Movement library expansion (SW v351)

Seed library grew from 143 → 184 movements (+41), scoped to a functional gym with barbell + EZ-bar + hammer-curl bar + DBs + KBs + rings + sled + sandbag + plyo box + bands (no cables).

**Tier 1 (26 new) — common gaps:**
- *EZ-bar variants:* EZ-Bar Curl, EZ-Bar Reverse Curl, EZ-Bar Preacher Curl, EZ-Bar Skull Crusher, EZ-Bar Overhead Tricep Extension
- *Hammer-curl bar (multi-grip / Swiss):* Hammer Curl Bar Curl, Row, Bench Press
- *Push:* Floor Press, Z Press
- *Pull:* Pendlay Row, Chest-Supported DB Row, Meadows Row
- *Hinge:* Snatch-Grip Deadlift, Rack Pull, Stiff-Leg Deadlift
- *Squat:* Front-Foot-Elevated Split Squat, Cossack Squat, Sissy Squat
- *Carry:* Zercher Carry, Front-Rack Carry
- *Core:* Hollow Body Hold, V-up, Bear Crawl
- *Plyo/Cond:* Wall Ball, Battle Ropes

**Tier 2 (12 new) — variations:**
- Concentration Curl, Spider Curl, Zottman Curl, Reverse Curl
- Pin Press, Spoto Press, Bradford Press, Diamond Push-up
- B-Stance RDL, Jefferson Curl
- Shrimp Squat, Curtsy Lunge

**Extras (3 new) — user-requested:**
- Dragon Flag, Windshield Wipers, Hand-Release Push-up

**Notes on convention:**
- Specialty bars (EZ-bar, hammer-curl bar, safety-bar) all use `equipment: 'barbell'` with the bar type encoded in the name — matches the existing Safety-Bar Squat precedent.
- Bar weight is **not** auto-tracked. Enter total load including bar; the app treats `weightKg` as opaque user input. Means EZ-bar curl at "30 kg" means "30 kg total" same as a barbell curl at "30 kg total".
- Seed upsert is idempotent and adds-only by ID — new movements appear on existing installs without disturbing customizations.

### Fixed — Scientific calculation audit, round 6 (round-3 audit follow-up)

The round-3 re-audit found two LOW-severity polish items. Both fixed.

- **Polarized HR-zones card no longer sends contradictory signals (SW v350).** The card used two different "easy share" thresholds: `easyMin = 0.80` drove the per-bucket arrow (amber "Easy 75% ↓"), but `easyVerdictMin = 0.70` drove the verdict text. So a runner with easyShare = 75 % saw "Easy 75 % ↓" in amber AND "✓ On target — solid 80/20 distribution" emerald, simultaneously. Aligned `easyVerdictMin` to `easyMin` (0.80) — one threshold, one message. Verdict text already said "below 80%" so the wording is now also literally correct.
- **Equipment whitelist drift between `assistance-response.ts` and `apps/api/src/llm/validate.ts` resolved.** The two files are documented as kept in lockstep but the domain copy was missing `weighted-vest` and `dip-belt`. Both files now match. No user-visible effect (the production validator is the API copy), but the domain copy is no longer stale.

### Round-3 audit verdict
After three audit passes (rounds 1, 2, and 3), no HIGH or MED items remain. The round-2 bug pattern (destructive field enumeration into `MinimalSet`) was verified clean across every `.map((s) => ({` site in the codebase. Cross-cutting integration (suggester ↔ analytics, deload-scaling ↔ MinimalSet, chat-context ↔ load) verified consistent. The numbers can be trusted as displayed.

### Fixed — Scientific calculation audit, round 5 (round-2 audit follow-up)

A second-pass audit ran after v348 and found one real bug + one trivial cleanup. Everything else verified clean.

- **The v348 `lastAmrapPerformance` week-aware fix was dead in production (SW v349).** Two call sites (`apps/web/src/lib/wellness.ts:183` and `apps/web/src/lib/deload.ts:82`) build their `MinimalSet[]` by explicit field enumeration and were **stripping `percentOfTm` and `trainingMaxKgAtTime`** — the exact two fields v348 added to `MinimalSet` so the function could infer the Wendler week floor. Both sites now forward those fields. Real impact of the bug:
  - **Week 2 AMRAP** (floor 3): "crushing" used to require ≥ 8 reps in practice; should require ≥ 6 → **systematically under-classified**.
  - **Week 3 AMRAP** (floor 1): "crushing" used to require ≥ 8 reps; should require ≥ 4 → **substantially under-classified**, which means TM-bump recommendations from `recommendReturnPlan` / `recommendDeloadScaling` were too conservative on Wk2/Wk3.
  - The data was always there — `SetRecord` persists both fields and `LiftFocusView` writes them — only the boundary mappers stripped them. The unit tests in v348 passed because they construct `MinimalSet` directly with the fields included.
- **OnboardingWizard fallback bumped from 0.9 to 0.85** to match the database default and every other consumer (`AmrapAnalysis`, `program/setup`, `program/block`, `db.ts`). Only matters in the brief window before `useSettings` populates.

### Tests
- 834/834 passing (no test changes — the audit verified the test coverage in `return-plan.test.ts` already covers the floor logic correctly).

### Trust state
- Round-2 audit verified clean: `acwrUncoupled` boundaries, `consecutiveHighEffortStreak` warmup filter and MAX_SKIPS=1 logic, `rollingBaseline` SD floor with no caller sentinel issues, `previousWeekStarts` alias, `ban.acwr` (legacy EWMA) has zero remaining consumers in UI or thresholds, `MinimalSet` widening propagation everywhere except the two sites fixed above, `e1rmTrend` cadence-independence + span guard, polarized 80/10/10, HR-zone weights, pace PRs, bodyweight UX, analytics warmup policy consistency.

### Fixed — Scientific calculation audit, round 4 (polish bucket)

A batched cleanup of the MED + LOW items the audit surfaced. No headline numbers should move; these are correctness sharpening, naming hygiene, and edge-case guards.

- **M5 — Stress score JSDoc now matches the code.** The recipe in the comment claimed cardio cap 20 and raw minutes; the code actually uses HR-zone-weighted minutes with a dynamic cap (default 30), plus a separate strengthHR component capped at 10. The docstring is now an accurate cheat-sheet. Also added a `parseIsoUtc` helper so legacy rows without a timezone marker can no longer be silently re-parsed as local time and drift between weeks across devices.
- **M7 — `consecutiveHighEffortStreak` excludes warmups from the session-average RPE.** The JSDoc said it did already; the code didn't. Future schema work that defaults a warmup RPE won't silently change deload decisions.
- **M8 — Streak skips no-RPE sessions instead of breaking.** Pre-v348 a single unlogged-RPE session erased the entire walk-back ("you forgot to log RPE today → previous 3 days of grinding don't count"). Now skips up to 1 consecutive no-RPE session, then gives up. Strava-imported sets (no RPE) no longer permanently disable streak detection. New test pair locks both halves in.
- **M9 — `rollingBaseline` uses sample SD with a floor.** Was population SD with no guard against zero variance. With N=2 the population denominator gave ~½ the true spread, making the z-test in the RPE-vs-baseline check over-reject (every week looked like an outlier). Bessel correction (N-1 denominator) plus floors (`STRESS_SD_FLOOR=5`, `RPE_SD_FLOOR=0.3`) so 2-week baselines and zero-variance baselines both behave sensibly. Updated 1 test, added 2.
- **M11 — `lastAmrapPerformance` is now Wendler-week aware.** Pre-fix used absolute rep thresholds (≥8 crushing, ≤2 struggling) — a Wk1 AMRAP at 75 % TM hitting 7 reps was "on-target" but a Wk3 AMRAP at 95 % TM hitting 7 reps was crushing (floor 1 + 6 = TM-bump territory) and both got the same label. `MinimalSet` now optionally carries `percentOfTm` + `trainingMaxKgAtTime`; the function infers the prescribed floor (5/3/1 for w1/w2/w3 ≈ 85/90/95 % TM) and compares against `floor + 3` (crushing) / `floor − 2` (struggling). Falls back to absolute thresholds when neither field is set.
- **M12 — Added `recentWeekStartsIncludingCurrent` and `priorWeekStarts`** as clearly-named siblings of `previousWeekStarts` (which despite its name *includes* the current week). Old function marked `@deprecated` but kept as an alias so existing callers keep working. Future callers won't fall into the off-by-one trap.
- **L1 — OnboardingWizard respects `settings.defaultTmPercent`.** Previously hardcoded 90 % regardless of the user's settings default (which is 85 %). One source of truth.
- **L2 — `acwrTone` no longer screams "danger" red on low ACWR.** Returning users with ACWR < 0.5 used to see red (with no matching reason text from the deload engine). Low ACWR is detraining / ramping back up, not injury risk — now uses calm blue. Red is reserved for ACWR > 1.5 (the actual injury-risk zone). 1.3–1.5 stays yellow.

### Tests
- 834/834 passing. 3 added (M8 + M9), 2 updated (M9 SD denominator change, M8 streak skipping).

### Fixed — Scientific calculation audit, round 3

- **M2 — `e1rmTrend` cadence-independent (SW v347).** The strength-trend signal that feeds the return-plan recommendations used to regress e1RM against `[0, 1, 2, ...]` — the data-point index — not actual calendar days. So a 2× / week lifter and a 1× / week lifter making the SAME true progress per calendar week saw different per-point slopes, and the ±0.6 %/week threshold fired at different actual rates of progress depending on cadence. A user with mismatched cadences across the four main lifts (squat 2× / press 1×) got artificial asymmetry in the aggregate trend.
  - Slope is now regressed against actual day-of-year (`Math.floor(ts / 86400000)`), then scaled to weekly. Verdict is identical for any cadence at the same true rate of progress.
  - Added a 14-day minimum span guard. Three points clustered in one week are no longer dignified with a "rising"/"falling" verdict — they return `'unknown'` (slope estimate is too noisy).
  - 2 new tests: cadence-independence (1× vs 2× weekly with identical +1 kg/week progress both report `'rising'`), and the short-span guard.

### Fixed — Scientific calculation audit, round 2

- **M3 — /movements/history shares date-bucketing logic with the rest of the dashboard (SW v346).** The page had its own `ymd()` (local-time YYYY-MM-DD) and `isoWeekBucket()` (local-time ISO week) helpers, while the domain analytics that drive `/stats` use UTC-bucketed `isoDate()` and `isoWeekKey()`. A Sunday-evening set near midnight could land in different weeks on the two pages. Now both pages use the same domain helpers — the two screens can no longer disagree. Cursor walking in the zero-fill loops is also pinned to UTC noon, so a TZ shift on either side of midnight can't push the cursor across a week boundary and misalign with `isoWeekKey`.
- **M4 — warmups stay included in /movements/history tonnage (consistency with /stats, SW v346).** The page had a `kind !== 'warmup'` filter; everything else in the app does not. After deliberation: warmups are real lifted weight and counting them matches the user's mental model of "total tonnage". They never win "top-set e1RM per day" naturally (lower weight → lower Epley) so including them is honest. The dashboard "Total tonnage" headline is unchanged; the per-movement page now matches it.

### Fixed — Scientific calculation audit, round 1

This round addresses the two HIGH-severity findings from the audit plus one of the same-shape RPE bugs from the v344 family.

- **H1 — Bodyweight movements on /movements/history (SW v345).** Pull-ups, dips, and other BW assistance used to show "Best e1RM: 0 kg", a flat-zero top-set chart, and zero tonnage — `weightKg × reps` is meaningless when the user logs BW as 0. The page now uses `effectiveLoadKg()` from the domain (weight + bodyweight on the day of the set) for all kg-based stats, looking up the most recent bodyweight on-or-before each set's date from the recovery log. When no bodyweight has been logged for a BW movement, the page surfaces reps-based tiles instead (Best rep day, Avg reps/set, total reps) with a banner pointing to Profile, rather than lying with "0 kg" tiles. Externally-loadable BW (weighted pull-up, vest dips) adds the logged weight on top.
- **H2 — ACWR aligned with the published threshold literature (SW v345).** The tooltip said "last 7 days ÷ last 28 days" but the engine was computing EWMA (τ=7 vs τ=42). The "sweet spot 0.8–1.3 / danger > 1.5" thresholds the deload engine enforces (Gabbett 2016) were validated on rolling-mean ACWR, not EWMA — so the tooltip was misleading AND the thresholds were running against an uncalibrated distribution.
  - Added `acwrUncoupled()` in `packages/domain/src/load.ts`: acute = mean load over the last 7 days; chronic = mean load over the 28 days BEFORE that (no overlap — the Gabbett 2019 "coupled ACWR is mathematically biased" critique).
  - `BanisterResult` now carries both `acwr` (EWMA, legacy, kept for chart continuity) and `acwrRolling` (rolling-window, uncoupled).
  - `deloadSuggestion` switched to `acwrRolling` for the >1.3 watch / >1.5 risk thresholds.
  - LoadView shows `acwrRolling` (not the EWMA value) and the tooltip now accurately describes what's computed.
  - CTL / ATL / TSB (Banister EWMA) still drive the form-fatigue checks — that's the model that was validated against TSB cutoffs.
- **M1 — `dailyLoad` no longer spikes on a lone hard top set (SW v345).** Same `Math.max(rpes)` shape as the v344 streak fix. A single AMRAP set at RPE 9 used to add `(9−6) × 0.5 = 1.5` to the day's load (a Wendler-shaped day). That number fed straight into CTL/ATL/TSB/ACWR. Switched to additive: `max(0, (avgRpe−6) × 0.4) + min(1, hardSetCount × 0.2)` where hardSetCount = sets at RPE ≥ 8.5. For a uniformly RPE-8 session the bump is the same as before; for a lone outlier the bump drops by ~70%.
  - New tests cover the Wendler-shape scenario (lone AMRAP) and a genuinely-hard session.

### Tests
- 829/829 passing. Added 4 new tests in `load.test.ts`: acwrUncoupled null below 35 days, ≈1.0 at steady state, exact 5.0 in a clean step scenario, dailyLoad ignores lone AMRAP spike.
- Updated 1 test: legacy "ACWR > 1.5" deload test now uses a shorter spike scenario so rolling ACWR (not EWMA) trips the threshold.

### Changed
- **High-effort session detection no longer fires on a single hard top set (SW v344).** `consecutiveHighEffortStreak` used to count any session whose **max** RPE hit 8.5+ as "high effort" — meaning one AMRAP top set at RPE 9 surrounded by easy supplemental and assistance work would mark the whole session as a grinder. That's not how Wendler training looks: the AMRAP is supposed to be hard; the rest isn't.
  - **New rule:** a session counts as high-effort only when **either** the average RPE across all working sets ≥ 8.0 **or** 3+ individual sets hit RPE 8.5+. Either condition genuinely means "this session was a grind."
  - User-facing reason text is now "N high-effort sessions in a row" with a sub-explanation ("avg RPE ≥ 8 or 3+ sets at RPE 8.5+") instead of the misleading "N sessions at RPE 8.5+" which only described the per-set check.
  - Old test "uses the session max RPE — one heavy top set is enough" is replaced by "ignores a single heavy top set surrounded by easy sets — Wendler shape". Two new tests cover the average-RPE and many-hard-sets branches.

### Fixed
- **LineChart y-axis labels no longer clipped (SW v343).** The shared `LineChart` component had a hardcoded `padX = 44`, which wasn't enough for labels like "208.5 kg" — `textAnchor="end"` at `x=padX-6` made the labels grow leftward and the leading digit fell off the SVG viewBox (rendered as "08.5 kg"). `padX` is now computed from the longest formatted label (~7px per char at fontSize 12, plus 14px breathing room, never less than 44). This fixes the per-movement history e1RM chart and benefits any other LineChart usage with multi-digit y-values.
- **Movement-history chart rounds e1RM to integers for cleaner display.** "208 kg" beats "208.45 kg" for at-a-glance scanning, and one fewer character helps the axis fit.

### Removed
- **MAIN tag dropped from `/movements` list rows (SW v343).** The four `isMainLift: true` seed entries (back squat, deadlift, bench, OHP) were marked as MAIN because they're Wendler's defaults — but the user's program may not use those, and the badge implied otherwise. The `isMainLift` flag still exists on the data model (used by program setup wizards, deload picks, etc.), but it no longer claims those four are the user's mains in the library UI.

### Added
- **Per-movement training history page at `/movements/history?id=…` (SW v342).** Works for both main lifts (bench, squat, deadlift, press) and assistance movements. Surfaces:
  - **Summary tiles:** heaviest set ever, best e1RM ever (with the source set), best volume day (max Σ weight × reps in one calendar day), all-time set count + reps + tonnage.
  - **Top-set e1RM line chart over time.** One point per workout day (best Epley-formula e1RM among that day's sets), so you can see strength development at a glance. Skips warm-ups and skipped sets.
  - **Weekly tonnage bar chart.** Σ weight × reps per ISO week, last 26 weeks for legibility, zero-weeks filled in for visual continuity.
  - **Full set log grouped by day, newest first.** Date · setCount · day-tonnage header per row, then each set with weight × reps, AMRAP badge, kind tag (supplemental / assistance / warmup), and per-set e1RM. Bodyweight sets render as "BW × N".
- **Discoverability:** `/movements` list rows now route to history by default (tap the row to see history); a small "Edit" button on the right preserves access to the movement definition. The edit page also has a "History" button next to Delete.

### Fixed
- **Existing carry entries now show under "Carry" header (SW v341).** Companion to v340. The category change in v340 applied only to newly-generated entries — existing Suitcase Carry still had `category: 'other'` baked into IDB, so /day kept showing it under the OTHER sub-header. AssistanceTrack now normalises the category at render time by looking up the linked movement and calling `categoryFromMovement` on it, falling back to the stored `entry.category` when no movement is linked. No database migration needed; the display always reflects current category logic.

### Added
- **New "Carry" assistance category (SW v340).** Carries (Suitcase Carry, Farmer Carry, Yoke Walk, etc.) used to land in the catch-all "Other" sub-header on /day — because the LLM emitted `slot: 'carry'` and the client mapped it to `category: 'other'`. They now have a proper `carry` category with its own sub-header on /day. The deterministic suggester's `categoryFromMovement` follows: `pattern: 'carry'` → `carry` (was `accessory`). `BODYWEIGHT_SWAPS` for deload now has a carry entry (bodyweight carry, 30 sec). The "Other" bucket remains as a fallback for unknowns.

### Fixed
- **Today hero handles out-of-order training + heals stale cursor (SW v339).** Real root cause of the "long run wins over accessory day" issue from v337/v338. The user activated the Anchor block mid-week (Wed). Cursor parked at Day 0 (Monday). User then trained Thursday (Day 1) directly, skipping Monday. `advanceScheduleAfterDay` only ran when `cursor.groupIndex === dayIdx` strictly, so completing Day 1 while cursor was on Day 0 did NOTHING — cursor stuck on Monday. Then NextUpCard's override scanned for today-weekday, found the just-completed Thursday, set `currentGroup = Day 1 (done)`, `describeNextWorkout` reported "next Thu is 7 days away", `sUrg = 7`, cardio (urgency 2) won. The brief strength flash was the render before sessions loaded.
  - **Three fixes together:**
    1. **`advanceScheduleAfterDay` is now a catch-up rule, not strict equality.** Cursor advances past any completed `dayIdx` at-or-past the current cursor position in the same week. Out-of-order training (skip Monday, train Thursday) now jumps the cursor to Day 2 (Friday) immediately.
    2. **NextUpCard self-heals stale cursors on mount.** A `useEffect` looks for completed sessions for the cursor's (block, week) whose `dayIndex >= cursor.groupIndex` and calls `advanceScheduleAfterDay` once. This back-fills users who completed sessions under the pre-v339 strict rule.
    3. **`effectiveGroupIndex` scan now skips already-finished days.** Even if the cursor briefly points at a finished day, the override picks the soonest unfinished group at-or-past today's weekday, falling back to the soonest unfinished group anywhere.

### Fixed
- **Today hero no longer demotes accessory day to cardio (SW v338).** Companion to v337. v337 made `effectiveGroupIndex` trust the cursor when it pointed at a future weekday this week (e.g. Friday accessory after Thursday's lift). But on the next render the strength-vs-cardio urgency comparison demoted it anyway: the cursor's day (Friday accessory) had no explicit `weekday` field and no parseable label, so `resolveDayWeekday(currentGroup)` returned `null` → `strengthDesc` was `null` → `strengthUrgency` was `Infinity` → cardio (Saturday long run, urgency 2) won. The strength flash you saw was the brief moment before sessions/cursor synced.
  - Now infers the cursor day's weekday from the nearest neighbour day with a known weekday (each step in the schedule list advances by one calendar day).
  - As a final guard: when the cursor still can't be dated, the strength session is assumed to be "tomorrow" rather than Infinity — so a scheduled cardio later this week never overrides a present cursor.

### Fixed
- **Today hero respects forward cursor advancement (SW v337).** After Thursday's session was logged the cursor correctly advanced to Day 2 (Friday accessory), but the v331 `effectiveGroupIndex` override fired regardless of cursor direction — when `cursorWd !== todayWd` it scanned for any group matching today, found the just-completed Thursday, and pushed the hero card back to Thursday. The hero then thought today was already done and surfaced Saturday's long run as next. Tightened the override to only fire when the cursor is *behind* today (`cursorWd < todayWd`). When the cursor is at a future weekday this week (`cursorWd > todayWd`) — the case after completing a session — trust it as-is. Mid-week activation (cursor stuck on a past Monday) still triggers the original scan-forward behaviour.

### Changed
- **Per-entry rationale chips are now plain English, not validator audit lines (SW v336).** The suggester used to emit chips like "marathon-prep hip-stability mandate · clamshell is a promoted prehab keyword; concentrated on accessory day per prehab-keyword directive · cross-week: clamshell not used in earlier weeks". Rewrote the system prompt to require ≤90-char user-facing sentences with explicit jargon bans (no "mandate" / "directive" / "promoted prehab keyword" / "preferProven" / "Wk1/Wk2/Wk3 used" / "cross-week:" / em-dash-ellipsis truncation). Moved the audit-trail reasoning (which Filters fired, which weeks already used what) into `blockRationale` — the block-level summary that's already meant for prose. Per-entry chips now read like "Hip stability for marathon prep, kept light on accessory day." instead of internal validator text.
- **Rationale chip CSS hardened so long text wraps instead of being clipped (SW v336).** Replaced `whitespace-normal break-words` with explicit inline `overflow-wrap: anywhere; word-break: normal; white-space: normal` and added `min-w-0` to dodge any potential flex-min-content quirk further up the tree. Rationale chips now always wrap to multiple lines when needed.

### Changed
- **Warm-up card drops the empty status circle (SW v335).** The idle-state black circle with a `·` was visual chrome with no meaning — main lifts and assistance both show set progression (0/9 etc.) in their circles, but the warmup is a single bool with no count. The circle only appears now when the warmup is complete (green checkmark). Idle state just shows the title.

- **Removed "Re-authenticating with Microsoft" notification (SW v334).** The silent-token-refresh recovery path on iOS PWA was logging an info-channel inbox entry before redirecting to login.microsoftonline.com. Since the redirect itself is the user-visible event and the recovery is part of the normal iOS PWA token lifecycle, the inbox entry only added noise (often arriving hours after the actual redirect when the user opens the inbox). Auth-provider now redirects silently — no inbox row, no toast.

### Fixed
- **/day visual fixes (SW v333):** three small bugs surfaced on the Thursday session card.
  - **Warm-up card now actually defaults collapsed.** v331 set `useState(true)` but a `useEffect(setCollapsed(completed))` ran on first render with `completed=false` and re-expanded the card. Replaced with a ref-tracked transition guard: the effect only fires when `completed` actually flips, so the initial `true` survives.
  - **Main-lift circles now show set progression like assistance.** Was: black circle with `·` when not started, just `doneCount` when in progress (no `/total`). Now: `0/9`, `3/9`, `✓` — matches the assistance entries' status pill.
  - **Stray bullets in front of assistance rows.** v332's refactor turned the `<ul>` wrapper around `AssistanceEntryCard` into a `<div>` but the entry itself was still a `<li>`. Orphan `<li>`s render with default `list-style: disc` in most browsers, hence the white dots in the screenshot. Changed the entry to a `<div>`.

- **/day assistance order matches what you dragged (SW v332).** AssistanceTrack was rebucketing entries by category (push → pull → single-leg → core → accessory → other) regardless of the saved sequence. So if you dragged Step-up first and Dip last in the editor, /day still showed Dip (push) → Pull-up (pull) → Step-up (single-leg) by category order. Now renders entries in their saved order; category labels appear as sub-headers only when the category changes between consecutive entries (so consecutive same-category entries still group visually under one label). Drag order on the editor is honored verbatim on /day.
- **Today hero card respects today's weekday even when cursor lags (SW v331).**Active block cursor was stuck at Day 0 (Monday) but today is Thursday and Day 1 is the Thursday slot. The "Up next" hero used `cursor.groupIndex` blindly → showed Monday's session as "in 4 days" → cardio Saturday won → hero misrepresented today as a cardio-only day. NextUpCard now computes an `effectiveGroupIndex`: if the cursor's weekday is past today's weekday within this week, it scans the schedule's groups for one whose weekday matches today and uses that instead. Persisted cursor isn't mutated; advancement still happens on session completion as usual. Both the "Open day" URL and the eyebrow/header use the effective index.
- **/day cards default collapsed (SW v331).** Pre-lifting warm-up card now starts collapsed (was expanded). Lift cards and assistance entries already defaulted collapsed; the warmup was the outlier.
- **Today / calendar: mid-week activation surfaces same-week days (SW v330).**Activating a block on a Wednesday pushed the entire Wk1 to next week — even Thu/Fri sessions that were still in the future this week. `projectUpcomingWorkouts` now considers each slot's date in the CURRENT calendar week when that date is today-or-future, falling back to next-week projection only when the current-week candidate is past. Output is sorted chronologically so look-back inserts (e.g. Thu emitted after Mon was projected to next week) come out in the right order. Added a regression test that locks the May 13 incident in (Wed activation, Mon+Thu schedule → Thu this week + Mon next week, in that order).
- **Today: fatigue + soreness card collapses once both answered (SW v330).** The full 2×5-button grid stayed visible all day after logging. Now collapses to a one-line summary ("Logged · Fatigue 3/5 · Soreness 2/5") with **Change** and **Reset** affordances. Saves screen real estate on Today.
- **Suggester: relax cross-week dedup on corrective retry to avoid bad fallbacks (SW v329).**v326's hard cross-week dedup correctly rejected mirrored responses, but the corrective-retry prompt was too generic and the AI sometimes re-mirrored, triggering the deterministic-suggester fallback. The deterministic suggester doesn't know about `marathon-prep`, current goal flavors, or cross-week context, so the fallback plan was worse than letting the duplicate through (recent example: it proposed Deadlift as an accessory on a bench+deadlift day, missed the calf-raise mandate, and invented goal flavors that weren't set).
  - **First attempt unchanged** — still rejects cross-week id reuse so most generations vary on the first call.
  - **Corrective retry now relaxes** the cross-week constraint **when the failures are only cross-week-dedup violations**. The retry prompt explicitly says "this retry RELAXES the cross-week dedup rule — strongly prefer variation if safely possible, but variety is preferred over fallback. State in the rationale which case applies." So the worst case is "same picks across weeks" (the pre-v326 behaviour), not the marathon-blind deterministic fallback.
  - Other validation failures (unknown movementId, budget overflow, schema errors) still get the full constraint on retry — they're real bugs we want corrected.
- **Suggester: implement-prefix dedup for novel movements (SW v328).**With cross-week dedup live the model now proposes more `newMovement` entries. Some of those duplicate existing library rows because the model prefixed the implement word into the name — e.g. it invented "Dumbbell Step-up" when the library already has "Step-up" (with `equipment: dumbbell`). Two-layer fix:
  - **Prompt rule 10** explicitly tells the model not to prefix the implement into a `newMovement.name` (it's already encoded in the `equipment` field) with concrete examples ("Dumbbell Step-up" → "Step-up", "Kettlebell Goblet Squat" → "Goblet Squat", etc.).
  - **Client-side dedup** in `SuggestAssistanceForBlock` now does a normalized-name match in addition to exact lowercased match. Normalization strips common implement prefixes (dumbbell, barbell, kettlebell, sandbag, trap-bar, etc.), hyphens/underscores collapse to spaces, and dup spaces collapse. A normalized-name hit logs a console warning and reuses the existing `movementId` instead of inserting a new row. Catches the case where the LLM ignores the prompt rule.
- **Inline LLM Prompt+Response disclosure resets on week-tab switch (SW v327).**`SuggestAssistanceForBlock` kept its last-generation `lastAiResponseRaw` and `status` in component state across `weekScope` changes — so after generating Wk1, switching to Wk2 still showed Wk1's prompt + response in the disclosure (and the applied banner). Added a `useEffect` that clears both whenever `weekScope` changes.

### Changed
- **AI suggester: hard cross-week dedup (prompt + server validator) (SW v326).**v325's soft "prefer fresh selections" wasn't biting — the model still mirrored picks across weeks because the previous framing left both options open and the temperature-0.5 sampler defaulted to the highest-confidence (cached-style) movement each time.
  - **System rule 5 rewritten** to a two-layer hard rule: within-week dedup unchanged, **across-week MUST NOT re-use the same movementId** when a same-family alternative exists in the library OR can be proposed as a `newMovement`. Quote from *5/3/1 Forever* p.86 kept as the rationale anchor.
  - **System rule 10 relaxed** the "strongly prefer library" wording. When cross-week dedup forces the model off the obvious library pick and remaining library family-mates don't fit the slot well, it should propose a `newMovement` rather than repeat the previous week's id. "Don't be timid here — the user explicitly wants week-to-week variation, and the library is finite."
  - **Cross-week context section in the user prompt** flipped from neutral framing to "**You MUST NOT re-use these specific movementIds**", with the same-family rotation example and the only-when-no-alternative escape hatch.
  - **Server-side validation** now rejects responses that re-use a cross-week movementId. New `crossWeekUsedMovementIds` option on `parseAssistanceResponse` (mirrored across `packages/domain` and `apps/api/src/llm/validate.ts`). When validation fails, the existing corrective-retry path kicks in with the exact errors, giving the model one chance to vary before falling back to the deterministic suggester. Client computes the set from `otherWeeksContext.perDay[].movementId` and sends it on every Suggest call.
- **AI suggester: vary movements across weeks within the same family + temp 0.5 (SW v325).**Two real fixes for the "identical w1/w2/w3 picks" bug — Wendler explicitly endorses varying assistance ("I don't see any problem in changing the exercises from workout to workout. It is the work that matters." — *5/3/1 Forever* p.86), and the prompt + sampling were both fighting that.
  - **Prompt:** the cross-week context section was framed neutrally ("you MAY mirror these picks, or you MAY pick different movements"), which a low-temp model resolved to "mirror" by default. New framing tells the model to **prefer fresh selections this week** and explicitly to pick a different specific movement than the other weeks listed, choosing within the same movement family (e.g. Wk1 Goblet Squat → Wk2 Bulgarian Split Squat → Wk3 Step-up — all single-leg/quad). Repeating a specific exercise across weeks is now only permitted when no equally-good same-family alternative exists. Intra-week family-dedup is unchanged.
  - **Temperature:** assistance-suggester default raised from 0.3 back to 0.5. 0.3 was tuned for structured-output reliability but was suppressing meaningful inter-call variation; 0.5 still passes the validator reliably while giving the model room to actually pick differently. Override via `ANTHROPIC_TEMPERATURE` env.
  - Existing tests for the cross-week prompt section were rewritten to lock in the new intent (rotation within family, no mirroring).

### Fixed
- **Root cause: tighten `isBareScheduleShape` so partial rows can't masquerade as rich (SW v324).**Tracked the May 13 schedule-wipe incident to a real bug, not just a missing guard. The `isBareScheduleShape` predicate (used by both the sync push guard and the apply guard) counted `activeBlockId` and `cursor` as evidence the row was user-authored. They are not — they are tiny pointers that any block-activation or session-completion flow sets automatically, with no input from the user about program shape. The propagation chain:
  1. iOS Safari evicts IndexedDB on the PWA (well-known aggressive eviction policy on iOS PWAs).
  2. `seedIfEmpty` runs at next open and writes a bare schedule `{id, dayOrder, updatedAt}` (no dayGroups / liftsPerDay / supplementalTemplate). Sync pulls down blocks, sessions, TMs etc. but the local bare row's fresh `updatedAt` wins LWW against the server's older rich row.
  3. User notices "no active block" and clicks "Make active" on /program/detail. `doActivate` spreads the bare schedule, adds `activeBlockId + cursor`, bumps `updatedAt`.
  4. Resulting row passed `isBareScheduleShape` ("looks rich, has activeBlockId!") → push guard let it through → server replicated to web → web's apply guard also said "rich" → LWW wiped web's good row too.
  - **Fix:** only the actual config fields count as rich now: `dayGroups.length > 0` OR `liftsPerDay >= 2` OR `supplementalTemplate` OR `supplementalSetsOverride`. The same definition is mirrored in the db.ts write tap so they can't drift. `liftsPerDay: 1` no longer counts because it's the install default and is also written defensively by `completeDayWorkout` reading `schedule.liftsPerDay ?? 1`.
- **Singleton write guard upgraded from passive to active (SW v323).**The pre-existing `installSingletonWriteBreadcrumbs` tap on `db.schedule.put` / `db.settings.put` would log a warning when a bare-shaped row was written but did not block the write. After an incident where the user's `schedule` row got wiped to defaults on both web and PWA (and propagated to the server because the bare row, with TMs deleted in the same window, briefly passed `isSafeSingletonPush`'s `userHasRealData` check), the tap now **refuses** bare-over-rich writes outright and posts a notification to the inbox with the stack trace location. The breadcrumb buffer in localStorage (`__wendler_wipe_breadcrumbs`) now records `refused: true` on blocked writes so the next forensic look-back can distinguish "blocked the bug" from "logged the bug but it still happened". The sync-layer guards (`isSafeSingletonPush`, `isBareScheduleShape` in `applyIncoming`) are unchanged — this is a third belt on the same trousers, closer to the source.
- **Chat "+ New" reset bug — third (final) layer (SW v322).**ChatPanel had a `useEffect` that bubbled `sender.id` up to the parent whenever it differed from `chatId`. When the parent flipped `chatId` to null (the "+" button), the sender's internal id was momentarily still the old id (one render tick before its own sync effect ran). The bubble effect saw "they differ" and re-emitted the old id back up to the parent, which set it again. Replaced the effect with a direct `onChatIdChange(newId)` call inside `submit()` after `send()` completes — the only legitimate case for bubbling. v320 fixed the sender's stale id; v321 fixed the drawer's auto-select; v322 fixes the bubble loop between them.
- **Chat: "+ New" actually resets, exposed in header, readiness hint matches 1–5 scale (SW v321).**
  - **Root cause of the "+ New keeps the old chat" bug:** the ChatDrawer had an auto-select-most-recent `useEffect` (`if (!chatId) setChatId(conversations[0])`) that re-set the chat the moment "+ New" cleared it. Added a `userTouched` flag — auto-select only fires on first open, never overrides an explicit user choice (including the explicit choice of "start fresh"). v320's `useChatSender` fix was correct but masked by this second bug upstream.
  - **"+ New" button now in the chat header** on both the drawer and the full-screen route, alongside History, Expand/Back, Close. Previously buried two clicks deep behind the hamburger.
  - **Readiness scale labels.** The Today page's fatigue/soreness widgets are a 5-button scale, but the hint text still read "1 fresh · 10 wrecked" / "1 none · 10 severe" — leftover from the underlying 1–10 schema. Updated to "1 fresh · 5 wrecked" and "1 none · 5 severe" so the visible UI matches the labels. (Internally the buttons still map 1→1, 2→3, 3→5, 4→7, 5→9 in the schema, so the load/stress calculations are unchanged.)
- **Full-screen chat: add back/close + mobile conversations sheet, and "New chat" actually resets (SW v320).**
  - The /chat route had no header chrome — once you tapped "Expand" in the drawer you were stuck on /chat with no way back (the FAB is hidden on this route). Added a header button cluster: a back arrow (uses `router.back()` falling back to `/`), a close X (links home), and on mobile only, a hamburger that opens the conversation list as a bottom-sheet (the sidebar is desktop-only). The /chat top nav is still available too — this just adds in-panel affordances.
  - **"+ New" no longer resurrects the open conversation.** `useChatSender` cached the conversation id only on mount, so when the parent flipped `chatId` to `null` the sender kept its previous id and the next send appended to the old chat. Added a `useEffect` that re-syncs the internal id whenever the external prop changes (skipped mid-send to avoid clobbering an in-flight request).
- **Chat system prompt tuning (SW v319).**Round of upgrades to the chat prompt based on a review:
  - **Today's date injected.** Client sends `todayLocal` (YYYY-MM-DD in user's local timezone) on every turn; API adds `Today's date: …` to the system prompt so "race in 3 weeks" reasoning works without guessing.
  - **Response depth guidance.** Replaced "be concise" with "match response depth to question complexity. Short factual questions get one-sentence answers. Diagnostic or planning questions get structured multi-paragraph analysis — don't underdeliver." The half-marathon-readiness style of question now gets the substance it asks for.
  - **[Data] vs [Opinion] labels.** Mandated inline labels: `[Data]` for snapshot-cited statements, `[Opinion]` for interpretive coaching. Standardised format makes claims auditable and opens the door to styling them in UI later.
  - **Multi-turn guidance.** "Conversation history is provided in full. Refer back to earlier questions in the session when relevant." Prevents the model from treating each turn as stateless.
  - **Markdown rules tightened.** Headings, bullet lists, bold emphasis are appropriate; tables only when comparing data; code blocks dropped (this is coaching, not programming).
  - **Temperature lowered 0.5 → 0.3.** Default for `ANTHROPIC_CHAT_TEMPERATURE`. Same numbers should produce consistent interpretations across similar questions; 0.5 added unhelpful variance.
- **Chat polish: streaming, markdown, rename, prettier prompt cards (SW v318).**
  - **SSE streaming.** `POST /api/chat` now streams the response as `text/event-stream`. The API switched to `client.messages.stream()` + an async generator wrapped in a Node `Readable`; events are JSON-encoded `{type:'delta'|'done'|'error'}` records. The client parses the SSE buffer in `useChatSender` and exposes `streaming` for live render — the assistant bubble fills in word by word with a blinking caret instead of waiting 10s for the whole response.
  - **Markdown rendering.** Assistant messages now render via `react-markdown` + `remark-gfm`. Headings, lists, tables, code blocks, links, blockquotes — all styled inline (no global CSS additions). The streaming bubble also renders markdown live as the bytes arrive.
  - **Conversation rename.** Click the title in the chat header to edit inline. Enter saves, Escape cancels, blur saves. The new title syncs across devices like any other Chat row.
  - **Suggested-prompt cards.** The empty-state pickers are now narrower (max-width 28rem, centred), card-styled with a 2-line title + description summary + leading emoji. Header now has a "💬 Ask your training coach" intro. Replaced the wide-as-the-window buttons with a small grid that fits the drawer width naturally.

### Added
- **AI chat — grounded conversational coaching (SW v317).**New floating action button (bottom-right, hidden on /day, /session, /chat) opens a slide-up drawer/right-drawer with a Claude Sonnet 4.6 chat grounded in your training data. Also reachable as full-screen at `/chat?id=…`, via `/more → Chat`, and via Quick-jump (aliases: chat, ai, ask, coach). The drawer is page-aware — the system prompt includes the current pathname so questions like "is this block too volume-heavy?" resolve correctly. Conversations persist to Dexie (`chats` table, schema v16) and sync across devices via the existing LWW pipeline.
  - **Context strategy is multi-resolution** so the LLM gets both fine-grained recency and trend signal without blowing the context window:
    - Last 90 days: full per-day detail (every cardio activity, every working set, every recovery entry)
    - 90 days – 1 year: weekly aggregates (mileage, tonnage per lift, avg HR, avg fatigue)
    - Older than 1 year: monthly aggregates
    - Race results and lift PRs are always emitted verbatim regardless of age
  - **Pure domain function `buildChatContext`** (`packages/domain/src/chat-context.ts`) produces the snapshot; `renderChatContextAsText` formats it as a YAML-ish text block for prompt embedding. 7 new tests cover aggregation correctness, status classification, and empty-input edge cases.
  - **New API `POST /api/chat`** (`apps/api/src/functions/chat.ts`) verifies the request, accepts `{ context, messages[], contextPath? }`, calls Anthropic with the rendered snapshot in the system prompt + full message history, returns `{ ok, content, modelInfo }`. Same auth pattern as `suggestAssistance`; bounded message length (20K each) and history depth (100 messages).
  - **New Dexie table `chats`** at schema v16. Per-conversation row holding `{ id, createdAt, updatedAt, title, messages[] }`. Sync.ts updated: outbound collection, apply-incoming case, tombstone-guard inclusion, and `delete.ts` kind routing all extended.
  - **UI components** (`apps/web/src/components/`): `ChatFab`, `ChatDrawer`, `ChatPanel`, plus `app/chat/page.tsx` for the full-screen route. `useChat` + `useChatSender` hooks (`apps/web/src/lib/useChat.ts`) own the live-query + sender pipeline. Empty conversations surface 5 suggested-prompt chips (running history, A-race readiness, stalling lifts, next-block planning, year-over-year comparison).

- **Relocate the readiness inputs (SW v316).**Three small moves to put each input where the user actually thinks about it:
  - **Fatigue + soreness** check-in is now on the **Today** page (under "Up next", above "Recent activity"). It's a daily question — it belongs on the daily landing page, not nested two clicks deep inside Load → Recovery tab.
  - **Bodyweight** input is now on the **Training Profile** (`/profile`) page. Bodyweight is a slow-changing personal-stats input, not a recovery metric.
  - **Recovery menu entry removed from `/more`.** It was redundant: clicking it just opened `/load?tab=recovery`, and `Load` is already on the primary nav. /more no longer lists Recovery; users land on the Recovery tab via Load → Recovery instead.
  - The Recovery tab on /load keeps the muscle freshness map, recent RPE, and Banister TSB summary (the read-only views). The bodyweight + fatigue + soreness widgets that lived there now show a short pointer at the bottom of the tab saying where they moved.
  - Shared widget bodies extracted to `apps/web/src/components/Readiness.tsx` (`<FatigueSorenessCard />`, `<BodyweightCard />`, `<ReadinessScale />`). Same `RecoveryEntry` singleton-per-day; no schema or sync changes.
### Removed
- **Muscle volume heatmap removed from /stats (SW v315).** `MuscleHeatmapCard` component deleted; the per-muscle volume grid wasn't earning its real estate on the Stats page. The underlying `lastTrained` muscle-freshness data on the Recovery tab (a separate, more actionable view) is unaffected.
- **Retire the per-goal "Training emphasis" editor (SW v314).** The five-flavor picker on each Goal (strength / hypertrophy / functional / conditioning / prehab) overlapped confusingly with the Training Profile's `primaryGoal` + `secondaryGoals` vocabulary on /profile — users were setting the same conceptual posture in two places with different words ("real-life-strength" on profile ≈ "functional" on a goal; "primary=strength" on profile ≈ "flavor=strength" on a goal). **Training Profile is now the single source of truth for emphasis.** The `Goal.flavors` schema field is preserved on existing rows; the suggester still reads it (falling back to `defaultFlavorsForKind(kind)` when absent) so the volume-recommendation pipeline and `goalMixDelta` keep getting per-goal hints. But new goals no longer write the field, the picker is gone from both the new-goal form and the edit form, and the per-goal pill row is removed from goal cards. /goals breadcrumb to /profile clarifies where emphasis is now set. ~180 lines of legacy UI removed.

### Changed
- **Merge `/load` and `/recovery` into one tabbed route (SW v311).** Two related pages that answered the same question — "how recovered am I, how hard am I training?" — sat as separate /more destinations with no cross-link. `/load` now hosts two tabs: **Training load** (Banister CTL/ATL/TSB, weekly stress, tonnage trend, cardio trend, deload urgency) and **Recovery** (muscle freshness map, recent RPE, recovery log). Tab choice is reflected in the URL (`?tab=recovery`) so deep-links and the back button work. The old `/recovery` URL still works: SWA issues a 301 rewrite to `/load`, and a client-side redirect stub handles internal navigations from cached PWAs. /more entry updated to point at `/load?tab=recovery`. View bodies extracted to `apps/web/src/components/load/LoadView.tsx` and `RecoveryView.tsx`; the orchestrator at `app/load/page.tsx` is now thin.
- **Split `/goals` into `/goals` + `/profile` (SW v310).**/goals had grown into a five-job page (goal list + Training Profile + Phase + Filters + LLM notes), and four of those concerns aren't goals — they're how you want the AI to help. The four-axis Training Profile editor (`TrainingGoalsSection`) moved to a new `/profile` route. /goals returns to its core scope: PR targets, race times, habits. State still lives in `settings.trainingProfile` so the suggester, `effectiveTrainingPhase`, and `deriveGoalFlags` are unaffected — only the URL the user edits it from changed. A breadcrumb on /goals points at /profile and vice versa. Added /profile to /more (between Goals and Races) and to Quick-jump (aliases: profile, phase, emphasis, filters, ai notes).
- **Calendar: trim legend + add Strength/Cardio filter tabs (SW v309).**The legend collapsed from 7 chips to **5** by folding `In-progress strength` and `Upcoming strength` into a single `Strength · planned` chip (the styling difference is preserved on the events themselves) and `Imported strength` into `Strength · done` (Strava-imported strength *is* done strength — colour scheme already matched). The "Strava badge on event = imported" footnote replaces the dedicated legend chip. Added a tab pair above the grid (`All / Strength / Cardio`) that filters which event classes the month renders — picking Strength hides cardio chips and planned-run pills; picking Cardio hides every strength variant.
- **Unified nav: "More" is now a primary tab on desktop too (SW v308).**Before, mobile had a 6th `More` tab linking to /more (Goals, Races, Recovery, Movements) and desktop had no equivalent — Settings was reachable only via the avatar dropdown, which on a tablet/laptop meant a tap into an account menu just to change a rest-timer default. Same IA shape on both viewports now: `Today · Program · Calendar · Stats · Load · More`. /more also now lists **Notifications** and **Settings** so every app-level destination has a single canonical entry point. The avatar dropdown is trimmed to account-only items (account name, sync status, Sync now, Sign out); Settings and "More tools" links removed from it. The bell icon stays in the header on both viewports as a shortcut for the unread badge.
- **Rename `/analytics` → `/stats` (SW v307).**The top-nav label was already "Stats" but the route was `/analytics` — a long-standing label/URL mismatch that confused Quick-jump search and made shared URLs misleading. The page itself is unchanged; only the route moved. The Azure Static Web Apps config now issues a `301` redirect for `/analytics` → `/stats`, so any bookmarked or shared old URL still lands on the right page. Internal references in `Nav`, `QuickJumpPalette`, and `MondayDigest` updated to the new path. Quick-jump still accepts `analytics` as an alias.

### Fixed
- **Phase auto-toast no longer fires when viewing a stale 7th-week deload block (SW v313).** Opening a *completed* 7th-week deload block detail page from /program — or from a calendar deep-link — would call `effectiveTrainingPhaseInfo` with that block's `kind`/`seventhWeekKind`, derive `phase = deload, source = block`, and fire the first-encounter `PhaseAutoToast` + write a notification row to the inbox. But the user was no longer in that block — the schedule had already advanced to the next Anchor. Two-pronged fix: (a) `/program/block` only passes the `activeBlock` argument when the block matches `schedule.activeBlockId` AND has no `completedAt` — historical or future blocks return the global phase, not their own. (b) `useActiveBlock()` now filters out completed blocks defensively, covering the small window between marking a block complete and the schedule pointer advancing. The Training Profile editor on /profile inherits the fix transparently. Existing stale "Phase auto-shifted to deload" notification rows are not auto-cleaned; delete them once.
- **Deleted notifications no longer resurrect on next sync (SW v306).**The tombstone guard in `applyIncoming` (`apps/web/src/lib/sync.ts`) listed every deletable record kind *except* `notification` and `aiGeneration`. Both call `deleteWithTombstones` correctly on delete, but when the server replayed an older `put` for that record back in the next pull, `lwwPut` re-inserted it without consulting the tombstone table — so a notification the user had explicitly deleted would reappear the moment the next background sync ran. Added both kinds to the guard list. No schema or migration needed; existing tombstones already in the local table will now be honoured retroactively.

### Removed
- **Retire the sync-conflict notification entirely (SW v299).** Root-cause investigation: the v297 emitter was measuring nothing useful. The server-side "conflict" count is a 409 from `cosmos container.items.create` keyed on `userId::kind::recordId::updatedAt` — a deterministic dedupe id. Combined with the existing `SLACK_MS = 60_000` rebroadcast (defends against clock-skew dropping writes) and the 10s background sync cadence, every push that catches the previous push's slack window reports a "conflict" for every record touched in that window. **It's a benign idempotent-resend confirmation, NOT a write/write race.** There are no real cross-device write conflicts in this system — LWW happens client-side. The "21 conflicts" the user saw simply meant 21 records were touched in the preceding ~60s and re-broadcast. Removed the emitter, the rate-limiter, and the now-obsolete v298 hotfix machinery (the cleanup still runs once to purge legacy flood rows). Documented the actual semantics in a comment in `syncNow` so a future reader doesn't reintroduce the same bug.

### Fixed
- **Hot-fix: sync-conflict notification feedback loop (SW v298).** v297 introduced a sync-conflict emitter that wrote a notification row every time the push reported `conflicts > 0`. Each `notify.*` call also kicks a fresh sync to broadcast the new row, which pushed the notification AND retried the unresolved conflict-prone records — so every cycle reported conflicts again, wrote another notification, and the inbox grew by one per ~10-second sync tick. Users with an unresolved cross-device singleton race could accumulate dozens of duplicate "N sync conflicts on push" rows.
  - **`notify.*` no longer kicks sync on the `sync` channel.** Other channels still kick (the user expects the badge to update across devices promptly when something automatic happens) — but writing a sync-channel notification from inside the sync loop can never re-trigger a push.
  - **Sync-conflict emitter is rate-limited to once per 10 minutes** via a module-scoped timestamp. A persistent conflict logs once per tab session per window; resolving the underlying conflict resets the next window naturally.
  - **One-shot cleanup `SyncConflictFloodCleanup`** runs once per device and deletes existing flood rows (keeps the most recent one as the audit-trail entry). Existing installs auto-purge the dozens of duplicates on first page load after v298 deploys. localStorage flag `wendler:sync-conflict-flood-cleanup:v1`.

### Added
- **Notifications — Phase 3: sync, plan-match, deload, Strava import (SW v297).** Rounds out the inbox with the remaining auto-event sources.
  - **Sync conflicts (channel: `sync`, severity: `warn`).** When a push reports `conflicts > 0` (another device wrote a newer version of the same record since this device last synced), the inbox gets an entry explaining what happened. Previously silent — the user had no way to know cross-device write contention occurred.
  - **Strava import (channel: `sync`, severity: `info`).** After each Strava sync that imported new activities, log a summary with: `added` / `refreshed` counts, plan-match breakdown (`autoMatched` to a planned slot vs `unmatched`), strength-HR enrichment counts, deep-link to `/cardio`. The plan-match line is the substantive piece — when you do a bonus run on a planned-run weekday, it gets auto-tagged with the slot's kind, and now you can see at a glance how many runs were tagged.
  - **Deload strategy applied (channel: `recovery`, severity: `info`).** Every time `applyDeloadChoice` writes the deload-week assistance scaling (volume-half / intensity-cut / bodyweight-only / mobility-recovery / skip-assistance), the inbox records the choice with a deep-link to the block.

### Changed
- **Notifications — Phase 2: four real emitters wired (SW v296).** The unified inbox is no longer empty. Existing transient UX (toasts, banners, undo) is untouched — every emitter calls `notify.*` ADDITIVELY alongside whatever inline UI it already shows.
  - **AI suggester applied (channel: `ai-suggester`, severity: `action`).** Every time the LLM applies picks, a permanent entry is logged with the full `blockRationale[]` body, a deep-link to the block, and a rich `context` payload: `cardioFatigueShift`, `cardioFatigue` diagnostics (recent vs baseline weighted minutes, delta %, modality mix), model info (model name, elapsed ms, token counts), the `newMovementsAdded` list, and any `validationWarnings`. After-the-fact "why did the AI pick that?" investigation now has all the data persisted; no more relying on the 10-second undo banner.
  - **Local deterministic fallback applied (channel: `ai-suggester`, severity: `warn`).** Same shape, distinct severity so it's clear in the history when the LLM was bypassed and why (the `fallbackReason` is in `context`).
  - **Phase auto-derivation first-encounter (channel: `phase-auto`, severity: `info`).** Fires on the same trigger as the existing `PhaseAutoToast` — exactly once per `(source, phase)` bucket, gated by the existing localStorage flag. Title clarifies whether the source was `block` (7th-week deload) or `race` (taper/peak from race calendar). Deep-link to `/goals` for manual override.
  - **Migrations (channel: `migration`, severity: `info`).** Both `LegacyDeloadMigrator` (the v272 in-block deload flag flip) and `LegacyDefaultAssistanceMigrator` (the v287 default→per-week promotion) now log how many blocks they touched + a deep-link to `/program`. New installs see nothing; users on old data get a permanent audit trail.
  - **Auth recovery (channel: `auth`, severity: `info`).** The v294 interactive recovery (`acquireTokenRedirect` when silent refresh fails — the iOS PWA's usual recovery path) now logs an entry BEFORE the redirect so it's in place when the user returns. The account email is included in the body when present.

### Changed
- **Removed Phase 1 dev smoke-test panel** from `/notifications`. The four real emitters above replace it.
- **Unified notifications inbox — Phase 1 foundation (SW v295).** Adds the persistent history layer the app has been missing. Future automatic events (AI suggester applied, phase auto-shifts, migrations, sync conflicts, auth recovery) will all log through one channel with an unread badge in the nav, instead of disappearing as transient toasts.
  - **New Dexie table `notifications`** (schema v14) — `{ id, createdAt, channel, severity, title, body, deepLink, context, readAt, dismissedAt, expiresAt, updatedAt }`. Persistent by default; `expiresAt` is opt-in for future noisy events. Synced across devices via the existing LWW pipeline (rides on the same `OutboundDoc[]` flow as wellness / races / cardio — cross-device unread badge for free).
  - **New `Notification` interface** in `packages/db-schema` with `NotificationChannel` (10 values) + `NotificationSeverity` (info / success / warn / action) + `NotificationDeepLink`. Soft-delete via tombstone, mirrors other synced tables.
  - **New imperative API `apps/web/src/lib/notify.ts`** — `notify.info / .success / .warn / .action({ channel, title, body?, deepLink?, context?, expiresAt? })` plus `notify.markRead / .markAllRead / .dismiss` and `deleteNotification(id)`. Existing transient UX (toasts, banners, undo) stays untouched — emitters call `notify.*` ADDITIVELY in Phase 2.
  - **New `NotificationBell` component in the global nav** — visible on every page on both PWA and desktop, mobile header AND desktop top-right strip. Live-queries unread count; rose-coloured badge with "99+" cap.
  - **New `/notifications` inbox page** — grouped by day (Today / Yesterday / explicit dates), channel filter chips that only render channels actually present, per-entry: title + body + relative-time ("3 min ago" / "2d ago" / "1mo ago") with absolute-time tooltip, deep-link button, mark-read / delete. "Mark all read" at the top when there are unread items.
  - **Phase 1 dev-only smoke-test buttons** at the bottom of the inbox page emit info / success / warn / action notifications so the UI can be validated before any real source is instrumented. Removed in Phase 2.
  - **No existing emitters wired yet** — Phase 2 (next session) will instrument the four high-value sources the user has explicitly asked for awareness on: AI suggester applied (with rationale + cardio-trim diagnostics), phase auto-derivation (deload trigger, taper start), migration ran, auth recovery happened.

### Fixed
- **iOS PWA: recurring "auth error" no longer requires manual sign-out/in (SW v294).** Three related fixes for the most painful Home Screen PWA failure mode.
  - **Auto-redirect on `InteractionRequiredAuthError`.** Previously, when MSAL's silent token refresh failed (very common on iOS — Safari ITP blocks the hidden iframe that talks to login.microsoftonline.com), `acquireIdToken` quietly returned `null`, the API rejected the missing token with 401, and the user had to manually sign out + in to recover. Now silent-failure immediately triggers `acquireTokenRedirect`. The redirect is usually seamless (MS recognises the existing browser session and bounces back within ~1s with a fresh token — no manual sign-in prompt).
  - **401 retry path in `authFetch`.** If the server rejects an attached token (clock skew, server-side allowlist edge cases, expired-between-acquire-and-send), the same recovery fires.
  - **Throttled — concurrent 401s trigger at most ONE redirect.** A burst of in-flight `authFetch` calls won't kick off a flurry of redirects.
  - **`storeAuthStateInCookie: true` + `temporaryCacheLocation: 'sessionStorage'`** in MSAL config. iOS aggressively clears PWA localStorage (~7-day ITP purge, OS storage reclamation). The cookie copy bridges the redirect callback when localStorage is wiped; sessionStorage handles in-flight nonces when localStorage is unavailable. Not a substitute for sign-in when MS-side cookies are also gone — but eliminates the "everything works except the refresh path" failure mode.

  Net effect: in the common case (token expired, MS account still signed in to Safari), you'll see a quick redirect and the app works again, no UI interaction. In the worst case (localStorage AND MS cookies all wiped after weeks of inactivity), one tap on the sign-in screen instead of "sign out then sign in".

### Changed
- **Cardio-fatigue trim is now principle-based, not hardcoded — and modality-aware (SW v293).** The previous v290 rule told the LLM to "trim isolation slots FIRST". That was wrong: trimming a hammer curl during a hard running week returns almost no recovery; trimming reps on a hamstring/glute compound returns real recovery. v293 fixes the logic without hardcoding any movement names.
  - **Rule 14 rewrite — two-axis ranking.** The LLM now ranks each movement on the day by combining (1) **intrinsic systemic cost** (compound > full-body BW > carry > core > isolation > prehab) with (2) **overlap with the dominant recent cardio modality** (running → posterior chain; cycling → quads/glutes; swim/row → lats/back). Highest combined score = first to trim. Isolation goes from "trim first" to "trim last when nothing else justifies it". The LLM picks based on `pattern` + `primaryMuscles` data it already has — no movement names in the prompt.
  - **New diagnostic — modality mix line.** The "Recent cardio load" prompt section now includes a modality breakdown ("Modality mix (last 7d): run 87%, row 13%") so the LLM knows which muscle chain is actually being depleted. Computed from the trailing-7-day weighted minutes per modality; modalities below 10% share are omitted.
  - **`CardioFatigueSignal.recentModalityMix`** added to the domain output (consumed via `SuggesterContext.cardioFatigue.recentModalityMix`); `MinimalCardio.modality` is now required on the input shape (matches reality — every cardio session has one).
  - **Rationale guidance updated.** The LLM should now name the chain it's protecting ("trimmed to preserve posterior-chain recovery during elevated running load"), not the movement type ("trimmed isolation").

### Added
- **AI response is now visible in the prompt-preview disclosure (SW v293).** The "▾ LLM prompt preview" section under each Suggest block is renamed "▾ LLM prompt + response" and includes a third pane showing the raw JSON the LLM returned. Captured per-generation in component memory; persists until the next generation. Pretty-printed when valid JSON, raw text otherwise. The local deterministic fallback's output is captured in the same pane prefixed with `// Local deterministic fallback (reason: …)` for parity. Helps debug "why did it pick that?" weeks later — paste the system + user + response triple into your AI of choice and ask.

### Fixed
- **AI rationale chip in the day view no longer truncates with ellipsis (SW v292).** The "✨ why this was suggested" badge under each assistance entry was rendered as an `inline-block max-w-full` span which was being clipped to a single line by an enclosing flex layout. Changed to a true block-level `<p>` with `whitespace-normal break-words` so the full rationale always wraps and stays readable.

### Changed
- **Calendar: click "+N" to expand the day cell and reveal hidden entries (SW v291).** When a day had more than 2-3 strength workouts / cardio / imported entries, the leftover items collapsed behind a static "+N" label with no way to see what they were. Now "+N" is a button: click to expand the cell to show ALL entries (no per-row cap); click "Show less" at the bottom to collapse. Per-day expansion state is local to the calendar page; navigating away resets it. Works on every entry row (strength, upcoming, cardio, imported).

### Added
- **Recent-cardio fatigue signal — bounded accessory trim when actual cardio spikes above baseline (SW v290).** The suggester previously saw only the run plan *template*; bonus / unplanned Strava runs (e.g. a heavy Z3 weekend) were invisible to it, so assistance picks didn't reflect real cardio load. v290 fixes this with a **deterministic, bounded** shift signal that never lets the LLM decide cut magnitude on its own.

  **How it works:**
  - Compute `cardioFatigueShift` in `suggester-context.ts` from the trailing **7-day HR-zone-weighted cardio minutes** vs the rolling **28-day baseline**:
    - Delta < +30% → shift `0` (no section emitted; zero behavior change)
    - Delta ∈ [+30%, +60%) → shift `-1` (prompt asks for ~10–15% rep trim)
    - Delta ≥ +60% → shift `-2` (prompt asks for ~15–20% trim, hard-capped at 20%)
  - Reuses the existing `weightedCardioMinutes` formula from `load.ts` (single source of truth: Z1 ×0.5, Z2 ×1.0, Z3 ×2.0, Z4 ×4.0, Z5 ×6.0).
  - The 28-day baseline window is long enough to smooth a single hard week and short enough that a sustained ramp (marathon prep) eventually shifts it. Configurable via `CARDIO_FATIGUE_BASELINE_DAYS` / `*_LIGHT_THRESHOLD` / `*_HEAVY_THRESHOLD` constants — retune from one file when data dictates.

  **Guardrails (defense in depth):**
  1. **Bounded — never more than 20% under budget.** The cut magnitude is set by the deterministic shift, not the LLM. System-prompt rule 14 surfaces the 20% cap; the existing validator's volume-deviation check applies on the response side.
  2. **Compound-cut guard — suppressed during deload and taper.** The assistance budget is already cut upstream there via the phase preset auto-shift; stacking another cut would crater volume. The signal only fires in `normal` and `peak` phases. Peak deliberately does NOT suppress — peak is when cardio cuts are most needed.
  3. **Mandates inviolable.** Goal-mandated movements (calf raises for marathon, prehab for shoulder-health, etc.) stay at full reps. The trim comes from `isolation` slots first, never compounds/carries/single-leg/core.
  4. **Trim by reps, not by slot removal.** Drop reps within isolation slots (e.g. curls 4×12 → 4×10). Do NOT remove whole slots. Prompt rule 14 enforces this verbatim.

  **What the user sees:** When generating Suggest the week after a bonus-cardio spike, the LLM's `rationale` strings cite "trimmed for elevated recent cardio load" on cut picks. Mandates and prehab keep their normal volume.

  **Diagnostics:** `SuggesterContext.cardioFatigue` carries `{ recentWeightedMin, baselineWeightedMin, deltaPct, suppressedByPhase }` for future UI / fallback introspection (no UI surface yet — ship the prompt change first, observe quality for a few generations, then disclose in the Suggest banner if useful).

  **Tests:** 6 new in `cardio-analytics.test.ts` (no-data, steady-state, +33% / +67%, HR-zone weighting, future-date exclusion); 5 new in `suggester-context.test.ts` (fires in normal, suppressed in deload, suppressed in taper, fires in peak, no-cardio). 4 new in `assistance-prompt.test.ts` (section omitted at shift 0, emitted at -1 with stats + bounded trim wording, heavier wording at -2, system rule 14 present). 800/800 domain tests pass.

  **Threading:** New `cardio?` field on `BuildSuggesterContextInput` accepts the trailing 35-day cardio array (fed by `useCardioRecent(35)` in `SuggestAssistanceForBlock`). New `cardioFatigueShift` + `cardioFatigue` fields on `BuildAssistancePromptInput`. The fallback path will pick this up naturally on its next refresh — every field that lands here is consumed by both the LLM and fallback through the same context, by design.

### Changed
- **Weighted vest / dip belt as equipment + loaded-bodyweight prompt rule (SW v289).** External-load tools (vest, belt) are now first-class equipment types, and the suggester knows when to recommend loading vs sticking to bodyweight.
  - **New `EquipmentType` values:** `weighted-vest` and `dip-belt`. Available in the EquipmentPicker, the per-movement equipment dropdown, the validator, and `ALL_EQUIPMENT`. No new presets — add per block / program as needed.
  - **New `Movement.externallyLoadable: boolean` flag.** Hard gate on which BW movements the LLM is allowed to propose loading. Seeded `true` on: pull-up, chin-up, dip, push-up, ring dip, ring row, ring push-up, inverted row, deficit push-up. Deliberately *not* on prehab work, mobility, plyo, skill-capped movements (pistol squat, handstand pushup, muscle-up), or already-loaded movements (DB/KB/BB).
  - **Movement library line now includes a `loadable` tag** so the LLM can grep for eligible movements.
  - **New environmental signal — "External-load tools available: weighted-vest, dip-belt"** — only emitted when the user actually has a loader in available equipment. Otherwise the LLM never sees the option.
  - **New system-prompt rule 13: "Loaded bodyweight progression"** covering: (a) hard gate (loader available AND loadable tag), (b) phase-awareness (anchor / peak / >12 BW reps → load; leader / normal / deload / taper → unloaded + reps), (c) never load prehab / mobility / plyo / skill-capped, (d) loaded variant uses the same rep budget. The LLM picks the BW movement, the user logs the actual kg per set.
  - **Per-set load** stays as today — every set already accepts a numeric load, so vest/belt progression flows into e1RM and analytics automatically. No new schema fields for load weight.
  - **No goalNote required.** Toggling `weighted-vest` and/or `dip-belt` in EquipmentPicker is the only setup step.

### Changed
- **Week tab "override dot" removed (SW v289).** The yellow • on Wk1/2/3/Deload chips signaled "this week differs from Default". With Default gone since v287, every week is its own thing — the dot is meaningless. Chip strip is now clean. Removed `weekHasOverride` derivation, unused `hasDayAssistanceOverride` import, and the `fallback*` props on `BlockWeekTabsProps` that only existed for that derivation.

### Changed
- **Assistance section: drop stale "Edits stay scoped to Week N" prose; relocate the action as a subtle "Clear Week N" link (SW v288).** With every week being its own override now (v287), the previous banner just stated the obvious. Replaced with a small right-aligned "Clear Week N" / "Clear Deload" link under the assistance list — only rendered when the day actually has entries to clear in the active week. Undo banner still appears for 10s after a clear.

### Changed
- **Block editor: "Default" tab removed; every week is programmed independently (SW v287).** The block editor used to show a "Default" tab (the per-day default assistance list) alongside Wk 1/2/3/Deload chips. Editing Default applied to every week without an explicit override; editing a specific week silently created an override. This violated the model the user actually wants — variation across weeks per Wendler 5/3/1 Forever p.86 ("I don't see any problem in changing the exercises from workout to workout").

  - **"Default" chip removed from `BlockWeekTabs`.** Wk 1 is now the initial selection; `?week=` URL param defaults to `1`.
  - **`weekScope` narrowed from `'default' | WendlerWeek` → `WendlerWeek`** in `BlockPlanEditor`, `BlockAssistanceVolumePanel`, `SuggestAssistanceForBlock`, `weekStartDate`, `formatMainWorkSection`, `buildSuggesterContext`, and `buildAssistancePrompt`.
  - **All editor edits flow into per-week overrides.** The "Showing the default list…" explainer paragraph is gone; the per-week "Edits stay scoped to Week N — Reset" affordance stays. Reset clears the override (falls back to whatever's stored on the day, which is `[]` for new blocks and the original default for migrated blocks).
  - **One-shot migrator promotes existing defaults into per-week overrides.** New `LegacyDefaultAssistanceMigrator` walks every block; for each `(block × day)` with non-empty `day.assistance`, it copies the list verbatim into Wk 1/2/3/Deload overrides where no override already exists. `day.assistance` itself is left intact for sync compat with older clients. Idempotent via `localStorage` flag `wendler:legacy-default-assistance-migrated:v1`.
  - **System prompt rules 5 + 6 reworded.** No more "source plan / default scope" branches — the prompt only ever describes "the active week".
  - **`SuggestAssistanceForBlock` cross-week context loses the "Default plan" source.** Only real weeks contribute to the cross-week framing now.
  - Domain types narrowed; all 784 domain tests pass; `pnpm typecheck` clean across all 4 workspaces; `pnpm lint` clean.

### Changed
- **Smart day-ordering: LLM picks the order, post-process pulls prehab to the end (SW v286).** Two problems noticed in v285's generated picks:
  1. Calf raise (isolation — real loaded work) landed AFTER prehab (face pull, clamshell) on an accessory day. My previous category-based sort collapsed isolation + prehab into one `accessory` bucket and couldn't distinguish them.
  2. Nordic Hamstring Curl and Single-Leg Glute Bridge ended up back-to-back — both posterior-chain compounds. Pure category sorting can't see "shares a primary muscle".

  Both flaws come from the same root: post-process sorting by 6-value category can't capture the nuance the LLM already understands (slot vocabulary, primary muscles, when to alternate). New approach: **let the LLM order the picks; post-process only enforces the easy-to-violate guardrail "prehab goes last"**.

  - **System-prompt rule 12 added.** Explicitly tells the LLM: compound work first (push, pull, single-leg, carry), then trunk (core), then isolation, prehab last. Avoid programming two consecutive movements that share a primary muscle group. On main-lift days, the assistance whose slot matches the main lift goes first.
  - **`sortAssistanceEntriesForDay` now accepts an optional `slotByEntryId: Map<string, RuleSlot>` parameter.** When the slot map is provided (LLM path), the function trusts the model's intra-day ordering and only pulls `prehab` slot entries to the end. The LLM's compound-first + muscle-alternation reasoning is preserved.
  - **When slot info is absent (deterministic fallback, older callers), the legacy 6-value category sort kicks in** as back-compat. Both paths now produce sensibly-ordered picks.
  - **Carries are no longer treated as "session finishers"**. The previous "carry → last" placement was wrong; loaded carries are compound work and belong in the compound tier. The new prompt rule explicitly groups carry with push/pull/single-leg.
  - 5 new ordering tests covering: prehab-to-end with slot map, LLM-order preservation, idempotence, the v286 user-reported scenario verbatim, and back-compat fallback. 786 total pass.

  Quality impact assessment: zero. The ordering instruction is orthogonal to *which* movements the LLM picks — it only constrains the order they're returned in. Mandates, slot vocabulary, family dedup, prehab concentration rules all unchanged.

### Changed
- **Suggest assistance now operates in "fill-the-gaps" mode (SW v285).**Previously, clicking Suggest with mixed empty/filled days would append new picks to every day — including the ones you'd already arranged. The intent was always "fill what's empty", but the implementation didn't enforce it. Now:

  - **Days with at least one existing entry are treated as intentionally arranged.** Suggest returns no new picks for those days; only empty days get filled. Three layers of defence so this can't drift:
    1. **Prompt-level directive.** The `## Existing entries` section now appends an explicit "Fill-the-gaps mode is ACTIVE" block when any day is filled, listing the day indices and instructing the LLM to return `entries: []` for those days.
    2. **Pre-flight short-circuit.** If every day already has entries, the LLM call is skipped entirely with a user-readable error ("Every day already has assistance entries. Clear a day to enable Suggest to fill the gaps.").
    3. **Post-response filter.** Even if the LLM ignores the directive and returns picks for a filled day, the apply-path drops them. The user's arranged days are immutable from the Suggest button.
  - **Dedup + mandate coverage still respect filled days.** The LLM still sees every existing movement so it can't propose duplicates or violate family-dedup; mandates like "marathon-prep needs a calf raise" still count coverage from filled days (so if Day 0 has a calf raise, the LLM won't add another to Day 1/2 just to satisfy the mandate).
  - **Same fill-the-gaps filter applies to the deterministic fallback.** Both AI and fallback code paths respect arranged days. Parity guaranteed.
  - **Suggest button help text updated** to reflect the new behavior: "Fills empty days only — days you've already arranged are left alone."
  - 3 new prompt-builder tests; 781 total pass.

### Changed
- **Completed workouts are now fully read-only on the day page (SW v284).**Previously, the `locked` flag on `/day` only fired when the parent BLOCK was marked complete — an individual completed session inside an active block remained editable (set logs, RPE, notes, assistance toggles). This was the editing-side counterpart to the prescription-mutation bug fixed in v282: even with the snapshot in place, you could still accidentally edit the actual logged data of a historic session.

  The `locked` derivation now ORs in `workoutCompletedAt`. Any day with the workout marked complete (whether 5 minutes or 5 months ago) renders as read-only — `AssistanceTrack`, notes section, RPE buttons, and the "Complete workout" button all already honor the same `locked` prop. The amber banner at the top distinguishes the two cases:
  - **Block locked**: "🔒 This block is marked complete. Open the block page and unmark complete to make changes."
  - **Workout locked**: "🔒 This workout is marked complete. Sets, RPE, and notes are read-only to preserve the historical record. If you need to fix a mistake, delete the day and re-log it from the home page."

  Combined with the v282 prescription snapshot, completed sessions are now structurally immutable from both directions: the prescription can't be retroactively rewritten by block-plan edits, AND the logged sets/RPE/notes can't be accidentally over-typed by reopening the day later.

- **"Logged for today" badge now shows the actual date for historic sessions.** Previously, opening a session from the recent-sessions list days later still read "Logged for today — link to a different planned date…", which was misleading. The badge now reads "Logged on Mon 11.05. — link to a different planned date…" when the performed date isn't today, and keeps "Logged for today" only when it actually is.

### Added
- **Undo for "Reset to default" on per-week assistance overrides (SW v283).**The Reset button was a confirm-less, immediate clear — a real foot-gun if a per-week override held LLM-generated picks or manually-arranged work, which is often the case. After Reset, an amber banner now appears inside the assistance section showing how many entries were cleared and from which week, with an **Undo** button that restores the exact entries (deep-cloned at reset time so they survive any in-flight edit). Banner auto-dismisses after 10 seconds. No data structures changed; pure UI safety net.

### Fixed
- **Completed workouts no longer change shape when the block plan is later edited (SW v282).**Reported scenario: yesterday's Day 1 of Wk1 was completed with assistance lifts A/B/C. This morning the user generated fresh assistance for Wk1 of the same block; the new movements appended to Wk1 Day 1's override. The day page (when reopening yesterday's session from the recent-sessions list) then rendered the live plan's view, showing main lifts as completed but the **new** assistance entries as un-logged, with no trace of the originally-prescribed A/B/C. The actual logged sets in `db.sets` were never touched — they still pointed at the right `movementId`s — but the prescription rendering surface lied about what was prescribed at completion time.

  Underlying cause: the day page rendered prescription from the LIVE block plan. Any future edit to the block plan (manually or via the AI suggester, in any week scope that intersects the completed day) retroactively changed how the historical day looked.

  **Fix — historical sessions now snapshot the prescription on completion:**
  - New `SessionRecord.assistanceSnapshot?: AssistanceEntry[]` field. Stamped once per day-group on the first row when `completeDayWorkout` runs, carrying the resolved assistance prescription at that moment.
  - `DayAssistanceSection` (the day-page assistance render) now prefers the snapshot over `resolveDayAssistance(plan, …)` when present. Live plan is used as a fallback for in-progress days and for sessions completed before v282 (pre-snapshot).
  - Snapshot is deep-cloned before storage so a later mutation to the live plan can't leak in via shared object refs.
  - Sync engine needs no changes — the new field rides along in the existing session payload.
  - 778 domain tests pass (no domain logic changed; the fix is in the web + schema layers).

  **Manual recovery for the reported case:** the existing "Reset to default" button on the per-week assistance tab (BlockPlanEditor → Wk1 → any day → Assistance section) clears the bad override and reverts Wk1 Day 1 to inheriting from the unchanged default plan. Going forward, the snapshot prevents this recurrence regardless of how the block plan is later edited.

### Changed
- **`buildSuggesterContext()` extracted into `packages/domain` (SW v281).**The single highest-value structural concern flagged in the v278 architecture review. The AI suggester component (`SuggestAssistanceForBlock.tsx`) used to compute ~150 LOC of "what does both the LLM and the deterministic fallback need to see?" inline as a React useMemo, and pass the resulting bag to both code paths. Adding a new field meant remembering to update both call sites; the two paths could (and did, in the past) silently drift.

  Lifted into a single pure domain function `buildSuggesterContext({ block, days, movements, settings, programs, races, runPlan, goals, blockFirstSessionDate, weekScope, defaultFlavorsForKind, now? }): SuggesterContext`. The React component now reads Dexie state in hooks (unchanged) and calls this function once. Both the AI prompt builder and the fallback `suggestAssistance()` consume the same SuggesterContext object, removing the drift seam.

  - New file: `packages/domain/src/suggester-context.ts` (~370 LOC including doc comments). One exported function (`buildSuggesterContext`), one exported predicate (`isCardioPeakActive` — also extracted out of the component because it duplicated taper-window logic that conceptually lives in the domain).
  - Component now ~150 LOC lighter; the giant useMemo becomes a one-call invocation with a stable dep array.
  - 14 new vitest cases covering: empty inputs, race-driven phase + preset shift, manual override (no multiplier suppression), block-derived deload, program-equipment inheritance, block-override-vs-program, flavor de-duplication, completed-goal filtering, and the `isCardioPeakActive` predicate (kind-specific windows, priority filter, past-race exclusion).
  - Behavior preserved exactly: 764 → 778 tests, all green. No SW-visible change for the user — just future-proofing against the LLM/fallback drift bugs that bit us in v272 and v276.

### Added
- **Canonical day-ordering for newly-suggested assistance picks (SW v280).** AI and deterministic-fallback suggestion paths now both run their per-day picks through a new pure helper `sortAssistanceEntriesForDay(entries, mainLifts)` before they land in the block, so each day reads in Wendler's intended session flow instead of whatever order the LLM emitted or the rule engine iterated.

  **The rule:**
  - On a **main-lift day**, the assistance category that matches the day's main lift comes first: `push` for bench/press, `pull` for deadlift, `single-leg` for squat. The rest follows the default flow.
  - On an **accessory day** (no main lifts), the default flow applies: `push → pull → single-leg → core → accessory → other`. Carries land last as session finishers.
  - **Stable within category** — same-category entries preserve their LLM-given (or rule-engine-given) order, so any intentional ordering inside a slot is kept.
  - When a day has multiple main lifts (e.g. bench + deadlift), the FIRST-listed lift picks the primary category. Stable, predictable.

  **Applies to:** AI-generated picks and the deterministic fallback. Does NOT re-sort manually-arranged entries — only newly-produced picks. Manual entries added to an already-arranged day still append at the bottom (existing behavior preserved).

  New file `packages/domain/src/assistance-ordering.ts` (pure, 1 exported function). 11 new vitest cases covering accessory days, all four main-lift kinds, multi-main days, stability, idempotence, and no-mutation. 764 total tests pass (was 753).

### Changed
- **Sync engine quick-wins + small structural cleanups (SW v279).**Acting on the v278 architecture + code review findings. No behavior change for the user; all internal refactor.

  **Sync engine (`apps/web/src/lib/sync.ts`):**
  - **Unified LWW tie-breaking.** Previously the sync engine used `local.updatedAt > incoming.updatedAt → skip` (local-wins-ties) for blocks, programs, goals, cardio, races, but `incoming.updatedAt >= local.updatedAt → write` (incoming-wins-ties) for settings, schedule, recovery, runPlan, strengthHr, wellness. At identical timestamps the two paths disagreed — a long-tail landmine, not a current bug. Standardized everywhere on **incoming-wins-ties** because both sides of a sync converge to the same answer that way (whichever doc arrives later wins; both devices end up agreeing).
  - **New `lwwPut(table, incoming, key)` helper.** Collapses ~50 lines of repeated LWW-guard logic into one place. Every mutable-entity branch in `applyIncoming` is now one line. `set`, `session`, `trainingMax` remain unguarded blind puts (append-only at sync level; tombstones already prevent resurrection); `movement` ALSO remains unguarded because Movement has no `updatedAt` field — using a fake timestamp in `collectOutbound` means LWW would be meaningless. Each of these is now explicitly commented.
  - **New `latestTimestamp(...candidates)` helper.** Replaces 7 copies of the `[a, b, c].filter(Boolean).sort().pop()!` pattern in `collectOutbound` with one named call. Same behavior, named purpose.

  **Domain hygiene:**
  - **Moved `computeLongRunDays` from `apps/web/src/components/SuggestAssistanceForBlock.tsx` → `packages/domain/src/blocks.ts`.** It was a pure derivation living in a React component, untested. Now exported from the domain package and covered by 5 new vitest cases (undefined slots, empty slots, no long-run kinds, weekday match, label fallback, non-long slots).
  - **Split `goal-flags.ts` → `goal-flags.ts` + `profile-directives.ts`.** The 70-LOC section at the bottom of `goal-flags.ts` covered phase × secondary-goal directive strings + Filter serialization — concerns that depend on the four-axis `TrainingProfile` model, not the legacy `GoalFlags` axis. Had its own mid-file `import` statement (code smell). Now lives in `profile-directives.ts`. Back-compat re-exports kept in `goal-flags.ts` so external call sites still work; internal callers (`assistance-prompt.ts`, `training-profile.ts`) updated to import from the new module directly.

  - 753 domain tests pass (5 new for `computeLongRunDays`). Zero behavior change.

### Changed
- **Wendler-calibrated preset numbers + marathon-prep transparency (SW v278).**After re-reading *5/3/1 Forever* end-to-end, two small but meaningful corrections:
  - **`minimal` preset bumped 50 → 75 reps/main-day** (and 150 → 225 accessory-day, 5 → 7 movements). Wendler's lowest published assistance prescription is the 7th-Week Protocol: Push 25 + Pull 25 + Single-Leg/Core 25 = **75 reps per workout**. Our previous `minimal` of 50 sat *below* the book's floor, which contributed to the structural validator collision earlier today (marathon-prep mandates 3 categories × Wendler's 25-rep floor = ≥75 reps, but our `minimal` budget was only 50). With `minimal` at 75, the floor matches the mandates and the validator stops fighting itself. The `volume-recommend` `bucketOf` thresholds were updated in lockstep (75/120/150 → cutoffs at 95 / 135).
  - **Marathon-prep flag prose now flags itself as an app-specific extension.** The `goal-context` prose for `marathon: true` previously read as if it were a 5/3/1 Forever template. It isn't — Wendler doesn't have a marathon template; the calf/hip-stability/hamstring/face-pull combo is *our* interpretation of his general endurance-athlete advice (chapter on Running, p.265+, and his comments on protecting recovery between conditioning and lifting). The prose now says so explicitly: *"app-specific extension — NOT a 5/3/1 Forever template"*. The LLM should now calibrate its claims accordingly and not present these mandates as canonical Wendler.
  - Test budget thresholds in `volume-recommend.test.ts` already pass because they assert preset-relative behavior, not specific numbers. 748 domain tests pass.

### Changed
- **AppliedBanner rationale: readable bullets, collapsed by default (SW v277).** Two coordinatedchanges to the "Why these picks" surface that follows the AI suggester:
  - **System prompt instruction reshaped.** The previous `blockRationale` rule said "lists block-wide signals that affected ALL days (active mandates, volume reductions, vetoes)" which invited the LLM to dump raw audit lines like *"deadlift-family dedup: no additional hinge/deadlift-family assistance on Day 0 beyond single-leg RDL (which is single-leg family, not bilateral hinge family)"* or *"Day 2 budget check: 198 reps-equivalent, well within 300-rep budget"*. The new rule asks for a **short list (3–6) of plain-English explanations the user will read** — focus on **why** the plan looks the way it does (which goals honored, which constraints respected, what trade-offs made). Explicitly tells the LLM to skip mechanical bookkeeping (family-dedup notes, budget check audits, "no additional X on Day Y") and avoid jargon like "preferProven active" / "dropAmrapOverload". Translate to user-readable language. Each bullet ≤ 100 chars. Updated the in-prompt example to match.
  - **UI redesigned.** The rationale used to render as a wall of equal-weight pill bubbles — no hierarchy, no truncation, hard to scan. Now: a "Why these picks" header followed by a clean bulleted list, with only the top 2 entries shown by default and `▸ N more reasons` to expand the rest. Bubbles are gone; sentences belong in lists.
  - Touches only the AppliedBanner rendering; the underlying `status.blockRationale` shape is unchanged so older entries surface correctly under the new presentation too.

### Changed
- **Wendler corrections: Leader/Anchor defaults flipped + cross-week consistency softened + peak allows variation (SW v276).**Three coordinated corrections after re-reading 5/3/1 Forever:

  1. **`defaultAssistanceVolumeForKind` flipped: leader → `standard`, anchor → `high`** (was the reverse). Leader blocks already carry heavy supplemental (BBB 5×10, SSL); stacking `high` assistance on top is over-prescription. Anchor blocks have lighter supplemental (often just FSL or none) and short main work, leaving room for the accessory variety Wendler often pairs with anchor cycles. Existing blocks in your Dexie are unaffected — the default only fires when a block has no explicit `assistanceVolume` yet, so only new blocks pick up the new shape.

  2. **Cross-week context section reframed to "context only".** The previous wording instructed the LLM to "**prefer to reuse the same movements on the same days as other weeks**" and claimed "the canonical Wendler pattern is identical accessories across the weeks of a block". This was wrong. Wendler 5/3/1 Forever (p.86) explicitly endorses variation: *"I don't see any problem in changing the exercises from workout to workout. It is the work that matters."* The cross-week section now frames OTHER weeks' picks as **context only** — the LLM MAY mirror them or MAY pick different movements for the same slot, whichever serves this week better. Family-dedup still applies WITHIN the week being generated.

  3. **`preferProven` directive scoped to taper only.** The `competitionPeaking` flag fires for both peak (15–28d A / 15–21d B) and taper (≤14d). Previously, `preferProven` (bias toward familiar/proven picks, avoid novelty) fired for both. That's right for taper — introducing novelty in the last 2 weeks before a race is genuinely risky — but oversold for peak, where the lifter is still training and variation is fine. With `evaluateGoalsForRules`'s new optional `phase` argument, `preferProven` now fires only when `phase === 'taper'`. The legacy 2-arg call still triggers the combined behavior for back-compat.

  Why these surfaced together: in peak phase, the cross-week "prefer consistency" instruction + the `preferProven` directive + the (now-removed) "bias toward familiar/proven picks" prose all pointed the same direction, producing literally identical picks across weeks. The Wk2 generation that motivated this commit returned exactly the Wk1 picks, with the LLM's rationale citing "preferProven active (peak phase): all picks match Week 1 proven selections for consistency". Three layers of redundant consistency-bias, each individually small, compounded into "Suggest doesn't actually try" behavior. All three layers softened in lockstep.

  - HANDOFF §7.5 rewritten to document the new `defaultAssistanceVolumeForKind` mapping + the phase-aware `goalsToPromptContext` and `evaluateGoalsForRules` signatures.
  - 13 tests updated to reflect flipped defaults; 7 new tests covering peak/taper distinction in `preferProven` and the Wendler-quote cross-week framing; 748 total pass.

### Changed
- **Peak vs taper now treated distinctly (SW v275).** They serve
  different training purposes — peak (race 15–28d for A-priority,
  15–21d for B-priority) is a *sharpening* phase where you're still
  training but with reduced fatigue risk; taper (race ≤14d) is a
  *recovery* phase where you're prepping to perform fresh. The old code
  treated them nearly identically (both demoted volume aggressively),
  which broke multi-mandate goal profiles like marathon-prep.

  Concrete case that surfaced it: an Anchor block Wk2 in peak phase
  collapsed to `minimal` (50 reps/main day) while marathon-prep
  mandated ≥3 slots (prehab + isolation + carry) at Wendler's 25-rep
  per-category floor = ≥75 reps. Structural impossibility → validator
  rejected, fell back to deterministic suggester.

  Two coordinated fixes:

  1. **`effectiveAssistanceVolumeForPhase` peak rule changed.**
     - Peak: `high` → `standard` (demote), `standard` → `standard`
       (no demote), `minimal` → `minimal`.
     - Taper: unchanged (any → `minimal`).
     - The 75-rep mandate floor now fits cleanly inside the
       `standard` budget (120 reps) with room to spare; the
       structural collision disappears.

  2. **`goalsToPromptContext` gains an optional `phase` argument.**
     When supplied, emits a peak-specific line ("sharpening, still
     training, bias toward proven picks, drop AMRAP, volume modestly
     reduced") or a taper-specific line ("recovery, not training,
     maintenance only, prehab + light isolation, do NOT introduce
     novel movements, short 2–3 sets at moderate reps"). The
     2-argument signature is preserved for back-compat with older
     callers (returns the combined wording).

  - `BuildAssistancePromptInput.phase` is now threaded into
    `goalsToPromptContext` automatically — no caller changes needed
    when the suggester provides phase context (which it does via the
    v274 change).
  - 5 new domain tests (peak's new asymmetric rule, peak/taper prose
    distinction, back-compat with phase-less calls); 741 total pass.

### Changed
- **AI suggester user prompt audit + cleanup (SW v274).** Companion pass
  to the v273 system-prompt audit. The user prompt is fully dynamic, so
  drift here is per-section rather than per-string. Four changes:
  - **Resolved a conflicting volume signal.** `goalsToPromptContext` used
    to emit `- deload: reduce volume ~40%` and
    `- competition peaking: ... reduce volume ~25%` as part of the goal-
    context prose. After v272 those percentages contradicted the new
    system-prompt rule "the budget you see is already phase-adjusted, do
    NOT cut volume further" — the structured `Volume multiplier`
    directive is correctly suppressed when phase is auto-derived, but
    the prose was still telling the LLM to cut. Rewrote both lines to
    describe the qualitative shape (drop AMRAP overload, prefer movement
    quality / proven picks, bias toward prehab) and explicitly tell the
    LLM not to cut volume in its picks.
  - **Renamed the free-text-notes label.** "User-supplied
    constraints/context (treat as authoritative)" →
    "User-supplied free-text notes (treat as authoritative)". The system
    prompt's "How to read" section calls the structured filters
    "Filters" and the free-text field "free-text notes"; the prose label
    now matches.
  - **Block kind now surfaced.** The block summary header gains a
    `Block kind: leader/anchor/standalone/seventh-week` line when
    supplied, giving the LLM the macro frame (anchors carry heavier
    intensity / lower volume than leaders).
  - **Phase + preset auto-shift now surfaced.** When the active phase
    is non-normal, the summary emits `Active phase: <phase>`. When the
    assistance-volume preset was auto-shifted upstream (e.g. `standard`
    → `minimal` on a deload week), the budget line gains a suffix:
    `Per-day assistance budget — phase-adjusted: `standard` preset
    auto-shifted to `minimal` …`. This closes the loop on the v272
    "no silent automation" UX rule at the prompt layer: the LLM now
    sees explicitly which shift was applied and matches the chip the
    user sees in the editor.
  - 6 new domain tests covering the new prompt fields; 739 total pass.

### Changed
- **AI suggester system prompt audit + cleanup (SW v273).** The system
  prompt is static (the dynamic per-block data lives in the user prompt),
  but several factual claims had drifted out of sync with the current
  schema. Cleaned up against the post-v272 reality:
  - **Removed the stale "6-week block" framing.** The opening sentence
    used to claim the LLM was suggesting "for the next 6-week block",
    which matched the pre-migration 5+1 = 6-week shape. Modern blocks
    are 3 weeks (Leader/Anchor/Standalone) or 1 week (7th-week). The
    opening now explicitly tells the LLM not to assume a fixed length
    and to read the block's actual shape from the user message.
  - **Removed the stale "4 weeks of a block" reference** in the
    cross-week context section. Now reads "across the weeks of a block".
  - **Replaced the legacy "Goal-context handling" section** with a
    proper "How to read the user's training context" section that names
    the current concepts: Training Profile (primary × secondaries ×
    phase × user-authored Filters), the legacy goal-flag summary kept
    in sync with it, the rule directive summary, and free-text notes.
    Calls out Filters by name (no longer "constraints"), and instructs
    the LLM to quote Filter labels verbatim in rationales.
  - **Aligned the dedup rules with per-week generation.** Sections 5
    and 6 ("no duplicate movements", "movement-family dedup") used to
    say "across the entire block" — which was confusing now that the
    suggester runs per-week. Both now say "within the scope you're
    generating" and explicitly distinguish a single week from the
    block's source plan ("default" scope).
  - **Added phase-budget awareness.** Rule 4 (volume budget) now tells
    the LLM that the budget it sees is already phase-adjusted (deload/
    taper/peak preset shifts happen upstream) and NOT to cut further on
    those phases unless a directive says to. This pairs with the
    `suppressPhaseVolumeMultiplier` change in v272.
  - **Added a 7th-week rule** (new rule 11). 7th-week blocks (deload /
    TM-test / PR-test) are single-week recovery/test cycles with very
    low accessory volume — "do not pad to fill the budget; less is more
    on these weeks". The user prompt's `## Main work this week` section
    for the 7w scope already encodes the variant-specific intent; the
    system prompt now tells the LLM to honor it literally.
  - All 733 domain tests continue to pass. The prompt-test assertions
    (slot vocabulary, JSON example, pair-awareness phrasing) were
    written against stable phrases and survived the rewrite.

### Added
- **Block-derived deload phase + "no silent automation" UX (SW v272).**
  Two structural changes that together close the loop on deload semantics:

  1. **`effectiveTrainingPhase` now sees the active block.** When the active
     block is a 7th-week deload block (`kind: 'seventh-week'`,
     `seventhWeekKind: 'deload'`), the training phase auto-derives to
     `'deload'` at the GoalFlags layer — not just at the visible
     Assistance-volume chip. So the AI suggester, `deriveGoalFlags`, and
     every downstream consumer now see `phase: 'deload'` automatically
     during a 7th-week deload, without the user having to flip the manual
     phase toggle on `/goals`.
     - Precedence (highest first): **manual > race > block > normal**.
       Manual `trainingPhaseManual` still wins; race-driven taper (≤14d)
       and peak (A 15–28d, B 15–21d) still take precedence over the new
       block-derived deload (if you're inside a 7th-week deload block AND
       a race is in the taper window, taper wins).
     - The 2-completed-Leader cadence gate that decides *when* a 7th-week
       deload block gets inserted lives in `nextSeventhWeekRecommendation`
       (unchanged). By the time the block is active, the deload is
       structurally warranted; this change just makes every layer aware of it.
     - New domain API: `effectiveTrainingPhaseInfo(profile, races, now, activeBlock?)`
       returns `{ phase, source: 'manual' | 'race' | 'block' }`. The bare
       `effectiveTrainingPhase` wrapper still exists for back-compat.
       `deriveGoalFlags` now surfaces `phaseSource` on its result.

  2. **"No silent automation" UX — every auto-derive is visible.** A new
     amber `PhaseAutoBadge` is mounted on the block editor header, on
     `/goals`, and in the AI-suggester button row whenever the phase was
     auto-derived (race or block) to a non-normal value. Tapping the badge
     opens `/goals` for override. On first encounter of an auto-derived
     phase you also get a one-time `PhaseAutoToast` banner ("Auto-deload
     active for this block — you're inside a 7th-week deload block …")
     with a "Got it, don't show again" dismissal. Persistence is per
     `(source, phase)` bucket via `localStorage:wendler:phase-auto-toast-seen:v1`,
     so each distinct auto-derivation surfaces exactly once.

  3. **Compound-cut guard.** When phase was auto-derived to non-normal,
     the `volumeMultiplier` directive (×0.6 deload / ×0.75 peak) is now
     suppressed — the assistance-volume preset auto-shift already cuts
     the rep budget, and stacking the multiplier on top double-cut more
     aggressively than intended. The other deload/peak side effects
     (`dropAmrapOverload`, `preferProven`, slot biases) still fire. Manual
     phase overrides keep the multiplier for back-compat with users who
     set the override expecting both signals to apply. Implemented via a
     new `EvaluateGoalsForRulesOptions { suppressPhaseVolumeMultiplier }`
     opt; threaded through `buildAssistancePrompt` and the deterministic
     fallback in `SuggestAssistanceForBlock`.

### Added
- **Phase-aware assistance volume auto-shift (SW v271).**
  The Assistance volume chip in the block editor now visibly auto-shifts
  per week when the visible week falls into a non-normal phase, so you can
  see at a glance that taper/peak/deload are being honored:
  - **deload** → always `minimal`
  - **taper** (race ≤14d out) → always `minimal`
  - **peak** (A-priority 15–28d, B-priority 15–21d) → demote one tier
    (`high`→`standard`, `standard`→`minimal`)
  - **normal** → unchanged
  - Custom (object) volumes are never auto-shifted — explicit numbers win.
  An amber "auto · {phase} → {preset}" badge appears next to the chip when
  a shift is active. Clicking any chip persists block-level (overriding the
  auto-shift across the whole block). The AI suggester uses the same
  effective preset, so what you see is what the LLM gets.
  - New domain helper `effectiveAssistanceVolumeForPhase(stored, phase)`.
  - `BlockAssistanceVolumePanel` now takes an optional `weekScope` prop and
    derives the phase using the same anchor rules as the suggester
    (first-session date in the block, falling back to today).

### Changed
- **Per-week phase anchor now derives from the first session in the block, not block activation (SW v270).**
  Previously, `weekStartDate` calculated Week N from `block.startedAt` (the
  moment you activated the block). That broke for the common case of
  activating a new block a few days before your first actual training day
  — Week 1 would be backdated and the phase auto-derivation could miss
  the real race-proximity window. Now the anchor is the **earliest
  `performedAt` of any session linked to the block**, falling back to
  "today" when no sessions have been logged yet. Re-activating a stale
  block is no longer necessary.
  - `weekStartDate(block, weekScope)` → `weekStartDate(anchor, weeksBeforeDeload, weekScope)`
    with `anchor: Date | string | null | undefined`.
  - Suggester computes `blockFirstSessionDate` from `useAllSessions()` and
    passes it (or `new Date()`) as the anchor.

### Added
- **Per-week phase auto-derivation in AI assistance suggester (SW v269).**
  When generating per-week assistance, the suggester now computes the
  effective training phase **for the calendar week being generated**
  rather than for "right now". This means you can generate Week 1, 2, and
  3 of an anchor block at block start and the LLM will already see
  taper/peak directives on the weeks that land inside the race-proximity
  window — no need to wait, regenerate, or flip the profile phase mid-block.
  - New `weekStartDate(block, weekScope)` helper computes each week's
    calendar start from `block.startedAt` (week 1 = startedAt, week 2 = +7d,
    week 3 = +14d, deload = +weeksBeforeDeload×7d).
  - `effectiveTrainingPhase` now auto-derives from race date proximity:
    A/B race ≤14d out → `'taper'`, A-priority 15–28d → `'peak'`,
    B-priority 15–21d → `'peak'`. Manual `trainingPhaseManual` override
    still wins. Dismissing the peaking banner for a race opts that race
    out of the auto-derivation.
  - When the block hasn't started yet (no `startedAt`), or for the
    `'default'` and `'7w'` scopes, falls back to `now` — preserving the
    pre-existing behavior.
  - Composes cleanly with the previously-shipped per-week main-work
    section: Week 3 of an anchor near a half-marathon now sees BOTH the
    "95% × 1+ AMRAP — be conservative" cue AND the taper-driven
    `volumeMultiplier` (~0.6×).

- **Prehab concentration rule in AI suggester (SW v268).**
  Stops the LLM from sprinkling face pulls / band pull-aparts / scapular
  work / hip-stability bands across every single training day. New rule:
  - Concentrate prehab on the pure-accessory day (2–3 slots there if
    shoulder-health or injury-prevention is active; 0–1 otherwise).
  - Cap prehab on main-lift days at **1 slot per session** maximum, and
    zero when the warmup already covers prehab.
  - Whole-week ceiling: roughly `training-days ÷ 2` prehab slots
    (so a 4-day block lands ≤2 prehab slots in the week unless a goal
    explicitly demands more).
  - When a prehab slot gets dropped from a main-lift day, replace with a
    deficit slot type (push/pull/single-leg/core/isolation/carry per
    pair-awareness) — never another prehab.

- **Per-week main-work context in AI assistance suggester (SW v267).**
  When generating per-week assistance (Week 1/2/3, Deload, or 7th week),
  the LLM now sees the exact main-work prescription for that week —
  computed deterministically from the block's `mainScheme` (and
  `seventhWeekKind` for 7w) — so it can autoregulate accessory volume
  against the systemic load you're actually about to do.
  - The new `## Main work this week` section lists each set as
    `- 65% × 5+ (AMRAP)` and includes a short week-specific cue
    ("standard volume" on Week 1, "moderate" on Week 2, "be conservative
    on accessory volume" on Week 3, "cut accessory volume meaningfully"
    on deload). 7th week renders intent lines for `tm-test`, `pr-test`,
    or `deload` variants.
  - Honors the `5s PRO` (every set 5 reps, no AMRAP on training weeks)
    and `3/5/1` (Week 1 ↔ Week 2 wave swap) variations.
  - Skipped when generating the block source plan (`weekScope === 'default'`)
    because the source plan is meant to apply across all weeks; the
    section only matters for per-week regeneration.

### Fixed
- **Sync no longer resurrects mid-edit deletions of in-document fields.**
  Deleting assistance entries from a block (or any field inside the
  block.plan JSON, which is a mutation rather than a row delete with
  tombstone) could be undone by the next sync cycle: the pull-before-push
  step receives the user's own previously-pushed copy of the block from
  the server, which `applyIncoming` was blindly `put`-ing over the local
  row regardless of timestamps. Rapid sequential deletes made this
  obvious — entries would pop back as the sync timer fired mid-batch.
  - Added a last-write-wins guard to `applyIncoming` for `block`,
    `program`, `goal`, `cardio`, and `race` (mutable records that carry
    `updatedAt`): if the local row has a newer `updatedAt` than the
    incoming doc, the incoming doc is dropped.
  - `set`, `session`, `trainingMax`, and `movement` remain blind `put`s
    — they're effectively append-only and the existing tombstone guard
    already prevents resurrection of deleted rows.
  - Singletons (`settings`, `schedule`, `recovery`, `runPlan`,
    `strengthHr`, `wellness`) already had LWW.

### Changed
- **AI suggester now sees other weeks of the same block as context.**
  Previously, generating assistance for a specific week scope (Week 1,
  Week 2, Week 3, or Deload) only showed the LLM that scope's own
  entries — picks from the default plan or other week-specific overrides
  were invisible. Result: generating Week 2 after Week 1 could pick
  entirely different curl/dip/carry variants on the same training day,
  breaking cross-week consistency.
  - New `otherWeeksContext` field on `BuildAssistancePromptInput`
    carries per-day entries from every OTHER scope in the block
    (`'default' | 1 | 2 | 3 | 'deload'`). Empty scopes are dropped.
  - When non-empty, the prompt emits a new `## Cross-week context (other
    weeks in this same block)` section instructing the LLM to **prefer
    consistency** — reuse the same movements on the same days as other
    weeks unless variation is the explicit goal. The canonical Wendler
    pattern is identical accessories across the 4 weeks, with only
    volume/intensity changing.
  - Framing is "context, not constraints": these entries are NOT
    forbidden. Family-dedup rules (one variant per family per week)
    still apply WITHIN the week being generated, not across them.
  - Wired through `BlockPlanEditor` → `SuggestAssistanceForBlock` → the
    domain prompt builder. When `weekScope === 'default'` the context
    is empty (default IS the source for all weeks).

### Changed (earlier in this Unreleased)
- **Clarified the Filters help text on /goals.**The previous wording
  ("Hard filters — never compete with goals for slot budget. The
  suggester avoids matching movements outright.") was technically
  accurate but easy to misread: a label like "injury prevention" was
  silently interpreted as "exclude injury-prevention movements" — the
  opposite of what most people expect from that phrase. New text:
  *"Things to **avoid**. Each filter is a hard exclusion the suggester
  must respect — phrase it as something you do NOT want (e.g. 'no
  machines', 'no overhead pressing', 'left hip flexor flare-up').
  Goal-shaped labels like 'injury prevention' or 'strength' will be
  read as 'exclude these movements' — usually the opposite of what
  you mean."*

### Changed (earlier in this Unreleased)
- **Renamed "Tier 1/2/3" labels to Primary / Secondary / Filters.**The
  numeric "Tier" terminology was misleading because it suggested a
  one-dimensional priority ordering, but the three layers actually live
  on two axes: direction-setting (Primary > Secondary > Filters) and
  enforcement strength (Filters > Primary ≈ Secondary). Filters are the
  *hardest* layer (the LLM never violates one) but the *least*
  directional (they exclude movements rather than shape selection).
  - UI: the constraints section header on `/goals` is now **"Filters"**.
  - LLM prompt: the section header is now `## Filters (hard constraints
    — never violate)`. The Primary / Secondary descriptions in the
    "Training profile" section dropped the parenthetical "(Tier N, …)"
    qualifiers — the role names alone carry the meaning.
  - Doc comments + types updated throughout (`training-profile-types.ts`,
    `training-profile.ts`, `goal-flags.ts`, `assistance-prompt.ts`,
    `TrainingGoalsSection.tsx`).
  - No data migration required — the underlying types/persistence are
    unchanged; only the labels people read changed.

### Changed (earlier in this Unreleased)
- **LLM may propose novel movements (auto-added to the library on accept).**
  Previously the assistance suggester was strictly limited to picking
  `movementId`s from the seeded/custom library — directives like
  "include a Pallof iso-hold" silently failed when the exact movement
  wasn't seeded. Now each suggestion entry may carry **either**
  `movementId` (preferred when a clearly good library match exists)
  **or** `newMovement: { name, equipment, pattern, primaryMuscles,
  secondaryMuscles?, isBodyweight? }`.
  - On accept, novel movements are inserted into the Dexie movement
    library **before** the block entry is written, so the new movement
    gets a real `movementId` and e1RM history starts from the very
    first set — identical to seeded movements.
  - Case-insensitive name dedup against the existing library and within
    the same suggestion batch — no orphan duplicates.
  - Equipment validation stays in code (validator): `newMovement.equipment`
    must be in the user's available equipment list (bodyweight always
    allowed). Server-side validator + client both enforce this.
  - The applied banner surfaces a "✨ Added N new movement(s) to your
    library: …" line when novel additions happen.
  - System prompt biases the LLM toward library matches and instructs
    it to only propose new movements when no existing entry plausibly
    fits the directive.

### Changed (earlier in this Unreleased)
- **Sharpened `real-life-strength` vs `functional-movement` differentiation.**
  Previously both secondaries touched loaded carries and `functional-movement`
  also told the LLM to "reduce heavy bilateral barbell work" — which fights
  the 5/3/1 main lifts. Now responsibilities are disjoint:
  - `real-life-strength` exclusively owns loaded carries (farmer, suitcase,
    sled, sandbag, yoke) and mandates one carry slot per week.
  - `functional-movement` exclusively owns single-leg + anti-rotation
    accessories (split squat, lunge, step-up, single-leg RDL, Pallof press,
    bird-dog, dead-bug) plus optional low-amplitude jumps/throws when load
    budget allows. It no longer touches carries and no longer suppresses
    bilateral barbell volume.
  - Deload/taper "light" cell for `functional-movement` updated to match:
    single-leg + anti-rotation only, ≤2 sets, no AMRAP, no carries/jumps/plyos.
  - `/goals` chip help text updated to reflect the new ownership split so
    pairing both is now a coverage decision rather than a redundancy.

### Constraints (still in [Unreleased])

- **Constraints behave like a saved library now.** Adding a custom
  constraint persists it as a chip in the constraints row. Click the chip
  to toggle active/inactive — only active chips are serialized into the
  assistance prompt. The × button permanently deletes a chip from the
  library; the ✎ icon enters rename mode. This matches the prior built-in
  picker's "available but not selected" behavior, but for your own
  user-authored vocabulary. `Constraint.active` defaults to `true` when
  missing, so every previously saved chip stays active by default.
- **Removed the entire built-in constraint vocabulary.** No more
  `injury-prevention`, `no-running`, `no-weight-vest`, `trap-muscle-issue`,
  `pubic-pain`, or `single-shoulder-issue` chips in the picker. Every
  constraint is now user-authored via the "+ Custom" free-text input — full
  control over which suggestions appear in the prompt. The `Constraint.kind`
  field is collapsed to the literal `'custom'`, and `ConstraintKind`,
  `defaultConstraintLabel`, `builtInConstraint`, and the
  `CONSTRAINT_INJURY_PREVENTION_PEAK_EMPHASIS` peak-phase prompt addendum
  are all deleted. Phase-specific prompt nudges belong in your free-text
  Notes from now on. `normalizeTrainingProfile()` rewrites any persisted
  non-`custom` constraint to `kind: 'custom'` while preserving the
  user-visible label, so existing entries survive as plain text.
- **Renamed the `trap-bar-issue` constraint to `trap-muscle-issue` ("Trap
  (trapezius) issue").** The original kind label was an unfortunate author
  mix-up — it was always meant to refer to the trapezius muscle (the user's
  actual flare-up area), not the hex/trap bar. `normalizeTrainingProfile()`
  silently remaps any stored `trap-bar-issue` constraint entries on next
  hydrate, preserving the constraint id so React keys stay stable.
- **Retired the `no-machines` constraint as fully redundant with
  `Program.availableEquipment`.** Equipment availability already drives both
  the movement-library filter and the explicit `- Available equipment: …`
  line in the assistance prompt — to disable machine-based suggestions, untick
  `machine` in Program defaults (or the per-block override) instead. Stale
  `no-machines` entries are silently dropped from stored profiles by
  `normalizeTrainingProfile()` on next hydrate.
- **Constraints UI: every active constraint (built-in or custom) now has an
  explicit × delete button and click-to-rename**, not just custom ones. The
  picker chip row now only shows un-added built-ins (prefixed `+`) so the
  active set and the available-to-add set are visually distinct. Previously,
  built-in chips only supported click-toggle with no visible delete affordance,
  which made removal non-obvious.

- **`injury-prevention` reclassified from Tier 2 (secondary goal) to Tier 3
  (constraint).** Per the agreed taxonomy — Tier 3 is "always-on prehab,
  injury, or equipment flags that filter rather than drive selection" — and
  prehab fits that definition far better than the Tier-2 phase-driven
  emphasis it was getting. Behaviour-preserving:
  - Existing profiles with `'injury-prevention'` in `secondaryGoals` are
    transparently normalized on first hydrate via the new
    `normalizeTrainingProfile()` helper: the value is stripped from
    `secondaryGoals` and added as an `injury-prevention` constraint instead.
    The migrated profile is persisted silently — one-shot.
  - The legacy "promoted in peak" matrix cell is gone, but the prompt
    behaviour is preserved: when peak phase is active and an
    `injury-prevention` constraint is set, the prompt builder appends the
    same "include at least one prehab movement per session" emphasis
    string (now exported as `CONSTRAINT_INJURY_PREVENTION_PEAK_EMPHASIS`).
  - The compatibility matrix and `phaseDirectiveString()` no longer carry
    the injury-prevention column — the matrix is now 3-wide instead of 4.
- **Constraints are now serialized into the assistance LLM prompt.**
  Previously they were edited on `/goals` but never reached the suggester;
  only `goalNotes` did. The prompt builder now emits a
  `## Constraints (Tier 3, hard filters)` section right after the training
  profile section with the constraint labels, plus the peak-phase prehab
  addendum when applicable. Closes the "constraints had no effect" gap
  this refactor exposed.

### Added
- **Rename custom constraints inline.** Click a custom constraint chip to
  edit the label in place; Enter / blur saves, Escape cancels. Built-in
  constraints (no machines, trap bar issue, …) keep the toggle behaviour
  unchanged. The × button on custom chips already handles deletion.

### Internal
- Service-worker cache bumped to `wendler-shell-v257`.

### Added
- **Sticky auto-suggested primary goal indicator on /goals.** When the
  Training Profile is auto-set from an active A/B race (existing migration
  behaviour), the originating race is now surfaced as a persistent
  `Auto · {race name} · {N}d` badge on the matching primary tile and
  remains visible after the user picks a different primary — the badge
  just gains an `· overridden` suffix and a subtle accent border so it
  stays discoverable instead of vanishing the moment you click away.

### Changed
- **Removed the muscle-volume heatmap from the block detail page.** The
  `BodyMap` and surrounding "Muscle volume during this block" section
  are gone from `/program/block`; muscle visualisation lives only on
  `/analytics` now (where `MuscleHeatmapCard` continues to use it). The
  `muscleVolume` import, `blockSets`/`muscles` memos and unused
  `blockSessionIds` were dropped from the block page along with it.

### Internal
- Service-worker cache bumped to `wendler-shell-v256`.

### Added
- **Four-axis Training Profile on /goals (Phase 3 of 3).** The legacy flat
  `Training goals` checkbox grid is replaced with a structured editor over
  `settings.trainingProfile`:
  - **Primary goal** (exactly one of marathon-prep / strength / hypertrophy
    / balanced) — drives the headline assistance bias.
  - **Secondary goals** (≤ 2 of real-life-strength / functional-movement /
    isolation-emphasis / injury-prevention), each tagged with its
    phase-driven effect ("Suppressed in deload", "Light in taper",
    "Priority in peak"). Compatibility warnings surface when a secondary
    is "expensive" or "redundant" against the primary (e.g. isolation
    emphasis under a hypertrophy primary).
  - **Training phase** (normal / deload / taper / peak) — auto-managed
    from the race calendar, with the auto-derived value labelled inline
    and a one-tap manual override + "back to auto" button.
  - **Constraints** — hard filters (no machines, no running, trap-bar
    issue, single-shoulder issue, …) plus free-form custom entries.
    Hard filters never compete with goals for slot budget; the suggester
    avoids matching movements outright.
  - Free-text **Notes** are retained for nuance the LLM should read but
    not enforce, persisted to `settings.goalNotes` as before.
  Existing users are auto-migrated on first visit to /goals via
  `migrateLegacyToTrainingProfile`, with a dismissible banner explaining
  the auto-set primary goal — or a "confirm your primary" prompt when
  the legacy state was inconclusive.

### Changed
- **Service-worker cache bumped to v255** to evict stale assets after
  the /goals UI follow-up (vestigial-flavor deprecation hint, request-
  new-secondary CTA, prompt-string colocation). Bumped from v254 in
  the Phase 3 ship.
- **Phase × Tier-2 directive strings colocated in `goal-flags.ts`.** The
  two non-active prompt strings (functional-movement → "light" in
  deload/taper, injury-prevention → "priority" in peak) now live next
  to `goalsToPromptContext` as named constants
  (`PHASE_DIRECTIVE_FUNCTIONAL_MOVEMENT_LIGHT`,
  `PHASE_DIRECTIVE_INJURY_PREVENTION_PRIORITY`) plus a thin
  `phaseDirectiveString(secondary, phase)` lookup. The matrix-aware
  `phaseDirective` shim in `training-profile.ts` delegates to it, so
  prompt-language tuning happens in one file while the structural
  matrix stays where derivation lives.
- **Per-goal "Training emphasis" tags marked vestigial.** The legacy
  flavor pills on the per-goal create form (strength / hypertrophy /
  functional / conditioning / prehab) now show a one-release migration
  hint explaining that this signal moved to the Training Profile
  section and isn't read by the suggester anymore. Existing tags stay
  visible so users can review, but new goals don't need them.
- **"Request a new secondary goal" CTA on the Training Profile.** The
  v1 Tier-2 vocabulary is fixed at four; instead of letting users
  type free-text secondaries that the suggester can't reason about,
  the UI now links to a prefilled GitHub issue so real demand for v2
  vocabulary lands in a tracked channel.

### Added
- **Movement-family awareness for the AI assistance suggester.** A new
  `packages/domain/src/movement-families.ts` module provides regex-based
  family detection (deadlift / squat / muscle-up / olympic / single-leg)
  plus predicates for high-skill gymnastics, calf raises, bicep/tricep
  isolation, rear-delt prehab, pressing, metabolic conditioning hybrids,
  and fatiguing posterior-chain work. Single-leg movements are intentionally
  treated as their own family (never folded into deadlift), so the AI is
  required to include both bilateral hinging and dedicated unilateral work
  rather than substituting one for the other.

### Changed
- **Cross-day duplicate detection in the prompt and validator.** The
  system prompt now explicitly forbids the same movement family appearing
  twice in a week (e.g. bar muscle-up Monday + ring muscle-up Friday), with
  an explicit single-leg carve-out where multiple unilateral variants are
  expected. The validator emits a warning when this rule is broken so the
  banner surfaces it alongside other issues. A separate check warns when
  an assistance entry conflicts with a scheduled main lift family.
- **High-skill rep ceiling.** The prompt instructs the LLM to keep
  ring/bar muscle-ups, pistol squats, handstand push-ups and similar
  high-skill gymnastics work to 3–6 working reps per set. The validator
  warns when any high-skill movement is prescribed above 6 working reps.
- **Broadened pre-long-run veto.** The prompt's pre-long-run guidance
  now enumerates all fatiguing posterior-chain and metabolic-conditioning
  movements that are inappropriate before a long run — bilateral
  deadlifts at any reps, single-leg RDL ≥10 reps, KB swings, devil press,
  thrusters, burpees, snatches, cleans, wall balls, man-makers and sled
  pushes. The deterministic fallback engine's `isHeavyLower` mirrors
  this so both code paths apply the same constraint.
- **Marathon goal now mandates calf work explicitly.** The prompt
  context for the marathon goal flag now spells out "MUST include at
  least one calf raise variant" rather than relying on the LLM to infer
  it from the broader running-prep block. The validator warns when the
  marathon flag is set but no calf raise appears in the week.
- **Big arms goal now mandates both bicep and tricep isolation.** The
  prompt and validator both require at least one direct bicep curl
  variant AND at least one direct tricep isolation movement when the
  flag is on. Compound pulling (chin-ups, muscle-ups) and pressing (dips,
  close-grip bench) no longer satisfy the requirement on their own.
- **Press-balance check.** When a week contains 3 or more pressing
  variants and no rear-delt or external-rotation prehab work (face pulls,
  band pull-aparts, etc.), the validator emits a warning so the AI's
  shoulder-health gap surfaces in the banner.

### Fixed
- **Block-level rationale stays on screen until you dismiss it.** The
  applied banner (with the ✨ rationale chips explaining why each lift was
  picked) used to auto-disappear after the 10-second undo window expired,
  often before there was time to read it. The undo button still expires
  on its 10-second timer, but the banner and rationale now persist until
  you click the ✕ or generate again.
- **Goal flavors no longer over-counted across overlapping goals.**The
  assistance suggester and volume recommender previously summed each
  flavor once per goal that carried it — so 3 separate Strength PR goals
  (each defaulting to `['strength']`) would multiply the strength signal
  by 3, dragging the volume recommendation toward the floor and biasing
  slot weights. Both consumers now dedup `activeGoalFlavors` across goals
  into a single bucket so each unique flavor contributes at most once,
  reflecting the real user intent (multiple PRs are one strategic
  emphasis, not N independent strength goals). `goalMixDelta`'s threshold
  is correspondingly lowered from ±3 to ±2 to match the new max range.
- **Goal cards now show all active emphasis tags.** The collapsed goal
  card previously hid emphasis pills when the goal still used its kind
  defaults — so e.g. a Strength PR card showed only the auto Conditioning
  tag, not the Strength tag itself. All effective flavors now render as
  pills, with auto-applied tags clearly distinguished by their dashed
  amber border.

### Added
- **Race-driven taper actions panel.** The `<TaperBanner expanded />` on
  `/load` (and the compact dashboard variant) now shows a per-race list of
  *proposed* taper actions with explicit Accept / Dismiss buttons:
  - **Insert deload block now** — at the deload-prompt phase (A: 14–21d,
    B: 10–14d). Wraps the existing `insertSeventhWeekBlock` and records the
    inserted block id on the race.
  - **Activate "Competition peaking" goal flag** — at deload-prompt or
    maintenance phase. Tells the assistance suggester to bias toward proven
    movements and reduce volume, *without* writing to `settings.goalFlags`
    directly. The new `computeEffectiveGoalFlags(manual, races, now)` ORs
    race-driven activations with the manual checkbox at read time, so once
    the race date passes the activation simply stops contributing — no
    cleanup write needed.
  - **Per-race state**: each accept or dismiss is sticky and stored on
    `Race.taperActions` (`{ insertedDeload?, competitionPeakingActivated? }`),
    last-write-wins synced. Dismissed actions don't reappear; accepted
    actions disappear once the work is done.
  - **Why-am-I-seeing-this** explainer line under each action panel
    surfaces the race name, days-out, priority, and what changes once
    accepted.
  - **Auto badge on Training Goals**: when `competitionPeaking` is
    race-driven, the row in `<TrainingGoalsSection />` now shows a small
    `Auto · on (Race, 12d)` chip so the user can tell at a glance that the
    flag is active because of a race, not a manual click.
- **Domain helpers** in `@wendler/domain`:
  - `proposedTaperActions(race, now): ProposedTaperAction[]`
  - `proposedTaperActionsByRace(races, now)`
  - `computeEffectiveGoalFlags(manual, races, now)` returning
    `{ effective, autoSources }`
- **Action handlers** in `apps/web/src/lib/raceTaperActions.ts`
  (`acceptAction`, `dismissAction`).

### Changed
- **`Mobility focus` → `Functional movement`.** Display label and help
  text on the Training Goals section. The flag KEY in storage stays
  `mobilityFocus` so no migration is needed.
- **Suggester reads effective goal flags.** `<SuggestAssistanceForBlock />`
  now calls `computeEffectiveGoalFlags(settings.goalFlags, upcomingRaces)`
  before passing flags to `buildAssistancePrompt` / `evaluateGoalsForRules`,
  so race-driven peaking flows through automatically.
- **`<TaperBanner />` action wiring.** The inline `Insert deload now`
  button is replaced by the new `<TaperActionsPanel />` (no behavior loss
  — the same `insertSeventhWeekBlock` flow is now invoked through the
  panel's Accept handler, which also persists the per-race state).

### Schema
- `Race.taperActions?: { insertedDeload?, competitionPeakingActivated? }`
  added to `packages/db-schema/src/types.ts` (and structurally to
  `RaceLike` in `@wendler/domain`). Optional and additive — no migration.

### Added
- **AI-powered block-level assistance suggester.** A new `Suggest assistance`
  panel on the block editor calls Claude (Sonnet 4.6, 8k tokens, temp 0.3)
  to fill in the assistance slots for every training day in the block at
  once, with per-entry rationales (≤120 chars). The deterministic engine
  (`assistance-suggest.ts`) remains the fallback when the LLM is
  unavailable, returns invalid output, or `validateBlock` rejects the
  result.
  - **Backend**: `POST /api/suggestAssistance` (Azure Function, requires
    `ANTHROPIC_API_KEY` SWA setting). Server is a thin proxy: client
    builds the prompt with `buildAssistancePrompt` from `@wendler/domain`
    and ships the movement-id whitelist alongside, so the API never
    needs Dexie access. Schema-validation failures return `200
    { ok:false, errors }` so the client can decide whether to surface,
    retry, or fall back.
  - **Prompt builder** (`@wendler/domain`): pulls user goal flags
    (`goalsToPromptContext`), free-form goal notes, active flavor
    coverage, available equipment, and pre-long-run day indices
    (`computeLongRunDays(days, runPlan?.slots)`) into a single system +
    user prompt.
  - **Validator** (`validateBlock`): rejects rep totals outside the per-
    slot envelope, missing rationales, rationales > 120 chars, unknown
    movement ids, and out-of-range day indices. Drives the corrective-
    fallback path.
  - **Prompt preview**: a copyable preview of the exact system + user
    prompts is rendered under the Suggest panel for inspection /
    debugging.
- **Goal-flag rule directives.** A new `goalFlags` block on User Settings
  (Training goals + free-form notes) drives both the deterministic
  engine (via `evaluateGoalsForRules`) and the LLM prompt (via
  `goalsToPromptContext`). Marathon, hypertrophy, aesthetics, longevity,
  and pain-flag rules each map to specific assistance preferences.
- **Marathon-aware assistance constraints.** When the user has a long-run
  slot in their recurring run plan (Saturday or any other day), the LLM
  prompt now emits a *Pre-long-run guidance* line for the day before
  each long run. **As of SW v246 this fires automatically whenever a
  long run is on the calendar — the marathon goal flag is no longer
  required to opt in.** A scheduled long run is itself sufficient
  signal; the marathon flag now only governs additional behaviors
  (mandatory hip-stability/calf/hamstring slots, quad downweighting).
  The current language (commit `de7b784`, SW v245) is softer than a
  hard `FORBIDDEN` veto — it says "strongly prefer to avoid",
  enumerates specific movements (BSS, walking/reverse lunges, step-ups,
  pistol squats, heavy hip thrusts) instead of abstract "squat-pattern"
  categories, and lists preferred hip-stability prehab substitutes
  (clamshells, banded lateral walks, hip abductions, bodyweight glute
  bridges). An explicit escape hatch (≤2 light sets, must justify in
  rationale) lets Claude override when it has a real reason.
- **Press-day pair-awareness.** System prompt rule #3 now splits bench
  and press into separate bullets and explicitly prefers triceps work
  (dips, skull crushers, close-grip) over more vertical pressing on a
  press day, with the general principle: avoid duplicating the main
  lift's primary mover even when the implement differs (commit
  `0d06bd3`, SW v244).

### Changed
- **Training-goal flags moved from /settings to /goals (SW v247).** All
  goal configuration now lives in one place. The "Training goals"
  section (Marathon prep / Real-life strength / Big arms / Deload /
  Competition peaking / Mobility focus checkboxes + free-form notes)
  was previously on the Settings page, which split goal config across
  two screens. The component is now `TrainingGoalsSection` mounted on
  /goals above the goal list. Storage shape is unchanged
  (`settings.goalFlags` / `settings.goalNotes`), so no data migration
  is needed.
- **Rationale chip wrapping.** Per-entry rationale chips on the block
  editor switched from `inline-flex` to `inline-block` +
  `whitespace-normal break-words max-w-full leading-snug`, so the
  ≤120-char rationales returned by the LLM wrap onto multiple lines
  instead of getting clipped by parent overflow.
- **`strengthHr` is now cloud-synced.**Strava-imported HR enrichment for
  in-app strength sessions is now part of the regular sync engine
  (last-write-wins on `updatedAt`), so a Strava sync run on the desktop
  propagates the imported HR rows to the mobile PWA on its next pull.
  Previously the table was local-only — each device would have to run its
  own Strava sync, which meant fresh installs (and mobile after the v177
  release) showed no imported strength workouts even on the same SHA.
  SW cache bumped to `v178`.

- **Quick-jump palette polish.**
  - Desktop nav: replaced the "Jump ⌘K" pill with a plain magnifying-glass
    icon button (matches the mobile header). Hover/title still surfaces the
    `Ctrl/Cmd-K` shortcut.
  - Replaced the static `esc` keycap inside the palette with a proper
    clickable **×** close button — clicking it now closes the palette
    instead of silently doing nothing.
  - Session results now route to the **day view** (`/day?blockId&week&day`)
    when the session belongs to a planned block, so picking e.g. a
    "Deadlift" session lands on the page that shows every set logged that
    day. Standalone sessions still fall back to `/session?id=…`.
  - SW cache bumped to `v177`.
  - Dates in palette results now follow the Finnish `d.M.yyyy` format
    (matching `fmtDate` used elsewhere) instead of ISO `YYYY-MM-DD`.
    Both formats remain searchable.

### Added
- **Quick-jump palette (Cmd-K).** A keyboard-first command palette that
  searches across pages, movements, blocks, races, goals, and the last 30
  sessions in one place.
  - **Open** with `Cmd-K` / `Ctrl-K` on desktop, the 🔍 button on the
    mobile header, or the new "Jump" button on the desktop nav.
  - **Fuzzy match** with a tiny in-house scorer (no new dependency):
    exact &gt; prefix &gt; word-initials (`cp` → "Cardio plan") &gt; substring
    &gt; gap-penalised subsequence. Covered by 22 unit tests.
  - **Synonyms**: `log` / `past sessions` &rarr; History, `stats` /
    `charts` &rarr; Analytics, `ohp` &rarr; Press, `banister` &rarr; Load,
    etc.
  - **Recency-aware**: active blocks and upcoming A-races float up on
    ties; the empty state shows the 5 most-recently-visited pages from
    `localStorage` (capped at 20).
  - **Keyboard**: ↑/↓ navigate, ↵ open, esc close. Mouse/touch fully
    supported. Each result row carries a type chip
    (Page / Movement / Block / Race / Goal / Session) so what you're
    picking is never ambiguous.
  - **No data destruction**: enter only navigates, never writes or
    deletes.
- **First-run onboarding wizard.** Opens automatically on a fresh install
  (no `schedule.singleton` and no blocks) and walks through three steps:
  1. **Training maxes** — kg/lb input for squat/bench/deadlift/press, with
     inline validation and unit conversion. Skippable.
  2. **Schedule** — pick 4-day (S/B/D/P) or 3-day rolling pairs. Writes
     `schedule.singleton` immediately so partial progress is never lost.
  3. **First race (optional)** — date, distance, A/B/C priority, or skip.
  - Each step **persists immediately** to Dexie + `localStorage`, so a
    user who closes the app mid-flow resumes exactly where they left off.
  - The final "You're ready" step routes to `/program/new` to use the
    canonical block-creation flow rather than re-implementing it. The
    button is disabled with a hint if TMs were skipped.
  - **ESC defers** (re-fires next visit) rather than cancelling permanently.
  - **`?onboarding=1`** URL flag re-opens the wizard for testing without
    wiping data.
  - Pure decision logic (`shouldOpenOnboarding`, `nextOnboardingStep`,
    `parseTrainingMaxInput`) lives in `@wendler/domain` and is covered
    by 15 unit tests.
- **Backup &amp; restore (Settings).** A new section on the Settings page
  exports every backup-eligible Dexie table — movements, training maxes,
  settings, sets, sessions, blocks, programs, schedule, goals, cardio,
  recovery, tombstones, runPlan, races — into a single deterministic JSON
  file named `wendler-backup-YYYY-MM-DD.json`. Two re-exports of the same
  state are byte-identical, which means the file diffs cleanly in git or
  any text comparison tool.
  - **Optional notes redaction** on export replaces all free-text note
    fields with `[redacted]` for safer sharing.
  - **Two import modes**: **Merge** keeps local rows that have a newer
    `updatedAt` and only pulls in newer/missing rows from the file (with
    a per-row conflict report); **Replace** wipes local data first and
    loads the file verbatim, gated behind an explicit confirmation
    checkbox.
  - **Schema-version aware**: the file embeds the current `SCHEMA_VERSION`
    and refuses to import a file from a *newer* app build. Older files
    will eventually run through a per-version migration map (currently
    empty — v12 is the first schema with the backup format). A vitest
    guard test fails the build if a `SCHEMA_VERSION` bump ships without
    a migration entry.
  - Excluded by design: device-local sync cursors, push-subscription
    endpoints, and the Strava-derived HR cache. Tombstones *are* included
    so the sync engine still propagates deletes after a restore.
  - 27 new unit tests cover deterministic serialisation, validation,
    migration, merge resolution, redaction, and round-trip equivalence.

### Added
- **Race calendar (v1).** New `Race` entity and `/races` page so a season can
  hold more than a single race-time goal:
  - **Priority A/B/C semantics** drive the taper, anchored to real-world
    distance-running protocols (Hal Higdon, Pfitzinger, Bosquet meta-analysis):
    - **A · marathon-style** — at 14–21 days out the banner prompts a deload
      insertion; 5–14 days out switches to maintenance (light/familiar lifts,
      no AMRAPs); ≤5 days = no lifting, mobility only.
    - **B · half-marathon-style** — deload prompt at 10–14 days out, light
      maintenance through 5 days, then no lifting.
    - **C · calendar only** — visibility, no taper.
  - **TaperBanner now offers a one-tap "Insert deload now" CTA** when a
    race-driven deload prompt is active. Reuses the existing 5/3/1 7th-week
    deload flow but overrides cadence — slots in regardless of where you are
    in Leader/Anchor.
  - Inline **"why" reason text** on the banner and on each upcoming race row
    (e.g. *"Marathon in 17 days. Insert a deload now so the final 2 weeks
    land in light/maintenance mode…"*). No academic citations; just the
    rationale.
  - `/races` lists upcoming and past races with priority pill, distance,
    target time, days-out, and per-row taper hint. Result modal captures
    finish time, place, and notes after the race date.
  - Reachable from the **More** menu and from a small caption on `/goals`
    when the race-time kind is selected.
  - Existing race-time Goals continue to work as the fallback path when no
    `Race` rows exist, so installs without races configured see no change.
  - Backed by a new `@wendler/domain/races` module + extended
    `taperRecommendation` / `nextRaceWindow` (10 + 27 new unit tests).

### Changed
- Goals editor shows a "Logging a real race? Use the Races page →" hint when
  the race-time kind is selected.

### Added
- **Goals are now wired into the rest of the app (v1).** The `/goals` page
  was previously a notepad — these changes make it the source-of-truth surface
  the app's own README promised:
  - **New "Focus" goal kind** for qualitative goals that don't map to a hard
    number (e.g. "Improved aesthetics"). Optional **strength-trend signal**
    on a Focus goal renders an 8-week sparkline + delta% of your average
    main-lift e1RM — perfect for "Get stronger" without committing to a
    specific 1RM target.
  - **Today → "Goals" card** below Recent activity. Up to 4 active goals
    with progress bars (hard goals) or Focus tag + sparkline (qualitative).
    Empty state links to `/goals`.
  - **Analytics → "Goals" card** above the strength/cardio cards, expanded
    layout with numeric progress and weeks-to-deadline.
  - Race-time goals already drive `TaperBanner`; this release adds the
    visibility layer for everything else (strength PR, habit, focus).
  - Backed by a new `@wendler/domain/goals` module: `evaluateStrengthPrGoal`,
    `evaluateHabitGoal`, `evaluateRaceGoal`, `evaluateStrengthTrend`, and
    a uniform `summarizeGoal` consumed by both Today and Analytics. 15 new
    unit tests.

### Changed
- **Goals editor** — `/goals` now splits the active list into "Active"
  (hard goals) and "Focus" (qualitative). The new-goal picker hides the
  target/unit/deadline inputs when "Focus" is selected and surfaces a
  Progress signal toggle (None / Strength trend) instead.

### Changed
- **This week widget shows scheduled workouts only.** The Mon–Sun strip
  now lights up only for items that are part of the user's plan:
  - "S" — a logged Wendler workout (no longer lit by imported Strava
    strength HR, which would widen the strip with off-program activity);
  - "C" — a cardio session whose weekday matches a configured RunPlan
    slot. Ad-hoc cardio (extra recovery walks etc.) no longer pushes
    the layout.
  Done-count and planned-glyphs follow the same rule. Imported strength
  is still surfaced everywhere else (Today, History, Calendar, Load).
- **Imported strength rows are no longer clickable.**They previously
  linked to `/settings` (the only place that listed them), which felt
  like a dead-end bounce. They now render as static, slightly muted
  violet tiles (darker bg, lower opacity, no hover ring) so the
  non-interactive nature is visually obvious. Same on the Calendar
  imported pill.
- **Imported strength HR no longer double-counts a Wendler workout.**
  When a Strava strength activity (gymnastics, CrossFit, etc.) lines up
  with a logged Wendler session on the same calendar day, the duration
  and avg HR fold into that day's existing strength entry instead of
  rendering as a separate "Imported" line item:
  - **Today → Recent activity** and **History**: the matching Wendler
    row gains a "📈 Strava · NN min · XXX bpm" sub-line; no second
    Imported row.
  - **Calendar**: the imported pill is suppressed on days that already
    have a Wendler chip; the Strava enrichment is appended to the chip's
    tooltip ("… · Strava 52 min · 138 bpm"). Orphan days (e.g. Wednesday
    gymnastics) still show the standalone violet imported pill.
  Backed by a new `partitionStrengthHr()` helper in `@wendler/domain`
  with tests, splitting HR rows into matched-by-day vs. orphans.

### Added
- **Imported strength HR is now visible everywhere strength &amp; cardio
  are.** Off-app strength sessions pulled from Strava (gymnastics,
  CrossFit, weight training, HIIT — anything Garmin pushes through as a
  strength activity) now show up on:
  - **Today → Recent activity** as a violet "Imported · &lt;sport&gt;" row
    with duration and avg HR;
  - **History** as the same row, interleaved with Wendler workouts and
    cardio in chronological order;
  - **Calendar** as a violet pill in the day cell ("🏋️ Weight training ·
    52 min"), with a new "Imported strength" entry in the legend and an
    "imported" count in the month-summary line;
  - **This week** widget — the violet "S" glyph now lights up on days
    that had an imported strength session, even with no Wendler workout.
  Same accent &amp; color as Wendler strength so the visual story stays
  unified, with a small "Imported" tag and the sport name to
  differentiate. Backed by a new `importedStrengthLabel()` helper in
  `@wendler/domain` (with tests).
- **Settings → Strava: "Imported strength HR with no matching Wendler
  workout"** lists up to 5 most-recent orphan strength HR enrichments
  (e.g. a Wednesday gymnastics session logged on Garmin with no Wendler
  workout that day). They still contribute to the weekly load score and
  Banister daily series — this is just visibility so the user knows the
  enrichment was picked up.
- **Plate calculator: "Prefer max plate" cap.**New Settings option
  (Equipment → Prefer max plate) lets users tell the calculator to avoid
  rare plates (e.g. 25 kg) when picking a loadout. Works as a two-pass
  algorithm: first try without plates above the cap, fall back to the full
  inventory only if a target weight isn't otherwise achievable. Default is
  Auto (current behaviour). Options: 20 / 15 / 10 kg max.
- **Strava strength HR enrichment.** Strava activities classified as
  strength training (`WeightTraining`, `Crossfit`, `Workout`,
  `HighIntensityIntervalTraining`) — typically Garmin-pushed lifting
  workouts — are no longer skipped wholesale. Their HR streams are pulled
  in as enrichment-only and stored in a new local `strengthHr` table
  (Dexie v11, not synced). The HR-zone time is folded into the weekly
  load score (capped at 10 points) and into the Banister daily series so
  heavy lifting weeks register their true cardiovascular cost. Crucially,
  these activities are NOT imported as cardio — `cardioMinutes`, the
  cardio-volume chart, and the polarized 80/10/10 distribution stay
  cardio-only. New Settings toggle (Strava → Enrich strength sessions
  with HR data) defaults on; off suppresses the extra HR stream fetches.
- **Wake-lock reliability on iOS PWA.** "Keep screen on" now re-acquires
  the lock on `pageshow` and `focus` events in addition to
  `visibilitychange` (per WebKit bug 254545, the API works on iOS 18+
  home-screen apps but needs more re-acquire triggers after notifications
  or BFCache resume).
- **Polarized split summary on the `/analytics` "Time in HR zones" card.**
  A new section above the existing 5-zone breakdown rolls Z1+Z2 / Z3 /
  Z4+Z5 into Easy / Grey / Hard buckets, shows them as a 3-segment
  stacked bar with target reference (80 / &lt;10 / 10–25), grades each
  bucket with ↓ / ✓ / ↑ status arrows, and prints a single actionable
  verdict line (e.g. "Hard share is high — too many quality sessions
  this window"). The detailed Z1–Z5 view below is unchanged.
- **Per-session intensity tag on `/cardio`.** Every cardio entry with HR
  data now shows an auto-derived polarized-model badge — *Easy*,
  *Threshold*, *Hard*, *Mixed*, or *Recovery* — computed from
  `hrZoneSeconds` against your editable LTHR zones. Hover the badge for
  the underlying easy / grey / hard share. Sessions under 10 minutes or
  without HR data are left untagged. Tag re-derives automatically if you
  re-tune your LTHR thresholds.

### Changed
- **Warm-up editor now auto-saves on every change**, matching the program
  block editor. Add / remove / reorder / dropdown changes persist
  immediately; inline typing (block title, movement name, dose) is
  debounced ~400 ms. Pending edits also flush on tab hide / unmount, so
  navigating away mid-typing never loses work. The outer Settings *Save*
  button is no longer required for the warm-up — only the
  *★ Save current as default* button remains, for promoting the current
  protocol to your personal default snapshot.

### Fixed
- **`★ Save current as default` in the warm-up editor now actually saves
  immediately.** Previously the click only updated React state; the
  snapshot was lost unless the user also clicked the outer Settings
  *Save* button. The snapshot now writes straight to local DB and
  pushes to the cloud, so it survives a refresh on its own.

### Changed
- **Single "Reset to defaults" button in the warm-up editor.** Removed the
  separate *Reset to my default* / *Reset to built-in defaults* pair — one
  *↺ Reset to defaults* button now restores the user's saved snapshot when
  one exists, and falls back to the built-in defaults otherwise.
- **Warm-up duration estimator now respects `/side` on time-based doses.**
  A movement like `40 s / side` is counted as both sides (80 s) instead of
  40 s. Sets×reps doses (`2 × 8 / side`) were already doubled correctly.
- **Drag-and-drop reordering in the warm-up editor.** Replaced the per-row
  ↑/↓ arrow buttons in `/settings → Pre-lifting warm-up` with a `⋮⋮` grip
  handle and HTML5 drag-and-drop, mirroring the pattern already used in
  the assistance list editor (opacity-50 on the dragged row, ring-2 ring-accent
  on the drop target). Both blocks and movements support drag reordering;
  movement drops are constrained to their own block.

### Added
- **Auto-estimated warm-up duration.** Each warm-up block on `/day` now shows
  a duration label that is computed from its movements (sets×reps,
  `/side`, explicit `~3 min` / `30 s` doses, with sensible fallbacks),
  instead of being typed in by hand. The editor in `/settings` exposes an
  *Override* toggle per block for cases where the heuristic isn't quite
  right; clearing the override returns to the auto-estimate.
- **Personal default snapshot for the warm-up.** The editor now has a
  *★ Save current as my default* button that snapshots the working draft
  into settings (`preLiftingWarmupUserDefault`). A *↺ Reset to my default*
  button restores from that snapshot, alongside the existing *↺ Reset to
  built-in defaults*.
- **Day-combo *Applies to* picker.** Per-block applicability is no longer a
  fixed *Press / Lower* split — the dropdown now lists each main-lift
  combination from your active program (e.g. *Bench + Deadlift*,
  *Press + Squat*) plus *Every day*. Blocks match a day exactly when the
  saved combo matches the day's main lifts. Existing blocks tagged with
  the legacy `press` / `lower` values continue to work (mapped to days
  containing bench/press or squat/deadlift respectively); they are still
  visible in the dropdown so you can re-tag them at your own pace.
- **Editable pre-lifting warm-up.** The warm-up card on `/day` is no longer a
  hardcoded protocol — `/settings → Pre-lifting warm-up` now exposes a full
  editor: add / remove / reorder blocks, edit each movement's name and dose,
  and tag each block as *Every day*, *Press / bench day*, or *Squat /
  deadlift day* so activation work still auto-picks the right variant from
  the day's first main lift. A *Reset to defaults* button restores the
  original General / Mobility / Activation protocol. Existing installs keep
  the same warm-up because settings without a custom protocol fall back to
  the defaults at render time. (`packages/db-schema` exports the new
  `WarmupBlockDef` type, `DEFAULT_PRE_LIFTING_WARMUP_BLOCKS`, and
  `selectWarmupBlocks` helper, all vitest-covered.)

### Infrastructure
- **Hardened Cosmos DB against accidental loss.** Added a `CanNotDelete`
  resource lock on the `wendler-cosmos-…` account, bumped periodic backup
  retention from 8 h to 7 days (interval 24 h), restricted public network
  access to the owner's home IP plus Azure-datacenter sources (so SWA
  managed Functions still reach Cosmos), and wired an Activity-Log alert
  on `Microsoft.DocumentDB/databaseAccounts/delete` to email the owner.
  No app behaviour change; documented in `docs/architecture.md` →
  *Cosmos DB protections*.

### Added
- **Pull-to-refresh in the installed PWA.**Standalone-mode PWAs suppress the
  browser's native pull-to-refresh, so previously the only way to force a
  fresh fetch was to fully close and reopen the app. Dragging down from the
  top of any page now shows a spinner indicator and, past the threshold,
  triggers a service-worker `update()` followed by a page reload — picking
  up newly deployed assets without a cold restart. Desktop and non-touch
  devices are unaffected.

### Fixed
- **Profile menu hidden behind bottom nav on mobile.** The avatar dropdown
  (Settings / More tools / Sync now / Sign out) opened underneath the mobile
  bottom tab bar, leaving the lower menu items unclickable. The mobile top
  header is now `z-40` so its dropdown layers above the `z-30` bottom nav.

### Added
- **Info tooltips on `/load` cards.**Small `i` icon in the top-right of the
  Form (TSB), Fitness (CTL), Fatigue (ATL), ACWR, Stress score and Weighted
  (IF²) cards. Hover (or focus / long-press on touch via the native `title`)
  to see a plain-language explanation of what each metric means and how to
  read its numbers. Self-explanatory tiles (Tonnage, Cardio, Days, Avg
  RPE/sleep/fatigue) are unchanged.

### Changed
- **Recovery page is now fully computed— no manual logging.** Replaced the
  sleep/HRV/fatigue/soreness/mood sliders and the 30-day history list with an
  auto-derived view: Banister fitness (CTL), fatigue (ATL) and form (TSB) tiles
  mirroring `/load`, average RPE over the last 7 days, and a "muscle freshness"
  grid showing days-since-last-trained for each muscle group (color-coded:
  green ≥4d, yellow 2–3d, red &lt;2d). The `RecoveryEntry` schema and Dexie
  table are kept intact so existing entries remain queryable and a future
  Garmin/Apple Health backfill can populate sleep + HRV programmatically.

### Changed
- **Muscle volume heatmap is much smaller.**The `BodyMap` SVG previously
  filled the whole analytics card width (often >600px on desktop). It's now
  capped at 260px and centered, matching the visual weight of the other
  analytics tiles instead of dominating the page.

### Added
- **Browser favicon now uses the 5/3/1 logo.**Previously, browsers bookmarking
  the app fell back to the Azure Static Web Apps default (Microsoft logo)
  because no `<link rel="icon">` was set. Adopted the existing PWA icon as
  `apps/web/src/app/icon.png` and `apps/web/src/app/apple-icon.png` — Next.js
  app-router conventions auto-emit the right link tags. Tabs, bookmarks, and
  iOS Safari "Add to Home Screen" all now show the same orange 5/3/1 mark
  as the installed PWA.

### Changed
- **HR-zone editor now shows zone names + current %LTHR inline.** Each Z1–Z4
  bpm input is labeled with its Garmin name and the % threshold currently in
  effect (e.g. "Z1 warmup ≤ 81%", "Z4 threshold ≤ 99%"). Z5 (maximum) is
  surfaced as a derived read-only tile alongside Z1–Z4 in both the bpm and
  %LTHR editors, showing "Z5 maximum > {Z4 upper}%" and the corresponding
  ">N bpm" cutoff. Bumped to a 5-column responsive grid.

### Added
- **Editable %LTHR thresholds for HR-zone calculation.** The Strava panel's
  "Calc from LTHR" helper previously hard-coded Garmin's default upper-bound
  percentages (Z1≤81%, Z2≤89%, Z3≤93%, Z4≤99% of LTHR). Each is now editable
  from Settings → Strava: click **Edit %** under the LTHR row to override
  any of the four percentages, **Save %** to persist (localStorage,
  `wendler.lthrZonePct`), or **Reset to defaults** to restore Garmin's
  values. The current thresholds are surfaced inline ("Using
  81% / 89% / 93% / 99% of LTHR (Garmin defaults)" or "(custom)") and in
  the Calculate button tooltip. Validates ascending order and 0–150%.
- **Banister CTL/ATL/TSB + ACWR on Load & Recovery.** A daily-load model
  rolls strength (IF²-weighted), cardio (HR-zone-weighted) and an RPE
  bump into one number per day, then runs the standard exponentially
  weighted average to produce **CTL** (chronic, 42-day), **ATL** (acute,
  7-day) and **TSB** (form = CTL − ATL). The page now leads with a big
  colour-coded TSB tile plus CTL, ATL and ACWR (acute:chronic ratio)
  side-by-side. Deload urgency now fires on `ACWR > 1.5` (high injury
  risk), `ACWR > 1.3` (above sweet spot), `TSB < -30` (deeply negative
  form) and `TSB < -15` (negative form). New exported helpers
  `dailyLoad()`, `dailyLoadSeries()`, `banister()`. A 14-day cold-start
  guard suppresses TSB/ACWR signals for users coming back from a layoff.
- **Dynamic cardio cap.** The cardio contribution to the weekly stress
  score is no longer hard-capped at 30. The cap floats to
  `max(30, round(1.3 × trailing-6-week mean cardio contribution))`, so a
  sustained endurance phase is no longer flattened against its own
  ceiling. The current in-progress week is excluded from the trailing
  mean so today's big run can't immediately self-cap. New exported
  helpers `trailingMeanCardioContribution()` and `dynamicCardioCap()`;
  `weeklyLoad(..., { cardioCap })` accepts an explicit override.
- **Consecutive high-RPE streak detection.** The deload engine now
  receives the past ~14 days of set-level history and looks for
  consecutive sessions where any set hit RPE 8.5+. Three sessions in
  a row at high effort triggers `deload-now`; two in a row triggers
  `deload-soon`. Catches the failure mode where a single easy session
  pulls the weekly RPE average down to 7.8 and hides three back-to-back
  RPE-9 days. New exported helper `consecutiveHighEffortStreak()`.

### Changed
- **Rolling baseline z-score is now display-only.** The personal
  4-week stress mean ± SD is still computed and rendered under the
  recommendation card as a "personal stress range", but it no longer
  contributes to deload urgency — TSB/ACWR are the load-relative
  trigger now. Absolute stress thresholds (75 / 90), RPE streak,
  fatigue and sleep all stay as urgency inputs.
- **HR-zone weights rebalanced (Edwards/Lucia-style).**Cardio minutes
  are now weighted `Z1×0.5, Z2×1.0, Z3×2.0, Z4×4.0, Z5×6.0` instead of
  the previous near-linear `0.5/1.0/1.5/2.0/3.0`. VO₂max work and
  threshold runs now contribute substantially more to weekly stress
  than easy zone-2 minutes — closer to TRIMP convention.

### Removed
- **Weekly `>+15 jump` heuristic.** The old "sharp week-over-week
  increase in load" deload trigger has been retired — TSB and ACWR
  capture the same idea on a daily granularity, with a real time
  constant rather than an arbitrary threshold.

### Added
- **Intensity-weighted tonnage on Load & Recovery.**The stress recipe
  now uses `weightedTonnageKg = Σ reps × weight × (weight / TM)²` instead
  of raw kg, so a top-set PR week scores meaningfully higher than an
  equal-tonnage backoff week. Sets without a TM snapshot (assistance /
  accessory work) use a flat `IF = 0.55` fallback so they still
  contribute. The `/load` summary now shows a fourth stat
  `Weighted (IF²)` next to raw tonnage. `WeeklyLoad` exposes
  `weightedTonnageKg`, `tonnageMainKg`, and `tonnageAssistanceKg`.

### Added
- **Personal rolling baseline on Load & Recovery.** The deload engine now
  computes mean ± SD of `stressScore` (and `avgRpe`) over your last 4
  trained weeks, and flags the current week using a z-score against that
  baseline (≥1σ → "above baseline", ≥2σ → "well above baseline"). Falls
  back to the previous absolute thresholds when fewer than 2 trained
  weeks of history exist. Absolute 90+ stress remains a safety net even
  for high-baseline athletes. The recommendation card now displays the
  active baseline (`stress 45 ± 8 over 4 prior weeks · RPE 7.6`) or a
  cold-start hint.

### Changed
- **Strength rows in `Recent activity` now lead with `Strength · …`.**
  Mirrors the cardio rows' `Cardio · 129 bpm · Strava` subtext so the
  feed is consistent. Completed strength reads `Strength · Complete · 22
  of 22 sets logged`; in-progress reads `Strength · In progress · …`.
- **Strength rows in `Recent activity` get a 🏋️ emoji.** Cardio rows
  already lead with a modality emoji (🏃 / 🎾 / etc.), so strength
  rows looked unlabelled by comparison. Both completed-strength and
  in-progress-strength rows now have the lifter emoji prefixed to
  the title.

### Removed
- **Today right-side `Wk N / M` progress widget.** The block-context line
  under the headline (`Week X of Y · Block name · N weeks total`)
  already conveys where you are in the cycle, so the duplicated
  global-week counter on the right was redundant.

### Changed
- **Program timeline collapses single-week segments.** On
  `/program/detail`, blocks whose start/end weeks are equal (e.g. the
  7th-Week Deload) now show `Wk 7` instead of the awkward `Wk 7–7`.
  Multi-week blocks still show the range (`Wk 1–3`).

### Removed
- **In-block deload toggle.** The "Includes deload?" checkbox on the
  block editor (`/program/block`) and on the new-program form
  (`/program/new`) is gone. Deload weeks are now managed exclusively by
  the existing 7th-Week prompt logic, which schedules a standalone
  seventh-week block (Deload / TM Test / PR Test) automatically once
  enough consecutive training weeks have accumulated. A one-shot,
  per-device migration (`LegacyDeloadMigrator`) flips every existing
  block's `includesDeload` flag to `false` on first load so the program
  timeline no longer double-counts deloads (e.g. a Leader-2 inline
  deload immediately followed by a 7th-Week deload block, which
  previously inflated an 11-week cycle that should have been 10).
- **`+ deload` badge on `/program/detail`** and the Duration "+ deload"
  suffix on the block editor strip — both rendered the now-removed
  flag.

### Changed
- **Today widget shows `Wk N / M` instead of bare `N / M`.** The label
  was missing on single-week blocks (after the previous "hide `Wk N`
  badge when blockTotalWeeks === 1" fix), leaving the right-side
  counter reading just "8 / 11" with no unit.

### Changed
- **Today header drops contradictory week count on single-week blocks.**
  When the active block is one week long (e.g. the 7th Week Protocol),
  the title line previously read "Week 1 of 1 · 7th Week · Deload" —
  two coordinate systems on the same line. The block-local "Week X of Y"
  prefix is now hidden when `blockTotalWeeks === 1`, so the line reads
  just "7th Week · Deload · 8 weeks total". The right-side progress
  widget also drops its now-meaningless "Wk 1" badge in that case;
  the global "8 / 11" counter still conveys cycle position.
- **`Recent activity` now groups entries under day headers.** Items
  used to render as a flat list with each row carrying its own date,
  forcing you to read every label to understand the timeline. Entries
  are now bucketed under "Today · 5 May" / "Yesterday · 4 May" / "2 May"
  headers (with year added for past years), and the per-row date is
  removed. Same-day activities (e.g. Padel + Run on the same date)
  visually belong together.
- **`/calendar` upcoming-pill subtitle no longer doubles up on
  seventh-week blocks.** For deload / TM-test / PR-test blocks the
  block chip already encodes the variant ("7w · Deload"), so the
  generic week-label suffix produced redundant text like
  "7w · Deload · Deload" or "7w · Deload · 7th Week". The `wk`
  segment is now omitted when the block is a seventh-week block.

### Changed
- **Strength accent follow-ups.** The Today `Recent activity`
  completed-strength row now has a violet-tinted background/border to
  match the cardio row's sky tint (previously just a dot on the
  default card background, which made it look unlabelled). On
  `/calendar`, upcoming strength workouts and the legend "Upcoming"
  swatch now use violet (was the orange app accent, which is
  reserved for CTAs and didn't match strength's category color
  elsewhere).

### Changed
- **Strength category color is now violet everywhere.**Strength used
  to be blue-500 in analytics surfaces but emerald-700/900 on the Today
  recent activity dot, the `This week` S/C glyphs, and the `/calendar`
  workout pills — and the analytics blue read as too similar to the
  cardio sky. Consolidated to violet-500 (`STRENGTH_ACCENT = #8b5cf6`)
  across the analytics charts/heatmap, the AnalyticsCard category
  badge, the Today `Recent activity` strength dot, the `This week`
  S glyphs and legend, and the `/calendar` completed-workout pill +
  legend. Cardio glyphs in `This week` now correctly use sky as well
  (they were previously emerald, doubling up with the strength glyph).
  The training-calendar "Both" cell stays distinct as pink-500 instead
  of purple-500 to avoid clashing with the new strength violet.
  Emerald is preserved everywhere it means "done/success" (set
  checkboxes, completed indicators, save status, etc.) — only category
  uses changed.

### Added
- **LTHR-based HR zone calculator.** The HR zone editor now has a
  *Calc from LTHR* row: enter your Lactate Threshold HR (bpm) and the
  four Z1–Z4 upper-bound inputs are filled using Garmin's default
  %LTHR percentages (Z1 ≤ 81%, Z2 ≤ 89%, Z3 ≤ 93%, Z4 ≤ 99%). Values
  remain editable before Save, so customised Garmin percentages can
  still be applied by hand. Matches the zones already displayed on
  Garmin watches that use the LTHR method.
- **Editable HR zones in Settings → Strava panel.** New endpoint
  `GET/PUT/POST /api/strava/hr-zones` lets you override the upper bpm
  bound for Z1–Z4 (Z5 is everything above Z4) and persist it on the
  Strava auth doc. The panel now has an `Edit` link next to the HR
  zones row that opens an inline form with four bpm inputs, a `Save`
  action, and a `Pull from Strava` action that re-fetches zones from
  your Strava athlete profile. New imports use the saved zones; older
  sessions keep their previous time-in-zone breakdown until you hit
  `Refresh last 60 days`.
- **Padel as a cardio modality.** New `padel` modality (🎾 Padel,
  amber accent) added to the cardio session type, the in-app cardio
  logger picker, analytics colour map, and the Today/Calendar/Recent-
  activity surfaces. The Strava sync now maps `sport_type: "Padel"`
  to `modality: 'padel'` instead of falling through to `other`, so
  weekly padel sessions show up in cardio history and weekly stress
  rather than being silently dropped. Padel is intentionally
  excluded from running-specific analytics and RunPlan slot matching
  by the existing `modality !== 'run'` filters.

### Fixed
- **`Last sync` text now updates immediately after `Sync now`.** The
  service worker's stale-while-revalidate strategy was caching
  `/api/strava/status` GET responses, so after a successful sync the
  panel kept showing the previous timestamp until a hard refresh. The
  SW now bypasses caching entirely for any `/api/*` request — those are
  authenticated and user-specific and must never be served from cache.
  As a defensive optimisation the panel also reflects the new
  `lastSyncAt` from the sync response immediately, so the UI updates
  even before the follow-up status fetch completes.
- **Stale TMs from a previous rounding-increment change now self-heal.**
  The earlier fix only re-rounded TMs when the increment was changed in
  the *current* Settings save, so users who had already switched
  increments under an older app version were stuck with stale TMs (e.g.
  63.75 kg from 1.25 kg rounding showing instead of 65 kg at 2.5 kg).
  Reconciliation now also runs once when the Settings page mounts, and
  the Settings save handler reconciles unconditionally instead of only
  on increment change. The reconciler skips lifts whose stored TM
  already matches `computeTrainingMax(oneRm, roundingKg)`, so it's a
  no-op when everything is consistent.
- **Rounding-increment change now re-rounds Training Maxes automatically.**
  Previously, switching the rounding increment in Settings (e.g. 1.25 kg
  → 2.5 kg) left existing TMs at their old rounding, so projected sets
  and the hero pill kept using stale weights until the user re-saved the
  TM editor. The Settings save handler now detects when `roundingKg`
  changed and appends a fresh TM history entry per main lift,
  recomputing `trainingMaxKg` from the stored unrounded `oneRmKg` with
  the new increment. Source = `manual`, note records the before/after
  increment so the change is visible in TM history.

### Changed
- **Unified `Up next` hero on Today.** The hero now surfaces the next
  prescribed activity regardless of modality — whichever comes sooner
  between the next strength workout (per program schedule) and the next
  non-rest cardio slot (per RunPlan, skipping days that already have
  logged cardio). The cardio variant of the hero is informational only
  (no CTAs) since there is no "start cardio" flow in the app — runs are
  imported from Strava after the fact. On a tie the strength hero wins
  because it has the actionable Start/Preview buttons.
- **Removed standalone `TodayCardioCard`.** Its responsibility — telling
  the user about today's cardio — moved into the hero (planned cardio)
  and into the `This week` card / Recent activity list (logged cardio),
  so we no longer render a separate tile under the hero.
- **`This week` card now also shows planned strength.** Days that have
  a projected strength workout in the next ~2 weeks render a dashed
  emerald `S` glyph (mirroring the dashed sky `C` for planned cardio),
  so the right rail reflects every prescribed activity for the week
  rather than just the cardio side.

### Added
- **Cardio in `This week` card on Today.** Each Mon–Sun cell can now show
  up to two glyphs: green `S` when a strength session was completed,
  green `C` when a cardio activity was logged, and a dashed sky `C` when
  today/future has a planned run (per the RunPlan). Today gets an accent
  ring; legend below explains the three states. The "N done" footer
  counts strength + cardio together.
- **`Today's cardio` card next to `Up next` hero.** When a cardio
  activity has been logged today the card shows a "Done" pill with the
  modality emoji + metric. When today is a non-rest day per the RunPlan
  but no cardio is logged yet, it shows a dashed sky CTA "Log →" linking
  to `/cardio/plan`. Renders nothing on rest days.
- **Recent activity** (renamed from "Recent sessions") on Today now
  interleaves cardio entries with strength workouts, sorted by date.
  Cardio rows render with a sky outline + modality emoji + metric and
  link to `/cardio` so a logged run shows up immediately on the home
  page without having to dig into a separate tab.

### Changed
- **Cardio accent** — moved from teal `#14b8a6` to sky `#0ea5e9` so it
  reads as blue rather than blue-green and is easier to distinguish
  from completed-state greens on `/calendar`. Applied across the run
  modality (weekly cardio volume), KPI tiles (cardio time / distance),
  the `cardio` card badge, the training calendar, and the calendar
  pills.
- **Canonical accent tokens** — `STRENGTH_ACCENT` (blue `#3b82f6`) and
  `CARDIO_ACCENT` (sky `#0ea5e9`) now exported from `@wendler/domain`
  and consumed by `apps/web/src/app/analytics/page.tsx` +
  `TrainingCalendarCard`. Future cardio/strength surfaces should pull
  these instead of repeating hex literals so the two categories look
  identical across `/analytics`, `/calendar`, `/cardio`, KPIs, etc.
- **Planned-run pills on `/calendar`** — outline-only (transparent fill,
  dashed sky border, faded sky text) to clearly separate them from
  filled-sky completed cardio pills. Was teal-on-teal which read as
  another green state.

### Added
- **Planned runs on `/calendar`** — every future date whose ISO weekday
  matches a non-rest slot in the run plan now shows an "upcoming run"
  pill with the planned kind (Easy / Long / Quality / Recovery /
  Race-pace / Cross). Pills are visually distinct from completed cardio
  (dashed teal border + faded teal fill, planned emoji + ◌ marker, links
  to `/cardio/plan`) so they can't be confused with logged sessions
  (solid sky border + filled sky background). Suppressed automatically
  when an actual cardio session already exists on the same date. New
  "planned runs" stat in the month summary and a matching legend entry.

### Fixed
- **Weekly cardio volume trend line** rendered as multiple ghost
  segments because the SVG used a tiny `0 0 N 100` viewBox with
  `preserveAspectRatio="none"` — at extreme x/y aspect ratios the
  polyline was getting subdivided into visual artefacts. Switched to a
  normalized `0 0 100 100` viewBox with `shape-rendering=geometricPrecision`
  and round line joins/caps so it always renders as a single clean line.

### Changed
- **Training calendar** — centered horizontally inside the card, cells
  bumped to 26px on `/analytics` so the heatmap actually fills the card
  width instead of hugging the left edge.

### Changed (existing)
- **Weekly cardio volume** — totals now visible above each bar at all
  times (no hover required), and a 4-week trailing moving-average trend
  line is overlaid in amber so the longer-term direction is obvious at a
  glance. Reuses the same chart primitive as weekly tonnage.
- **`StackedBarChart` primitive** — gained `showTotals`, `formatTotal`,
  and `trend`/`trendColor`/`trendLabel` props. The trend line is drawn
  in SVG over the bars so it crosses bar boundaries cleanly and shares
  the bars' y-scale.
- **Training calendar placement** — moved out of the top of the
  `/analytics` grid and into the strength stack, slotted between
  push/pull/lower/core balance and the muscle heatmap. Default size
  bumped on this page (20 weeks of history, 20×20 cells) so the
  combined view has more presence; the card now accepts a `cellSize`
  prop for future re-use.
- **Cardio color scheme** — replaced Strava-orange (`#fc4c02`) with calm
  teal (`#14b8a6`) as the cardio accent across `/analytics`: KPI tiles
  (cardio time, distance), `cardio` card badge, the `run` modality in
  weekly cardio volume, and the cardio swatch in the training calendar.
  Run-plan adherence mid-tier swapped from amber `#f59e0b` to sky
  `#38bdf8` to keep the bar palette free of yellow/orange. New
  `CARDIO_ACCENT` export from `@wendler/domain` so future cardio cards
  pick up the canonical color without duplication.
- **Training calendar** — re-laid out as a GitHub-style heatmap (7
  weekday rows × N week columns of 14×14 squares) with month labels
  along the top and weekday labels (Mon/Wed/Fri/Sun) down the left.
  Days are now clearly separated cells instead of merging into long
  horizontal bars, and the leading edge is padded so column 0 always
  starts on a Monday.

### Added
- **Unified Analytics page** — `/analytics` is now a modular card grid
  surfacing both strength and cardio under one roof. Top-level
  `All / Strength / Cardio` mode switcher + window selector
  (`30d / 90d / 6m / 1y / all`). New cards: weekly cardio volume
  (stacked-by-modality, minutes/km toggle), aggregate HR-zone breakdown,
  pace personal records, run-plan adherence (last 8 weeks), training
  calendar (12-week strength × cardio dot grid). Headline KPI row covers
  workouts, tonnage, cardio time, and distance — each with delta vs
  prior period and a sparkline.
- **`@wendler/domain/cardio-analytics`** — pure helpers backing the new
  cards: `weeklyCardio`, `aggregateHrZones`, `runPlanAdherence`,
  `trainingCalendar`. 7 vitest cases.
- **HR-zone summary chart on `/cardio`** — aggregates `hrZoneSeconds` across all
  loaded sessions into a stacked bar plus per-zone rows (Z1–Z5 with labels,
  total time, and percentage). Hidden when no zone data is available.
  *(Note: superseded — the canonical aggregate now lives on `/analytics`;
  per-session zone bars on `/cardio` are unchanged.)*

### Changed
- **`/cardio`** — removed the aggregate HR-zones card and the Pace PRs grid.
  Both now live on `/analytics` as part of the unified-page redesign. The
  cardio page is back to its log/plan focus: per-session entries, per-run
  zone strips, and "Log cardio" action.
- **`/analytics`** — strength cards (weekly tonnage, push/pull balance,
  muscle heatmap, 1RM history) extracted into
  `apps/web/src/components/analytics/*Card.tsx` for reuse and easier
  individual evolution.

## [1.2.0] — 2026-05-05

The "run-plan + UX polish" release. Establishes a recurring weekly run-plan
template that Strava-imported activities auto-tag against, and a wave of
in-gym ergonomics improvements.

### Added
- **Weekly run plan** (`/cardio/plan`) — recurring `dayOfWeek → kind` template
  (rest/easy/quality/long). Singleton row, Dexie schema v10. (`3ecb201`, `04a4853`)
- **Strava → run-plan auto-tagging** — day-of-week match; manual override
  via "Tag as:" dropdown is sticky across re-syncs (`planMatch === 'manual'`).
  (`636ca5e`)
- **Refresh last 60 days** button on the Strava panel — idempotent, dedupes
  by `externalId`. (`0cd1726`)
- **`/api/strava/inspect?count=N`** debug endpoint — dumps raw activity
  metadata to verify what Strava actually exposes. (`b8be140`)
- **Settings → Display → Keep screen on while the app is open** —
  `navigator.wakeLock` integration; auto-releases on tab hide. (`5551f82`)
- **Settings → Equipment → Trap bar weight (kg)** — plate calculator now
  resolves bar weight from `movement.equipment` per slot. (`5551f82`)
- **Assistance auto-collapse** — finishing the last prescribed set of an
  assistance entry collapses its card to the summary row, just like main
  lifts. (`5551f82`)
- **Block Sessions list grouping** — multi-lift workouts collapse to one
  entry (Day N · Bench Press + Deadlift · Deload ✓) and link to
  `/day` overview instead of one lift's `/session`. (`93aa75c`, `0759cb0`)
- **Cardio sessions on calendar.** (`6ebd1a7`)
- **Pre-lifting warm-up reference card** on `/day`; warm-up movements as
  per-item rows. (`744f073`, `6505fcf`)
- **Per-exercise AMRAP toggle** on the assistance editor — applies to every
  set, not just the last one. (`72d44ed`, `c1b3c50`)
- **Day:** in-progress state on lift status circle + Unmark complete. (`eb50d59`)

### Changed
- **Sync status badge** in the top nav is now a **fixed-size icon-only**
  indicator (✓ / spinning circular arrows / ✕ / cloud-off). No more nav
  reflow when sync state changes. Detailed status preserved in tooltip. (`cc2b51e`)
- **Cardio total time** formats as `1h 24m` once over 60 minutes (was
  `84m`). (`e1c5b4a`)
- **Cardio dates** prefix the weekday short name: `Mon 14.04.2026`. (`e1c5b4a`)
- **Analytics balance chart** counts working sets per category instead of
  tonnage — band/bodyweight movements (e.g. Pallof Press) now show up. (`45f3b60`)
- **Hide weight input for band movements** in block planning. (`04e88ab`)
- **Mobile readability** improved on 1RM chart and calendar. (`555044b`)
- **Sync push order** changed to pull-before-push so fresh installs no
  longer clobber server data. (`a1b6530`)
- **MovementCombobox** hardened against stale name-prop echoes. (`416c031`)
- **Assistance editor** uses optimistic local entries to fix delete/typing
  races. (`865046e`)
- **Completed blocks** visually dimmed on program detail. (`7f5ad2d`)
- **Assistance shown on 7th-week (incl. deload) workouts.** (`a6d1c20`)
- **`/cardio/plan` back-button** no longer wraps onto two lines. (`e1c5b4a`)

### Fixed
- **`MSAL_CLIENT_ID` documentation** — restored docs in
  `docs/architecture.md` after a sibling project's deploy temporarily wiped
  the SWA Application Settings; codebase was unaffected, but docs now
  enumerate the full required env-var matrix.

### Internal
- Run-plan matcher (`packages/domain/src/runPlan.ts`) — pure, day-of-week
  lookup. 7 unit tests covering match/no-match/manual-skip cases.
- Dexie schema v10 — new `runPlan` table.
- 199+ tests pass; build clean across all workspaces.

## [1.1.0] — Strava integration
HR-zone stress, pace PRs, OAuth + token storage in Cosmos.

## [1.0.0] — GA
Race-taper detection, a11y pass, methodology docs.

## [0.6.0]
Goals, cardio, recovery, weekly load + deload coach.

## [0.5.0]
MSA auth + Cosmos DB cloud sync.

## [0.4.0]
Calendar, analytics, body heatmap.

## [0.3.0]
In-gym UX (timer, AMRAP capture).

## [0.2.0]
Blocks + supplemental templates (FSL, BBB, PB).

## [0.1.0]
Core 5/3/1 engine (waves, TM, plate math).
