# UX Audit Round 2 — Hub + LiveTrack Pairing + MCP

Round 1: `UX_AUDIT_HUB_MCP_LIVETRACK.md`. Round 1 flags: `UX_AUDIT_HUB_MCP_LIVETRACK_FLAGS.md`. The R1 fix-batch agent died mid-run; salvage commit `34dc1a5` plus a manual ExtensionCard finish landed the work — this pass verifies what actually shipped.

## What changed since round 1

**Landed:**

- **MCP endpoint flipped to `/mcp` (Streamable HTTP).** `McpSettingsPage.tsx:50-51` now derives `baseUrl` from `VITE_MCP_URL` and renders `${baseUrl}/mcp`. Comment at `:47-49` documents the DO-billing rationale.
- **Quick Start card.** `McpSettingsPage.tsx:281-323` adds an ordered list naming "Settings → Connectors → Add custom MCP" plus a copy-pasteable snippet (`:301-306`) and a docs link.
- **Test connection card.** `McpSettingsPage.tsx:329-378` fires `JSON-RPC method:'ping'` against the endpoint; success/fail rendered inline (`:360-372`). Worker handler exists at `apps/mcp-worker/src/stateless.ts:27-28`.
- **Timezone capture at signup.** `Signup.tsx:15-22` `detectBrowserTimezone()`, banner at `:113-129`, threaded through `AuthProvider.signUp` (`:98-119`) into `raw_user_meta_data.timezone`. The DB trigger `private.handle_new_user` already reads that key (`supabase/migrations/20260302014004_create_schemas.sql:44`), so the wiring lands cleanly. **Cross-cutting verified:** ChefByte's `private.get_logical_date()` reads `hub.profiles.timezone`, so a Pacific signup now gets correct day-boundaries from session 1.
- **Deactivation confirm modal with destructive copy.** `AppActivationCard.tsx:38-87` per-app data-loss bullet list (`:53-68`), red "Yes, delete my data" button. Tests at `AppActivationCard.test.tsx:38-72` cover the flow.
- **ToolsPage extension lists synced to worker registry.** `ToolsPage.tsx:82-117` matches `extensions/{obsidian,todoist,homeassistant}/tools/index.ts` exactly. Stale `OBSIDIAN_search_notes` entry from R1 is gone.
- **ExtensionCard SETUP_HINTS + Test connection.** `ExtensionCard.tsx:19-43` per-extension help blocks render at `:199-219`; `Test connection` button at `:233-242` calls `probeExtensionCredentials` (`:67-112`) for Obsidian + Todoist.

**Intentionally deferred per FLAGS:** ScalesTab Pi-side instructions / device pairing relocation (FLAG-01/02), HA cred test (FLAG-03), `mcp_tool_logs` per-extension tail (FLAG-04), scope-aware OAuth consent (FLAG-05), Hub onboarding checklist (FLAG-06), scale-03 wizard (FLAG-07), tooltip system (FLAG-08), step indicator (FLAG-09), error taxonomy on "Start over" (FLAG-10).

---

## Findings

### F1 — AI-tare loading state was NOT implemented (FLAG-09 claims partial fix that didn't land)

`UX_AUDIT_HUB_MCP_LIVETRACK_FLAGS.md:67` claims "Loading state for AI-tare was the highest-impact part of this finding and was implemented." The code disagrees. `LiveTrackImportPage.tsx:97-135` defines `WizardState` with no `awaiting_ai_tare` kind. `requestAiTare` (`:585-597`) patches the **server** session to `state: 'awaiting_ai_tare'` but the local wizard reducer stays in `'product_loaded'`. The render branch for `product_loaded` (`:885-913`, AutoTarePanel at `:1145-1177`) shows the "Request AI tare from Pi" button (`:1147-1155`) with no `disabled`/`loading`/spinner conditioning on `session.state === 'awaiting_ai_tare'`. After click, the button stays clickable, no spinner appears, no cancel surfaces. R1's #4 ask is unaddressed. No tests exist for the loading state (`grep -r livetrack-ai-tare-btn apps/web/src/__tests__` returns nothing).

### F2 — Documentation references to `/sse` are stale

UI now uses `/mcp` but two docs still say `/sse`:

- `docs/apps/hub.md:20` — "endpoint URL `https://mcp.lunahub.dev/sse`, SSE transport". Direct contradiction with current UI.
- `docs/ascii-layouts.md:113-114` — `Endpoint https://mcp.lunahub.dev/sse` + `Transport SSE` in the MCP Settings layout.

CLAUDE.md mandates docs stay in sync with code; this slipped.

**Existing-user impact:** safe. `apps/mcp-worker/src/index.ts:218-285` routes `POST /sse` through `handleStatelessMcp` (same as `POST /mcp`), so existing `/sse` configs keep working without spawning DOs. Doc drift only misleads new readers.

### F3 — `claudeSnippet` is not actually paste-able into Claude.ai

`McpSettingsPage.tsx:173` builds:

```
${endpointUrl}\n\nAuthorization: Bearer <paste-your-key-here>
```

