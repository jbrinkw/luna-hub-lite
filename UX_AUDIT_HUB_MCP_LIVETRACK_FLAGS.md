# UX Audit Findings — Flagged for Follow-up

This document tracks items from `UX_AUDIT_HUB_MCP_LIVETRACK.md` that were NOT auto-implemented in the same pass and need cross-cutting work or product decisions.

## FLAG-01 — Device pairing misplaced under ChefByte Settings → Scales tab

**Audit:** "Wrong placement: a platform-level device pairing concern lives inside ChefByte. Jeremy will look for 'scale' under `/hub/extensions` and find only Obsidian/Todoist/HA. No nav signpost from Hub."
**Source:** `apps/web/src/pages/chefbyte/ScalesTab.tsx`, `ExtensionsPage.tsx:10-36`, audit "Top 5" #3.
**Why flagged:** Cross-cutting refactor. Moving pairing into `/hub/extensions` (or a new `/hub/devices`) requires:

1. Lifting `ScalesTab` UI logic into a Hub-side component.
2. Defining whether scales become a 4th "extension" or get their own settings route.
3. Removing the duplicate device-pairing UI from ChefByte Settings.
4. Adjusting nav, breadcrumbs, and tests across both modules.
   **Owner:** Product decision needed — not an autonomous call. Once decided, mechanical follow-up.

## FLAG-02 — LiveTrackImportPage location

**Audit:** Wizard "buried under `/chef`" — should likely live under Hub or a top-level `/livetrack` path.
**Source:** `apps/web/src/pages/chefbyte/LiveTrackImportPage.tsx` (the wizard file itself).
**Why flagged:** Brief explicitly said "you can keep it where it is for now and implement loading-state fix in place; flag the misplacement." Loading state fix done in place; relocation deferred.
**Owner:** Same decision as FLAG-01 — bundle with the device-pairing relocation to keep nav consistent.

## FLAG-03 — Home Assistant credential test

**Audit:** "credential-test buttons to every extension card" — Home Assistant test endpoint not as well-defined as Obsidian/Todoist.
**Source:** `apps/web/src/components/hub/ExtensionCard.tsx`, `extensions/homeassistant/`.
**Why flagged:** HA needs a long-lived token + base URL probe (`GET {ha_url}/api/` with the token); response body shape varies by version. Each user's HA instance is a different host (potentially LAN-only) — the cloud Worker can't always reach it. Implemented Obsidian + Todoist cred tests; HA needs additional design on whether the test should go through the Worker or be skipped when the URL is private.
**Owner:** HA-specific networking decision (Worker → user HA reachability) before implementing.

## FLAG-04 — `mcp_tool_logs` "Last 5 calls" tail per extension card

**Audit:** "Pair credential test with a 'Last 5 calls' tail pulled from `mcp_tool_logs`."
**Source:** `apps/web/src/components/hub/ExtensionCard.tsx`, `hub.mcp_tool_logs` table.
**Why flagged:** Adding a query path for "last N tool calls per extension namespace per user" requires a new query (probably an RPC) and accompanying UI. Out of scope for this pass; prerequisite design (do we filter by tool name prefix? group by tool? show duration?) needs decision.
**Owner:** Product decision on the surface area, then implementation.

## FLAG-05 — OAuth consent body identical regardless of scopes

**Audit:** "OAuthConsent.tsx:131-150 — its consent body is identical regardless of scopes requested."
**Source:** `apps/web/src/pages/OAuthConsent.tsx`.
**Why flagged:** Out of scope of this pass (Hub + MCP + LiveTrack). Worth a separate small PR to render scope-aware consent bullets.

## FLAG-06 — Hub home onboarding checklist + "Finish setup" banner

**Audit:** "3-step Hub home checklist: 1. Profile, 2. Activate an app, 3. Generate MCP key." plus "Finish setup banner gated behind a profile-set flag."
**Source:** `apps/web/src/pages/hub/HubHomePage.tsx`.
**Why flagged:** Implemented the timezone capture at signup (closes part of the audit's #5). The richer onboarding checklist component is a separate visual/product design task — surface area, copy, dismiss persistence, and cross-module triggers all need decision.
**Owner:** Product/design pass, then implementation.

## FLAG-07 — Single-track scale (scale-03) wizard

**Audit:** "Single-track scale (scale-03): supported in the data model but the wizard hardcodes scale-02. Pairing scale-03 to a product is via scale_pairings row in ScalesTab.tsx — multi-page treasure hunt with no dedicated single-track wizard."
**Source:** `apps/web/src/pages/chefbyte/LiveTrackImportPage.tsx:298`, `ScalesTab.tsx:424-436`.
**Why flagged:** Designing a single-track wizard requires an additional state machine + UI, and would touch ChefByte (which is out of scope per the brief). Loading-state fix on the existing scale-02 path was the primary ask.

## FLAG-08 — Tooltip / "?" affordances across Hub

**Audit:** "Almost completely absent. One hint on day_start_hour. Zero tooltips, zero '?' affordances, zero linked docs."
**Source:** All Hub pages.
**Why flagged:** Building a tooltip system + adding hints on every settings field is a design system task with copy across many fields. Spot-fixed the timezone-default banner + MCP Quick Start + extension setup hints in this pass.

## FLAG-09 — Step indicator on LiveTrack wizard

**Audit:** "Add a step indicator: 'Step 2 of 4: Place container on scale'."
**Source:** `apps/web/src/pages/chefbyte/LiveTrackImportPage.tsx`.
**Why flagged:** The wizard has nine WizardState kinds, not a clean 4-step model. Mapping nine states to a linear step-indicator requires UX decision on which states count as "the same step" (e.g. is `analyzing` part of step 2 or its own?). Loading state for AI-tare was the highest-impact part of this finding and was implemented; the broader step-indicator is deferred.

## FLAG-10 — Rename context-blind "Start over" on error states

**Audit:** "Rename context-blind error-state 'Start over' to 'Try again' for transient failures, 'Start new session' for expired ones."
**Source:** `apps/web/src/pages/chefbyte/LiveTrackImportPage.tsx:927-935`.
**Why flagged:** Distinguishing transient vs fatal requires changing the error reducer to carry a "kind" (transient | fatal | expired) and adapting copy accordingly. Implementable but expands scope; left for a focused error-taxonomy pass.
