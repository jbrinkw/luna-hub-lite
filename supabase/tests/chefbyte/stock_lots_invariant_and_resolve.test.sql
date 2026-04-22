-- One-lot-per-product-per-tracked-shelf invariant + MOVE-vs-MINT resolver.
--
-- Validates 20260424080000_stock_lots_invariant_and_resolve.sql:
--   * Invariant: partial UNIQUE on (user_id, product_id, last_update_source)
--     where last_update_source IN ('live_shelf','live_scale') AND qty > 0.
--     Second live_shelf lot for same (user, product) raises a unique violation.
--   * Non-tracked lots unaffected (multiple pantry lots still allowed).
--   * resolve_add_to_shelf_lot MOVE: pantry lot of matching weight → shelf.
--   * resolve_add_to_shelf_lot MINT: no pantry match → fresh lot.
--   * Multi-candidate: picks nearest-expires-on + writes audit reason.
--   * Cross-user: user A's pantry lot never touched by user B's resolver.
--   * Weight-mismatch: resolver does NOT move an off-tolerance lot.
--
-- The private.resolve_add_to_shelf_lot function has its EXECUTE grant
-- restricted to service_role (SECURITY DEFINER callers are the edge
-- function + apply_shelf_event). Tests elevate via SET LOCAL role
-- postgres to invoke it directly — matches the pattern used in
-- stock_lots_in_flight.test.sql for private.apply_shelf_event.

BEGIN;
SELECT plan(14);

------------------------------------------------------------
-- Setup — two users, one product each with net_weight_g set so
-- the resolver can compute qty_containers from placed-grams.
------------------------------------------------------------
SELECT tests.create_supabase_user('shelf_alice');
SELECT tests.create_supabase_user('shelf_bob');

SELECT tests.authenticate_as('shelf_alice');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('shelf_bob');
SELECT hub.activate_app('chefbyte');

SELECT tests.authenticate_as('shelf_alice');

-- Chocolate milk: 1672g full container, 4 servings, 200 cal/serving.
INSERT INTO chefbyte.products (
  product_id, user_id, name, net_weight_g, servings_per_container,
  calories_per_serving
) VALUES (
  'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  tests.get_supabase_uid('shelf_alice'),
  'Chocolate Milk', 1672, 4, 200
);

SELECT location_id AS alice_fridge
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('shelf_alice') AND name = 'Fridge' \gset

SELECT location_id AS alice_pantry
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('shelf_alice') AND name = 'Pantry' \gset

-- Bob: same-named product so we can prove cross-user isolation.
SELECT tests.authenticate_as('shelf_bob');
INSERT INTO chefbyte.products (
  product_id, user_id, name, net_weight_g, servings_per_container,
  calories_per_serving
) VALUES (
  'bbbb0001-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  tests.get_supabase_uid('shelf_bob'),
  'Chocolate Milk', 1672, 4, 200
);

SELECT location_id AS bob_pantry
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('shelf_bob') AND name = 'Pantry' \gset

------------------------------------------------------------
-- 1. Invariant: two live_shelf lots for same (user, product) → unique violation
------------------------------------------------------------
SELECT tests.authenticate_as('shelf_alice');

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('shelf_alice'),
  'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  :'alice_fridge', 1.0, 'live_shelf', now()
);

SELECT throws_ok(
  format(
    $sql$INSERT INTO chefbyte.stock_lots
         (user_id, product_id, location_id, qty_containers,
          last_update_source, last_update_ts, expires_on)
       VALUES (%L, %L, %L, 0.5, 'live_shelf', now(), '2026-07-01')$sql$,
    tests.get_supabase_uid('shelf_alice'),
    'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    :'alice_fridge'
  ),
  '23505',  -- unique_violation
  NULL,
  'second live_shelf lot for same (user, product) raises unique_violation'
);

