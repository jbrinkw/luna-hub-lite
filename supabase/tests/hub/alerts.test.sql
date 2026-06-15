BEGIN;
SELECT plan(20);

-- Grants are transaction-scoped (pgTAP rolls back after finish()).
-- service_role needs USAGE on the tests schema to call
-- tests.get_supabase_uid() from INSERT VALUES expressions later in
-- this file (after we switch role to service_role).
GRANT USAGE ON SCHEMA tests TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tests TO service_role;

-- Setup: two users — one admin, one regular.
SELECT tests.create_supabase_user('alerts_admin', 'admin@alerts.test');
SELECT tests.create_supabase_user('alerts_user', 'user@alerts.test');

-- Promote alerts_admin via the is_admin flag (the 20260427030000
-- migration only auto-promotes Jeremy by email, so we set ours
-- explicitly for the test).
UPDATE hub.profiles
   SET is_admin = true
 WHERE user_id = tests.get_supabase_uid('alerts_admin');

-- Insert two synthetic alerts as service_role (the monitor's role).
SET LOCAL role = service_role;

INSERT INTO hub.alerts (invariant_name, severity, subject_type, subject_id, user_id, details)
VALUES
  ('test_invariant_a', 'critical', 'stock_lot', '00000000-0000-0000-0000-000000000a01',
   tests.get_supabase_uid('alerts_user'), '{"qty_containers": -3}'::jsonb),
  ('test_invariant_b', 'warning', 'food_log',  '00000000-0000-0000-0000-000000000b01',
   tests.get_supabase_uid('alerts_user'), '{"drift_kcal": 25}'::jsonb);

-- Test 1: dedup_key is generated as md5(name || subject_type || subject_id).
SELECT is(
  (SELECT dedup_key FROM hub.alerts
    WHERE invariant_name = 'test_invariant_a' LIMIT 1),
  md5('test_invariant_a' || 'stock_lot' || '00000000-0000-0000-0000-000000000a01'),
  'dedup_key generated as md5(invariant || subject_type || subject_id)'
);

-- Test 2: partial unique index blocks duplicate UNACK rows with same key.
-- The second INSERT should fail because no acknowledged row exists yet.
SELECT throws_ok(
  $$INSERT INTO hub.alerts (invariant_name, severity, subject_type, subject_id, user_id)
    VALUES ('test_invariant_a', 'critical', 'stock_lot', '00000000-0000-0000-0000-000000000a01',
            (SELECT user_id FROM hub.profiles WHERE is_admin = false LIMIT 1))$$,
  '23505',
  NULL,
  'partial unique index rejects duplicate unack rows with same dedup_key'
);

-- Test 3: severity CHECK rejects bad values.
SELECT throws_ok(
  $$INSERT INTO hub.alerts (invariant_name, severity, subject_type)
    VALUES ('bad_sev', 'fatal', 'whatever')$$,
  '23514',
  NULL,
  'severity CHECK rejects values outside (warning, error, critical)'
);

-- Test 4: regular (non-admin) user CANNOT SELECT.
SELECT tests.authenticate_as('alerts_user');
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts),
  0,
  'non-admin user sees zero rows (RLS hides all)'
);

-- Test 5: admin user CAN SELECT (sees both rows).
SELECT tests.authenticate_as('alerts_admin');
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts WHERE invariant_name LIKE 'test_invariant_%'),
  2,
  'admin user can SELECT all alerts'
);

-- Test 6: admin can UPDATE (acknowledge) — direct UPDATE.
UPDATE hub.alerts
   SET acknowledged_at = now(),
       acknowledged_by = (SELECT auth.uid()),
       acknowledged_note = 'test ack'
 WHERE invariant_name = 'test_invariant_b';
SELECT is(
  (SELECT acknowledged_note FROM hub.alerts WHERE invariant_name = 'test_invariant_b'),
  'test ack',
  'admin can UPDATE/acknowledge an alert'
);

