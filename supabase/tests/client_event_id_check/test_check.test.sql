-- pgTAP: shelf_event_log_client_event_id_nonempty CHECK constraint
--
-- Verifies the constraint added by migration
-- 20260430000000_client_event_id_check.sql:
--   - Non-empty client_event_id → INSERT succeeds
--   - Empty string ''          → INSERT fails (CHECK violation)
--   - Whitespace-only '   '   → INSERT fails (CHECK violation)
--   - NULL                     → INSERT fails (NOT NULL violation)
--
-- Uses SET ROLE service_role to bypass RLS (shelf_event_log is write-only
-- via service_role; the real edge function path). UUIDs are cached in
-- session GUCs before role switch since service_role cannot access the
-- tests schema (matches the pattern in coachbyte/timer_states.test.sql).

BEGIN;
SELECT plan(4);

-- ─── Setup ───────────────────────────────────────────────────────────────────
SELECT tests.create_supabase_user('ceid_tester');
SELECT tests.authenticate_as('ceid_tester');
SELECT hub.activate_app('chefbyte');

-- Insert a live_shelf_devices row while still running as authenticated user
INSERT INTO chefbyte.live_shelf_devices (user_id, device_name, import_key_hash)
VALUES (
  tests.get_supabase_uid('ceid_tester'),
  'Test Device',
  md5('test-import-key-ceid')
);

-- Cache user_id and device_id in session GUCs before SET ROLE service_role.
-- service_role cannot access the tests schema, so we use GUCs to pass the
-- UUIDs across the role boundary.
SELECT set_config(
  'tests.ceid_user_id',
  tests.get_supabase_uid('ceid_tester')::text,
  false  -- session-scoped, survives SET ROLE
);

SELECT set_config(
  'tests.ceid_device_id',
  (SELECT device_id::text
     FROM chefbyte.live_shelf_devices
    WHERE user_id = tests.get_supabase_uid('ceid_tester') AND device_name = 'Test Device'),
  false
);

-- Switch to service_role so shelf_event_log RLS is bypassed
-- (shelf_event_log has no write policy for authenticated — writes are
--  service_role only, matching the real edge function path).
SET LOCAL ROLE service_role;

-- ─── Test 1: non-empty client_event_id → success ─────────────────────────────

SELECT lives_ok(
  $$
    INSERT INTO chefbyte.shelf_event_log (
      user_id, device_id, client_event_id, payload, applied
    ) VALUES (
      current_setting('tests.ceid_user_id')::uuid,
      current_setting('tests.ceid_device_id')::uuid,
      'uuid-1234-non-empty',
      '{"scale_id":"s1","kind":"pickup","event_kind":"consume_product","product_id":null,"delta_g":-50,"occurred_at":"2026-04-30T00:00:00Z"}'::jsonb,
      false
    )
  $$,
  'INSERT with non-empty client_event_id must succeed'
);

-- ─── Test 2: empty string client_event_id → CHECK violation ──────────────────

SELECT throws_ok(
  $$
    INSERT INTO chefbyte.shelf_event_log (
      user_id, device_id, client_event_id, payload, applied
    ) VALUES (
      current_setting('tests.ceid_user_id')::uuid,
      current_setting('tests.ceid_device_id')::uuid,
      '',
      '{}'::jsonb,
      false
    )
  $$,
  '23514',  -- check_violation SQLSTATE
  NULL,
  'INSERT with empty string client_event_id must fail with check_violation'
);

-- ─── Test 3: whitespace-only client_event_id → CHECK violation ───────────────

SELECT throws_ok(
  $$
    INSERT INTO chefbyte.shelf_event_log (
      user_id, device_id, client_event_id, payload, applied
    ) VALUES (
      current_setting('tests.ceid_user_id')::uuid,
      current_setting('tests.ceid_device_id')::uuid,
      '   ',
      '{}'::jsonb,
      false
    )
  $$,
  '23514',  -- check_violation SQLSTATE
  NULL,
  'INSERT with whitespace-only client_event_id must fail with check_violation'
);

-- ─── Test 4: NULL client_event_id → NOT NULL violation ───────────────────────
-- The column is already NOT NULL (from the original table DDL). Verify the
-- constraint is still in place (regression guard — we must not have accidentally
-- dropped NOT NULL while adding the CHECK).

SELECT throws_ok(
  $$
    INSERT INTO chefbyte.shelf_event_log (
      user_id, device_id, client_event_id, payload, applied
    ) VALUES (
      current_setting('tests.ceid_user_id')::uuid,
      current_setting('tests.ceid_device_id')::uuid,
      NULL,
      '{}'::jsonb,
      false
    )
  $$,
  '23502',  -- not_null_violation SQLSTATE
  NULL,
  'INSERT with NULL client_event_id must fail with not_null_violation'
);

SELECT * FROM finish();
ROLLBACK;
