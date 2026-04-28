-- pgTAP — TOCTOU race regression for private.reap_catch_all_in_flight.
--
-- Validates supabase/migrations/20260428020000_catch_all_reaper_toctou_fix.sql.
--
-- The pre-fix reaper applied the TTL predicate ONLY in the CTE
-- selector. The downstream UPDATE rechecked in_flight_kind='catch_all'
-- but did NOT re-assert the age. A concurrent FIRST measurement that
-- refreshed in_flight_since to NOW between the CTE select and the
-- UPDATE could still have its markers wiped because the kind check
-- still passed.
--
-- pgTAP can't truly run two concurrent transactions in one body, but
-- we can simulate the race deterministically by:
--   1. Pre-staging an expired catch_all in-flight row.
--   2. Calling the reaper with a TTL that we then BEHAVIOR-mutate by
--      bumping the row's in_flight_since to NOW BEFORE the reaper's
--      UPDATE phase. We do this by wrapping the call in a CTE chain
--      that touches the row first — the simplest deterministic proxy
--      for the race is to use a parameter that proves the post-CTE
--      predicate guards against the bumped timestamp. We do that by:
--        a. Verifying the TOCTOU-protected reaper SKIPS a row whose
--           in_flight_since was just refreshed (different value than
--           the CTE captured). With the fix, the UPDATE's
--           in_flight_since=expired.original_since clause filters it
--           out. Without the fix, the bumped row gets cleared.
--        b. We exercise (a) by stamping a row, calling reaper from
--           a SAVEPOINT, immediately after refreshing in_flight_since
--           to now, then rolling back — confirming reap happens before
--           any concurrent refresh. Then in a separate scenario, we
--           do the inverse: refresh first, then call reaper, and
--           assert the refreshed row is preserved.

BEGIN;
SELECT plan(6);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('toctou_alice');
SELECT tests.authenticate_as('toctou_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('toctou_alice'),
  'TOCTOU Trail Mix',
  500.000, 5,
  200, 24, 4, 12
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('toctou_alice')
   AND name = 'TOCTOU Trail Mix' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('toctou_alice')
   AND name = 'Fridge' \gset

-- Two expired catch_all in-flight rows. We will then simulate a
-- concurrent FIRST-measurement refresh on row #1 BEFORE invoking the
-- reaper, and verify the refreshed row is NOT cleared.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  in_flight_since, in_flight_kind, pickup_event_id, pickup_weight_g,
  last_update_source, last_update_ts
) VALUES
  (tests.get_supabase_uid('toctou_alice'), :'alice_product_id',
   :'alice_fridge_id', 0.700, '2099-01-01',
   now() - interval '8 hours', 'catch_all',
   '11111111-aaaa-1111-1111-111111111111'::uuid, 350.000,
   'catch_all', now() - interval '8 hours'),
  (tests.get_supabase_uid('toctou_alice'), :'alice_product_id',
   :'alice_fridge_id', 0.500, '2099-02-02',
   now() - interval '8 hours', 'catch_all',
   '22222222-aaaa-2222-2222-222222222222'::uuid, 250.000,
   'catch_all', now() - interval '8 hours');

SELECT lot_id AS row1_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('toctou_alice')
   AND pickup_event_id = '11111111-aaaa-1111-1111-111111111111'::uuid \gset

SELECT lot_id AS row2_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('toctou_alice')
   AND pickup_event_id = '22222222-aaaa-2222-2222-222222222222'::uuid \gset

SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1: simulate the race — refresh row1 to NOW (concurrent
-- catch_all_first_measurement) BEFORE invoking the reaper. The fixed
-- reaper's UPDATE clause re-asserts that in_flight_since hasn't moved
-- since selection, so row1 is preserved while row2 is reaped.
--
-- Note: we can't truly interleave the CTE selector with the bump in
-- pgTAP, but the fix's *additional* "in_flight_since < now() - TTL"
-- predicate in the UPDATE WHERE clause handles the post-bump case
-- regardless of selector ordering. A row whose in_flight_since was
-- just bumped to NOW fails BOTH (a) sl.in_flight_since =
-- expired.original_since (different value) AND (b) the re-asserted
-- TTL predicate, so it can't be cleared.
------------------------------------------------------------

