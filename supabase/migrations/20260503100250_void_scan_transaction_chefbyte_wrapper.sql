-- Pi USB scanner forwarder (Task 6):
-- PostgREST exposes only (public, graphql_public, hub, coachbyte,
-- chefbyte) per supabase/config.toml. Direct
-- supabase.schema('private').rpc('void_scan_transaction', ...) calls
-- from the shelf-ingest edge function (or the web client) return
-- PGRST106 ("Invalid schema: private") because the schema isn't on the
-- API surface.
--
-- Mirrors the execute_scan_action wrapper added in
-- 20260503100150_execute_scan_action_chefbyte_wrapper.sql: thin
-- chefbyte-schema SECURITY DEFINER pass-through that delegates to the
-- private function. Logic stays in private (where the SECURITY DEFINER
-- privilege belongs); chefbyte exposes a callable surface for
-- PostgREST RPC.
--
-- IMPORTANT: this wrapper does NOT verify ownership. Callers (the
-- shelf-ingest /scan-transaction/:id/void route) MUST verify
-- chefbyte.scan_transactions.user_id = auth.uid() before invoking,
-- because the underlying private function operates by transaction_id
-- alone (it raises 'transaction_not_found' on missing rows but does
-- not enforce per-user ownership).
--
-- Callers invoke via:
--   supabase.schema('chefbyte').rpc('void_scan_transaction', { ... })
-- which routes through PostgREST with content-profile=chefbyte.

CREATE OR REPLACE FUNCTION chefbyte.void_scan_transaction(
  p_transaction_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM private.void_scan_transaction(p_transaction_id);
END;
$$;

REVOKE ALL ON FUNCTION chefbyte.void_scan_transaction(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.void_scan_transaction(UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION chefbyte.void_scan_transaction(UUID) IS
  'PostgREST-callable wrapper for private.void_scan_transaction. The '
  'shelf-ingest /scan-transaction/:id/void route (and the web client '
  'in the future) invoke via supabase.schema(''chefbyte'').rpc(...). '
  'Caller MUST verify ownership before invoking — the private function '
  'operates by transaction_id only.';