Claude.ai's "Add custom MCP" UI takes a URL field and a Bearer token field as **separate inputs**, not a multi-line blob. Users will copy this and have nowhere to paste it as a unit — they'll have to manually split it. The Quick Start step 3 ("Paste the endpoint and key below") gets the framing right, but the snippet itself sells a single-paste experience that doesn't exist. Either render two separately-copyable fields (URL / token-placeholder) or drop the "snippet" framing.

### F4 — `Test connection` flow has a UX dead-end after Save

`ExtensionCard.tsx:151-172` `handleSave` clears `setCredentials({})` (`:170`) on success. `handleTest` (`:174-178`) reads from in-form `credentials` — never from already-stored encrypted credentials. Two consequences:

1. Save → Test is impossible without re-typing the secret.
2. Returning to a previously-configured extension shows `Credentials configured` badge (`:191-195`) but Test connection always fails because the form is empty until the user re-enters the secret. There's no "test stored credentials" path. R1's #2 ("closes the silent-misconfiguration trap") only closes it for first-time setup; reconfirmation later is impossible without retyping.

Mitigation: route `handleTest` through a server-side probe that uses already-stored creds (a small RPC), or persist a local "test buffer" before clearing the form on save.

### F5 — `Test connection` runs from the browser, not the worker

`probeExtensionCredentials` (`ExtensionCard.tsx:67-112`) calls `api.github.com` and `api.todoist.com` directly from the user's browser. This tests browser → upstream reachability, not Worker → upstream reachability — which is what actually matters at tool-call time. Three concrete risks:

- A token gated by IP allow-list at the user's egress will pass the in-browser test then fail at the Worker.
- Todoist's CORS policy may not include arbitrary origins; the call may fail with a CORS error that the user reads as "auth failed" (probe surfaces it as a generic `Network error`, `:107`).
- Any future extension that requires non-CORS-permissive endpoints (e.g. self-hosted Gitea on a private network) is unwireable on this design.

This is also the exact reason FLAG-03 deferred HA — but the same logic applies to GitHub/Todoist for non-trivial deployments. Note in copy that "this tests reachability from your browser" or move probe behind the worker.

### F6 — `VITE_MCP_URL` undocumented

`apps/web/src/pages/hub/McpSettingsPage.tsx:50` and `AgentPage.tsx:35` both read `import.meta.env.VITE_MCP_URL` with the production fallback. `apps/web/.env.example` only lists `VITE_SUPABASE_URL` + anon key; new contributors forking for local dev have no signal that they should override this. Low-impact but it is a regression — adding env-driven config without examples.

### F7 — Signup banner promises a 6 AM day-start the user can't change at signup

`Signup.tsx:118-128` says "We'll set your timezone to … with a 6 AM day-start. You can change both later in Hub → Account." The "6 AM" is hardcoded — `signUp` only forwards timezone (`AuthProvider.tsx:105-113`), never `day_start_hour`. The trigger uses `DEFAULT 6` (`20260302014004_create_schemas.sql:18`). Whether the user wants 4 AM (early-rise athletes) or 12 AM (default-civic) they cannot capture intent at signup. Either drop "6 AM" from the banner copy (since the user can't act on it) or expose a 0–23 picker. R1's #5 explicitly asked for both being captured.

### F8 — Deactivate uses single-click confirm, not typed-confirmation

`AppActivationCard.tsx:76-86` confirms with one button click. R1 framing called this out for "destructive flows" — single-click confirm on full-database delete is still light. A typed-confirmation gate ("type DELETE to confirm") matches the other industry baselines for delete-all-data UX. Not a regression — it's the same gate R1 flagged, only now wrapped in a modal. Worth bumping severity.

### F9 — No regression test coverage for new R1 surfaces

- Signup tz banner: nothing in `apps/web/src/__tests__/` references `signup-tz-banner` / `detectBrowserTimezone`.
- McpSettingsPage Quick Start + Test connection: no tests reference `mcp-claude-snippet`, `mcp-test-key-input`, `mcp-test-connection`.
- ExtensionCard Test button: no tests for `probeExtensionCredentials`. The `testProbe` injection point at `ExtensionCard.tsx:128` is unused.

R1 salvaged work is undertested — these surfaces will silently regress on the next refactor.

---

## Things still working well

- AppActivationCard's per-app bullet list (`:53-68`) names exactly what gets deleted. Best in-Hub destructive copy.
- Timezone wiring end-to-end (`Signup.tsx` → `AuthProvider` → `raw_user_meta_data` → trigger → `hub.profiles.timezone` → `private.get_logical_date()`) is clean and auditable.
- `ToolsPage` tool list now matches the worker registry exactly (verified against `extensions/*/tools/index.ts`).
- MCP Test connection's `ping` path is genuinely cheap — `stateless.ts:27-28` returns `{}` with zero subrequests, so the user can test repeatedly without burning quota.
- `POST /sse` legacy compatibility (`apps/mcp-worker/src/index.ts:218-285`) is preserved cleanly — no orphan users from the endpoint flip.
