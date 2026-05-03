-- Pi USB scanner forwarder (Task 5):
-- PostgREST exposes only (public, graphql_public, hub, coachbyte,
-- chefbyte) per supabase/config.toml. Direct
-- supabase.schema('private').rpc('execute_scan_action', ...) calls
-- from the shelf-ingest edge function return PGRST106 ("Invalid
-- schema: private") because the schema isn't on the API surface.
--
-- Standard fix follows the apply_shelf_event_admin /
-- walmart_check_and_increment precedent (migration 20260429070000):
-- thin chefbyte-schema SECURITY DEFINER wrapper that delegates to the
-- private function. Logic stays in private (where the SECURITY
-- DEFINER privilege belongs); chefbyte exposes a callable surface
-- for PostgREST RPC.
--
-- Callers invoke via:
--   supabase.schema('chefbyte').rpc('execute_scan_action', { ... })
-- which routes through PostgREST with content-profile=chefbyte.

CREATE OR REPLACE FUNCTION chefbyte.execute_scan_action(
  p_user_id            UUID,
  p_product_id         UUID,
  p_mode               TEXT,
  p_qty                NUMERIC,
  p_unit               TEXT,
  p_nutrition_snapshot JSONB
) RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.execute_scan_action(
    p_user_id, p_product_id, p_mode, p_qty, p_unit, p_nutrition_snapshot
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.execute_scan_action(
  UUID, UUID, TEXT, NUMERIC, TEXT, JSONB
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.execute_scan_action(
  UUID, UUID, TEXT, NUMERIC, TEXT, JSONB
) TO authenticated, service_role;

COMMENT ON FUNCTION chefbyte.execute_scan_action(
  UUID, UUID, TEXT, NUMERIC, TEXT, JSONB
) IS
  'PostgREST-callable wrapper for private.execute_scan_action. The '
  'shelf-ingest edge function and web client both invoke via '
  'supabase.schema(''chefbyte'').rpc(''execute_scan_action'', ...). '
  'Logic stays in private — this is a thin pass-through.';
