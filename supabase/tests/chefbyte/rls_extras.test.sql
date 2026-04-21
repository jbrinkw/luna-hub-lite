-- RLS isolation tests for ChefByte extra tables:
-- shopping_list, user_config
BEGIN;
SELECT plan(8);

-- Setup: two users
SELECT tests.create_supabase_user('cf_rls2_a');
SELECT tests.create_supabase_user('cf_rls2_b');

SELECT tests.authenticate_as('cf_rls2_a');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cf_rls2_b');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

-- ═══════════════════════════════════════════════════════════════
-- SHOPPING_LIST
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('cf_rls2_a');

-- Need a product for FK
INSERT INTO chefbyte.products (product_id, user_id, name, servings_per_container,
  calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving)
VALUES (
  'c0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('cf_rls2_a'),
  'Shop Test Product', 1, 100, 10, 5, 20
);

INSERT INTO chefbyte.shopping_list (cart_item_id, user_id, product_id, qty_containers)
VALUES (
  'c0000000-0000-0000-0000-000000000010',
  tests.get_supabase_uid('cf_rls2_a'),
  'c0000000-0000-0000-0000-000000000001',
  3
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.shopping_list
    WHERE cart_item_id = 'c0000000-0000-0000-0000-000000000010'),
  'User A can SELECT own shopping_list'
);

SELECT tests.authenticate_as('cf_rls2_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.shopping_list
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a')),
  0,
  'User B cannot SELECT User A shopping_list'
);

UPDATE chefbyte.shopping_list SET qty_containers = 99
  WHERE cart_item_id = 'c0000000-0000-0000-0000-000000000010';
SELECT tests.authenticate_as('cf_rls2_a');
SELECT is(
  (SELECT qty_containers FROM chefbyte.shopping_list
    WHERE cart_item_id = 'c0000000-0000-0000-0000-000000000010'),
  3.000::numeric,
  'User B cannot UPDATE User A shopping_list'
);

SELECT tests.authenticate_as('cf_rls2_b');
DELETE FROM chefbyte.shopping_list
  WHERE cart_item_id = 'c0000000-0000-0000-0000-000000000010';
SELECT tests.authenticate_as('cf_rls2_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.shopping_list
    WHERE cart_item_id = 'c0000000-0000-0000-0000-000000000010'),
  'User B cannot DELETE User A shopping_list'
);

-- ═══════════════════════════════════════════════════════════════
-- USER_CONFIG
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('cf_rls2_a');

INSERT INTO chefbyte.user_config (user_id, key, value)
VALUES (tests.get_supabase_uid('cf_rls2_a'), 'goal_calories', '2000');

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.user_config
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a') AND key = 'goal_calories'),
  'User A can SELECT own user_config'
);

SELECT tests.authenticate_as('cf_rls2_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.user_config
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a')),
  0,
  'User B cannot SELECT User A user_config'
);

UPDATE chefbyte.user_config SET value = '9999'
  WHERE user_id = tests.get_supabase_uid('cf_rls2_a');
SELECT tests.authenticate_as('cf_rls2_a');
SELECT is(
  (SELECT value FROM chefbyte.user_config
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a') AND key = 'goal_calories'),
  '2000',
  'User B cannot UPDATE User A user_config'
);

SELECT tests.authenticate_as('cf_rls2_b');
DELETE FROM chefbyte.user_config
  WHERE user_id = tests.get_supabase_uid('cf_rls2_a');
SELECT tests.authenticate_as('cf_rls2_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.user_config
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a') AND key = 'goal_calories'),
  'User B cannot DELETE User A user_config'
);

-- Teardown
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('cf_rls2_a');
SELECT tests.delete_supabase_user('cf_rls2_b');

SELECT * FROM finish();
ROLLBACK;
