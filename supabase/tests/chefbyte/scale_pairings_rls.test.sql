-- RLS isolation tests for chefbyte.scale_pairings
-- Policy: scale_pairings_rls FOR ALL TO authenticated
--   USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id)
-- Child of chefbyte.live_shelf_devices (device_id FK, cascade delete).
BEGIN;
SELECT plan(6);

-- Setup: two users, each with activation
SELECT tests.create_supabase_user('sp_rls_a');
SELECT tests.create_supabase_user('sp_rls_b');

SELECT tests.authenticate_as('sp_rls_a');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('sp_rls_b');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

-- ═══════════════════════════════════════════════════════════════
-- User A creates a device + scale_pairing
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('sp_rls_a');

INSERT INTO chefbyte.live_shelf_devices
  (device_id, user_id, device_name, import_key_hash, is_active)
VALUES (
  'f0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('sp_rls_a'),
  'owner-pi-sp',
  'hash_owner_sp_rls',
  true
);

INSERT INTO chefbyte.scale_pairings
  (pairing_id, user_id, device_id, scale_id, kind, product_id)
VALUES (
  'f0000000-0000-0000-0000-000000000011',
  tests.get_supabase_uid('sp_rls_a'),
  'f0000000-0000-0000-0000-000000000001',
  'scale_01',
  'live_shelf',
  NULL
);

-- Regression guard: User A sees their own pairing
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.scale_pairings
    WHERE pairing_id = 'f0000000-0000-0000-0000-000000000011'),
  'User A can SELECT own scale_pairings'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot SELECT / UPDATE / DELETE User A's pairing
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('sp_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.scale_pairings
    WHERE user_id = tests.get_supabase_uid('sp_rls_a')),
  0,
  'User B cannot SELECT User A scale_pairings'
);

UPDATE chefbyte.scale_pairings SET kind = 'catch_all', scale_id = 'hacked'
  WHERE pairing_id = 'f0000000-0000-0000-0000-000000000011';
SELECT tests.authenticate_as('sp_rls_a');
SELECT is(
  (SELECT kind FROM chefbyte.scale_pairings
    WHERE pairing_id = 'f0000000-0000-0000-0000-000000000011'),
  'live_shelf',
  'User B cannot UPDATE User A scale_pairings'
);

SELECT tests.authenticate_as('sp_rls_b');
DELETE FROM chefbyte.scale_pairings
  WHERE pairing_id = 'f0000000-0000-0000-0000-000000000011';
SELECT tests.authenticate_as('sp_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.scale_pairings
    WHERE pairing_id = 'f0000000-0000-0000-0000-000000000011'),
  'User B cannot DELETE User A scale_pairings'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot INSERT a pairing spoofing User A's user_id
-- WITH CHECK ((select auth.uid()) = user_id) → throws RLS violation.
-- Note: even though the device_id FK would resolve to User A's device,
-- RLS on scale_pairings itself blocks the write before FK cascade runs.
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('sp_rls_b');

SELECT throws_ok(
  $$ INSERT INTO chefbyte.scale_pairings
       (pairing_id, user_id, device_id, scale_id, kind)
     VALUES ('f0000000-0000-0000-0000-00000000001b',
       (SELECT id FROM auth.users
         WHERE raw_user_meta_data->>'test_identifier' = 'sp_rls_a'),
       'f0000000-0000-0000-0000-000000000001',
       'scale_02', 'live_scale') $$,
  '42501',
  NULL,
  'User B cannot INSERT a scale_pairing row owned by User A (RLS WITH CHECK)'
);

-- ═══════════════════════════════════════════════════════════════
-- User A pairing still has original scale_id (end-to-end regression guard)
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('sp_rls_a');
SELECT is(
  (SELECT scale_id FROM chefbyte.scale_pairings
    WHERE pairing_id = 'f0000000-0000-0000-0000-000000000011'),
  'scale_01',
  'User A scale_pairings.scale_id preserved through B''s attacks'
);

-- Teardown
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('sp_rls_a');
SELECT tests.delete_supabase_user('sp_rls_b');

SELECT * FROM finish();
ROLLBACK;
