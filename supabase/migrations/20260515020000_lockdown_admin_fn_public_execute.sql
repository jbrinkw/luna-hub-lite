-- ════════════════════════════════════════════════════════════════════════════
-- T2 Privilege-Escalation lockdown — admin SECURITY DEFINER fns
-- ════════════════════════════════════════════════════════════════════════════
-- Deep-audit findings C-1, H-4, H-5, H-6, B1b(rls)-07.
--
-- Six SECURITY DEFINER functions accept a `p_user_id` argument, live in a
-- PostgREST-exposed schema (hub / coachbyte / chefbyte), and had EXECUTE
-- granted to PUBLIC (→ anon + authenticated). A re-CREATE migration dropped the
-- original REVOKE. SECURITY DEFINER bypasses RLS, and the inner
-- `WHERE user_id = p_user_id` is NOT a barrier because the attacker passes the
-- *victim's* own id. Net: any anon/authenticated caller reads or mutates another
-- tenant's data (live-confirmed: read another user's decrypted sk-ant key — C-1).
--
-- Two-layer fix per function (mirrors 20260429100000):
--   1. REVOKE EXECUTE FROM PUBLIC, anon, authenticated  (closes the live hole).
--   2. In-body auth.uid() guard as defense-in-depth      (survives a future
--      stray grant). The guard is a no-op for the service-role path because
--      auth.uid() is NULL under service_role — that is the legit MCP/edge caller
--      and the ONLY identity that should pass an arbitrary p_user_id.
--   3. Re-affirm GRANT EXECUTE ... TO service_role        (legit callers keep
--      working — MCP worker + edge functions call with service_role).
--
-- Guard shape (identical to 20260429100000) — auth.uid() is schema-qualified
-- (schema `auth`), so it resolves correctly under SET search_path = '':
--
--   IF (SELECT auth.uid()) IS NOT NULL
--      AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
--   THEN
--     RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
--       USING ERRCODE = 'insufficient_privilege';   -- SQLSTATE 42501
--   END IF;
--
-- The four SQL-language wrappers (consume_product_admin, complete_next_set_admin,
-- get_agent_system_prompt_admin, get_agent_voice_ack_admin) are re-expressed in
-- plpgsql so the imperative guard can run before the original body. Behavior,
-- signature, return type, SECURITY DEFINER and search_path are preserved; only
-- the guard is added.
--
-- NOTE on scope: a definitive sweep
--   (pg_proc WHERE prosecdef AND args ILIKE '%p_user_id%') found additional
--   SECURITY DEFINER functions in the `private` schema with PUBLIC EXECUTE, but
--   `private` is NOT in the PostgREST `schemas` list (config.toml:
--   public, graphql_public, hub, coachbyte, chefbyte), so those are not callable
--   over the API and are out of scope for this T2 fix. The six below are the
--   complete set of API-reachable, unguarded offenders.
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- 1. hub.get_agent_anthropic_key_admin(uuid)            [C-1] plpgsql
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hub.get_agent_anthropic_key_admin(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_enc_key TEXT;
  v_encrypted TEXT;
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_enc_key := coalesce(
    nullif(current_setting('app.settings.encryption_key', true), ''),
    'local-dev-fallback-key'
  );

  SELECT anthropic_key_encrypted INTO v_encrypted
  FROM hub.agent_settings
  WHERE user_id = p_user_id;

  IF v_encrypted IS NULL THEN RETURN NULL; END IF;

  RETURN extensions.pgp_sym_decrypt(v_encrypted::bytea, v_enc_key);
END;
$function$;

REVOKE EXECUTE ON FUNCTION hub.get_agent_anthropic_key_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hub.get_agent_anthropic_key_admin(uuid) TO service_role;

COMMENT ON FUNCTION hub.get_agent_anthropic_key_admin(uuid) IS
  'Decrypts p_user_id''s Anthropic key. service_role only (MCP/edge); auth.uid() guard + REVOKE block any authenticated/anon caller. [T2 lockdown]';

-- ─────────────────────────────────────────────────────────────────
-- 2. hub.get_agent_system_prompt_admin(uuid)            [H-6] sql→plpgsql
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hub.get_agent_system_prompt_admin(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_prompt TEXT;
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT system_prompt INTO v_prompt FROM hub.agent_settings WHERE user_id = p_user_id;
  RETURN v_prompt;
END;
$function$;

REVOKE EXECUTE ON FUNCTION hub.get_agent_system_prompt_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hub.get_agent_system_prompt_admin(uuid) TO service_role;

COMMENT ON FUNCTION hub.get_agent_system_prompt_admin(uuid) IS
  'Returns p_user_id''s agent system prompt. service_role only; auth.uid() guard + REVOKE block authenticated/anon. [T2 lockdown]';

-- ─────────────────────────────────────────────────────────────────
-- 3. hub.get_agent_voice_ack_admin(uuid)                [H-6] sql→plpgsql
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hub.get_agent_voice_ack_admin(p_user_id uuid)
RETURNS TABLE(voice_ack_enabled boolean, voice_ack_text text, voice_ack_delay_ms integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT s.voice_ack_enabled, s.voice_ack_text, s.voice_ack_delay_ms
  FROM hub.agent_settings s
  WHERE s.user_id = p_user_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION hub.get_agent_voice_ack_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hub.get_agent_voice_ack_admin(uuid) TO service_role;

COMMENT ON FUNCTION hub.get_agent_voice_ack_admin(uuid) IS
  'Returns p_user_id''s voice-ack config. service_role only; auth.uid() guard + REVOKE block authenticated/anon. [T2 lockdown]';

-- ─────────────────────────────────────────────────────────────────
-- 4. coachbyte.complete_next_set_admin(uuid,uuid,int,numeric)  [H-4] sql→plpgsql
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION coachbyte.complete_next_set_admin(
  p_user_id uuid, p_plan_id uuid, p_actual_reps integer, p_actual_load numeric
)
RETURNS TABLE(rest_seconds integer, completed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT * FROM private.complete_next_set(p_user_id, p_plan_id, p_actual_reps, p_actual_load);
END;
$function$;

REVOKE EXECUTE ON FUNCTION coachbyte.complete_next_set_admin(uuid, uuid, integer, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION coachbyte.complete_next_set_admin(uuid, uuid, integer, numeric) TO service_role;

COMMENT ON FUNCTION coachbyte.complete_next_set_admin(uuid, uuid, integer, numeric) IS
  'Completes p_user_id''s next planned set (MCP wrapper for private.complete_next_set). service_role only; auth.uid() guard + REVOKE block authenticated/anon. [T2 lockdown]';

-- ─────────────────────────────────────────────────────────────────
-- 5. chefbyte.consume_product_admin(...)                [B1b] sql→plpgsql
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION chefbyte.consume_product_admin(
  p_user_id uuid, p_product_id uuid, p_qty numeric, p_unit text,
  p_log_macros boolean, p_logical_date date, p_confirm_large_amount boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN private.consume_product(
    p_user_id, p_product_id, p_qty, p_unit, p_log_macros, p_logical_date, p_confirm_large_amount
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION chefbyte.consume_product_admin(uuid, uuid, numeric, text, boolean, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.consume_product_admin(uuid, uuid, numeric, text, boolean, date, boolean) TO service_role;

COMMENT ON FUNCTION chefbyte.consume_product_admin(uuid, uuid, numeric, text, boolean, date, boolean) IS
  'Consumes p_user_id''s stock + logs macros (MCP wrapper for private.consume_product). service_role only; auth.uid() guard + REVOKE block authenticated/anon. [T2 lockdown]';

-- ─────────────────────────────────────────────────────────────────
-- 6. chefbyte.add_to_shopping_admin(uuid,uuid,numeric)  [H-5] plpgsql
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION chefbyte.add_to_shopping_admin(
  p_user_id uuid, p_product_id uuid, p_qty numeric
)
RETURNS TABLE(out_cart_item_id uuid, out_product_id uuid, out_qty_containers numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM chefbyte.products p
    WHERE p.product_id = p_product_id
      AND p.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Product not found or not owned by user';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'qty_containers must be a positive finite number';
  END IF;

  RETURN QUERY
  INSERT INTO chefbyte.shopping_list AS sl (user_id, product_id, qty_containers)
  VALUES (p_user_id, p_product_id, p_qty)
  ON CONFLICT (user_id, product_id) DO UPDATE
    SET qty_containers = sl.qty_containers + EXCLUDED.qty_containers
  RETURNING sl.cart_item_id, sl.product_id, sl.qty_containers;
END;
$function$;

REVOKE EXECUTE ON FUNCTION chefbyte.add_to_shopping_admin(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.add_to_shopping_admin(uuid, uuid, numeric) TO service_role;

COMMENT ON FUNCTION chefbyte.add_to_shopping_admin(uuid, uuid, numeric) IS
  'Adds p_user_id''s product to their shopping list (MCP wrapper). service_role only; auth.uid() guard + REVOKE block authenticated/anon. [T2 lockdown]';
