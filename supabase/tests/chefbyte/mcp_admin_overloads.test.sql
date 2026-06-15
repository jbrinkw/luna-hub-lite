-- ════════════════════════════════════════════════════════════════════════════
-- T3 — MCP `_admin(p_user_id, …)` overloads for the two service-role-broken tools
-- ════════════════════════════════════════════════════════════════════════════
-- Deep-audit findings H-17 (CHEFBYTE_update_recipe) and H-18
-- (CHEFBYTE_import_shopping_to_inventory).
--
-- ROOT CAUSE (theme T3): the MCP worker builds its Supabase client with the
-- service-role key and NO JWT attached (apps/mcp-worker/src/supabase.ts) — the
-- JWT is only used to derive ctx.userId. Inside any RPC, auth.uid() is therefore
-- NULL. The two tools below call a *plain public wrapper* that forwards
-- private.fn((SELECT auth.uid()), …) → p_user_id = NULL → the ownership / location
-- lookup keyed on p_user_id finds nothing → the tool ALWAYS errors:
--   * H-17: chefbyte.save_recipe_ingredients(p_recipe_id, p_ingredients)
--           → private.save_recipe_ingredients(NULL, …) → 'Recipe not found …'
--   * H-18: chefbyte.import_shopping_to_inventory(p_location_id)
--           → private.import_shopping_to_inventory(NULL, …) → 'No storage locations …'
-- Live-reproduced before this fix: both RAISE under SET ROLE service_role.
--
-- FIX (the pattern every other working ChefByte MCP mutation uses): add an
-- `_admin(p_user_id, …)` overload the handler calls with ctx.userId, so the
-- correct user_id is supplied explicitly instead of via auth.uid().
-- Migration: 20260515070000_mcp_admin_overloads.sql.
--
-- This test (a) proves each overload, called under service_role with an explicit
-- p_user_id, actually performs the operation, and (b) pins the T2 lockdown shape
-- so the new overloads do not open a cross-tenant hole.
--
-- RED (pre-migration): existence + behavioral assertions FAIL (function missing).
-- GREEN (post-migration): all PASS.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(19);

-- ── Seed two tenants ────────────────────────────────────────────────────────
-- owner    : owns the recipe / shopping rows the overloads operate on.
-- attacker : a different authenticated user used for the T2 behavioral checks.
SELECT tests.create_supabase_user('t3_owner');
SELECT tests.create_supabase_user('t3_attacker');

SELECT tests.get_supabase_uid('t3_owner')    AS _owner    \gset
SELECT tests.get_supabase_uid('t3_attacker') AS _attacker \gset

-- Owner provisions data as themselves (activate_app seeds nothing we rely on for
-- locations here — we insert our own deterministic location below).
SELECT tests.authenticate_as('t3_owner');
SELECT hub.activate_app('chefbyte');

-- Two products: one used as the ORIGINAL recipe ingredient, one as the NEW
-- ingredient the replace must swap in. Also reused by the import test.
INSERT INTO chefbyte.products (product_id, user_id, name, servings_per_container)
VALUES
  ('a3000000-0000-0000-0000-000000000001', :'_owner'::uuid, 'T3 Product A', 1),
  ('a3000000-0000-0000-0000-000000000002', :'_owner'::uuid, 'T3 Product B', 1);

-- A recipe owned by the owner, pre-loaded with TWO ingredients so a successful
-- "fully replace" is observable (old set wiped, new single ingredient present).
INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES ('a3000000-0000-0000-0000-0000000000c1', :'_owner'::uuid, 'T3 Recipe', 1);

INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit)
VALUES
  (:'_owner'::uuid, 'a3000000-0000-0000-0000-0000000000c1', 'a3000000-0000-0000-0000-000000000001', 1, 'container'),
  (:'_owner'::uuid, 'a3000000-0000-0000-0000-0000000000c1', 'a3000000-0000-0000-0000-000000000002', 2, 'serving');