------------------------------------------------------------
-- 2. Multiple pantry lots (non-tracked source) still allowed.
--    The pre-existing stock_lots_merge_key treats expires_on as part
--    of the key, so two pantry lots must differ on either location
--    or expires_on. We give them distinct expires_on dates.
------------------------------------------------------------
SELECT lives_ok(
  format(
    $sql$INSERT INTO chefbyte.stock_lots
         (user_id, product_id, location_id, qty_containers,
          last_update_source, last_update_ts, expires_on)
       VALUES
         (%L, %L, %L, 1.0, 'manual', now(), '2026-06-01'),
         (%L, %L, %L, 2.0, 'manual', now(), '2026-07-01')$sql$,
    tests.get_supabase_uid('shelf_alice'),
    'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    :'alice_pantry',
    tests.get_supabase_uid('shelf_alice'),
    'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    :'alice_pantry'
  ),
  'multiple pantry (non-tracked) lots of same product allowed'
);

-- Clean the slate so subsequent resolver tests have a controlled starting state.
DELETE FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('shelf_alice')
   AND product_id = 'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

------------------------------------------------------------
-- 3. MOVE: single matching pantry lot → moved onto shelf
------------------------------------------------------------
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts, expires_on
) VALUES (
  'aaaa0010-0000-0000-0000-000000000001',
  tests.get_supabase_uid('shelf_alice'),
  'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  :'alice_pantry', 1.0, 'manual', now() - interval '1 hour',
  '2026-05-01'
);

SET LOCAL role postgres;

SELECT is(
  private.resolve_add_to_shelf_lot(
    tests.get_supabase_uid('shelf_alice'),
    'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'live_shelf',
    :'alice_fridge',
    1672.0,        -- matches pantry lot's 1672g
    NULL,
    now()
  ),
  'aaaa0010-0000-0000-0000-000000000001'::UUID,
  'resolver returns the pantry lot id (MOVE)'
);

RESET role;
SELECT tests.authenticate_as('shelf_alice');

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = 'aaaa0010-0000-0000-0000-000000000001'),
  'live_shelf',
  'moved lot now has last_update_source=live_shelf'
);

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shelf_alice')
      AND product_id = 'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'MOVE does not mint a duplicate lot'
);

------------------------------------------------------------
-- 4. MINT: no pantry match → fresh lot
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('shelf_alice')
   AND product_id = 'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

SET LOCAL role postgres;

SELECT isnt(
  private.resolve_add_to_shelf_lot(
    tests.get_supabase_uid('shelf_alice'),
    'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'live_shelf',
    :'alice_fridge',
    1672.0,
    NULL,
    now()
  ),
  NULL,
  'MINT returns a non-null lot_id even with no pantry candidate'
);

RESET role;
SELECT tests.authenticate_as('shelf_alice');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shelf_alice')
      AND product_id = 'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      AND last_update_source = 'live_shelf'),
  1,
  'MINT creates exactly one live_shelf lot'
);

------------------------------------------------------------
-- 5. MULTI-CANDIDATE: two matching pantry lots → picks nearest
--    expires_on + records audit reason on shelf_event_log.
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('shelf_alice')
   AND product_id = 'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts, expires_on
) VALUES
  ('aaaa0011-0000-0000-0000-000000000001',
   tests.get_supabase_uid('shelf_alice'),
   'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   :'alice_pantry', 1.0, 'manual', now() - interval '1 hour',
   '2026-06-01'),
  ('aaaa0011-0000-0000-0000-000000000002',
   tests.get_supabase_uid('shelf_alice'),
   'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   :'alice_pantry', 1.0, 'manual', now() - interval '1 hour',
   '2026-05-01');  -- earlier expiry → resolver should pick this one

-- Seed the event-log scaffolding so the resolver can stamp reason.
-- live_shelf_devices is writable only to service_role; shelf_event_log
-- the same. Elevate for both inserts, then restore.
SET LOCAL role postgres;

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash
) VALUES (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  tests.get_supabase_uid('shelf_alice'),
  'alice-test-shelf',
  encode(extensions.digest('alice-key', 'sha256'), 'hex')
);

