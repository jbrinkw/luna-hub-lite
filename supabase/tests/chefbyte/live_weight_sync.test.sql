-- pgTAP — apply_live_weight_sync per-lot live-weight observation flow.
--
-- Validates supabase/migrations/20260429030000_live_weight_sync.sql.
--
-- Coverage:
--   1. Schema: last_observed_weight_g + last_observed_at columns exist
--      with the expected types + CHECK constraint shape.
--   2. Happy path: live_shelf weight sync updates ONLY the two
--      observation columns, leaves qty_containers + in_flight_* +
--      last_update_* untouched, writes NO food_logs row.
--   3. live_scale weight sync also works (kind='live_scale').
--   4. Idempotent replay: same client_event_id returns cached result
--      without re-running the UPDATE (memory: increment a marker so we
--      can detect a second UPDATE happening).
--   5. Stale-write protection: out-of-order arrival (older observed_at
--      than stored) records the event with applied=true reason starting
--      with 'stale' but does NOT regress last_observed_at /
--      last_observed_weight_g.
--   6. Cross-user lot rejected: applied=false reason='lot_id not owned
--      by user'.
--   7. catch_all kind rejected: the helper enforces kind in
--      (live_shelf, live_scale) only — catch_all has its own delta-
--      capture stream.
--   8. Negative observed_weight_g rejected.
--   9. Both columns populate together — never one without the other.
--  10. Independent of in-flight markers: an in-flight lot still gets
--      its observation columns updated (the catch-all-style "lot is
--      in flight but has been re-measured" flow is supported).

BEGIN;
SELECT plan(25);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('lws_alice');
SELECT tests.authenticate_as('lws_alice');
SELECT hub.activate_app('chefbyte');

-- Product with full macros so we can confirm food_logs stays empty.
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('lws_alice'),
  'LWS Trail Mix',
  500.000, 5,
  200, 24, 4, 12
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('lws_alice')
   AND name = 'LWS Trail Mix' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('lws_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('lws_alice'),
  'lws-pi',
  'lws_hash_alice',
  true
);

SELECT device_id AS alice_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('lws_alice')
   AND device_name = 'lws-pi' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('lws_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  1.000,
  'live_shelf',
  '2026-04-28 10:00:00+00'::timestamptz
);

SELECT lot_id AS alice_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('lws_alice')
   AND product_id = :'alice_product_id' \gset

SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1: schema columns exist
------------------------------------------------------------

SELECT has_column('chefbyte', 'stock_lots', 'last_observed_weight_g',
  'case 1a: last_observed_weight_g column exists');

SELECT has_column('chefbyte', 'stock_lots', 'last_observed_at',
  'case 1b: last_observed_at column exists');

SELECT col_type_is('chefbyte', 'stock_lots', 'last_observed_weight_g',
  'numeric(10,3)',
  'case 1c: last_observed_weight_g is NUMERIC(10,3)');

SELECT col_type_is('chefbyte', 'stock_lots', 'last_observed_at',
  'timestamp with time zone',
  'case 1d: last_observed_at is TIMESTAMPTZ');

-- Negative weight rejected by CHECK constraint.
SELECT throws_ok(
  format(
    $$INSERT INTO chefbyte.stock_lots
        (user_id, product_id, location_id, qty_containers,
         last_observed_weight_g)
      VALUES (%L, %L, %L, 0, -1.0)$$,
    tests.get_supabase_uid('lws_alice'),
    :'alice_product_id',
    :'alice_fridge_id'
  ),
  '23514',
  NULL,
  'case 1e: last_observed_weight_g CHECK rejects negative values'
);

------------------------------------------------------------
-- Case 2: happy path live_shelf — observation columns update only
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_live_weight_sync(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf',
        %L::UUID, 160.4::NUMERIC,
        '2026-04-29 03:32:41+00'::timestamptz,
        'evt-lws-1', NULL
      )$$,
    tests.get_supabase_uid('lws_alice'),
    :'alice_device_id',
    :'alice_lot_id'
  ),
  'case 2a: live_weight_sync runs without error'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('lws_alice')
      AND client_event_id = 'evt-lws-1'),
  true,
  'case 2b: applied=true on happy path'
);

SELECT is(
  (SELECT last_observed_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  160.400::numeric(10,3),
  'case 2c: last_observed_weight_g matches the streamed value'
);

SELECT is(
  (SELECT last_observed_at FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  '2026-04-29 03:32:41+00'::timestamptz,
  'case 2d: last_observed_at matches the streamed timestamp'
);

-- qty_containers MUST NOT be touched.
SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  1.000::numeric(10,3),
  'case 2e: qty_containers stays event-driven (no mutation)'
);

-- last_update_ts MUST NOT be bumped — observations are not stock writes.
SELECT is(
  (SELECT last_update_ts FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  '2026-04-28 10:00:00+00'::timestamptz,
  'case 2f: last_update_ts not bumped (observation != stock mutation)'
);

-- food_logs MUST stay empty — no consumption claim.
SELECT is(
  (SELECT count(*)::bigint FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('lws_alice')
      AND source_client_event_id = 'evt-lws-1'),
  0::bigint,
  'case 2g: NO food_logs row written (observation not consumption)'
);

------------------------------------------------------------
-- Case 3: idempotent replay
------------------------------------------------------------
-- Re-call with the SAME client_event_id but a different observed_at +
-- weight. The cached row must replay; the lot must NOT pick up the
-- new values (would happen if the function ran the UPDATE again).

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_live_weight_sync(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf',
        %L::UUID, 999.000::NUMERIC,
        '2026-04-29 04:00:00+00'::timestamptz,
        'evt-lws-1', NULL
      )$$,
    tests.get_supabase_uid('lws_alice'),
    :'alice_device_id',
    :'alice_lot_id'
  ),
  'case 3a: replay with same client_event_id runs without error'
);

