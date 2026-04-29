# UX Audit — Hub + LiveTrack Pairing + MCP

## Overall impression

Structurally sound but built for a developer who already understands the system, not a new user. Plumbing is excellent — show-once API keys, encrypted extension creds at rest (pgcrypto, `supabase/migrations/20260303100000_encrypt_extension_credentials.sql:35`), per-tool gating, OAuth 2.1 consent, optimistic mutations — but the storytelling is missing at every entry point. Signup → blank Hub. Generated key → no instruction on what to paste it into. Connected Claude.ai → no in-app way to verify it worked. Paired a single-track scale → no wizard for the device-side setup. Cross-cutting symptom: Hub decisions silently shape ChefByte/CoachByte (timezone drives logical_date, day_start_hour gates macros, deactivating an app deletes data), but those couplings are never named.

## Per-flow

### Sign up + profile

`Signup.tsx:53-95`. Three fields, no friction. **But** there's no timezone / `day_start_hour` capture at signup. The DB trigger `private.handle_new_user()` (`supabase/migrations/20260302014004_create_schemas.sql:33-48`) defaults to `America/New_York` + 6am, so a Pacific user signing up at 11pm gets their day boundary wrong from session one. `Signup.tsx:46` navigates to `/hub`, which renders `HubHomePage` (`HubHomePage.tsx:51`) showing **two grayed-out app cards** because no app is activated by default (`AppsPage.tsx:12-15`). No welcome tour, no checklist.

`AccountPage.tsx` is well built — searchable IANA combobox with keyboard nav (`AccountPage.tsx:231-298`) and the only explanatory hint in the Hub: "Your day resets at this hour for macro tracking" (`AccountPage.tsx:304`). App deactivation (`AppsPage.tsx:38-49`) calls `hub.deactivate_app` which per `docs/apps/hub.md:15` performs a _full delete_ of that module's data. The page-level handler (`AppsPage.tsx:82-85`) calls the mutation directly with no visible `ConfirmModal` — for a data-destroying flow, lack of a typed confirmation at this layer is a real risk.

### Connect Claude.ai via MCP

`McpSettingsPage.tsx`. The pieces are right: copy-able endpoint (`McpSettingsPage.tsx:181-196`), labeled generate (`ApiKeyGenerator.tsx:109-121`), show-once-then-hashed (`ApiKeyGenerator.tsx:125-144`) with SHA-256 on wire (`McpSettingsPage.tsx:23-29`), per-key **last_used relative time** updated by the worker (`ApiKeyGenerator.tsx:38-50`), revoke-individual + revoke-all gated by `ConfirmModal` (`ApiKeyGenerator.tsx:195-216`), 10-key cap (`McpSettingsPage.tsx:73-77`).

But the endpoint URL is hardcoded to `/sse` (`McpSettingsPage.tsx:37`). Per `docs/mcp/guide.md:7-9`, `/sse` is the **legacy** transport that "burns DO duration billing"; `/mcp` (Streamable HTTP) is recommended. UI/doc drift steers users onto the costly path.

What's missing between "I have a key" and "Claude is calling my tools":

- **No Test-connection button.** `mcp_tool_logs` exists per `docs/mcp/guide.md:45-52` but is not surfaced.
- **No copy-pasteable Claude.ai snippet.** Zero references to "claude" or "connector" in `McpSettingsPage.tsx` / `ApiKeyGenerator.tsx`. A non-developer doesn't know about Claude.ai → Connectors → Add custom MCP.
- **No inline help on the endpoint URL.**

OAuth consent (`OAuthConsent.tsx:131-150`) is functional but its consent body is identical regardless of scopes requested.

Tools page (`ToolsPage.tsx:201-275`) is the surprise hero — search, collapsible groups, per-tool toggles. Misses: descriptions are 5 words ("Complete next planned set") with nothing about side effects, and hardcoded extension-tool lists (`ToolsPage.tsx:77-103`) are stale vs the worker's actual registry (lists `OBSIDIAN_search_notes`; worker exposes `OBSIDIAN_get_morning_brief`, `_get_project_hierarchy`, `_usage_guide`).

### LiveTrack pairing wizard

Two flows masquerading as one.

