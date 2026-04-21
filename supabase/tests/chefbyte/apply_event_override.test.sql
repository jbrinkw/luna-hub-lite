BEGIN;
SELECT plan(24);

-- Scenarios covered for private.apply_event_override:
--   1. first-time override (macros_servings_override=3) — stock+macros
--      re-applied
--   2. re-edit — food_logs reflects new override
--   3. void a previously-live event — stock backed out, food_logs gone
--   4. un-void — stock + macros restored
--   5. RLS/ownership — cross-user throws 'event not found'
--   6. invalid p_event_kind → throws 22023
--   7. p_event_kind=added on a consumed Pi event → stock reverses (no
--      net food_logs row)
--   8. p_event_kind=consumed flip-back → stock decrements, food_logs logged
--   9. macro_logging_enabled=false → stock still changes, no food_logs
--  10. independent stock + macros overrides (different magnitudes)

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('aeo_owner');
SELECT tests.create_supabase_user('aeo_intruder');

SELECT tests.authenticate_as('aeo_owner');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('aeo_intruder');
SELECT hub.activate_app('chefbyte');

SELECT tests.get_supabase_uid('aeo_owner')    AS _owner_uid    \gset
SELECT tests.get_supabase_uid('aeo_intruder') AS _intruder_uid \gset

SELECT tests.authenticate_as('aeo_owner');

-- Seed product
INSERT INTO chefbyte.products (
  product_id, user_id, name,
  net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving,
  protein_per_serving, fat_per_serving
) VALUES (
  '80000000-0000-0000-0000-000000000001',
  :'_owner_uid'::uuid,
  'Override Test Product',
  100, 2, 200, 10, 20, 5
);

SELECT location_id AS fridge_id
  FROM chefbyte.locations
 WHERE user_id = :'_owner_uid'::uuid AND name = 'Fridge' \gset

-- Seed initial stock lot at 4 containers (what Pi would have left after
-- applying a -100g consume from an initial 5).
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '80000000-0000-0000-0000-0000000000b1',
  :'_owner_uid'::uuid,
  '80000000-0000-0000-0000-000000000001',
  :'fridge_id',
  4, 'live_shelf', '2026-04-15 10:00:00+00'
);

-- Simulate apply_shelf_event's food_logs row from the Pi event.
INSERT INTO chefbyte.food_logs (
  user_id, product_id, logical_date, qty_consumed, unit,
  calories, carbs, protein, fat, source_client_event_id
) VALUES (
  :'_owner_uid'::uuid,
  '80000000-0000-0000-0000-000000000001',
  '2026-04-15', 2, 'serving',
  400, 20, 40, 10, 'evt-001'
);

-- shelf_event_log + live_shelf_devices seeded via service_role (those
-- tables disallow INSERT to authenticated; only service_role has grant).
SELECT tests.clear_authentication();
SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash
) VALUES (
  '70000000-0000-0000-0000-0000000000a1',
  :'_owner_uid'::uuid,
  'test-device',
  'sha-hash-placeholder-aeo-' || gen_random_uuid()
);

INSERT INTO chefbyte.shelf_event_log (
  event_id, user_id, device_id, client_event_id,
  payload, applied, resolved_lot_id, reason
) VALUES (
  '80000000-0000-0000-0000-0000000000c1',
  :'_owner_uid'::uuid,
  '70000000-0000-0000-0000-0000000000a1',
  'evt-001',
  jsonb_build_object(
    'scale_id', 'scale-01',
    'kind', 'live_shelf',
    'event_kind', 'consumed',
    'product_id', '80000000-0000-0000-0000-000000000001',
    'delta_g', -100,
    'occurred_at', '2026-04-15T14:00:00Z'
  ),
  TRUE, '80000000-0000-0000-0000-0000000000b1', 'decremented'
);

SET ROLE postgres;

-- ─────────────────────────────────────────────────────────────
-- Test 1: first override (macros only — servings=3, keep stock delta)
-- ─────────────────────────────────────────────────────────────

SELECT tests.authenticate_as('aeo_owner');

SELECT lives_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', NULL, 3, NULL, NULL, NULL, NULL, TRUE, FALSE
    )
  $$,
  'first-time override succeeds'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '80000000-0000-0000-0000-0000000000b1'),
  4::numeric(10,3),
  'stock unchanged after macros-only override (backed out + re-applied)'
);

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'evt-001'
    ORDER BY created_at DESC LIMIT 1),
  600::numeric(10,3),
  'food_log calories = 3 servings * 200 cal = 600 after override'
);

-- ─────────────────────────────────────────────────────────────
-- Test 2: re-edit to servings=1
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', NULL, 1, NULL, NULL, NULL, NULL, TRUE, FALSE
    )
  $$,
  're-edit override succeeds'
);

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'evt-001'),
  200::numeric(10,3),
  'food_log calories = 1 serving * 200 cal after re-edit'
);

