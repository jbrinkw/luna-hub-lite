-- Cloud-authoritative logical_date for Pi-driven events.
--
-- Verifies 20260424060000_logical_date_from_cloud_clock.sql: when the Pi
-- posts a shelf event with a bogus future `occurred_at` (simulating NTP
-- skew), the cloud MUST derive food_logs.logical_date from cloud now()
-- rather than the Pi's value. The Pi-supplied occurred_at is preserved
-- in shelf_event_log.payload for forensics.

BEGIN;
SELECT plan(5);

-- ─────────────────────────────────────────────────────────────
-- Setup: seed the owner + an authenticated chefbyte activation +
-- a live_shelf device + product with enough weight data for
-- apply_shelf_event to resolve net_weight_g.
-- ─────────────────────────────────────────────────────────────
SELECT tests.create_supabase_user('clock_tester');
SELECT tests.authenticate_as('clock_tester');
SELECT hub.activate_app('chefbyte');

SELECT tests.get_supabase_uid('clock_tester') AS _owner_uid \gset

-- Pin tz + dsh so we can predict cloud logical_date.
UPDATE hub.profiles
   SET timezone = 'UTC', day_start_hour = 0
 WHERE user_id = :'_owner_uid'::uuid;

SELECT location_id AS fridge_id
  FROM chefbyte.locations
  WHERE user_id = :'_owner_uid'::uuid AND name = 'Fridge' \gset

INSERT INTO chefbyte.products (
  product_id, user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, protein_per_serving, fat_per_serving,
  carbs_per_serving
) VALUES (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  :'_owner_uid'::uuid,
  'ClockTestChicken', 100, 4, 165, 31, 3.6, 0
);

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on
) VALUES (
  :'_owner_uid'::uuid,
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  :'fridge_id', 2.0, '2099-01-01'
);

-- shelf_event_log + live_shelf_devices require service_role to INSERT;
-- apply_shelf_event itself also needs service_role (REVOKE PUBLIC on
-- private.apply_shelf_event, GRANT to service_role only).
SELECT tests.clear_authentication();
SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash
) VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  :'_owner_uid'::uuid,
  'clock-test-shelf',
  'sha-hash-placeholder-clock-' || gen_random_uuid()
);

-- ─────────────────────────────────────────────────────────────
-- Drive apply_shelf_event with a FAR-FUTURE occurred_at (2099).
-- If the RPC still derived logical_date from p_occurred_at, the
-- food_logs row would land on 2099-01-01. Cloud-authoritative
-- derivation must put it on TODAY (cloud now() in UTC, dsh=0).
-- ─────────────────────────────────────────────────────────────
SELECT * FROM private.apply_shelf_event(
  :'_owner_uid'::uuid,                     -- p_user_id
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,  -- p_device_id
  'scale-01',                              -- p_scale_id
  'live_shelf',                            -- p_kind
  'consumed',                              -- p_event_kind
  'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,  -- p_product_id
  -50,                                     -- p_delta_g (half of net_weight_g → 0.5 containers)
  '2099-01-01T00:00:00Z'::timestamptz,     -- p_occurred_at (SKEWED)
  'clock-test-event-1',                    -- p_client_event_id
  NULL                                     -- p_pi_event_id
);

SET ROLE postgres;
SELECT tests.authenticate_as('clock_tester');

-- ─────────────────────────────────────────────────────────────
-- T1: food_log row exists for this event
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'clock-test-event-1'),
  1,
  'apply_shelf_event wrote a food_logs row for the skewed event'
);

-- ─────────────────────────────────────────────────────────────
-- T2: food_log.logical_date is TODAY (cloud now()) — NOT 2099-01-01
-- Since the user's tz=UTC and day_start_hour=0, cloud logical_date
-- reduces to (now() AT TIME ZONE 'UTC')::date — compute inline so
-- the test doesn't need private.get_logical_date grants.
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT logical_date FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'clock-test-event-1'),
  ((now() AT TIME ZONE 'UTC')::date),
  'food_logs.logical_date uses cloud now() (today), NOT Pi''s future occurred_at'
);

-- ─────────────────────────────────────────────────────────────
-- T3: logical_date is definitely NOT 2099
-- ─────────────────────────────────────────────────────────────
SELECT isnt(
  (SELECT logical_date FROM chefbyte.food_logs
    WHERE user_id = :'_owner_uid'::uuid
      AND source_client_event_id = 'clock-test-event-1'),
  '2099-01-01'::date,
  'food_logs.logical_date is not 2099-01-01 (Pi-clock skew ignored)'
);

-- ─────────────────────────────────────────────────────────────
-- T4: Pi-supplied occurred_at is still preserved in shelf_event_log.payload
-- (forensic — the event's own timestamp isn't rewritten to now())
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT (payload->>'occurred_at')::timestamptz FROM chefbyte.shelf_event_log
    WHERE user_id = :'_owner_uid'::uuid
      AND client_event_id = 'clock-test-event-1'),
  '2099-01-01T00:00:00Z'::timestamptz,
  'shelf_event_log.payload.occurred_at preserves Pi-supplied timestamp for forensics'
);

-- ─────────────────────────────────────────────────────────────
-- T5: stock_lots.last_update_ts also preserves the Pi timestamp
-- (per spec: not our authoritative date attribution, but fine as
-- a per-lot audit trail)
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT last_update_ts FROM chefbyte.stock_lots
    WHERE user_id = :'_owner_uid'::uuid
      AND product_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  '2099-01-01T00:00:00Z'::timestamptz,
  'stock_lots.last_update_ts preserves Pi-supplied timestamp (forensic audit)'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('clock_tester');

SELECT * FROM finish();
ROLLBACK;