-- A deterministic storage location + one purchased, not-yet-imported shopping row.
INSERT INTO chefbyte.locations (location_id, user_id, name)
VALUES ('a3000000-0000-0000-0000-0000000000f1', :'_owner'::uuid, 'T3 Fridge');

INSERT INTO chefbyte.shopping_list (cart_item_id, user_id, product_id, qty_containers, purchased)
VALUES ('a3000000-0000-0000-0000-0000000000d1', :'_owner'::uuid,
        'a3000000-0000-0000-0000-000000000001', 4, true);

SELECT tests.clear_authentication();

-- ════════════════════════════════════════════════════════════════════════════
-- Existence — both overloads must exist with the exact signatures the handlers
-- call (catches a wrong arg order / missing overload before behavior is tested).
-- ════════════════════════════════════════════════════════════════════════════
SELECT has_function(
  'chefbyte'::name, 'save_recipe_ingredients_admin'::name,
  ARRAY['uuid','uuid','jsonb'],
  'H-17: chefbyte.save_recipe_ingredients_admin(uuid,uuid,jsonb) exists'
);
SELECT has_function(
  'chefbyte'::name, 'import_shopping_to_inventory_admin'::name,
  ARRAY['uuid','uuid'],
  'H-18: chefbyte.import_shopping_to_inventory_admin(uuid,uuid) exists'
);

-- ════════════════════════════════════════════════════════════════════════════
-- H-17 — save_recipe_ingredients_admin actually REPLACES the ingredient list
-- when called under service_role (auth.uid() NULL) with an explicit p_user_id.
-- This is the exact MCP worker call path; pre-fix the only available wrapper
-- raised 'Recipe not found …'.
-- ════════════════════════════════════════════════════════════════════════════
SET LOCAL role = service_role;

-- Precondition under service_role: auth.uid() is NULL (the bug trigger).
SELECT ok(
  (SELECT auth.uid()) IS NULL,
  'H-17 precondition: auth.uid() is NULL under service_role (MCP path)'
);

SELECT lives_ok(
  format(
    $q$ SELECT chefbyte.save_recipe_ingredients_admin(
          %L::uuid,
          'a3000000-0000-0000-0000-0000000000c1'::uuid,
          jsonb_build_array(jsonb_build_object(
            'product_id','a3000000-0000-0000-0000-000000000002',
            'quantity', 5, 'unit','container', 'note','swapped'))
        ) $q$,
    :'_owner'
  ),
  'H-17: save_recipe_ingredients_admin(owner_uid, …) succeeds under service_role'
);
RESET role;

-- The list was FULLY replaced: exactly one ingredient now, and it is the NEW one.
SELECT is(
  (SELECT count(*)::int FROM chefbyte.recipe_ingredients
     WHERE recipe_id = 'a3000000-0000-0000-0000-0000000000c1'),
  1,
  'H-17: ingredient list fully replaced — exactly 1 ingredient remains'
);
SELECT is(
  (SELECT product_id FROM chefbyte.recipe_ingredients
     WHERE recipe_id = 'a3000000-0000-0000-0000-0000000000c1'),
  'a3000000-0000-0000-0000-000000000002'::uuid,
  'H-17: the surviving ingredient is the NEW product (B), not an original'
);
SELECT is(
  (SELECT quantity::numeric FROM chefbyte.recipe_ingredients
     WHERE recipe_id = 'a3000000-0000-0000-0000-0000000000c1'),
  5::numeric,
  'H-17: the new ingredient carries the supplied quantity (5)'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM chefbyte.recipe_ingredients
     WHERE recipe_id = 'a3000000-0000-0000-0000-0000000000c1'
       AND product_id = 'a3000000-0000-0000-0000-000000000001'
  ),
  'H-17: the original ingredient (A) was deleted by the replace'
);

-- ════════════════════════════════════════════════════════════════════════════
-- H-18 — import_shopping_to_inventory_admin actually imports the purchased row
-- into stock_lots when called under service_role with an explicit p_user_id.
-- Pre-fix the only wrapper raised 'No storage locations found for user'.
-- ════════════════════════════════════════════════════════════════════════════
-- Baseline: no stock lots before the import.
SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots WHERE user_id = :'_owner'::uuid),
  0,
  'H-18 baseline: owner has 0 stock lots before import'
);