-- ─────────────────────────────────────────────────────────────
-- Test 3: void the event
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', NULL, NULL, NULL, NULL, NULL, NULL, TRUE, TRUE
    )
  $$,
  'void override succeeds'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '80000000-0000-0000-0000-0000000000b1'),
  5::numeric(10,3),
  'stock restored to 5 after void (consumption backed out)'
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'evt-001'),
  0,
  'food_logs row removed after void'
);

-- ─────────────────────────────────────────────────────────────
-- Test 4: un-void
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', NULL, 2, NULL, NULL, NULL, NULL, TRUE, FALSE
    )
  $$,
  'un-void override succeeds'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '80000000-0000-0000-0000-0000000000b1'),
  4::numeric(10,3),
  'stock back to 4 after un-void (re-applied original -1 container)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 5: RLS/ownership — intruder cannot override owner's event
-- ─────────────────────────────────────────────────────────────

SELECT tests.authenticate_as('aeo_intruder');

SELECT throws_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', NULL, 5, NULL, NULL, NULL, NULL, TRUE, FALSE
    )
  $$,
  'event not found: evt-001',
  'intruder cannot override another user''s event'
);

-- Switch back to owner for the rest. Starting lot qty after Test 4 = 4.
SELECT tests.authenticate_as('aeo_owner');

-- ─────────────────────────────────────────────────────────────
-- Test 6: invalid p_event_kind throws
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', NULL, NULL, NULL, NULL, NULL, NULL, TRUE, FALSE, 'eaten'
    )
  $$,
  '22023',
  'invalid event_kind: eaten',
  'invalid event_kind raises 22023'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7: flip consumed → added
-- Before: Test 4 left qty_containers = 4, food_log for 2 servings.
-- After flipping to added: the prior -1 consume backs out (+1 → 5),
-- the new effect is +1 increment (5 → 6) and NO food_logs row.
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', NULL, NULL, NULL, NULL, NULL, NULL, TRUE, FALSE, 'added'
    )
  $$,
  'flip consumed→added succeeds'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '80000000-0000-0000-0000-0000000000b1'),
  6::numeric(10,3),
  'flip to added: stock = 4 + 1 (back out) + 1 (add) = 6'
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'evt-001'),
  0,
  'flip to added: no food_logs row (added is stock-only)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 8: flip back added → consumed
-- Before: qty = 6, no food_logs.
-- After: prior +1 backs out (6 → 5), new -1 consume (5 → 4), food_logs
-- for 2 servings derived (net_g=100 ÷ 100 = 1 container, svg_per=2).
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', NULL, NULL, NULL, NULL, NULL, NULL, TRUE, FALSE, 'consumed'
    )
  $$,
  'flip added→consumed succeeds'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '80000000-0000-0000-0000-0000000000b1'),
  4::numeric(10,3),
  'flip to consumed: stock = 6 - 1 (back out) - 1 (consume) = 4'
);

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'evt-001'
    ORDER BY created_at DESC LIMIT 1),
  400::numeric(10,3),
  'flip to consumed: food_log cal = 2 servings * 200 = 400'
);

-- ─────────────────────────────────────────────────────────────
-- Test 9: macro_logging_enabled=false on consumed
-- Stock still changes, but no food_logs row is inserted. Use-case:
-- spoiled food (stock decremented, not counted against daily macros).
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', NULL, NULL, NULL, NULL, NULL, NULL, FALSE, FALSE, 'consumed'
    )
  $$,
  'macros-off override succeeds'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '80000000-0000-0000-0000-0000000000b1'),
  4::numeric(10,3),
  'macros-off: stock still at 4 (prior -1 undone, new -1 applied)'
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'evt-001'),
  0,
  'macros-off: food_logs row not inserted'
);

-- ─────────────────────────────────────────────────────────────
-- Test 10: independent stock and macros overrides
-- stock_qty_override = -2 (stock goes 4 → 2), macros_servings = 5
-- (food_log cal = 5 * 200 = 1000). Re-enable macro logging.
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.apply_event_override(
      'evt-001', -2, 5, NULL, NULL, NULL, NULL, TRUE, FALSE, 'consumed'
    )
  $$,
  'independent stock+macros override succeeds'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '80000000-0000-0000-0000-0000000000b1'),
  3::numeric(10,3),
  'independent: stock = 4 (backed out +1) + (-2 override) = 3'
);

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'evt-001'
    ORDER BY created_at DESC LIMIT 1),
  1000::numeric(10,3),
  'independent: food_log cal = 5 svg * 200 = 1000 (macros field ≠ stock field)'
);

SELECT finish();
ROLLBACK;
