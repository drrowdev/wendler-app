# Changelog

All notable changes to this app are documented here. The most recent release
is at the top. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

Service-worker cache version (`apps/web/public/sw.js` → `CACHE = 'wendler-shell-vNNN'`)
is bumped on every release so installed PWAs evict stale assets on next visit.

## [Unreleased]

### Changed
- **Unified nav: "More" is now a primary tab on desktop too (SW v308).** Before, mobile had a 6th `More` tab linking to /more (Goals, Races, Recovery, Movements) and desktop had no equivalent — Settings was reachable only via the avatar dropdown, which on a tablet/laptop meant a tap into an account menu just to change a rest-timer default. Same IA shape on both viewports now: `Today · Program · Calendar · Stats · Load · More`. /more also now lists **Notifications** and **Settings** so every app-level destination has a single canonical entry point. The avatar dropdown is trimmed to account-only items (account name, sync status, Sync now, Sign out); Settings and "More tools" links removed from it. The bell icon stays in the header on both viewports as a shortcut for the unread badge.
- **Rename `/analytics` → `/stats` (SW v307).**The top-nav label was already "Stats" but the route was `/analytics` — a long-standing label/URL mismatch that confused Quick-jump search and made shared URLs misleading. The page itself is unchanged; only the route moved. The Azure Static Web Apps config now issues a `301` redirect for `/analytics` → `/stats`, so any bookmarked or shared old URL still lands on the right page. Internal references in `Nav`, `QuickJumpPalette`, and `MondayDigest` updated to the new path. Quick-jump still accepts `analytics` as an alias.

### Fixed
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
