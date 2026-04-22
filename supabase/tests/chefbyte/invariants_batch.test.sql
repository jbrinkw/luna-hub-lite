-- pgTAP — 6 cloud-side invariant partial unique indexes + [MEAL] helper.
--
-- Validates supabase/migrations/20260424090000_invariant_batch.sql.
-- Each invariant is tested with (a) happy-path insert, (b) a
-- violating second insert that must raise 23505 (unique_violation),
-- and (c) where a non-violating neighbour is allowed to coexist.
-- The [MEAL] helper gets layered collision tests.

BEGIN;
SELECT plan(33);

------------------------------------------------------------
-- Setup
------------------------------------------------------------
SELECT tests.create_supabase_user('inv_alice', 'inv_alice@test.com');
SELECT tests.create_supabase_user('inv_bob',   'inv_bob@test.com');

SELECT tests.authenticate_as('inv_alice');
SELECT hub.activate_app('chefbyte');
SELECT hub.activate_app('coachbyte');

SELECT tests.authenticate_as('inv_bob');
SELECT hub.activate_app('chefbyte');
SELECT hub.activate_app('coachbyte');

-- Capture UIDs for service_role phase
SELECT tests.get_supabase_uid('inv_alice') AS alice_uid \gset
SELECT tests.get_supabase_uid('inv_bob')   AS bob_uid   \gset

------------------------------------------------------------
-- Invariant 1: coachbyte.timers — one active per user
------------------------------------------------------------
-- The table also has user_id UNIQUE at the column level; both
-- constraints raise 23505, so the test proves the invariant without
-- distinguishing which index catches it. We also assert that the
-- partial index was actually created so a future relax of the
-- column UNIQUE doesn't silently drop the guarantee.

SELECT tests.authenticate_as('inv_alice');

SELECT has_index(
  'coachbyte', 'timers', 'timers_one_active_per_user',
  'partial unique index timers_one_active_per_user exists'
);

-- Happy path: one running timer inserts cleanly.
INSERT INTO coachbyte.timers (
  timer_id, user_id, state, end_time, duration_seconds, elapsed_before_pause
) VALUES (
  '11111111-1111-1111-1111-111111111101',
  :'alice_uid'::uuid,
  'running', now() + interval '60 seconds', 60, 0
);

SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.timers
          WHERE timer_id = '11111111-1111-1111-1111-111111111101'
            AND state = 'running'),
  'invariant 1: first running timer inserted for alice'
);

-- Violation: a second row (running) for alice is rejected.
SELECT throws_ok(
  $sql$INSERT INTO coachbyte.timers (
         timer_id, user_id, state, end_time, duration_seconds,
         elapsed_before_pause
       ) VALUES (
         '11111111-1111-1111-1111-111111111102',
         (SELECT user_id FROM coachbyte.timers
           WHERE timer_id = '11111111-1111-1111-1111-111111111101'),
         'running', now() + interval '60 seconds', 60, 0
       )$sql$,
  '23505',
  NULL,
  'invariant 1: second active timer for same user rejected'
);

-- Cross-user neighbour: bob's row coexists.
SELECT tests.authenticate_as('inv_bob');
INSERT INTO coachbyte.timers (
  timer_id, user_id, state, end_time, duration_seconds, elapsed_before_pause
) VALUES (
  '11111111-1111-1111-1111-11111111110b',
  :'bob_uid'::uuid,
  'running', now() + interval '60 seconds', 60, 0
);
SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.timers
          WHERE timer_id = '11111111-1111-1111-1111-11111111110b'),
  'invariant 1: cross-user timer permitted'
);

------------------------------------------------------------
-- Invariant 2: chefbyte.scale_pairings UNIQUE(user_id, scale_id)
------------------------------------------------------------
-- Seed a device per user via service_role (bypasses RLS + FK chase).

SELECT tests.clear_authentication();
SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash
) VALUES
  ('22222222-2222-2222-2222-222222222201', :'alice_uid'::uuid,
   'alice-pi', 'inv_hash_alice_' || gen_random_uuid()),
  ('22222222-2222-2222-2222-22222222220b', :'bob_uid'::uuid,
   'bob-pi',   'inv_hash_bob_'   || gen_random_uuid());