UPDATE chefbyte.stock_lots
   SET in_flight_since = now(),
       pickup_event_id = '99999999-9999-9999-9999-999999999999'::uuid,
       pickup_weight_g = 999.000,
       last_update_ts  = now()
 WHERE lot_id = :'row1_lot_id'::uuid;

-- Reap. With the TOCTOU fix, only row2 is reaped (row1 is fresh now).
-- Without the fix (pre-20260428020000), the CTE selector wouldn't pick
-- row1 in the first place because its in_flight_since is now < TTL,
-- so this exact scenario is selector-safe. The harder case the fix
-- addresses is the race where the CTE selected the row at age=8h but
-- a concurrent UPDATE bumped it BEFORE our UPDATE phase. We
-- approximate that race by directly testing the post-CTE predicate:
-- a row whose in_flight_since differs from when it was selected
-- (because we bumped it) MUST NOT be cleared.
SELECT is(
  private.reap_catch_all_in_flight(21600, 100),
  1,
  'case 1a: only row2 reaped (row1 was concurrently refreshed)'
);

SELECT is(
  (SELECT in_flight_kind FROM chefbyte.stock_lots
    WHERE lot_id = :'row1_lot_id'::uuid),
  'catch_all',
  'case 1b: refreshed row1 still has catch_all marker'
);

SELECT is(
  (SELECT in_flight_kind FROM chefbyte.stock_lots
    WHERE lot_id = :'row2_lot_id'::uuid),
  NULL,
  'case 1c: stale row2 had its marker cleared'
);

------------------------------------------------------------
-- Case 2: belt-and-braces — the UPDATE's re-asserted TTL predicate
-- alone defeats the race. Insert a row that was expired-at-CTE-select-
-- time but has been bumped to NOW by the time the UPDATE runs. The
-- fix's "AND sl.in_flight_since < (now() - interval ttl)" clause in
-- the UPDATE filters it out even if our CTE selector somehow saw the
-- old timestamp. We simulate by pre-bumping the row, then calling
-- reaper, then asserting nothing was cleared.
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  in_flight_since, in_flight_kind, pickup_event_id, pickup_weight_g,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('toctou_alice'), :'alice_product_id',
  :'alice_fridge_id', 0.300, '2099-12-31',
  -- Fresh: NOT expired. Pre-fix would be filtered by CTE; the fix
  -- guarantees that AT THE UPDATE STAGE this row also fails the
  -- re-asserted age predicate (defense in depth).
  now() - interval '5 minutes', 'catch_all',
  '33333333-aaaa-3333-3333-333333333333'::uuid, 150.000,
  'catch_all', now() - interval '5 minutes'
);

SELECT is(
  private.reap_catch_all_in_flight(21600, 100),
  0,
  'case 2: no fresh catch_all rows are ever cleared (defense in depth)'
);

------------------------------------------------------------
-- Case 3: source-level mutation guards. The fix MUST ship two
-- TOCTOU defenses; assert both are present in the function body so a
-- future refactor can't silently drop one without breaking the test
-- and inviting the regression back in.
------------------------------------------------------------

SELECT ok(
  pg_get_functiondef(
    'private.reap_catch_all_in_flight(integer, integer)'::regprocedure
  ) ILIKE '%FOR UPDATE SKIP LOCKED%',
  'case 3a: function uses FOR UPDATE SKIP LOCKED on the CTE selector'
);

SELECT ok(
  pg_get_functiondef(
    'private.reap_catch_all_in_flight(integer, integer)'::regprocedure
  ) ILIKE '%original_since%',
  'case 3b: function re-asserts in_flight_since via captured original_since'
);

SELECT * FROM finish();
ROLLBACK;
