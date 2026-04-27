-- Plant synthetic violations the TS invariant-monitor would detect, then
-- assert that calling private.upsert_alert (the same RPC the edge fn uses)
-- writes one alert per violation and dedupes on the second call.
--
-- This is a behavioural test of the cloud-side write path. The actual
-- TS predicates that *find* violations are exercised in:
--   apps/web/src/__tests__/integration/edge-functions/invariant-monitor.test.ts

BEGIN;
SELECT plan(8);

-- Grants are transaction-scoped (pgTAP rolls back after finish()).
-- service_role needs USAGE on the tests schema to call
-- tests.get_supabase_uid() inside service_role-scoped statements below.
GRANT USAGE ON SCHEMA tests TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tests TO service_role;

SELECT tests.create_supabase_user('inv_admin', 'inv_admin@inv.test');
SELECT tests.create_supabase_user('inv_user',  'inv_user@inv.test');

UPDATE hub.profiles SET is_admin = true
 WHERE user_id = tests.get_supabase_uid('inv_admin');

-- All upsert_alert calls run as service_role (matches edge-fn behavior).
SET LOCAL role = service_role;

------------------------------------------------------------
-- Plant 5 violations covering 5 invariants and assert one alert each.
------------------------------------------------------------

-- 1. qty_non_negative — synthetic subject_id (would correspond to a
-- stock_lot row with qty < 0 in production).
SELECT private.upsert_alert(
  'qty_non_negative', 'critical', 'stock_lot', 'lot-neg-1',
  tests.get_supabase_uid('inv_user'),
  '{"qty_containers": -2, "product_id": "p-1"}'::jsonb
);
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts
    WHERE invariant_name = 'qty_non_negative'),
  1,
  'qty_non_negative: first violation creates one alert'
);

-- 2. food_logs_per_day_match_consume_events
SELECT private.upsert_alert(
  'food_logs_per_day_match_consume_events', 'warning', 'food_log_day',
  format('%s|2026-04-27', tests.get_supabase_uid('inv_user')),
  tests.get_supabase_uid('inv_user'),
  '{"date": "2026-04-27", "drift_kcal": 42}'::jsonb
);
SELECT is(
  (SELECT severity FROM hub.alerts
    WHERE invariant_name = 'food_logs_per_day_match_consume_events' LIMIT 1),
  'warning',
  'food_logs_per_day: severity stored as warning'
);

-- 3. mcp_tool_log_user_id_present
SELECT private.upsert_alert(
  'mcp_tool_log_user_id_present', 'error', 'mcp_tool_log', '9999',
  NULL,  -- global / unattributed
  '{"tool_name": "CHEFBYTE_get_inventory"}'::jsonb
);
SELECT is(
  (SELECT user_id FROM hub.alerts
    WHERE invariant_name = 'mcp_tool_log_user_id_present' LIMIT 1),
  NULL,
  'mcp_tool_log: user_id NULL accepted (global / unattributed alert)'
);

-- 4. coachbyte_timer_running_not_stale
--    (post-2026-04-27 reconcile: was coachbyte_timer_no_stale_active —
--     same predicate intent, renamed to align with Phase 3 runtime.)
SELECT private.upsert_alert(
  'coachbyte_timer_running_not_stale', 'warning', 'coachbyte_timer',
  '00000000-0000-0000-0000-00000000d001',
  tests.get_supabase_uid('inv_user'),
  '{"state": "running", "end_time": "2026-04-26T22:00:00Z"}'::jsonb
);
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts
    WHERE invariant_name = 'coachbyte_timer_running_not_stale'),
  1,
  'coachbyte_timer_running_not_stale: violation persisted'
);

-- 5. product_macro_drift_4_4_9
--    (post-2026-04-27 reconcile: was product_no_macro_drift.)
SELECT private.upsert_alert(
  'product_macro_drift_4_4_9', 'warning', 'product',
  '11111111-1111-1111-1111-111111111111',
  tests.get_supabase_uid('inv_user'),
  '{"name": "Mystery Bar", "drift_pct": 0.18}'::jsonb
);
SELECT is(
  (SELECT (details->>'drift_pct')::numeric FROM hub.alerts
    WHERE invariant_name = 'product_macro_drift_4_4_9' LIMIT 1),
  0.18,
  'product_macro_drift_4_4_9: details.drift_pct round-trips through JSONB'
);

------------------------------------------------------------
-- Idempotency check: second call with same dedup_key bumps seen_count,
-- doesn't insert a second row.
------------------------------------------------------------
SELECT private.upsert_alert(
  'qty_non_negative', 'critical', 'stock_lot', 'lot-neg-1',
  tests.get_supabase_uid('inv_user'),
  '{"qty_containers": -2}'::jsonb
);
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts
    WHERE invariant_name = 'qty_non_negative'),
  1,
  'second upsert with same dedup_key does NOT create a 2nd row'
);
SELECT is(
  (SELECT (details->>'seen_count')::int FROM hub.alerts
    WHERE invariant_name = 'qty_non_negative' LIMIT 1),
  2,
  'idempotency: seen_count bumped to 2 on second upsert'
);

------------------------------------------------------------
-- Reopen-after-ack: ack the qty_non_negative row, then a fresh upsert
-- creates a new row (the partial unique index excludes acked rows).
------------------------------------------------------------
UPDATE hub.alerts SET acknowledged_at = now(),
                      acknowledged_by = tests.get_supabase_uid('inv_admin')
 WHERE invariant_name = 'qty_non_negative';

SELECT private.upsert_alert(
  'qty_non_negative', 'critical', 'stock_lot', 'lot-neg-1',
  tests.get_supabase_uid('inv_user'),
  '{"qty_containers": -3}'::jsonb
);
SELECT is(
  (SELECT count(*)::integer FROM hub.alerts WHERE invariant_name = 'qty_non_negative'),
  2,
  'after ack, identical violation reopens as a NEW row'
);

-- Cleanup
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('inv_admin');
SELECT tests.delete_supabase_user('inv_user');

SELECT * FROM finish();
ROLLBACK;
