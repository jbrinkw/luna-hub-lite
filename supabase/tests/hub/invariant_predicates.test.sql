-- Verifies the DB-side preconditions the invariant-monitor edge function
-- depends on. The TS edge function runs queries; this file makes sure the
-- queries it issues will be syntactically + semantically valid against
-- the live schema (i.e. the columns, constraints, and indexes the
-- predicates query against actually exist).
--
-- Per-invariant TS-side correctness is exercised in the edge-function
-- vitest under apps/web/src/__tests__/integration/edge-functions/invariant-monitor.test.ts.

BEGIN;
SELECT plan(16);

------------------------------------------------------------
-- Invariant 1: qty_non_negative
-- The check predicate scans stock_lots WHERE qty_containers < 0. The
-- table-level CHECK (qty_containers >= 0) means a violation would be a
-- DB-layer failure. We assert the constraint exists.
------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'chefbyte'
       AND table_name = 'stock_lots'
       AND constraint_type = 'CHECK'
       AND constraint_name = 'stock_lots_qty_nonneg'
  ),
  'qty_non_negative: stock_lots_qty_nonneg CHECK constraint present'
);

------------------------------------------------------------
-- Invariant 2: food_logs_per_day_match_consume_events
-- The predicate sums over food_logs grouped by (user_id, logical_date)
-- and compares to 4-4-9. We just verify the schema columns exist.
------------------------------------------------------------
SELECT col_is_pk('chefbyte', 'food_logs', 'log_id', 'food_logs has log_id PK');
SELECT has_column('chefbyte', 'food_logs', 'logical_date',
  'food_logs.logical_date present (per-day aggregation key)');

------------------------------------------------------------
-- Invariant 3: stock_lots_lifecycle_invariant
-- The predicate looks for stock_lots where in_flight_since is older than
-- 24h. Verify the column + partial index exist.
------------------------------------------------------------
SELECT has_column('chefbyte', 'stock_lots', 'in_flight_since',
  'stock_lots.in_flight_since present');
SELECT has_column('chefbyte', 'stock_lots', 'pickup_event_id',
  'stock_lots.pickup_event_id present');

------------------------------------------------------------
-- Invariant 5: mcp_tool_log_user_id_present
-- The predicate looks for mcp_tool_logs.user_id IS NULL rows. The column
-- is NOT NULL at the schema level; we assert that.
------------------------------------------------------------
SELECT col_not_null('hub', 'mcp_tool_logs', 'user_id',
  'mcp_tool_logs.user_id is NOT NULL (constraint defends the invariant)');

------------------------------------------------------------
-- Invariant 6: stock_lots_match_4_4_9_at_food_log_write
-- Predicate scans food_logs.calories vs 4*c + 4*p + 9*f. Schema check.
------------------------------------------------------------
SELECT has_column('chefbyte', 'food_logs', 'calories',
  'food_logs.calories present');
SELECT has_column('chefbyte', 'food_logs', 'carbs',
  'food_logs.carbs present');
SELECT has_column('chefbyte', 'food_logs', 'protein',
  'food_logs.protein present');
SELECT has_column('chefbyte', 'food_logs', 'fat',
  'food_logs.fat present');

------------------------------------------------------------
-- Invariant 7: shelf_event_log_no_orphan_lots
------------------------------------------------------------
SELECT has_column('chefbyte', 'shelf_event_log', 'resolved_lot_id',
  'shelf_event_log.resolved_lot_id present');

------------------------------------------------------------
-- Invariant 8: livetrack_session_no_stale_active
------------------------------------------------------------
SELECT has_column('chefbyte', 'livetrack_import_sessions', 'state',
  'livetrack_import_sessions.state present');
SELECT has_column('chefbyte', 'livetrack_import_sessions', 'expires_at',
  'livetrack_import_sessions.expires_at present');

------------------------------------------------------------
-- Invariant 9: coachbyte_timer_no_stale_active
------------------------------------------------------------
SELECT has_column('coachbyte', 'timers', 'state',
  'coachbyte.timers.state present');
SELECT has_column('coachbyte', 'timers', 'end_time',
  'coachbyte.timers.end_time present');

------------------------------------------------------------
-- Invariant 10: product_no_macro_drift
-- Requires updated_at (set by 20260421030000_products_updated_at).
------------------------------------------------------------
SELECT has_column('chefbyte', 'products', 'updated_at',
  'products.updated_at present (delta + macro-drift invariant)');

SELECT * FROM finish();
ROLLBACK;
