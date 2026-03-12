# Phase 03d: Hub Pages -- Account, Apps, MCP Settings

> Previous: phase-03c.md | Next: phase-03e.md

## Skills

test-driven-development, frontend-design, context7 (Ionic React, Supabase)

## Build

- `apps/web/src/pages/hub/AccountPage.tsx` — profile form: display_name, timezone (IANA dropdown), day_start_hour (0-23 dropdown), save button
- `apps/web/src/pages/hub/AccountPage.tsx` — security section: change password (current + new + confirm)
- `apps/web/src/pages/hub/AppsPage.tsx` — CoachByte/ChefByte activation cards with active/inactive status + confirm deactivation modal
- `apps/web/src/components/hub/AppActivationCard.tsx` — reusable card: app name, status, activate/deactivate buttons, confirmation modal
- `apps/web/src/pages/hub/McpSettingsPage.tsx` — endpoint URL display (https://mcp.lunahub.dev/sse), API key generation/view-once/revoke
- `apps/web/src/components/hub/ApiKeyGenerator.tsx` — generate button, show-once plaintext display, copy-to-clipboard, dismiss, active keys list with revoke

## Test (TDD)

### Unit: `apps/web/src/__tests__/unit/hub/AppActivationCard.test.tsx`

- Shows app name and current status (active/inactive)
- Activate button calls activate mutation
- Deactivate button shows confirmation modal first
- Confirm deactivation -> calls deactivate mutation
- Cancel deactivation -> modal closes, no mutation

### Unit: `apps/web/src/__tests__/unit/hub/ApiKeyGenerator.test.tsx`

- Click generate -> calls generate mutation -> displays plaintext key
- Key is visible only once — after dismiss button clicked, key hidden
- Copy-to-clipboard button copies key to clipboard
- Multiple clicks on generate -> generates new key each time
- Error from mutation -> shows error message

### Integration: `apps/web/src/__tests__/integration/hub/profile-crud.test.ts`

- Load profile -> returns correct fields (display_name, timezone, day_start_hour)
- Update display_name -> persists to DB
- Update timezone to valid IANA name -> persists
- Update day_start_hour to valid value (0-23) -> persists
- Reload after update -> shows updated values
- Update multiple fields at once -> all persist

### Integration: `apps/web/src/__tests__/integration/hub/api-key-lifecycle.test.ts`

(Already created in 03b — extend or reuse)

- Generate API key -> plaintext returned to caller
- Verify DB stores SHA-256 hash (not plaintext)
- Query active keys -> newly generated key included
- Revoke key -> sets revoked_at timestamp
- Query active keys after revoke -> revoked key excluded
- Generate multiple keys -> all returned in active query
- Revoke one of multiple -> only that one excluded

### Integration: `apps/web/src/__tests__/integration/hub/app-activation.test.ts`

(Already created in 03b — extend or reuse)

- Activate CoachByte -> verify hub.app_activations row exists
- Deactivate CoachByte -> verify row deleted
- Hub profile still intact after deactivation
- Activate + deactivate + reactivate -> clean cycle

### Browser: `apps/web/e2e/hub/profile.spec.ts`

- Navigate to Account page -> form shows current values
- Edit display_name -> click Save -> success feedback
- Reload page -> display_name shows updated value
- Change timezone dropdown -> save -> persists
- Change day_start_hour dropdown -> save -> persists
- Change password -> enter current + new -> save -> can log in with new password

### Browser: `apps/web/e2e/hub/app-activation.spec.ts`

- Navigate to Apps page -> see CoachByte and ChefByte cards
- Both initially inactive
- Click Activate on CoachByte -> card shows "Active" status
- Navigate to /coach -> page renders (not "app not activated" error)
- Click Deactivate on CoachByte -> confirmation modal appears
- Click Cancel -> modal closes, app still active
- Click Confirm -> card shows "Inactive"
- Navigate to /coach -> redirected or shows "not activated" message

### Browser: `apps/web/e2e/hub/api-keys.spec.ts`

- Navigate to MCP Settings -> see endpoint URL displayed
- Click Generate API Key -> key displayed in read-only field
- Key is visible (shown once)
- Click Copy -> clipboard contains the key
- Dismiss/close the key display -> key is hidden permanently
- Key appears in active keys list (label + created date, no plaintext)
- Click Revoke on a key -> key removed from active list
- Multiple keys: generate 2 -> both in list -> revoke 1 -> only 1 remains

## Legacy Reference

- `legacy/luna-hub/hub_ui/src/context/AuthContext.jsx` — session validation, profile loading
- `legacy/luna-hub/core/utils/agent_api.py` — API key generation pattern
- `legacy/chefbyte-vercel/apps/web/src/contexts/AuthContext.tsx` — useAuth() hook for profile data
- `legacy/chefbyte-vercel/apps/web/src/lib/supabase.ts` — Supabase client query patterns

## Commit

`feat: hub pages -- account, apps, MCP settings`

## Acceptance

- [ ] Account page: can edit display_name, timezone, day_start_hour and save
- [ ] Account page: can change password
- [ ] Apps page: can activate/deactivate CoachByte and ChefByte with confirmation modal
- [ ] MCP Settings: can generate API key (shown once), copy, dismiss, revoke
- [ ] Unit tests pass: `pnpm --filter web test -- run src/__tests__/unit/hub/AppActivationCard src/__tests__/unit/hub/ApiKeyGenerator`
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/hub/profile-crud src/__tests__/integration/hub/api-key-lifecycle src/__tests__/integration/hub/app-activation`
- [ ] Browser tests pass: `pnpm --filter web exec playwright test e2e/hub/profile.spec.ts e2e/hub/app-activation.spec.ts e2e/hub/api-keys.spec.ts`
- [ ] `pnpm typecheck` passes
