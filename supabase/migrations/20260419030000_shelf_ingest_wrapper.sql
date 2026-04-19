-- Public wrapper for private.apply_shelf_event so the shelf-ingest edge
-- function can call it via PostgREST RPC. PostgREST only exposes schemas
-- listed in config.toml (`public`, `graphql_public`, `hub`, `coachbyte`,
-- `chefbyte`), so `private.*` functions can't be called over the REST API
-- directly — we add a thin pass-through in `chefbyte` and restrict execute
-- to service_role only.

CREATE OR REPLACE FUNCTION chefbyte.apply_shelf_event_admin(
  p_user_id      UUID,
  p_device_id    UUID,
  p_scale_id     TEXT,
  p_kind         TEXT,
  p_event_kind   TEXT,
  p_product_id   UUID,
  p_delta_g      NUMERIC,
  p_occurred_at  TIMESTAMPTZ
) RETURNS chefbyte.shelf_event_result
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.apply_shelf_event(
    p_user_id, p_device_id, p_scale_id, p_kind,
    p_event_kind, p_product_id, p_delta_g, p_occurred_at
  );
$$;

-- Lock it down — only service_role (used by the edge function) can call it.
REVOKE ALL ON FUNCTION chefbyte.apply_shelf_event_admin FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin TO service_role;