-- Happy path: alice pairs her pi with scale-01.
INSERT INTO chefbyte.scale_pairings (
  pairing_id, user_id, device_id, scale_id, kind
) VALUES (
  '22222222-2222-2222-2222-2222222222a1',
  :'alice_uid'::uuid,
  '22222222-2222-2222-2222-222222222201',
  'scale-01',
  'live_scale'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.scale_pairings
          WHERE pairing_id = '22222222-2222-2222-2222-2222222222a1'),
  'invariant 2: first scale pairing inserted'
);

SELECT has_index(
  'chefbyte', 'scale_pairings', 'scale_pairings_unique_per_scale',
  'invariant 2: unique index scale_pairings_unique_per_scale exists'
);

-- Violation: a second pairing for the same (alice, scale-01) rejected
-- even via a different device_id (the pre-existing UNIQUE(device_id,
-- scale_id) would let this through — our new index catches it).
SELECT throws_ok(
  format(
    $sql$INSERT INTO chefbyte.live_shelf_devices (
           device_id, user_id, device_name, import_key_hash
         ) VALUES (
           '22222222-2222-2222-2222-222222222202', %L,
           'alice-pi-2', 'inv_hash_alice2_' || gen_random_uuid()
         );
         INSERT INTO chefbyte.scale_pairings (
           pairing_id, user_id, device_id, scale_id, kind
         ) VALUES (
           '22222222-2222-2222-2222-2222222222a2', %L,
           '22222222-2222-2222-2222-222222222202',
           'scale-01', 'live_scale'
         )$sql$,
    :'alice_uid', :'alice_uid'
  ),
  '23505',
  NULL,
  'invariant 2: duplicate (user, scale_id) across devices rejected'
);

-- Cross-user: bob can pair his pi to scale-01 (distinct user_id).
INSERT INTO chefbyte.scale_pairings (
  pairing_id, user_id, device_id, scale_id, kind
) VALUES (
  '22222222-2222-2222-2222-2222222222b1',
  :'bob_uid'::uuid,
  '22222222-2222-2222-2222-22222222220b',
  'scale-01',
  'live_scale'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.scale_pairings
          WHERE pairing_id = '22222222-2222-2222-2222-2222222222b1'),
  'invariant 2: cross-user scale pairing permitted'
);

-- Same user, different scale_id: allowed.
INSERT INTO chefbyte.scale_pairings (
  pairing_id, user_id, device_id, scale_id, kind
) VALUES (
  '22222222-2222-2222-2222-2222222222a3',
  :'alice_uid'::uuid,
  '22222222-2222-2222-2222-222222222201',
  'scale-02',
  'live_scale'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.scale_pairings
          WHERE pairing_id = '22222222-2222-2222-2222-2222222222a3'),
  'invariant 2: same user, different scale_id permitted'
);

SET ROLE postgres;

------------------------------------------------------------
-- Invariant 3: chefbyte.live_shelf_devices one-active-per-user
------------------------------------------------------------

SET ROLE service_role;

-- Alice already has one active device (22222222-...-201 from Inv 2).
-- Partial index exists.
SELECT has_index(
  'chefbyte', 'live_shelf_devices', 'live_shelf_devices_one_active_per_user',
  'invariant 3: partial unique index live_shelf_devices_one_active_per_user exists'
);

-- Violation: a second active device for alice is rejected.
SELECT throws_ok(
  format(
    $sql$INSERT INTO chefbyte.live_shelf_devices (
           device_id, user_id, device_name, import_key_hash, is_active
         ) VALUES (
           '33333333-3333-3333-3333-333333333333', %L,
           'alice-pi-extra', 'inv_hash_alice_x_' || gen_random_uuid(),
           true
         )$sql$,
    :'alice_uid'
  ),
  '23505',
  NULL,
  'invariant 3: second active pi for same user rejected'
);

