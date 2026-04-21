-- RLS isolation tests for chefbyte.live_shelf_devices
-- Policy: live_shelf_devices_rls FOR ALL TO authenticated
--   USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id)
BEGIN;
SELECT plan(6);

-- Setup: two users
SELECT tests.create_supabase_user('lsd_rls_a');
SELECT tests.create_supabase_user('lsd_rls_b');

SELECT tests.authenticate_as('lsd_rls_a');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('lsd_rls_b');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

-- ═══════════════════════════════════════════════════════════════
-- User A inserts a device row for themselves
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('lsd_rls_a');

INSERT INTO chefbyte.live_shelf_devices
  (device_id, user_id, device_name, import_key_hash, is_active)
VALUES (
  'e0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('lsd_rls_a'),
  'owner-pi',
  'hash_owner_lsd_rls',
  true
);

-- Regression guard: User A can see their own device
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.live_shelf_devices
    WHERE device_id = 'e0000000-0000-0000-0000-000000000001'),
  'User A can SELECT own live_shelf_devices'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot SELECT / UPDATE / DELETE User A's device
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('lsd_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.live_shelf_devices
    WHERE user_id = tests.get_supabase_uid('lsd_rls_a')),
  0,
  'User B cannot SELECT User A live_shelf_devices'
);

UPDATE chefbyte.live_shelf_devices SET device_name = 'Hacked', is_active = false
  WHERE device_id = 'e0000000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('lsd_rls_a');
SELECT is(
  (SELECT device_name FROM chefbyte.live_shelf_devices
    WHERE device_id = 'e0000000-0000-0000-0000-000000000001'),
  'owner-pi',
  'User B cannot UPDATE User A live_shelf_devices'
);

SELECT tests.authenticate_as('lsd_rls_b');
DELETE FROM chefbyte.live_shelf_devices
  WHERE device_id = 'e0000000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('lsd_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.live_shelf_devices
    WHERE device_id = 'e0000000-0000-0000-0000-000000000001'),
  'User B cannot DELETE User A live_shelf_devices'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot INSERT a device spoofing User A's user_id
-- WITH CHECK ((select auth.uid()) = user_id) → throws RLS violation
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('lsd_rls_b');

SELECT throws_ok(
  $$ INSERT INTO chefbyte.live_shelf_devices
       (device_id, user_id, device_name, import_key_hash, is_active)
     VALUES ('e0000000-0000-0000-0000-00000000000b',
       (SELECT id FROM auth.users
         WHERE raw_user_meta_data->>'test_identifier' = 'lsd_rls_a'),
       'intruder-pi', 'hash_intruder_spoof', true) $$,
  '42501',
  NULL,
  'User B cannot INSERT a device row owned by User A (RLS WITH CHECK)'
);

-- ═══════════════════════════════════════════════════════════════
-- Active flag / row count untouched (end-to-end regression guard)
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('lsd_rls_a');
SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'e0000000-0000-0000-0000-000000000001'),
  true,
  'User A device is_active preserved through B''s attacks'
);

-- Teardown
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('lsd_rls_a');
SELECT tests.delete_supabase_user('lsd_rls_b');

SELECT * FROM finish();
ROLLBACK;
