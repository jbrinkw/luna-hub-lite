-- hub.api_keys lifecycle hardening — last_used_at tracking + logout revocation
--
-- Security gap: on `auth.signOut()`, the browser session dies but any
-- `hub.api_keys` rows survive. A stolen laptop's browser session ends but
-- the MCP API keys continue granting access indefinitely. This migration:
--
--   1. Adds `last_used_at` to `hub.api_keys` — updated by the MCP worker
--      on every successful auth (see bump_api_key_used_admin below). This
--      gives the user a signal ("not used in 45 days — revoke?") and sets
--      us up for future auto-revoke-on-stale policies.
--
--   2. Adds `revoke_keys_on_logout BOOLEAN` to `hub.profiles` — default
--      FALSE (keys survive logout; most users want CLI / MCP access to
--      persist across browser sessions). When TRUE, the web app calls
--      the `revoke_all_api_keys_admin` RPC before `supabase.auth.signOut()`.
--
--   3. Adds `revoke_all_api_keys_admin(UUID)` SECURITY DEFINER RPC —
--      sets revoked_at=now() on every non-revoked row for the caller.
--      Callable from both the web UI (via service_role wrapper) and
--      future server-side policies (e.g. auto-revoke job).
--
--   4. Adds `bump_api_key_used_admin(TEXT)` SECURITY DEFINER RPC — looks
--      up the key by hash, sets last_used_at=now(). Called from the MCP
--      worker's authenticateApiKey path so telemetry reaches the DB
--      without requiring the worker to know user_id.
--
-- Design notes:
--   • last_used_at is nullable (keys created before this migration have
--     no history). UI renders "never" for nulls.
--   • No trigger-based "touch on SELECT" — would produce excessive writes
--     under high tool-call load. We accept the extra RPC round-trip on
--     each auth (one per SSE connection open, not per tool call).
--   • bump_api_key_used_admin returns void (not the row) so the worker
--     doesn't accidentally leak hash material back into response headers.

BEGIN;

------------------------------------------------------------------
-- 1. last_used_at column
------------------------------------------------------------------

ALTER TABLE hub.api_keys
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NULL;

-- Index on (user_id, last_used_at) for "stale keys" queries later.
-- Partial WHERE revoked_at IS NULL since we never sort revoked rows by
-- last_used_at.
CREATE INDEX IF NOT EXISTS api_keys_user_last_used_idx
  ON hub.api_keys (user_id, last_used_at DESC NULLS LAST)
  WHERE revoked_at IS NULL;

------------------------------------------------------------------
-- 2. revoke_keys_on_logout preference on hub.profiles
------------------------------------------------------------------

ALTER TABLE hub.profiles
  ADD COLUMN IF NOT EXISTS revoke_keys_on_logout BOOLEAN NOT NULL DEFAULT FALSE;

------------------------------------------------------------------
-- 3. revoke_all_api_keys_admin(UUID) RPC
------------------------------------------------------------------
-- SECURITY DEFINER so the web UI can invoke via service-role wrapper
-- before calling supabase.auth.signOut() (at which point the user's JWT
-- is stale and direct UPDATE via RLS would fail). Returns the number of
-- rows revoked so the UI can report "3 keys revoked".

CREATE OR REPLACE FUNCTION private.revoke_all_api_keys(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE hub.api_keys
     SET revoked_at = now()
   WHERE user_id = p_user_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION private.revoke_all_api_keys(UUID) FROM PUBLIC;

-- Thin service-role wrapper in the `hub` schema (PostgREST-callable).
CREATE OR REPLACE FUNCTION hub.revoke_all_api_keys_admin(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.revoke_all_api_keys(p_user_id);
$$;
GRANT EXECUTE ON FUNCTION hub.revoke_all_api_keys_admin(UUID) TO authenticated, service_role;

------------------------------------------------------------------
-- 4. bump_api_key_used_admin(TEXT) RPC
------------------------------------------------------------------
-- Called by the MCP worker on every successful authenticateApiKey to
-- stamp last_used_at. Takes the already-hashed key so the worker doesn't
-- double-hash; also means the plaintext never reaches the DB.

CREATE OR REPLACE FUNCTION private.bump_api_key_used(p_api_key_hash TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE hub.api_keys
     SET last_used_at = now()
   WHERE api_key_hash = p_api_key_hash
     AND revoked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.bump_api_key_used(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hub.bump_api_key_used_admin(p_api_key_hash TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.bump_api_key_used(p_api_key_hash);
$$;
GRANT EXECUTE ON FUNCTION hub.bump_api_key_used_admin(TEXT) TO service_role;

COMMIT;