-- Happy path: an inactive second device is allowed (audit trail).
INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash, is_active
) VALUES (
  '33333333-3333-3333-3333-333333333301',
  :'alice_uid'::uuid,
  'alice-pi-retired', 'inv_hash_alice_retired_' || gen_random_uuid(),
  false
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.live_shelf_devices
          WHERE device_id = '33333333-3333-3333-3333-333333333301'
            AND is_active = false),
  'invariant 3: inactive second device permitted (audit row)'
);

SET ROLE postgres;

------------------------------------------------------------
-- Invariant 4: chefbyte.food_logs idempotency key
------------------------------------------------------------

SET ROLE service_role;

-- Seed a product for alice (food_logs FKs products).
INSERT INTO chefbyte.products (
  product_id, user_id, name, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  '44444444-4444-4444-4444-444444444401',
  :'alice_uid'::uuid,
  'Invariant Product',
  1, 100, 10, 5, 2
);

-- Partial unique index exists
SELECT has_index(
  'chefbyte', 'food_logs', 'food_logs_source_event_unique',
  'invariant 4: partial unique index food_logs_source_event_unique exists'
);

-- Confirm the old non-unique index is gone
SELECT hasnt_index(
  'chefbyte', 'food_logs', 'food_logs_source_client_event_idx',
  'invariant 4: old non-unique index removed'
);

-- Happy path: one food_log with a client event id.
INSERT INTO chefbyte.food_logs (
  log_id, user_id, product_id, logical_date, qty_consumed, unit,
  calories, carbs, protein, fat, source_client_event_id
) VALUES (
  '44444444-4444-4444-4444-444444444a01',
  :'alice_uid'::uuid,
  '44444444-4444-4444-4444-444444444401',
  CURRENT_DATE, 1, 'serving',
  100, 10, 5, 2,
  'evt-first-placement'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.food_logs
          WHERE source_client_event_id = 'evt-first-placement'),
  'invariant 4: first food_log with event id inserted'
);

-- Violation: second insert with same (user, event_id) rejected.
SELECT throws_ok(
  format(
    $sql$INSERT INTO chefbyte.food_logs (
           log_id, user_id, product_id, logical_date, qty_consumed, unit,
           calories, carbs, protein, fat, source_client_event_id
         ) VALUES (
           '44444444-4444-4444-4444-444444444a02', %L,
           '44444444-4444-4444-4444-444444444401',
           CURRENT_DATE, 1, 'serving',
           100, 10, 5, 2,
           'evt-first-placement'
         )$sql$,
    :'alice_uid'
  ),
  '23505',
  NULL,
  'invariant 4: duplicate (user, source_client_event_id) rejected'
);

-- NULL source_client_event_id: multiple rows allowed (partial WHERE).
INSERT INTO chefbyte.food_logs (
  log_id, user_id, product_id, logical_date, qty_consumed, unit,
  calories, carbs, protein, fat
) VALUES (
  '44444444-4444-4444-4444-444444444a03',
  :'alice_uid'::uuid,
  '44444444-4444-4444-4444-444444444401',
  CURRENT_DATE, 1, 'serving', 100, 10, 5, 2
);

INSERT INTO chefbyte.food_logs (
  log_id, user_id, product_id, logical_date, qty_consumed, unit,
  calories, carbs, protein, fat
) VALUES (
  '44444444-4444-4444-4444-444444444a04',
  :'alice_uid'::uuid,
  '44444444-4444-4444-4444-444444444401',
  CURRENT_DATE, 1, 'serving', 100, 10, 5, 2
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.food_logs
    WHERE log_id IN (
      '44444444-4444-4444-4444-444444444a03',
      '44444444-4444-4444-4444-444444444a04'
    )),
  2,
  'invariant 4: NULL source_client_event_id rows coexist'
);

-- Cross-user: bob may use the same event_id string as alice.
INSERT INTO chefbyte.products (
  product_id, user_id, name, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  '44444444-4444-4444-4444-44444444440b',
  :'bob_uid'::uuid,
  'Invariant Product Bob',
  1, 100, 10, 5, 2
);

