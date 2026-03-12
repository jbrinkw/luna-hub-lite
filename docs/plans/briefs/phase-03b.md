# Phase 03b: Hub DB

> Previous: phase-03a.md | Next: phase-03c.md

## Skills

test-driven-development, context7 (Supabase, pgTAP)

## Build

- `supabase/migrations/<timestamp>_hub_tables.sql`:
  - `hub.app_activations` — user_id UUID REFERENCES auth.users ON DELETE CASCADE, app_name TEXT, activated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, app_name)
  - `hub.api_keys` — id UUID PK, user_id UUID REFERENCES auth.users ON DELETE CASCADE, api_key_hash TEXT NOT NULL, label TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ
  - `hub.user_tool_config` — id UUID PK, user_id UUID REFERENCES auth.users ON DELETE CASCADE, tool_name TEXT, enabled BOOLEAN DEFAULT true, UNIQUE(user_id, tool_name)
  - `hub.extension_settings` — id UUID PK, user_id UUID REFERENCES auth.users ON DELETE CASCADE, extension_name TEXT, enabled BOOLEAN DEFAULT false, credentials_encrypted TEXT (Vault), UNIQUE(user_id, extension_name)
- RLS policies on all new tables: `(select auth.uid()) = user_id TO authenticated`
- `private.activate_app(p_app_name TEXT)` — Phase 3b stub: INSERT INTO hub.app_activations, SECURITY DEFINER, SET search_path = ''
- `private.deactivate_app(p_app_name TEXT)` — Phase 3b stub: DELETE FROM hub.app_activations, SECURITY DEFINER, SET search_path = ''
- `hub.activate_app(p_app_name TEXT)` — thin RPC wrapper delegating to private.activate_app
- `hub.deactivate_app(p_app_name TEXT)` — thin RPC wrapper delegating to private.deactivate_app
- Run `supabase db push` + regenerate DB types (`pnpm --filter db-types generate`)

## Test (TDD)

### pgTAP: `supabase/tests/hub/api_keys.test.sql`

- Insert API key hash for user -> row created with correct fields
- Query active keys (WHERE revoked_at IS NULL) -> returns the key
- Revoke key (SET revoked_at = NOW()) -> key excluded from active query
- Insert multiple keys for same user -> all returned in active query
- Revoke one of multiple -> only revoked one excluded
- RLS: User B cannot see User A's keys
- RLS: User A can INSERT api_key with own user_id
- RLS: User B cannot INSERT api_key with User A's user_id
- RLS: User A can DELETE own api_key
- RLS: User B cannot DELETE User A's api_key

### pgTAP: `supabase/tests/hub/activation.test.sql`

- Call hub.activate_app('coachbyte') -> verify hub.app_activations row created
- Call hub.deactivate_app('coachbyte') -> verify hub.app_activations row deleted
- Deactivate app that's not activated -> no-op, no error
- Activate + deactivate + reactivate -> clean cycle, no errors

### Integration: `apps/web/src/__tests__/integration/hub/app-activation.test.ts`

- Activate CoachByte -> verify hub.app_activations row exists
- Deactivate CoachByte -> verify hub.app_activations row deleted
- Verify Hub profile still intact after deactivation
- Activate + deactivate + reactivate -> clean cycle

### Integration: `apps/web/src/__tests__/integration/hub/api-key-lifecycle.test.ts`

- Generate API key -> plaintext returned to caller
- Verify DB stores SHA-256 hash (not plaintext)
- Query active keys -> newly generated key included
- Revoke key -> sets revoked_at timestamp
- Query active keys after revoke -> revoked key excluded
- Generate multiple keys -> all returned in active query
- Revoke one of multiple -> only that one excluded

## Legacy Reference

- `legacy/luna-hub/core/utils/agent_api.py` — API key generation pattern (SHA-256 hashing)
- `legacy/luna-hub/hub_ui/src/context/AuthContext.jsx` — session validation
- `legacy/luna_ext_coachbyte/services/api/server.py` — embedded schema definitions (architecture reference)

## Commit

`feat: hub DB tables + activation stubs + RLS`

## Acceptance

- [ ] Migration applies cleanly via `supabase db push`
- [ ] DB types regenerated successfully
- [ ] RLS blocks cross-user access on all 4 new tables
- [ ] INSERT/DELETE RLS isolation verified on hub.api_keys (completes pattern from Phase 2)
- [ ] activate_app/deactivate_app stubs work (insert/delete hub.app_activations row)
- [ ] pgTAP tests pass: `supabase test db`
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/hub/app-activation src/__tests__/integration/hub/api-key-lifecycle`
- [ ] `pnpm typecheck` passes with new DB types