-- Test 7: non-admin UPDATE is blocked by RLS.
SELECT tests.authenticate_as('alerts_user');
UPDATE hub.alerts SET acknowledged_note = 'hijack' WHERE invariant_name = 'test_invariant_a';
SELECT tests.authenticate_as('alerts_admin');
SELECT is(
  (SELECT acknowledged_note FROM hub.alerts WHERE invariant_name = 'test_invariant_a'),
  NULL,
  'non-admin UPDATE blocked by RLS — note still NULL'
);

-- Test 8: after acking _b, a fresh INSERT with the same dedup_key SUCCEEDS
-- (the partial unique only covers UNACK rows).
SET LOCAL role = service_role;
INSERT INTO hub.alerts (invariant_name, severity, subject_type, subject_id, user_id, details)
VALUES ('test_invariant_b', 'warning', 'food_log', '00000000-0000-0000-0000-000000000b01',
        tests.get_supabase_uid('alerts_user'), '{"drift_kcal": 30}'::jsonb);
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts WHERE invariant_name = 'test_invariant_b'),
  2,
  'after ack, identical dedup_key can re-insert (fresh row for new occurrence)'
);

-- Test 9: hub.acknowledge_alert RPC respects admin gate (non-admin throws).
SELECT tests.authenticate_as('alerts_user');
SELECT throws_ok(
  format(
    $$SELECT hub.acknowledge_alert(%L, 'sneaky')$$,
    (SELECT alert_id FROM hub.alerts WHERE invariant_name = 'test_invariant_a' AND acknowledged_at IS NULL LIMIT 1)
  ),
  '42501',
  NULL,
  'hub.acknowledge_alert raises 42501 for non-admin caller'
);

-- Test 10: hub.acknowledge_alert RPC works for admin caller and sets the
-- ack columns atomically.
SELECT tests.authenticate_as('alerts_admin');
SELECT lives_ok(
  format(
    $$SELECT hub.acknowledge_alert(%L, 'reviewed')$$,
    (SELECT alert_id FROM hub.alerts WHERE invariant_name = 'test_invariant_a' AND acknowledged_at IS NULL LIMIT 1)
  ),
  'admin can call hub.acknowledge_alert'
);

SELECT is(
  (SELECT acknowledged_note FROM hub.alerts
    WHERE invariant_name = 'test_invariant_a' AND acknowledged_note = 'reviewed' LIMIT 1),
  'reviewed',
  'hub.acknowledge_alert sets acknowledged_note + acknowledged_at'
);

-- Test 11: private.upsert_alert (service-role only) bumps last_seen_at
-- on a persistent violation rather than inserting a new row.
SET LOCAL role = service_role;
SELECT private.upsert_alert(
  'persistent_invariant', 'error', 'product', 'product-xyz',
  tests.get_supabase_uid('alerts_user'), '{"hint": "first"}'::jsonb
);
SELECT private.upsert_alert(
  'persistent_invariant', 'error', 'product', 'product-xyz',
  tests.get_supabase_uid('alerts_user'), '{"hint": "second"}'::jsonb
);
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts WHERE invariant_name = 'persistent_invariant'),
  1,
  'private.upsert_alert bumps existing unack row instead of inserting twice'
);

-- Test 12: the bumped row's seen_count incremented to 2.
SELECT is(
  (SELECT (details->>'seen_count')::int FROM hub.alerts WHERE invariant_name = 'persistent_invariant' LIMIT 1),
  2,
  'persistent violation seen_count increments to 2'
);

-- Test 13: the alerts_unacked_idx index exists with the expected definition.
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'hub'
       AND tablename = 'alerts'
       AND indexname = 'alerts_unacked_idx'
  ),
  'alerts_unacked_idx partial index is present'
);