INSERT INTO chefbyte.food_logs (
  log_id, user_id, product_id, logical_date, qty_consumed, unit,
  calories, carbs, protein, fat, source_client_event_id
) VALUES (
  '44444444-4444-4444-4444-444444444b01',
  :'bob_uid'::uuid,
  '44444444-4444-4444-4444-44444444440b',
  CURRENT_DATE, 1, 'serving', 100, 10, 5, 2,
  'evt-first-placement'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.food_logs
          WHERE log_id = '44444444-4444-4444-4444-444444444b01'),
  'invariant 4: same event_id across users permitted'
);

SET ROLE postgres;

------------------------------------------------------------
-- Invariant 5: private.generate_meal_product_name helper
------------------------------------------------------------

SET ROLE service_role;

-- Helper function exists
SELECT has_function(
  'private', 'generate_meal_product_name',
  ARRAY['uuid','text','date'],
  'invariant 5: helper private.generate_meal_product_name(uuid,text,date) exists'
);

-- Layer 1: no collision → returns MM-DD shape.
SELECT is(
  private.generate_meal_product_name(
    :'alice_uid'::uuid, 'Alfredo', DATE '2026-04-22'
  ),
  '[MEAL] Alfredo 04-22',
  'invariant 5: no collision returns "[MEAL] <base> MM-DD"'
);

-- Plant a collision for layer 1.
INSERT INTO chefbyte.products (
  product_id, user_id, name, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  '55555555-5555-5555-5555-555555555501',
  :'alice_uid'::uuid,
  '[MEAL] Alfredo 04-22',
  1, 300, 40, 15, 8
);

-- Layer 2: returns HH:MM-suffixed shape when layer 1 is taken.
SELECT matches(
  private.generate_meal_product_name(
    :'alice_uid'::uuid, 'Alfredo', DATE '2026-04-22'
  ),
  '^\[MEAL\] Alfredo 04-22 [0-9]{2}:[0-9]{2}$',
  'invariant 5: collision returns "[MEAL] <base> MM-DD HH:MM"'
);

-- Cross-user isolation: bob's namespace does not see alice's row.
SELECT is(
  private.generate_meal_product_name(
    :'bob_uid'::uuid, 'Alfredo', DATE '2026-04-22'
  ),
  '[MEAL] Alfredo 04-22',
  'invariant 5: helper scopes uniqueness per user'
);

SET ROLE postgres;

------------------------------------------------------------
-- Invariant 6: chefbyte.livetrack_import_sessions one-active-per-user
------------------------------------------------------------

SET ROLE service_role;

SELECT has_index(
  'chefbyte', 'livetrack_import_sessions',
  'livetrack_sessions_one_active_per_user',
  'invariant 6: partial unique index livetrack_sessions_one_active_per_user exists'
);

-- Happy path: first active session for alice.
INSERT INTO chefbyte.livetrack_import_sessions (
  session_id, user_id, device_id, state
) VALUES (
  '66666666-6666-6666-6666-666666666601',
  :'alice_uid'::uuid,
  '22222222-2222-2222-2222-222222222201',
  'waiting_barcode'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.livetrack_import_sessions
          WHERE session_id = '66666666-6666-6666-6666-666666666601'),
  'invariant 6: first active session inserted'
);

-- Violation: a second active session for alice rejected.
SELECT throws_ok(
  format(
    $sql$INSERT INTO chefbyte.livetrack_import_sessions (
           session_id, user_id, device_id, state
         ) VALUES (
           '66666666-6666-6666-6666-666666666602', %L,
           '22222222-2222-2222-2222-222222222201',
           'waiting_scale'
         )$sql$,
    :'alice_uid'
  ),
  '23505',
  NULL,
  'invariant 6: second active livetrack session rejected'
);

