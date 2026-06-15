-- ════════════════════════════════════════════════════════════════════════════
-- T3 — MCP `_admin(p_user_id, …)` overloads for two service-role-broken tools
-- ════════════════════════════════════════════════════════════════════════════
-- Deep-audit findings H-17 (CHEFBYTE_update_recipe ingredient replace) and H-18
-- (CHEFBYTE_import_shopping_to_inventory).
--
-- ROOT CAUSE (theme T3): the MCP worker builds its Supabase client with the
-- service-role key and NO JWT attached (apps/mcp-worker/src/supabase.ts) — the
-- JWT is used only to derive ctx.userId. Inside any RPC, auth.uid() is therefore
-- NULL. Both tools below call a *plain public wrapper* that forwards
-- private.fn((SELECT auth.uid()), …):
--   * H-17 → chefbyte.save_recipe_ingredients(p_recipe_id, p_ingredients)
--            → private.save_recipe_ingredients(NULL, …)
--            → ownership guard NOT EXISTS(… user_id = NULL) → RAISE 'Recipe not found…'
--   * H-18 → chefbyte.import_shopping_to_inventory(p_location_id)
--            → private.import_shopping_to_inventory(NULL, …)
--            → location lookup WHERE user_id = NULL → RAISE 'No storage locations…'
-- Net: the ingredient-replace path and the entire import tool are 100% broken via
-- MCP (live-reproduced: both RAISE under SET ROLE service_role).
--
-- FIX (the pattern every other working ChefByte MCP mutation uses — e.g.
-- consume_product_admin, add_to_shopping_admin, complete_next_set_admin): add an
-- `_admin(p_user_id, …)` overload the handler calls with ctx.userId, delegating
-- to the SAME private function so behavior is identical to the authenticated path
-- (the H-18 underlying import's GHOST-IMPORT tombstone class — C-2 — is already
-- structurally fixed by the T1 revive trigger 20260515030000, so the delegated
-- private body is correct; this migration only adds the auth overload).
--
-- LOCKDOWN (theme T2, mirrors 20260515020000): each overload is service_role-only.
--   1. REVOKE EXECUTE FROM PUBLIC, anon, authenticated  (closes the API surface).
--   2. In-body auth.uid() guard — defense-in-depth: an authenticated caller can
--      never pass an arbitrary p_user_id (a future stray GRANT can't reopen the
--      hole). The guard is a NO-OP for service_role because auth.uid() is NULL —
--      that is the legit MCP/edge caller and the ONLY identity that should pass
--      an arbitrary p_user_id.
--   3. GRANT EXECUTE TO service_role.
-- auth.uid() is schema-qualified (schema `auth`), so it resolves under
-- SET search_path = ''.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- H-17 — chefbyte.save_recipe_ingredients_admin(uuid, uuid, jsonb)
-- ─────────────────────────────────────────────────────────────────
-- Delegates to private.save_recipe_ingredients(p_user_id, p_recipe_id,
-- p_ingredients) — the same body the 2-arg public wrapper uses, including the
-- recipe-ownership check and the atomic delete-old + insert-new replace.
CREATE OR REPLACE FUNCTION chefbyte.save_recipe_ingredients_admin(
  p_user_id uuid, p_recipe_id uuid, p_ingredients jsonb
)
RETURNS void
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

  PERFORM private.save_recipe_ingredients(p_user_id, p_recipe_id, p_ingredients);
END;
$function$;

REVOKE EXECUTE ON FUNCTION chefbyte.save_recipe_ingredients_admin(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.save_recipe_ingredients_admin(uuid, uuid, jsonb) TO service_role;

COMMENT ON FUNCTION chefbyte.save_recipe_ingredients_admin(uuid, uuid, jsonb) IS
  'Fully replaces p_user_id''s recipe ingredient list (MCP wrapper for '
  'private.save_recipe_ingredients). Fixes H-17: the MCP worker runs as '
  'service_role with no JWT, so the auth.uid()-based public wrapper sees '
  'p_user_id=NULL and always raises ''Recipe not found''. service_role only; '
  'auth.uid() guard + REVOKE block authenticated/anon. [T3 + T2 lockdown]';

-- ─────────────────────────────────────────────────────────────────
-- H-18 — chefbyte.import_shopping_to_inventory_admin(uuid, uuid)
-- ─────────────────────────────────────────────────────────────────
-- Delegates to private.import_shopping_to_inventory(p_user_id, p_location_id) —
-- the same body the 1-arg public wrapper uses (location resolution, stock_lot
-- merge/insert, imported_at stamping). Returns the private fn's JSONB verbatim
-- ({success, lots_processed, imported_at}).
CREATE OR REPLACE FUNCTION chefbyte.import_shopping_to_inventory_admin(
  p_user_id uuid, p_location_id uuid DEFAULT NULL
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

  RETURN private.import_shopping_to_inventory(p_user_id, p_location_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION chefbyte.import_shopping_to_inventory_admin(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.import_shopping_to_inventory_admin(uuid, uuid) TO service_role;

COMMENT ON FUNCTION chefbyte.import_shopping_to_inventory_admin(uuid, uuid) IS
  'Imports p_user_id''s purchased shopping rows into stock_lots (MCP wrapper for '
  'private.import_shopping_to_inventory). Fixes H-18: the MCP worker runs as '
  'service_role with no JWT, so the auth.uid()-based public wrapper sees '
  'p_user_id=NULL and always raises ''No storage locations found''. service_role '
  'only; auth.uid() guard + REVOKE block authenticated/anon. [T3 + T2 lockdown]';

COMMIT;
