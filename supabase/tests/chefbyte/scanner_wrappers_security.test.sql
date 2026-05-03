-- Critical security regression (audit 2026-05-03): the chefbyte-schema
-- wrappers chefbyte.execute_scan_action and chefbyte.void_scan_transaction
-- accept caller-controlled p_user_id / p_transaction_id with NO ownership
-- check. Migration 20260503110000_lock_down_scanner_wrappers.sql revokes
-- EXECUTE from authenticated/anon (matching the apply_shelf_event_admin /
-- consume_product_admin precedent), so a logged-in user calling either
-- wrapper directly via PostgREST must hit insufficient_privilege (42501).
--
-- This test enforces that contract. If a future migration restores the
-- authenticated/anon GRANT, these assertions fail loudly.
--
-- Note: the production path (shelf-ingest edge function) uses a
-- service-role client, which bypasses GRANT-level restrictions. That
-- path is exercised by execute_scan_action.test.sql /
-- void_scan_transaction.test.sql (which SET ROLE service_role) and by
-- the apps/web scanner-pipeline integration suite.

BEGIN;
SELECT plan(2);

------------------------------------------------------------
-- Setup: an authenticated user (alice). Bob isn't strictly
-- needed for the GRANT-level check (the wrapper has no
-- ownership logic to probe), but bootstrap two users to
-- match the audit-supplied template and document intent.
------------------------------------------------------------

SELECT tests.create_supabase_user('alice_scan_sec', 'alice_scan_sec@test.local');
SELECT tests.create_supabase_user('bob_scan_sec',   'bob_scan_sec@test.local');

SELECT tests.authenticate_as('alice_scan_sec');

------------------------------------------------------------
-- Test 1 — authenticated cannot RPC chefbyte.execute_scan_action.
-- Even with a fully-formed payload (caller-supplied p_user_id),
-- the GRANT REVOKE must fire FIRST → 42501 insufficient_privilege.
------------------------------------------------------------

SELECT throws_ok(
  $$ SELECT chefbyte.execute_scan_action(
       p_user_id            => '00000000-0000-0000-0000-000000000099'::uuid,
       p_product_id         => '00000000-0000-0000-0000-000000000099'::uuid,
       p_mode               => 'purchase',
       p_qty                => 1,
       p_unit               => 'container',
       p_nutrition_snapshot => NULL
     ) $$,
  '42501',
  NULL,
  'authenticated user cannot invoke chefbyte.execute_scan_action directly (42501 insufficient_privilege)'
);

------------------------------------------------------------
-- Test 2 — authenticated cannot RPC chefbyte.void_scan_transaction.
-- Same contract: GRANT REVOKE blocks at the wrapper boundary
-- before the (intentionally ownership-free) inner private function
-- can be reached.
------------------------------------------------------------

SELECT throws_ok(
  $$ SELECT chefbyte.void_scan_transaction(
       p_transaction_id => gen_random_uuid()
     ) $$,
  '42501',
  NULL,
  'authenticated user cannot invoke chefbyte.void_scan_transaction directly (42501 insufficient_privilege)'
);

------------------------------------------------------------
-- Teardown
------------------------------------------------------------

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('alice_scan_sec');
SELECT tests.delete_supabase_user('bob_scan_sec');

SELECT * FROM finish();
ROLLBACK;