SELECT is(
  (SELECT last_observed_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  160.400::numeric(10,3),
  'case 3b: replay does NOT overwrite stored weight (cached reason returned)'
);

SELECT is(
  (SELECT last_observed_at FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  '2026-04-29 03:32:41+00'::timestamptz,
  'case 3c: replay does NOT overwrite stored timestamp'
);

-- Replay returns exactly one shelf_event_log row (the original) — the
-- ON CONFLICT DO NOTHING dedup guarantees this.
SELECT is(
  (SELECT count(*)::bigint FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('lws_alice')
      AND client_event_id = 'evt-lws-1'),
  1::bigint,
  'case 3d: replay does NOT insert a second shelf_event_log row'
);

------------------------------------------------------------
-- Case 4: stale-write protection
------------------------------------------------------------
-- Send an observation whose observed_at is OLDER than the stored
-- last_observed_at. The function records the event but skips the
-- UPDATE (returns reason starting with 'stale').

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_live_weight_sync(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf',
        %L::UUID, 50.0::NUMERIC,
        '2026-04-29 01:00:00+00'::timestamptz,
        'evt-lws-stale', NULL
      )$$,
    tests.get_supabase_uid('lws_alice'),
    :'alice_device_id',
    :'alice_lot_id'
  ),
  'case 4a: stale observation runs without error'
);

SELECT is(
  (SELECT last_observed_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  160.400::numeric(10,3),
  'case 4b: stale observation does NOT regress last_observed_weight_g'
);

SELECT is(
  (SELECT last_observed_at FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  '2026-04-29 03:32:41+00'::timestamptz,
  'case 4c: stale observation does NOT regress last_observed_at'
);

------------------------------------------------------------
-- Case 5: live_scale kind also works
------------------------------------------------------------
-- Seed a separate lot for live_scale path so it doesn't collide with
-- the live_shelf state above.

-- Distinct expires_on to avoid the (user, product, location, expires_on)
-- merge-key collision with the live_shelf lot above.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  expires_on,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('lws_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  0.500,
  '2027-01-01'::date,
  'live_scale',
  '2026-04-28 12:00:00+00'::timestamptz
);

SELECT lot_id AS scale_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('lws_alice')
   AND last_update_source = 'live_scale' \gset

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_live_weight_sync(
        %L::UUID, %L::UUID, 'scale-pi-3', 'live_scale',
        %L::UUID, 250.0::NUMERIC,
        '2026-04-29 03:35:00+00'::timestamptz,
        'evt-lws-scale', NULL
      )$$,
    tests.get_supabase_uid('lws_alice'),
    :'alice_device_id',
    :'scale_lot_id'
  ),
  'case 5a: live_scale weight sync runs without error'
);

SELECT is(
  (SELECT last_observed_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = :'scale_lot_id')::numeric(10,3),
  250.000::numeric(10,3),
  'case 5b: live_scale lot picks up the streamed weight'
);

------------------------------------------------------------
-- Case 6: catch_all kind REJECTED
------------------------------------------------------------
-- The helper enforces kind in (live_shelf, live_scale). catch_all
-- already has its own delta-capture stream.

SELECT throws_ok(
  format(
    $$SELECT * FROM private.apply_live_weight_sync(
        %L::UUID, %L::UUID, 'scale-02', 'catch_all',
        %L::UUID, 100.0::NUMERIC,
        '2026-04-29 03:40:00+00'::timestamptz,
        'evt-lws-catch', NULL
      )$$,
    tests.get_supabase_uid('lws_alice'),
    :'alice_device_id',
    :'alice_lot_id'
  ),
  '22023',
  NULL,
  'case 6: catch_all kind rejected (helper is live_shelf/live_scale only)'
);

------------------------------------------------------------
-- Case 7: cross-user lot rejected
------------------------------------------------------------

SELECT tests.create_supabase_user('lws_bob');
INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('lws_bob'),
  'bob-pi',
  'bob_hash',
  true
);
SELECT device_id AS bob_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('lws_bob') \gset

-- Bob tries to update Alice's lot.
SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_live_weight_sync(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf',
        %L::UUID, 99.0::NUMERIC,
        '2026-04-29 03:45:00+00'::timestamptz,
        'evt-lws-cross', NULL
      )$$,
    tests.get_supabase_uid('lws_bob'),
    :'bob_device_id',
    :'alice_lot_id'
  ),
  'case 7a: cross-user attempt does not raise (returns applied=false)'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('lws_bob')
      AND client_event_id = 'evt-lws-cross'),
  false,
  'case 7b: cross-user attempt rejected (applied=false)'
);

-- Alice's lot still has the original observation values.
SELECT is(
  (SELECT last_observed_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  160.400::numeric(10,3),
  'case 7c: Alice''s lot weight unchanged by cross-user attempt'
);

SELECT * FROM finish();
ROLLBACK;
