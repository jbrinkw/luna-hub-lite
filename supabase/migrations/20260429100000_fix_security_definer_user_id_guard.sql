-- 2026-04-29: Phase 1 audit (AUDIT_FINDINGS_PHASE1.md) flagged 3
-- SECURITY DEFINER functions that accept a `p_user_id` parameter
-- and are granted to `authenticated` WITHOUT verifying the caller's
-- auth.uid() matches the parameter. Result: any authenticated user
-- can pass another user's UUID and act on their behalf.
--
--   1. hub.revoke_all_api_keys_admin(UUID)              [CRITICAL]
--      → revoke another user's API keys
--   2. chefbyte.walmart_check_and_increment(UUID, INT)  [CRITICAL]
--      → burn another user's Walmart 100/day quota
--   3. private.generate_meal_product_name(UUID, TEXT, DATE) [HIGH]
--      → enumerate / probe another user's meal product names
--
-- Fix: add a guard at the top of each that rejects when called as
-- `authenticated` with a non-self p_user_id. service_role bypasses
-- the guard (legitimate admin / edge-function paths).
--
-- Pattern used in this file:
--
--   IF (SELECT auth.uid()) IS NOT NULL
--      AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
--   THEN
--     RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
--       USING ERRCODE = 'insufficient_privilege';
--   END IF;
--
-- The auth.role() / auth.uid() lookups are wrapped in (SELECT ...)
-- for the same reason every RLS policy in this codebase wraps them:
-- the planner caches the call so it runs once per query, not once
-- per row in any function that loops.

-- ─────────────────────────────────────────────────────────────────
-- 1. hub.revoke_all_api_keys_admin
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub.revoke_all_api_keys_admin(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT private.revoke_all_api_keys(p_user_id) INTO v_count;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION hub.revoke_all_api_keys_admin(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub.revoke_all_api_keys_admin(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION hub.revoke_all_api_keys_admin(UUID) IS
  'Revokes all of p_user_id''s API keys. Authenticated callers MUST pass their own auth.uid(); service_role bypasses the check for admin tooling.';

-- ─────────────────────────────────────────────────────────────────
-- 2. chefbyte.walmart_check_and_increment
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION chefbyte.walmart_check_and_increment(
  p_user_id UUID,
  p_max     INT DEFAULT 100
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT private.walmart_check_and_increment(p_user_id, p_max) INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION chefbyte.walmart_check_and_increment(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.walmart_check_and_increment(UUID, INT) TO authenticated, service_role;

COMMENT ON FUNCTION chefbyte.walmart_check_and_increment(UUID, INT) IS
  'PostgREST-callable wrapper for private.walmart_check_and_increment with caller-vs-target ownership guard. service_role (edge functions) bypasses; authenticated must pass their own auth.uid().';

-- ─────────────────────────────────────────────────────────────────
-- 3. private.generate_meal_product_name
-- ─────────────────────────────────────────────────────────────────
--
-- This one's a SECURITY DEFINER plpgsql function with its own logic
-- (not just a wrapper). The original function from
-- 20260424090000_invariant_batch.sql is preserved; we only add the
-- guard at the top.

CREATE OR REPLACE FUNCTION private.generate_meal_product_name(
  p_user_id UUID,
  p_base_name TEXT,
  p_logical_date DATE
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_date_part TEXT := to_char(p_logical_date, 'MM-DD');
  v_candidate TEXT;
  v_now       TIMESTAMPTZ := now();
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Layer 1: bare "[MEAL] <base> MM-DD" shape.
  v_candidate := '[MEAL] ' || p_base_name || ' ' || v_date_part;
  IF NOT EXISTS (
    SELECT 1
      FROM chefbyte.products
     WHERE user_id = p_user_id
       AND name = v_candidate
  ) THEN
    RETURN v_candidate;
  END IF;

  -- Layer 2: append HH:MM (UTC) to disambiguate.
  v_candidate := '[MEAL] ' || p_base_name || ' ' || v_date_part
                 || ' ' || to_char(v_now, 'HH24:MI');
  IF NOT EXISTS (
    SELECT 1
      FROM chefbyte.products
     WHERE user_id = p_user_id
       AND name = v_candidate
  ) THEN
    RETURN v_candidate;
  END IF;

  -- Layer 3: append HH:MM:SS. Two meals within the same second is
  -- sufficiently degenerate that we stop here and rely on the
  -- caller's ON CONFLICT DO NOTHING fallback (if any).
  v_candidate := '[MEAL] ' || p_base_name || ' ' || v_date_part
                 || ' ' || to_char(v_now, 'HH24:MI:SS');
  RETURN v_candidate;
END;
$$;

REVOKE ALL ON FUNCTION private.generate_meal_product_name(UUID, TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.generate_meal_product_name(UUID, TEXT, DATE) TO authenticated, service_role;

COMMENT ON FUNCTION private.generate_meal_product_name(UUID, TEXT, DATE) IS
  'Returns a chefbyte.products.name that does not collide with any existing row for p_user_id. Authenticated callers must pass their own auth.uid(); service_role (mark_meal_done) bypasses. Three layers: MM-DD, MM-DD HH:MM, MM-DD HH:MM:SS.';