**Flow A — device pairing — buried under `/chef/settings` → "Scales" tab (`ScalesTab.tsx`).** Wrong placement: a platform-level device pairing concern lives inside ChefByte. Jeremy will look for "scale" under `/hub/extensions` and find only Obsidian/Todoist/HA (`ExtensionsPage.tsx:10-36`). No nav signpost from Hub. The Add Device form (`ScalesTab.tsx:491-537`) generates a 64-hex import key, displays it once with the "Save this key now" warning (`ScalesTab.tsx:586-588`) — well-designed show-once. But **zero inline instructions about scping it to the Pi, no guide URL, no "next step" CTA** — the user copied a key with nothing to do with it.

**Flow B — per-item import wizard — `LiveTrackImportPage.tsx`.** State machine has nine kinds (`LiveTrackImportPage.tsx:98-135`):

- **No progress indicator.** Each state renders a different `<section>` (`LiveTrackImportPage.tsx:831-936`) with no "Step 2 of 4."
- **Pi heartbeat freshness** in the header — "Pi: kitchen-pi (online, last hb 3s ago)" (`LiveTrackImportPage.tsx:811-823`) — refetched every 15s, 60s freshness window shared with edge function (`livetrackSession.ts:198-201`). Excellent.
- **Error recovery**: error-state button labeled "Start over" (`LiveTrackImportPage.tsx:933`). Accurate for session expiration; conflates fatal with transient for analyze-product blips (which only reset `sessionId`, no work lost).
- **Field visibility**: every product field editable inline (`LiveTrackImportPage.tsx:1017-1083`). Auto-derivation (serving_weight → net_weight when spc known, `LiveTrackImportPage.tsx:1043-1064`) is delightful. OFF-miss banner (`LiveTrackImportPage.tsx:1008-1014`) is neutral, not error-coded — right tone.
- **AI-tare visibility**: user clicks "Request AI tare from Pi" (`LiveTrackImportPage.tsx:1147-1155`); Pi takes 5+ seconds. **No spinner, no progress indicator, no cancel button.** Visual users see nothing until realtime flips state (`LiveTrackImportPage.tsx:353-367`). Aria-live fires for screen readers; visual users get silence. If Pi crashes mid-tare, the wizard hangs until 10-min expiration.
- **Auto-tare path** is the only well-narrated stretch (`LiveTrackImportPage.tsx:1115-1132`): "Place container on the catch-all scale… If the container isn't settled yet, wait — the reading refreshes as the scale sends heartbeats."
- **Single-track scale (scale-03)**: supported in the data model (`livetrackSession.ts:80-92`) but the wizard hardcodes `scale-02` (`LiveTrackImportPage.tsx:298`). Pairing scale-03 to a product is via `scale_pairings` row in `ScalesTab.tsx:424-436` — multi-page treasure hunt with no dedicated single-track wizard.

### Configure an extension

`ExtensionsPage.tsx`, `ExtensionCard.tsx`. Three extensions hardcoded (`ExtensionsPage.tsx:10-36`).

Working: pgcrypto encryption at rest (`20260303100000_encrypt_extension_credentials.sql:35`), URL vs secret field type distinction (`ExtensionCard.tsx:10`, `:84`), configured/not-configured badge (`ExtensionCard.tsx:72-76`), optimistic toggle (`ExtensionsPage.tsx:75-100`).

Weak:

- **Where do I get these credentials?** Obsidian asks for GitHub Repo + PAT + optional API URL (`ExtensionsPage.tsx:14-19`). Zero help text, no PAT scope hints, no Gitea hint.
- **No test affordance.** Per `docs/apps/hub.md:33`, "Credential validation on save is a future feature." A bad token only surfaces as a tool failure in Claude.
- **Extension health invisible.** `mcp_tool_logs` failure index (`docs/mcp/guide.md:50-52`) not surfaced.
- **Toggle without credentials** is allowed (`ExtensionCard.tsx:78`); visual cue doesn't distinguish "enabled but no creds" from "enabled and configured."

### Use MCP from Claude (onboarding trace)

Jeremy's path from key generation to first tool call:

1. `/hub/mcp` with endpoint + key. Done.
2. **Hub tells him nothing.** No copy-pasteable Claude.ai snippet, no `mcp.json` example, no link to `docs/mcp/guide.md`.
3. He Googles it.
4. He pastes the SSE endpoint Hub gave him (DO-billing cost per `docs/mcp/guide.md:9`) instead of `/mcp` Streamable HTTP — UI hardcodes `/sse` (`McpSettingsPage.tsx:37`).
5. To confirm, he must call a tool from Claude and watch `last_used_at` flip (`ApiKeyGenerator.tsx:171`). Two round trips for confirmation.