INSERT INTO chefbyte.shelf_event_log (
  event_id, user_id, device_id, client_event_id, payload, applied
) VALUES (
  'eeeeeeee-0000-0000-0000-000000000001',
  tests.get_supabase_uid('shelf_alice'),
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'test-evt-multi',
  '{}'::jsonb, false
);

RESET role;
SELECT tests.authenticate_as('shelf_alice');

SET LOCAL role postgres;

SELECT is(
  private.resolve_add_to_shelf_lot(
    tests.get_supabase_uid('shelf_alice'),
    'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'live_shelf',
    :'alice_fridge',
    1672.0,
    'eeeeeeee-0000-0000-0000-000000000001'::UUID,
    now()
  ),
  'aaaa0011-0000-0000-0000-000000000002'::UUID,
  'multi-candidate picks the nearest-expires_on lot'
);

RESET role;
SELECT tests.authenticate_as('shelf_alice');

SELECT ok(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE event_id = 'eeeeeeee-0000-0000-0000-000000000001')
  LIKE 'moved_to_shelf_multi_candidate:%',
  'multi-candidate emits moved_to_shelf_multi_candidate reason'
);

------------------------------------------------------------
-- 6. Cross-user isolation: Bob's resolver does NOT touch Alice's pantry
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('shelf_alice')
   AND product_id = 'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- Re-seed Alice's pantry lot.
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts, expires_on
) VALUES (
  'aaaa0020-0000-0000-0000-000000000001',
  tests.get_supabase_uid('shelf_alice'),
  'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  :'alice_pantry', 1.0, 'manual', now() - interval '1 hour',
  '2026-05-01'
);

-- Seed Bob's own pantry lot.
SELECT tests.authenticate_as('shelf_bob');
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts, expires_on
) VALUES (
  'bbbb0020-0000-0000-0000-000000000001',
  tests.get_supabase_uid('shelf_bob'),
  'bbbb0001-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  :'bob_pantry', 1.0, 'manual', now() - interval '1 hour',
  '2026-05-01'
);

SET LOCAL role postgres;

SELECT is(
  private.resolve_add_to_shelf_lot(
    tests.get_supabase_uid('shelf_bob'),
    'bbbb0001-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'live_shelf',
    :'bob_pantry',
    1672.0,
    NULL,
    now()
  ),
  'bbbb0020-0000-0000-0000-000000000001'::UUID,
  'Bob moves his own lot, not Alice''s'
);

RESET role;
SELECT tests.authenticate_as('shelf_alice');

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = 'aaaa0020-0000-0000-0000-000000000001'),
  'manual',
  'Alice''s pantry lot was NOT moved by Bob''s resolver'
);

------------------------------------------------------------
-- 7. Weight-mismatch → MINT even when a pantry lot exists
------------------------------------------------------------
-- Alice already has a pantry lot (aaaa0020) with current weight 1672g.
-- A resolver call with 400g (far outside the tolerance of max(50, 83.6))
-- must NOT move the pantry lot. It must MINT a fresh lot.

SET LOCAL role postgres;

SELECT isnt(
  private.resolve_add_to_shelf_lot(
    tests.get_supabase_uid('shelf_alice'),
    'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'live_shelf',
    :'alice_fridge',
    400.0,   -- far from pantry's 1672g + tolerance
    NULL,
    now()
  ),
  'aaaa0020-0000-0000-0000-000000000001'::UUID,
  'weight mismatch does NOT move the pantry lot — returns a NEW lot'
);

RESET role;
SELECT tests.authenticate_as('shelf_alice');

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = 'aaaa0020-0000-0000-0000-000000000001'),
  'manual',
  'pantry lot untouched when weights do not match'
);

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shelf_alice')
      AND product_id = 'aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  2,
  'weight-mismatch branch minted a fresh lot (pantry + new shelf)'
);

SELECT * FROM finish();
ROLLBACK;
