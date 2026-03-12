# Phase 03e: Hub Pages -- Tools, Extensions + Hub Tests

> Previous: phase-03d.md | Next: phase-04a.md

## Skills

test-driven-development, frontend-design, requesting-code-review (phase boundary)

## Build

- `apps/web/src/pages/hub/ToolsPage.tsx` — tool list table with tool name, description, per-tool enable/disable toggle
- `apps/web/src/components/hub/ToolToggle.tsx` — reusable toggle row: tool name, description, IonToggle, loading state
- `apps/web/src/pages/hub/ExtensionsPage.tsx` — Obsidian/Todoist/Home Assistant cards with enable toggle + credential forms
- `apps/web/src/components/hub/ExtensionCard.tsx` — reusable card: extension name, description, enabled toggle, credential form (shown when enabled), save button, validation

## Test (TDD)

### Unit: `apps/web/src/__tests__/unit/hub/ToolToggle.test.tsx`

- Renders list of tools with names and descriptions
- Each tool has a toggle switch showing enabled/disabled state
- Toggling calls update mutation with correct tool_name + enabled value
- Disabled state shown correctly for each tool
- Loading state while mutation in flight

### Unit: `apps/web/src/__tests__/unit/hub/ExtensionCard.test.tsx`

- Renders extension name, description, enabled/disabled status
- Enable toggle calls update mutation
- When enabled, credential form fields appear
- Save credentials button calls save mutation with field values
- Empty required credential -> shows validation error
- Disabled state hides credential form

### Integration: `apps/web/src/__tests__/integration/hub/tool-config.test.ts`

- Toggle tool enabled -> DB updated correctly
- Toggle tool disabled -> DB updated correctly
- Load config -> returns correct enabled/disabled state for all tools
- Deactivating app -> its tools removed from config
- Reactivating app -> tools restored with default state

### Integration: `apps/web/src/__tests__/integration/hub/extension-settings.test.ts`

- Enable extension -> extension_settings row created
- Save credentials -> stored (via Vault RPC)
- Load extension settings -> returns correct enabled state + credential status (has credentials, not the plaintext)
- Disable extension -> row updated
- Save credentials for disabled extension -> still stored (enable without re-entering)
- Delete/clear credentials -> credential removed
- RLS: User B cannot see User A's extension settings

### Browser: `apps/web/e2e/hub/navigation.spec.ts` (extend from 03c)

- Tools page link renders tool toggles
- Extensions page link renders extension cards

### Browser: full Hub e2e suite (all 5 specs run together)

- `e2e/hub/auth.spec.ts`
- `e2e/hub/navigation.spec.ts`
- `e2e/hub/profile.spec.ts`
- `e2e/hub/app-activation.spec.ts`
- `e2e/hub/api-keys.spec.ts`

## Legacy Reference

- `legacy/luna-hub/hub_ui/src/pages/ExtensionManager.jsx` — extension enable/disable UI, credential forms
- `legacy/luna-hub/hub_ui/src/pages/MCPToolManager.jsx` — tool toggle table layout
- `legacy/luna-hub/core/utils/extension_discovery.py` — extension manifest loading pattern
- `legacy/luna-hub/core/utils/tool_discovery.py` — tool registry pattern

## Commit

`feat: hub pages -- tools, extensions + full hub test suite`

## Acceptance (Phase 3 overall)

- [ ] Can sign up, login, edit profile, activate/deactivate apps
- [ ] Can generate/revoke API keys (show-once pattern)
- [ ] Can toggle tools enabled/disabled
- [ ] Can enable extensions and save credentials
- [ ] All Hub unit tests pass: `pnpm --filter web test -- run src/__tests__/unit/hub/`
- [ ] All Hub integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/hub/`
- [ ] All Hub browser tests pass: `pnpm --filter web exec playwright test e2e/hub/`
- [ ] All pgTAP tests pass: `supabase test db`
- [ ] Full phase boundary check: `supabase test db && pnpm test && pnpm typecheck && pnpm --filter web exec playwright test e2e/hub/`