## Cross-cutting findings

**Onboarding completeness.** Brand-new user lands on `HubHomePage` with two inactive app cards and a Settings sidebar of mystery-meat ("Account, Apps, Tools, Extensions, MCP Settings"). No onboarding checklist, no welcome card, no first-five-minutes path.

**Session continuity.** Solid. `AuthProvider.tsx` uses `onAuthStateChange` with `INITIAL_SESSION` detection, 10s timeout fallback, post-init session-expiry toast (`AuthProvider.tsx:73-75`). Refresh tokens handled by supabase-js automatically.

**Key security.** Excellent. SHA-256 hash stored, plaintext shown once, 10-key cap, individual + bulk revoke with confirm modals, last_used_at tracking. Lost-key recovery is 4 clicks.

**Extension health visibility.** Weak. No `mcp_tool_logs` surface, no credential test. Misconfiguration is only discoverable by calling a tool and seeing it fail in the Claude.ai conversation.

**Documentation in-app.** Almost completely absent. One hint on day_start_hour (`AccountPage.tsx:304`). Zero tooltips, zero "?" affordances, zero linked docs. `docs/mcp/guide.md` is comprehensive but not surfaced from the UI.

## Top 5 highest-impact UX changes

1. **Ship a "Quick Start" panel on `/hub/mcp` with a copy-pasteable Claude.ai connector snippet.** Default the displayed endpoint to `/mcp` Streamable HTTP (not the legacy `/sse` at `McpSettingsPage.tsx:37`) and add a "Test connection" button that fires `ping` against the worker. Single biggest dead-end in the flow.

2. **Add credential-test buttons to every extension card.** Three small probes — `obsidian-test-creds`, `todoist-test-creds`, `homeassistant-test-creds` — that surface OK / 401 / network error. Pair with a "Last 5 calls" tail pulled from `mcp_tool_logs`. Closes the silent-misconfiguration trap.

3. **Move device pairing into Hub** as a sixth Extensions row (or new `/hub/devices`). ScalesTab is buried under ChefByte Settings. Add inline Pi-side instructions next to the show-once key (`ScalesTab.tsx:540-596`) — scp command, systemd unit name, expected log line.

4. **Add a step indicator + AI-tare loading state to LiveTrack wizard.** "Step 2 of 4: Place container on scale" + a spinner when `state === 'awaiting_ai_tare'` with a cancel button (clear back to `product_loaded`). Rename context-blind error-state "Start over" (`LiveTrackImportPage.tsx:927-935`) to "Try again" for transient failures, "Start new session" for expired ones.

5. **Capture timezone + day_start_hour at signup**, or surface a "Finish setup" banner on Hub home gated behind a profile-set flag. Current path lets a Pacific user cross 6am EST believing it's still "today" while macros silently roll over. Pair with a 3-step Hub home checklist: "1. Profile, 2. Activate an app, 3. Generate MCP key."

## Things working well

- **Show-once API key pattern** (`ApiKeyGenerator.tsx:125-144`) — SHA-256 on wire, plaintext in component state, copy + dismiss.
- **last_used_at on API keys** (`ApiKeyGenerator.tsx:38-50`) — the right affordance for "which of my 6 keys is Claude using."
- **Optimistic mutations** across tool toggles (`ToolsPage.tsx:138-163`), key revocation (`McpSettingsPage.tsx:99-126`), extension toggles (`ExtensionsPage.tsx:75-100`).
- **Session-aware AuthProvider** with post-init expiry toast (`AuthProvider.tsx:73-75`).
- **LiveTrack heartbeat freshness math** shared client + edge function (`livetrackSession.ts:196-201` ↔ `livetrack-session/index.ts:34`).
- **Auto-derivation of net weight from spc × serving weight** (`LiveTrackImportPage.tsx:542-545`, `:1043-1064`).
- **OFF-miss neutral copy** (`LiveTrackImportPage.tsx:1013`) — right tone.
- **Per-tool toggles with search** (`ToolsPage.tsx:201-275`).
- **Encrypted extension creds at rest** via pgcrypto + key-fallback (`20260303100000_encrypt_extension_credentials.sql`, `20260304070000_encryption_key_fallback.sql`).
