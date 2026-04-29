-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — chefbyte.close_in_flight_lot ownership + state
-- ════════════════════════════════════════════════════════════════════════════
-- Pins migration 20260427110000_close_in_flight_lot_rpc.sql, line 116:
--
--   "Lot must exist, belong to caller, and currently be in-flight."
--
-- The public RPC `chefbyte.close_in_flight_lot(p_lot_id, p_resolution, p_note)`
-- is granted to `authenticated` and forwards `auth.uid()` to the private
-- helper. The contract has three failure modes that this test pins, plus
-- one happy path:
--
--   1. lot belongs to a different user → 'lot not found' (ERRCODE 22023).
--      This is the load-bearing security rule — without it any
--      authenticated user could zero or consume any other user's lot
--      simply by passing the lot_id.
--
--   2. lot exists for the caller but in_flight_since IS NULL →
--      'lot is not in-flight' (ERRCODE 22023). Otherwise repeat clicks
--      on a depleted-but-not-in-flight row would clobber qty.
--
--   3. invalid p_resolution → 'invalid resolution' (ERRCODE 22023).
--      Pins the {discarded, consumed, returned} closed set so a future
--      change can't silently introduce a fourth branch with no semantics.
--
--   4. happy path: 'returned' resolution preserves qty_containers
--      and clears in_flight_since (idempotent reset). Pins the
--      pairing_rotation note "'returned' preserves qty so MUST NOT
--      rotate".
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(8);

------------------------------------------------------------
-- Setup — two users, one in-flight lot owned by Alice.
------------------------------------------------------------

SELECT tests.create_supabase_user('cif_alice');
SELECT tests.create_supabase_user('cif_bob');

SELECT tests.authenticate_as('cif_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('cif_alice'),
  'CIF Test Product',
  500.000, 5,
  100, 10, 5, 5
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('cif_alice')
   AND name = 'CIF Test Product' \gset

SELECT location_id AS loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('cif_alice')
   AND name = 'Fridge' \gset

-- Insert an in-flight lot (qty 1, in_flight_since populated, expires_on A).
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id,
  qty_containers, in_flight_since, pickup_event_id, expires_on,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('cif_alice'),
  :'p_id'::UUID, :'loc_id'::UUID,
  1.0, now() - interval '5 minutes', gen_random_uuid(),
  CURRENT_DATE + 30,
  'live_scale', now()
);

SELECT lot_id AS in_flight_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('cif_alice')
   AND product_id = :'p_id'::UUID
   AND in_flight_since IS NOT NULL \gset

-- Insert a NOT-in-flight lot (qty 2, in_flight_since IS NULL, expires_on B).
-- last_update_source = 'manual' so we don't collide with the partial
-- unique stock_lots_one_per_tracked_shelf (user_id, product_id,
-- last_update_source) WHERE source IN (live_shelf, live_scale) AND qty>0.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id,
  qty_containers, in_flight_since, expires_on,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('cif_alice'),
  :'p_id'::UUID, :'loc_id'::UUID,
  2.0, NULL,
  CURRENT_DATE + 60,
  'manual', now()
);

SELECT lot_id AS not_in_flight_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('cif_alice')
   AND product_id = :'p_id'::UUID
   AND in_flight_since IS NULL \gset

------------------------------------------------------------
-- 1. Cross-user reject — Bob (authenticated) cannot resolve Alice's lot.
------------------------------------------------------------

SELECT tests.authenticate_as('cif_bob');

SELECT throws_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'discarded', 'cross-user attempt')$$,
    :'in_flight_lot_id'
  ),
  '22023',
  'lot not found',
  'close_in_flight_lot: cross-user lot_id is rejected as "lot not found"'
);

-- Confirm Alice's in-flight lot is unchanged after Bob's failed call.
SELECT tests.authenticate_as('cif_alice');

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'in_flight_lot_id'::UUID),
  1.0::NUMERIC(10,3),
  'close_in_flight_lot: Alice''s qty was NOT mutated by Bob''s rejected call'
);

SELECT isnt(
  (SELECT in_flight_since FROM chefbyte.stock_lots
    WHERE lot_id = :'in_flight_lot_id'::UUID),
  NULL::TIMESTAMPTZ,
  'close_in_flight_lot: Alice''s in_flight_since was NOT cleared by Bob''s rejected call'
);

------------------------------------------------------------
-- 2. Not-in-flight reject — Alice cannot resolve a lot whose
--    in_flight_since IS NULL.
------------------------------------------------------------

SELECT throws_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'discarded', NULL)$$,
    :'not_in_flight_lot_id'
  ),
  '22023',
  'lot is not in-flight',
  'close_in_flight_lot: non-in-flight lot is rejected as "lot is not in-flight"'
);

------------------------------------------------------------
-- 3. Invalid resolution literal — only {discarded, consumed, returned}.
------------------------------------------------------------

SELECT throws_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'broken-by-malice', NULL)$$,
    :'in_flight_lot_id'
  ),
  '22023',
  'invalid resolution: broken-by-malice',
  'close_in_flight_lot: invalid resolution literal is rejected'
);

------------------------------------------------------------
-- 4. Happy path — 'returned' preserves qty_containers, clears
--    in_flight_since. Pins the "MUST NOT rotate" rule from
--    20260428010000 line 1469.
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'returned', 'false in-flight')$$,
    :'in_flight_lot_id'
  ),
  'close_in_flight_lot: returned resolution succeeds for Alice on her own in-flight lot'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'in_flight_lot_id'::UUID),
  1.0::NUMERIC(10,3),
  'close_in_flight_lot: returned resolution PRESERVES qty_containers (must not rotate)'
);

SELECT is(
  (SELECT in_flight_since FROM chefbyte.stock_lots
    WHERE lot_id = :'in_flight_lot_id'::UUID),
  NULL::TIMESTAMPTZ,
  'close_in_flight_lot: returned resolution CLEARS in_flight_since'
);

SELECT * FROM finish();
ROLLBACK;
