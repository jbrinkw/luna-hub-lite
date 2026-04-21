-- RLS isolation tests for chefbyte.shelf_event_log
-- Policy: shelf_event_log_rls FOR SELECT TO authenticated
--   USING ((select auth.uid()) = user_id)
--
-- Writes (INSERT/UPDATE/DELETE) are service_role-only by design — the
-- shelf-ingest edge function is the sole writer. For authenticated users:
--   * authenticated SELECTs MUST be scoped to their own rows.
--   * authenticated INSERTs / UPDATEs / DELETEs MUST be blocked entirely
--     (no policy granting those commands exists).
--
-- Parent: chefbyte.live_shelf_devices (device_id FK, ON DELETE CASCADE).
BEGIN;
SELECT plan(6);

-- Setup: two users, each with activation
SELECT tests.create_supabase_user('sel_rls_a');
SELECT tests.create_supabase_user('sel_rls_b');

SELECT tests.authenticate_as('sel_rls_a');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('sel_rls_b');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

-- Capture UIDs before switching to service_role (which lacks access to
-- the `tests` schema helpers used as SECURITY DEFINER).
SELECT tests.get_supabase_uid('sel_rls_a') AS _a_uid \gset
SELECT tests.get_supabase_uid('sel_rls_b') AS _b_uid \gset

-- ═══════════════════════════════════════════════════════════════
-- Service-role seeds a device + event log row for User A.
-- This mirrors the shelf-ingest edge function's write path.
-- ═══════════════════════════════════════════════════════════════

SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices
  (device_id, user_id, device_name, import_key_hash, is_active)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  :'_a_uid'::uuid,
  'owner-pi-sel',
  'hash_owner_sel_rls',
  true
);

INSERT INTO chefbyte.shelf_event_log
  (event_id, user_id, device_id, client_event_id, payload, applied, reason)
VALUES (
  '10000000-0000-0000-0000-000000000010',
  :'_a_uid'::uuid,
  '10000000-0000-0000-0000-000000000001',
  'evt-owner-0001',
  '{"kind":"consumed","delta_g":-120}'::jsonb,
  true,
  'decremented'
);

SET ROLE postgres;

-- ═══════════════════════════════════════════════════════════════
-- User A can SELECT their own event log row
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('sel_rls_a');

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.shelf_event_log
    WHERE event_id = '10000000-0000-0000-0000-000000000010'),
  'User A can SELECT own shelf_event_log'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot SELECT User A's event log rows
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('sel_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.shelf_event_log
    WHERE user_id = :'_a_uid'::uuid),
  0,
  'User B cannot SELECT User A shelf_event_log'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot UPDATE — no UPDATE policy for authenticated role,
-- so RLS filters all rows and the statement is a silent no-op.
-- ═══════════════════════════════════════════════════════════════

UPDATE chefbyte.shelf_event_log SET reason = 'Hacked', applied = false
  WHERE event_id = '10000000-0000-0000-0000-000000000010';
SELECT tests.authenticate_as('sel_rls_a');
SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE event_id = '10000000-0000-0000-0000-000000000010'),
  'decremented',
  'User B cannot UPDATE User A shelf_event_log'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot DELETE — no DELETE policy for authenticated role.
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('sel_rls_b');
DELETE FROM chefbyte.shelf_event_log
  WHERE event_id = '10000000-0000-0000-0000-000000000010';
SELECT tests.authenticate_as('sel_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.shelf_event_log
    WHERE event_id = '10000000-0000-0000-0000-000000000010'),
  'User B cannot DELETE User A shelf_event_log'
);

-- ═══════════════════════════════════════════════════════════════
-- Even User A (authenticated) cannot INSERT into shelf_event_log —
-- no INSERT policy for authenticated, so pins the "service_role only"
-- write-path contract. If a future migration grants INSERT to
-- authenticated by mistake, this test fails.
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('sel_rls_a');

SELECT throws_ok(
  $$ INSERT INTO chefbyte.shelf_event_log
       (event_id, user_id, device_id, client_event_id, payload, applied)
     VALUES ('10000000-0000-0000-0000-0000000000aa',
       (SELECT id FROM auth.users
         WHERE raw_user_meta_data->>'test_identifier' = 'sel_rls_a'),
       '10000000-0000-0000-0000-000000000001',
       'evt-owner-selfwrite',
       '{"kind":"added","delta_g":100}'::jsonb,
       true) $$,
  '42501',
  NULL,
  'Authenticated users cannot INSERT into shelf_event_log (service_role only)'
);

-- Final regression guard that User A's row is still intact
SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE event_id = '10000000-0000-0000-0000-000000000010'),
  true,
  'User A shelf_event_log.applied preserved through B''s attacks'
);

-- Teardown
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('sel_rls_a');
SELECT tests.delete_supabase_user('sel_rls_b');

SELECT * FROM finish();
ROLLBACK;