SET LOCAL role = service_role;
SELECT is(
  (chefbyte.import_shopping_to_inventory_admin(
     :'_owner'::uuid, NULL) ->> 'lots_processed')::int,
  1,
  'H-18: import_shopping_to_inventory_admin(owner_uid, NULL) processes 1 row under service_role'
);
RESET role;

-- A real, VISIBLE stock lot now exists for the imported product with the right qty.
SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
     WHERE user_id = :'_owner'::uuid AND deleted_at IS NULL),
  1,
  'H-18: exactly 1 visible stock lot created by the import'
);
SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots
     WHERE user_id = :'_owner'::uuid
       AND product_id = 'a3000000-0000-0000-0000-000000000001'
       AND deleted_at IS NULL),
  4::numeric,
  'H-18: imported lot qty matches the purchased shopping qty (4)'
);
-- The source shopping row is stamped imported_at (removed from the active cart).
SELECT ok(
  (SELECT imported_at FROM chefbyte.shopping_list
     WHERE cart_item_id = 'a3000000-0000-0000-0000-0000000000d1') IS NOT NULL,
  'H-18: the source shopping row is stamped imported_at (left the cart)'
);

-- ════════════════════════════════════════════════════════════════════════════
-- T2 lockdown shape — neither overload may be callable by authenticated/anon,
-- and an authenticated attacker passing the owner's id must be denied (42501).
-- (42501 is raised by the missing grant AND by the in-body auth.uid() guard, so
-- the behavioral assertion holds regardless of which defense fires.)
-- ════════════════════════════════════════════════════════════════════════════
SELECT ok(
  NOT has_function_privilege('authenticated',
    'chefbyte.save_recipe_ingredients_admin(uuid,uuid,jsonb)', 'EXECUTE'),
  'T2: save_recipe_ingredients_admin — authenticated must NOT have EXECUTE'
);
SELECT ok(
  NOT has_function_privilege('anon',
    'chefbyte.save_recipe_ingredients_admin(uuid,uuid,jsonb)', 'EXECUTE'),
  'T2: save_recipe_ingredients_admin — anon must NOT have EXECUTE'
);
SELECT ok(
  NOT has_function_privilege('authenticated',
    'chefbyte.import_shopping_to_inventory_admin(uuid,uuid)', 'EXECUTE'),
  'T2: import_shopping_to_inventory_admin — authenticated must NOT have EXECUTE'
);
SELECT ok(
  NOT has_function_privilege('anon',
    'chefbyte.import_shopping_to_inventory_admin(uuid,uuid)', 'EXECUTE'),
  'T2: import_shopping_to_inventory_admin — anon must NOT have EXECUTE'
);

-- Behavioral guard: attacker authenticated, passes the OWNER's id. Even if a
-- stray future GRANT restored EXECUTE, the in-body auth.uid() guard denies it.
SELECT tests.authenticate_as('t3_attacker');
SELECT throws_ok(
  format(
    $q$ SELECT chefbyte.save_recipe_ingredients_admin(
          %L::uuid, 'a3000000-0000-0000-0000-0000000000c1'::uuid, '[]'::jsonb) $q$,
    :'_owner'),
  '42501',
  NULL,
  'T2: attacker calling save_recipe_ingredients_admin with owner id is denied (42501)'
);
SELECT throws_ok(
  format(
    $q$ SELECT chefbyte.import_shopping_to_inventory_admin(%L::uuid, NULL) $q$,
    :'_owner'),
  '42501',
  NULL,
  'T2: attacker calling import_shopping_to_inventory_admin with owner id is denied (42501)'
);
SELECT tests.clear_authentication();

-- ── Teardown ────────────────────────────────────────────────────────────────
SELECT tests.delete_supabase_user('t3_owner');
SELECT tests.delete_supabase_user('t3_attacker');

SELECT * FROM finish();
ROLLBACK;