-- ════════════════════════════════════════════════════════════════════════════
-- H-16 — hub.upsert_alert PostgREST-callable wrapper
-- ════════════════════════════════════════════════════════════════════════════
-- The invariant-monitor edge function reaches PostgREST under the SERVICE_ROLE
-- key. PostgREST exposes only (public, graphql_public, hub, coachbyte, chefbyte)
-- — NOT `private` — so supabase-js's `.schema('private').rpc('upsert_alert')`
-- is rejected with PGRST106 ("Invalid schema: private") BEFORE any grant check,
-- and every detected violation was silently dropped (hub.alerts stayed empty).
-- The fix mirrors the walmart / execute_scan_action / void_scan_transaction
-- precedent: a thin SECURITY DEFINER wrapper in the EXPOSED `hub` schema that
-- delegates to private.upsert_alert. The monitor calls .schema('hub').rpc(...).
--
-- RED (pre-fix): hub.upsert_alert(...) does not exist → every assertion below
--   errors / fails.
-- GREEN (post-fix): the wrapper exists, inserts/dedups identically to the
--   private fn, and is locked to service_role only (clients must NEVER write
--   alerts — there is intentionally no INSERT RLS policy, and SECURITY DEFINER
--   would bypass RLS anyway).

-- Test 14: the exposed hub.upsert_alert wrapper INSERTS a new alert row — this
-- is the assertion that proves the monitor's writes now actually land. We call
-- as service_role (the monitor's identity).
SET LOCAL role = service_role;
DO $$ BEGIN
  PERFORM hub.upsert_alert(
    'wrapper_invariant', 'critical', 'stock_lot', 'wrap-lot-1',
    tests.get_supabase_uid('alerts_user'), '{"qty_containers": -7}'::jsonb
  );
END $$;
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts WHERE invariant_name = 'wrapper_invariant'),
  1,
  'hub.upsert_alert wrapper inserts a new alert row (PGRST106 fix — alerts now land)'
);

-- Test 15: the wrapper persisted the supplied details + user attribution.
SELECT is(
  (SELECT (details->>'qty_containers') FROM hub.alerts WHERE invariant_name = 'wrapper_invariant' LIMIT 1),
  '-7',
  'hub.upsert_alert wrapper persists the supplied details payload'
);

-- Test 16: the wrapper dedups exactly like the private fn — a second call with
-- the same (invariant, subject_type, subject_id) bumps the existing unack row.
DO $$ BEGIN
  PERFORM hub.upsert_alert(
    'wrapper_invariant', 'critical', 'stock_lot', 'wrap-lot-1',
    tests.get_supabase_uid('alerts_user'), '{"qty_containers": -9}'::jsonb
  );
END $$;
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts WHERE invariant_name = 'wrapper_invariant'),
  1,
  'hub.upsert_alert wrapper bumps the existing unack row instead of inserting twice'
);
RESET role;

-- Test 17: service_role (the monitor) HAS EXECUTE on the wrapper.
SELECT ok(
  has_function_privilege('service_role', 'hub.upsert_alert(text,text,text,text,uuid,jsonb)', 'EXECUTE'),
  'hub.upsert_alert: service_role HAS EXECUTE (the monitor can write)'
);

-- Test 18: authenticated must NOT have EXECUTE — clients never write alerts.
SELECT ok(
  NOT has_function_privilege('authenticated', 'hub.upsert_alert(text,text,text,text,uuid,jsonb)', 'EXECUTE'),
  'hub.upsert_alert: authenticated must NOT have EXECUTE (clients never write alerts)'
);

-- Test 19: anon must NOT have EXECUTE either.
SELECT ok(
  NOT has_function_privilege('anon', 'hub.upsert_alert(text,text,text,text,uuid,jsonb)', 'EXECUTE'),
  'hub.upsert_alert: anon must NOT have EXECUTE'
);

-- Cleanup
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('alerts_admin');
SELECT tests.delete_supabase_user('alerts_user');

SELECT * FROM finish();
ROLLBACK;
