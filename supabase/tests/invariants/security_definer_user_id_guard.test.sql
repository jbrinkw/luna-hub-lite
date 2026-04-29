-- Pins AUDIT_FINDINGS_PHASE1.md L12 fix:
-- 3 SECURITY DEFINER functions accepted a `p_user_id` parameter and
-- were granted to `authenticated` without verifying p_user_id ==
-- auth.uid(). Migration 20260429090000 added an ownership guard to
-- each. This test fails if the guard is removed or weakened.

BEGIN;
SELECT plan(6);

-- Two test users
SELECT tests.create_supabase_user('guard_alice');
SELECT tests.create_supabase_user('guard_bob');

-- Capture UUIDs into psql variables so we can pass them through later
-- service_role phases that don't have access to the `tests.` schema.
SELECT tests.get_supabase_uid('guard_alice') AS alice_uid \gset
SELECT tests.get_supabase_uid('guard_bob')   AS bob_uid   \gset

------------------------------------------------------------
-- 1. hub.revoke_all_api_keys_admin
--   Alice authenticated → calling with bob's uid must be rejected
------------------------------------------------------------
SELECT tests.authenticate_as('guard_alice');

SELECT throws_ok(
  format(
    $$SELECT hub.revoke_all_api_keys_admin(%L::UUID)$$,
    tests.get_supabase_uid('guard_bob')
  ),
  '42501',
  NULL,
  'revoke_all_api_keys_admin: alice cannot revoke bob''s keys'
);

-- Same call with alice's own UID is allowed (returns 0 since no keys exist)
SELECT lives_ok(
  format(
    $$SELECT hub.revoke_all_api_keys_admin(%L::UUID)$$,
    tests.get_supabase_uid('guard_alice')
  ),
  'revoke_all_api_keys_admin: alice can revoke her own keys'
);

------------------------------------------------------------
-- 2. chefbyte.walmart_check_and_increment
------------------------------------------------------------
SELECT throws_ok(
  format(
    $$SELECT chefbyte.walmart_check_and_increment(%L::UUID, 100)$$,
    tests.get_supabase_uid('guard_bob')
  ),
  '42501',
  NULL,
  'walmart_check_and_increment: alice cannot burn bob''s quota'
);

SELECT lives_ok(
  format(
    $$SELECT chefbyte.walmart_check_and_increment(%L::UUID, 100)$$,
    tests.get_supabase_uid('guard_alice')
  ),
  'walmart_check_and_increment: alice can use her own quota'
);

------------------------------------------------------------
-- 3. private.generate_meal_product_name
--   This function lives in the `private` schema, which is NOT
--   exposed via PostgREST and not accessible to the `authenticated`
--   role. Production callers reach it only via mark_meal_done's
--   SECURITY DEFINER chain. The guard inside generate_meal_product_name
--   is defense-in-depth: if a future migration adds a chefbyte/hub
--   wrapper exposing it, the guard kicks in then.
--
--   These tests verify (under service_role, mirroring the real call
--   site) that the guard does NOT fire — service_role legitimately
--   passes any user_id from the SECURITY DEFINER chain.
------------------------------------------------------------
SELECT tests.clear_authentication();
SET ROLE service_role;

SELECT lives_ok(
  format(
    $$SELECT private.generate_meal_product_name(%L::UUID, 'Chicken & Rice', CURRENT_DATE)$$,
    :'bob_uid'
  ),
  'generate_meal_product_name: service_role bypasses guard (any user_id works)'
);

SELECT lives_ok(
  format(
    $$SELECT private.generate_meal_product_name(%L::UUID, 'Chicken & Rice', CURRENT_DATE)$$,
    :'alice_uid'
  ),
  'generate_meal_product_name: service_role mints alice''s name without throwing'
);

SELECT * FROM finish();
ROLLBACK;
