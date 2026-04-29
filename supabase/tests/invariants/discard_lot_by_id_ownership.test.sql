-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — apply_discard_with_lot_id ownership + product check
-- ════════════════════════════════════════════════════════════════════════════
-- Pins migration 20260428030000_discard_lot_by_id.sql:
--
--   Line 126: "Resolve the lot — must belong to the calling user.
--             Cross-user writes are rejected."
--   Line 155: "when product_id is supplied, it must match the lot's
--             product_id. Mismatch indicates a Pi-side data corruption;
--             we refuse rather than touching an unexpected lot."
--
-- The lot-targeted catch-all discard path (`chefbyte.apply_discard_with_lot_id_admin`,
-- service_role-only) is the entry point used by `shelf-ingest` for the
-- catch-all empty-bottle short-circuit when the Pi has visually identified
-- the specific lot.
--
-- The function does NOT throw on cross-user / mismatch — it RETURNS a
-- `(resolved_lot_id, applied, reason)` triple with applied=false and a
-- specific reason string, then writes that triple to shelf_event_log so
-- the Pi can correlate. Pinning means: the rejected branch must NOT
-- mutate the targeted lot.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(10);

------------------------------------------------------------
-- Setup — Alice owns lot A; Bob owns lot B; both reference different
-- products P_A / P_B.
------------------------------------------------------------

SELECT tests.create_supabase_user('disc_alice');
SELECT tests.create_supabase_user('disc_bob');

SELECT tests.authenticate_as('disc_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('disc_alice'),
  'Disc Alice Product',
  500.000, 5,
  100, 10, 5, 5
);

SELECT product_id AS p_alice
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND name = 'Disc Alice Product' \gset

-- Second product for Alice (used in the product-mismatch test).
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('disc_alice'),
  'Disc Alice Product 2',
  500.000, 5,
  100, 10, 5, 5
);

SELECT product_id AS p_alice_2
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND name = 'Disc Alice Product 2' \gset

SELECT location_id AS loc_alice
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('disc_alice'), 'disc-alice-pi', 'disc_alice_hash', true
);

SELECT device_id AS d_alice
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND device_name = 'disc-alice-pi' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('disc_alice'),
  :'p_alice'::UUID, :'loc_alice'::UUID, 1.0,
  'live_scale', now()
);

SELECT lot_id AS lot_alice
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND product_id = :'p_alice'::UUID \gset

-- Capture user UUIDs into psql variables NOW (while authenticated as
-- alice) — under SET ROLE service_role the `tests.` schema is not
-- accessible, so we'd otherwise fail with "permission denied".
SELECT tests.get_supabase_uid('disc_alice') AS alice_uid \gset
SELECT tests.get_supabase_uid('disc_bob')   AS bob_uid   \gset

------------------------------------------------------------
-- 1. Cross-user rejection — pass Bob's user_id as p_user_id but
-- target Alice's lot_id. The function should return applied=false
-- with reason='lot_id not owned by user' AND must NOT mutate the lot.
------------------------------------------------------------

SELECT tests.clear_authentication();
SET ROLE service_role;

WITH r AS (
  SELECT *
    FROM chefbyte.apply_discard_with_lot_id_admin(
      :'bob_uid'::UUID,                    -- p_user_id (wrong owner)
      :'d_alice'::UUID,                    -- p_device_id (Alice's device)
      'catch_all_kitchen',                 -- p_scale_id
      'catch_all',                         -- p_kind
      :'lot_alice'::UUID,                  -- p_pi_lot_id
      :'p_alice'::UUID,                    -- p_product_id
      now(),                               -- p_occurred_at
      'disc_test_cross_user_1',            -- p_client_event_id
      'pi_event_disc_1'                    -- p_pi_event_id
    )
)
SELECT is(
  (SELECT applied FROM r),
  false,
  'apply_discard_with_lot_id: cross-user lot returns applied=false'
);

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE client_event_id = 'disc_test_cross_user_1'),
  'lot_id not owned by user',
  'apply_discard_with_lot_id: cross-user audit row records the specific reason'
);

-- Lot must be unchanged.
SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'lot_alice'::UUID),
  1.0::NUMERIC(10,3),
  'apply_discard_with_lot_id: cross-user attempt did NOT mutate qty_containers'
);

SELECT isnt(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = :'lot_alice'::UUID),
  'manual_discard',
  'apply_discard_with_lot_id: cross-user attempt did NOT stamp last_update_source'
);

------------------------------------------------------------
-- 2. Unknown lot_id — passing a random UUID should return applied=false
--    with reason='lot_id not found'.
------------------------------------------------------------

WITH r AS (
  SELECT *
    FROM chefbyte.apply_discard_with_lot_id_admin(
      :'alice_uid'::UUID,
      :'d_alice'::UUID,
      'catch_all_kitchen',
      'catch_all',
      gen_random_uuid(),                   -- random lot_id, never inserted
      :'p_alice'::UUID,
      now(),
      'disc_test_missing_lot_1',
      'pi_event_disc_2'
    )
)
SELECT is(
  (SELECT applied FROM r),
  false,
  'apply_discard_with_lot_id: missing lot_id returns applied=false'
);

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE client_event_id = 'disc_test_missing_lot_1'),
  'lot_id not found',
  'apply_discard_with_lot_id: missing-lot audit row records the specific reason'
);

------------------------------------------------------------
-- 3. Product mismatch — pass Alice's lot_id but a DIFFERENT product_id
--    that doesn't match the lot's actual product. Function must refuse.
------------------------------------------------------------

WITH r AS (
  SELECT *
    FROM chefbyte.apply_discard_with_lot_id_admin(
      :'alice_uid'::UUID,
      :'d_alice'::UUID,
      'catch_all_kitchen',
      'catch_all',
      :'lot_alice'::UUID,
      :'p_alice_2'::UUID,                  -- DIFFERENT product
      now(),
      'disc_test_product_mismatch_1',
      'pi_event_disc_3'
    )
)
SELECT is(
  (SELECT applied FROM r),
  false,
  'apply_discard_with_lot_id: product mismatch returns applied=false'
);

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE client_event_id = 'disc_test_product_mismatch_1'),
  'lot_id product mismatch with payload product_id',
  'apply_discard_with_lot_id: product-mismatch audit row records the specific reason'
);

-- Lot still unchanged.
SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'lot_alice'::UUID),
  1.0::NUMERIC(10,3),
  'apply_discard_with_lot_id: product-mismatch attempt did NOT mutate qty_containers'
);

------------------------------------------------------------
-- 4. Happy path — owner + matching product + valid lot succeeds.
------------------------------------------------------------

WITH r AS (
  SELECT *
    FROM chefbyte.apply_discard_with_lot_id_admin(
      :'alice_uid'::UUID,
      :'d_alice'::UUID,
      'catch_all_kitchen',
      'catch_all',
      :'lot_alice'::UUID,
      :'p_alice'::UUID,                    -- matches lot
      now(),
      'disc_test_happy_1',
      'pi_event_disc_4'
    )
)
SELECT is(
  (SELECT applied FROM r),
  true,
  'apply_discard_with_lot_id: owner + matching product succeeds (applied=true)'
);

SELECT * FROM finish();
ROLLBACK;
