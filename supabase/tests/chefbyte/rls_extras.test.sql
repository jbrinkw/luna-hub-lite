-- RLS isolation tests for ChefByte extra tables:
-- shopping_list, liquidtrack_devices, liquidtrack_events, user_config
BEGIN;
SELECT plan(16);

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
-- LIQUIDTRACK_DEVICES
-- ═══════════════════════════════════════════════════════════════

INSERT INTO chefbyte.liquidtrack_devices (device_id, user_id, device_name,
  product_id, import_key_hash)
VALUES (
  'c0000000-0000-0000-0000-000000000020',
  tests.get_supabase_uid('cf_rls2_a'),
  'Kitchen Scale',
  'c0000000-0000-0000-0000-000000000001',
  'testhash_rls_001'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.liquidtrack_devices
    WHERE device_id = 'c0000000-0000-0000-0000-000000000020'),
  'User A can SELECT own liquidtrack_devices'
);

SELECT tests.authenticate_as('cf_rls2_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.liquidtrack_devices
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a')),
  0,
  'User B cannot SELECT User A liquidtrack_devices'
);

UPDATE chefbyte.liquidtrack_devices SET device_name = 'Hacked'
  WHERE device_id = 'c0000000-0000-0000-0000-000000000020';
SELECT tests.authenticate_as('cf_rls2_a');
SELECT is(
  (SELECT device_name FROM chefbyte.liquidtrack_devices
    WHERE device_id = 'c0000000-0000-0000-0000-000000000020'),
  'Kitchen Scale',
  'User B cannot UPDATE User A liquidtrack_devices'
);

SELECT tests.authenticate_as('cf_rls2_b');
DELETE FROM chefbyte.liquidtrack_devices
  WHERE device_id = 'c0000000-0000-0000-0000-000000000020';
SELECT tests.authenticate_as('cf_rls2_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.liquidtrack_devices
    WHERE device_id = 'c0000000-0000-0000-0000-000000000020'),
  'User B cannot DELETE User A liquidtrack_devices'
);

-- ═══════════════════════════════════════════════════════════════
-- LIQUIDTRACK_EVENTS
-- ═══════════════════════════════════════════════════════════════

INSERT INTO chefbyte.liquidtrack_events (user_id, device_id,
  weight_before, weight_after, consumption,
  calories, carbs, protein, fat, logical_date)
VALUES (
  tests.get_supabase_uid('cf_rls2_a'),
  'c0000000-0000-0000-0000-000000000020',
  500, 400, 100,
  80, 10, 5, 3, '2026-03-03'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.liquidtrack_events
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a')),
  'User A can SELECT own liquidtrack_events'
);

SELECT tests.authenticate_as('cf_rls2_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.liquidtrack_events
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a')),
  0,
  'User B cannot SELECT User A liquidtrack_events'
);

UPDATE chefbyte.liquidtrack_events SET calories = 999
  WHERE user_id = tests.get_supabase_uid('cf_rls2_a');
SELECT tests.authenticate_as('cf_rls2_a');
SELECT is(
  (SELECT calories FROM chefbyte.liquidtrack_events
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a') LIMIT 1),
  80.000::numeric,
  'User B cannot UPDATE User A liquidtrack_events'
);

SELECT tests.authenticate_as('cf_rls2_b');
DELETE FROM chefbyte.liquidtrack_events
  WHERE user_id = tests.get_supabase_uid('cf_rls2_a');
SELECT tests.authenticate_as('cf_rls2_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.liquidtrack_events
    WHERE user_id = tests.get_supabase_uid('cf_rls2_a')),
  'User B cannot DELETE User A liquidtrack_events'
);

-- ═══════════════════════════════════════════════════════════════
-- USER_CONFIG
-- ═══════════════════════════════════════════════════════════════

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