-- Happy path: a closed session alongside an active one is fine.
INSERT INTO chefbyte.livetrack_import_sessions (
  session_id, user_id, device_id, state
) VALUES (
  '66666666-6666-6666-6666-666666666603',
  :'alice_uid'::uuid,
  '22222222-2222-2222-2222-222222222201',
  'closed'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.livetrack_import_sessions
          WHERE session_id = '66666666-6666-6666-6666-666666666603'
            AND state = 'closed'),
  'invariant 6: closed session coexists with active session'
);

-- Multiple closed/expired rows coexist (partial WHERE excludes them).
INSERT INTO chefbyte.livetrack_import_sessions (
  session_id, user_id, device_id, state
) VALUES (
  '66666666-6666-6666-6666-666666666604',
  :'alice_uid'::uuid,
  '22222222-2222-2222-2222-222222222201',
  'expired'
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.livetrack_import_sessions
    WHERE user_id = :'alice_uid'::uuid
      AND state IN ('closed','expired')),
  2,
  'invariant 6: multiple closed/expired sessions coexist'
);

-- Cross-user: bob may have his own active session.
INSERT INTO chefbyte.livetrack_import_sessions (
  session_id, user_id, device_id, state
) VALUES (
  '66666666-6666-6666-6666-666666666b01',
  :'bob_uid'::uuid,
  '22222222-2222-2222-2222-22222222220b',
  'waiting_barcode'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.livetrack_import_sessions
          WHERE session_id = '66666666-6666-6666-6666-666666666b01'),
  'invariant 6: cross-user active session permitted'
);

SET ROLE postgres;

------------------------------------------------------------
-- Consolidation (pre-scan) coverage
------------------------------------------------------------
-- The pre-migration consolidation policies are documented in the
-- migration header. Fresh DBs have nothing to consolidate, so we
-- assert shape-level invariants post-state rather than replay a
-- pre-migration violation fixture — the migration's pre-scan SQL is
-- a CTE + UPDATE/DELETE, whose correctness is covered by the
-- individual invariant tests above (if pre-scan had been buggy,
-- the migration would have left violating rows behind and the
-- ``CREATE UNIQUE INDEX`` step itself would have raised 23505).

-- Post-migration invariant 1 count
SELECT is(
  (SELECT COUNT(*)::int
     FROM (
       SELECT user_id
         FROM coachbyte.timers
        WHERE state IN ('running','paused')
        GROUP BY user_id
       HAVING COUNT(*) > 1
     ) AS dup),
  0,
  'post-migration: zero users have multiple active timers'
);

-- Post-migration invariant 2 count
SELECT is(
  (SELECT COUNT(*)::int
     FROM (
       SELECT user_id, scale_id
         FROM chefbyte.scale_pairings
        GROUP BY user_id, scale_id
       HAVING COUNT(*) > 1
     ) AS dup),
  0,
  'post-migration: zero (user_id, scale_id) duplicates in scale_pairings'
);

-- Post-migration invariant 3 count
SELECT is(
  (SELECT COUNT(*)::int
     FROM (
       SELECT user_id
         FROM chefbyte.live_shelf_devices
        WHERE is_active = true
        GROUP BY user_id
       HAVING COUNT(*) > 1
     ) AS dup),
  0,
  'post-migration: zero users have multiple active Pi devices'
);

-- Post-migration invariant 4 count
SELECT is(
  (SELECT COUNT(*)::int
     FROM (
       SELECT user_id, source_client_event_id
         FROM chefbyte.food_logs
        WHERE source_client_event_id IS NOT NULL
        GROUP BY user_id, source_client_event_id
       HAVING COUNT(*) > 1
     ) AS dup),
  0,
  'post-migration: zero (user, source_client_event_id) duplicates in food_logs'
);

-- Post-migration invariant 6 count
SELECT is(
  (SELECT COUNT(*)::int
     FROM (
       SELECT user_id
         FROM chefbyte.livetrack_import_sessions
        WHERE state NOT IN ('closed','expired')
        GROUP BY user_id
       HAVING COUNT(*) > 1
     ) AS dup),
  0,
  'post-migration: zero users have multiple active livetrack sessions'
);

SELECT * FROM finish();
ROLLBACK;
