# Phase 10: Integration + Polish
> Previous: phase-09b.md | Next: (done)

## Skills
test-driven-development, frontend-design, requesting-code-review (final phase)

## Build
- `apps/web/src/components/ModuleSwitcher.tsx` — cross-module navigation:
  - Hub / CoachByte / ChefByte switcher in main nav/menu
  - Only shows activated modules (reads hub.app_activations)
  - Navigates between /hub/*, /coach/*, /chef/* route groups
- `apps/web/src/components/OfflineIndicator.tsx`:
  - Connection status detection (navigator.onLine + Supabase Realtime heartbeat)
  - "No connection" banner when offline
  - All write buttons disabled when offline (via shared context)
  - "Last synced" timestamp display
- `apps/web/src/components/ErrorBoundary.tsx`:
  - Per-module error boundaries (Hub, CoachByte, ChefByte each wrapped independently)
  - Graceful fallback UI with error message + retry button
  - One module crash does not affect others
- `apps/web/src/components/SkeletonScreen.tsx`:
  - Loading skeleton components for lists, cards, tables, macro bars
  - Used across all modules during data fetch
- Final DB types regeneration: `pnpm --filter db-types generate`
- Update all docs in `docs/` to reflect final implementation state
- Verify all Realtime subscriptions are properly cleaned up on unmount

## Test (TDD)

### Browser: `apps/web/e2e/cross-module/full-journey.spec.ts`
- Sign up with email/password -> redirected to Hub
- Set display name + timezone + day_start_hour in profile
- Activate CoachByte -> CoachByte appears in module switcher
- Navigate to CoachByte -> create split -> bootstrap plan -> complete a set
- Activate ChefByte -> ChefByte appears in module switcher
- Navigate to ChefByte -> scanner page loads -> create product via purchase mode
- Switch back to Hub via module switcher -> profile intact
- Switch to CoachByte -> workout data still present
- Switch to ChefByte -> product still in inventory
- Deactivate CoachByte -> removed from module switcher, data gone
- ChefByte still accessible and data intact

### Browser: `apps/web/e2e/cross-module/offline-indicator.spec.ts`
- Simulate network disconnect (via Playwright context.setOffline)
- "No connection" banner appears
- Write buttons (save, submit, complete) are disabled
- Read-only content still visible from cache/state
- Simulate reconnect -> banner disappears, buttons re-enabled
- "Last synced" timestamp updates on reconnect

### Browser: `apps/web/e2e/cross-module/responsive-layout.spec.ts`
- Desktop viewport (1280x800): side navigation visible, full table layouts
- Tablet viewport (768x1024): navigation adapts, tables remain usable
- Mobile viewport (375x667): hamburger menu, card layouts replace tables
- Module switcher accessible at all viewport sizes

### Browser: `apps/web/e2e/cross-module/error-boundaries.spec.ts`
- Inject error in CoachByte module -> fallback UI shown with retry button
- Hub module still functional (navigable, profile editable)
- ChefByte module still functional (scanner loads)
- Click retry in CoachByte -> module attempts recovery
- Error in one module's component does not crash sibling modules

## Legacy Reference
N/A — cross-cutting concerns with no direct legacy equivalent.

## Commit
`feat: integration + polish`

## Acceptance
- [ ] Module switcher shows only activated modules, navigates between Hub / Coach / Chef
- [ ] Offline indicator: banner on disconnect, buttons disabled, "last synced" timestamp
- [ ] Error boundaries: per-module isolation, fallback UI, retry button, sibling modules unaffected
- [ ] Skeleton screens render during loading states across all modules
- [ ] DB types regenerated and up to date
- [ ] All docs updated to reflect final implementation
- [ ] All 6 flow tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/flows/`
- [ ] All browser tests pass: `pnpm --filter web exec playwright test`
- [ ] Final full suite passes: `supabase test db && pnpm test && pnpm typecheck && pnpm --filter web exec playwright test`
