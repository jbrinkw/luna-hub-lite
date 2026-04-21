-- Public wrapper so authenticated callers can invoke apply_event_override.
-- The core function lives in `private` (not in the PostgREST-exposed set),
-- and the `private` schema USAGE isn't granted to `authenticated`. This
-- thin forward-wrapper in `chefbyte` schema exposes the same contract.
--
-- The wrapper is SECURITY DEFINER + SET search_path='' so it can cross
-- into `private` regardless of caller's search_path. auth.uid() resolves
-- correctly because SECURITY DEFINER preserves the caller's auth context
-- (the "current user" in Postgres terms differs from auth.uid()).

CREATE OR REPLACE FUNCTION chefbyte.apply_event_override(
  p_client_event_id        TEXT,
  p_stock_qty_override     NUMERIC DEFAULT NULL,
  p_macros_servings_override NUMERIC DEFAULT NULL,
  p_calories_override      NUMERIC DEFAULT NULL,
  p_protein_override       NUMERIC DEFAULT NULL,
  p_carbs_override         NUMERIC DEFAULT NULL,
  p_fat_override           NUMERIC DEFAULT NULL,
  p_macro_logging_enabled  BOOLEAN DEFAULT TRUE,
  p_is_voided              BOOLEAN DEFAULT FALSE
) RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.apply_event_override(
    p_client_event_id,
    p_stock_qty_override,
    p_macros_servings_override,
    p_calories_override,
    p_protein_override,
    p_carbs_override,
    p_fat_override,
    p_macro_logging_enabled,
    p_is_voided
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN
) TO authenticated;
