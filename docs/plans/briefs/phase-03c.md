# Phase 03c: Hub Layout Shell

> Previous: phase-03b.md | Next: phase-03d.md

## Skills

frontend-design, context7 (Ionic React, React Router 6)

## Build

- `apps/web/src/components/hub/HubLayout.tsx` — side nav + content area wrapper
- `apps/web/src/components/hub/SideNav.tsx` — navigation links: Account, Apps, Tools, Extensions, MCP Settings
- `apps/web/src/components/hub/HubHeader.tsx` — header bar with page title + offline indicator placeholder + logout button
- `apps/web/src/components/ModuleSwitcher.tsx` — Hub / CoachByte / ChefByte navigation (shared across modules)
- Wire Hub routes into `apps/web/src/App.tsx`:
  - `/hub` -> redirect to `/hub/account`
  - `/hub/account` -> Account page (placeholder)
  - `/hub/apps` -> Apps page (placeholder)
  - `/hub/tools` -> Tools page (placeholder)
  - `/hub/extensions` -> Extensions page (placeholder)
  - `/hub/mcp` -> MCP Settings page (placeholder)

## Test (TDD)

### Browser: `apps/web/e2e/hub/navigation.spec.ts`

- Log in -> land on /hub
- Click "Account" in side nav -> /hub/account page renders with profile form (placeholder OK)
- Click "Apps" -> /hub/apps renders with activation cards (placeholder OK)
- Click "Tools" -> /hub/tools renders with tool toggles (placeholder OK)
- Click "Extensions" -> /hub/extensions renders with extension cards (placeholder OK)
- Click "MCP Settings" -> /hub/mcp renders with endpoint URL + key management (placeholder OK)
- Active page highlighted in nav
- Module switcher: click CoachByte -> navigates to /coach
- Module switcher: click ChefByte -> navigates to /chef

## Legacy Reference

- `legacy/luna-hub/hub_ui/src/pages/ExtensionManager.jsx` — nav pattern, side menu structure
- `legacy/luna-hub/hub_ui/src/pages/MCPToolManager.jsx` — tool manager page layout pattern
- `legacy/chefbyte-vercel/apps/web/src/components/ProtectedRoute.tsx` — route guard integration

## Commit

`feat: hub layout shell with side navigation`

## Acceptance

- [ ] Side nav renders with 5 links (Account, Apps, Tools, Extensions, MCP Settings)
- [ ] Clicking each nav link navigates to correct route
- [ ] Active page highlighted in nav
- [ ] Module switcher navigates between /hub, /coach, /chef
- [ ] Header renders with page title and logout button
- [ ] Browser tests pass: `pnpm --filter web exec playwright test e2e/hub/navigation.spec.ts`
- [ ] `pnpm typecheck` passes
