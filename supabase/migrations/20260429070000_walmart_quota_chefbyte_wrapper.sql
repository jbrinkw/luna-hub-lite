-- 2026-04-29: walmart-scrape edge function calls
-- private.walmart_check_and_increment via PostgREST RPC, but PostgREST
-- only exposes (public, graphql_public, hub, coachbyte, chefbyte). The
-- direct call returns PGRST106 ("Invalid schema: private"), the edge
-- function 500s, and the test suite sees 500 instead of the expected
-- structured 503 on upstream forced failures.
--
-- Standard fix follows the apply_shelf_event_admin precedent: thin
-- chefbyte-schema wrapper that invokes the private function. Keeps the
-- atomic upsert + check logic in `private` (where SECURITY DEFINER
-- privilege should live) and exposes a callable surface in chefbyte.

CREATE OR REPLACE FUNCTION chefbyte.walmart_check_and_increment(
  p_user_id UUID,
  p_max     INT DEFAULT 100
) RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.walmart_check_and_increment(p_user_id, p_max);
$$;

REVOKE ALL ON FUNCTION chefbyte.walmart_check_and_increment(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.walmart_check_and_increment(UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.walmart_check_and_increment(UUID, INT) TO service_role;

COMMENT ON FUNCTION chefbyte.walmart_check_and_increment(UUID, INT)
  IS 'PostgREST-callable wrapper for private.walmart_check_and_increment. '
     'Edge functions invoke via /rest/v1/rpc/walmart_check_and_increment with '
     'content-profile=chefbyte. Logic stays in private; this is a thin pass-through.';
