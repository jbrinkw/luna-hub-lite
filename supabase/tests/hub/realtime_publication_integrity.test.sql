-- Realtime publication integrity — every table the web app's
-- `useRealtimeInvalidation` hook subscribes to MUST be a member of the
-- `supabase_realtime` publication, otherwise the channel returns
-- `status: error` from Supabase Realtime and the UI silently goes stale
-- (no postgres_changes events arrive — but page mounts still load via
-- the initial HTTP fetch, so a smoke test passes).
--
-- We ran into this on 2026-04-27 with `chefbyte.food_logs` and
-- `chefbyte.temp_items`: the MacroPage subscribed to both, neither was
-- in the publication, and the live macro totals stopped updating on
-- Pi events. Initial load looked correct so it didn't trip any alarm.
-- The fix migration (20260427070000) added them; this pgTAP locks the
-- invariant in place going forward — and pins the contract for ALL
-- tables the hook touches today.
--
-- The hardcoded list below MUST be kept in sync with every
-- `useRealtimeInvalidation(channelName, [{ schema, table, ... }])`
-- call across `apps/web/src/`. The companion CI script
-- `scripts/verify/realtime_publication_check.sh` greps the source for
-- those calls and fails fast if a (schema, table) tuple drifts out of
-- this list.
--
-- Mutation guard: dropping any single (schema, table) row from the
-- publication (e.g. `ALTER PUBLICATION supabase_realtime DROP TABLE
-- chefbyte.food_logs`) MUST flip the corresponding `ok(...)` assertion
-- below to false, with the table name in the failure message so the
-- operator knows immediately which one to re-add.
--
-- See: docs/architecture/realtime.md (if present) and the bug histories
-- behind 20260419080000_live_shelf_realtime_publication.sql,
-- 20260421020000_livetrack_import_sessions.sql,
-- 20260421040000_event_overrides.sql,
-- 20260427030000_hub_alerts.sql,
-- 20260427070000_food_logs_realtime_publication.sql,
-- 20260428040000_realtime_publication_backfill.sql.

BEGIN;

-- One assertion per table; the count is hardcoded so any future addition
-- forces a deliberate plan() bump (which is exactly the friction we want).
SELECT plan(21);

-- ------------------------------------------------------------------
-- chefbyte schema — Inventory, Macros, MealPlan, Shopping, EventViewer,
-- Home, Settings, Scales pages + ChefLayout + useLiveTrackSession hook.
-- ------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'stock_lots'
  ),
  'chefbyte.stock_lots is in supabase_realtime publication (Inventory + Home subscribe)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'products'
  ),
  'chefbyte.products is in supabase_realtime publication (Inventory + Settings subscribe)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'food_logs'
  ),
  'chefbyte.food_logs is in supabase_realtime publication (MacroPage + MealPlan + Home subscribe)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'temp_items'
  ),
  'chefbyte.temp_items is in supabase_realtime publication (MacroPage + MealPlan + Home subscribe)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'meal_plan_entries'
  ),
  'chefbyte.meal_plan_entries is in supabase_realtime publication (MealPlanPage + Home subscribe)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'shopping_list'
  ),
  'chefbyte.shopping_list is in supabase_realtime publication (ShoppingPage + Home subscribe)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'live_shelf_devices'
  ),
  'chefbyte.live_shelf_devices is in supabase_realtime publication (Inventory + Scales + LiveTrackSession)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'scale_pairings'
  ),
  'chefbyte.scale_pairings is in supabase_realtime publication (Inventory + Scales)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'shelf_event_log'
  ),
  'chefbyte.shelf_event_log is in supabase_realtime publication (EventViewer + ChefLayout)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'event_overrides'
  ),
  'chefbyte.event_overrides is in supabase_realtime publication (EventViewer + ChefLayout)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'livetrack_import_sessions'
  ),
  'chefbyte.livetrack_import_sessions is in supabase_realtime publication (LiveTrackSession)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'locations'
  ),
  'chefbyte.locations is in supabase_realtime publication (Settings)'
);

-- ------------------------------------------------------------------
-- coachbyte schema — TodayPage subscribes to plan/timer state.
-- ------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'coachbyte'
       AND tablename = 'planned_sets'
  ),
  'coachbyte.planned_sets is in supabase_realtime publication (TodayPage)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'coachbyte'
       AND tablename = 'completed_sets'
  ),
  'coachbyte.completed_sets is in supabase_realtime publication (TodayPage)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'coachbyte'
       AND tablename = 'timers'
  ),
  'coachbyte.timers is in supabase_realtime publication (TodayPage)'
);

-- ------------------------------------------------------------------
-- hub schema — AlertsPage.
-- ------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'hub'
       AND tablename = 'alerts'
  ),
  'hub.alerts is in supabase_realtime publication (AlertsPage)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'hub'
       AND tablename = 'app_activations'
  ),
  'hub.app_activations is in supabase_realtime publication (AppProvider activation gate)'
);

-- ------------------------------------------------------------------
-- Negative-control assertions — confirm the publication exists, has
-- non-zero membership, and is configured for the event types the
-- realtime server expects (insert/update/delete). If a future migration
-- accidentally drops the publication entirely or strips DML kinds, the
-- per-table checks above all fail with cryptic "X is not in publication"
-- messages; these guards point at the root cause directly.
-- ------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ),
  'supabase_realtime publication exists (root prerequisite)'
);

SELECT ok(
  (SELECT pubinsert FROM pg_publication WHERE pubname = 'supabase_realtime'),
  'supabase_realtime publishes INSERT events (postgres_changes event=INSERT path)'
);

SELECT ok(
  (SELECT pubupdate FROM pg_publication WHERE pubname = 'supabase_realtime'),
  'supabase_realtime publishes UPDATE events (postgres_changes event=UPDATE path)'
);

SELECT ok(
  (SELECT pubdelete FROM pg_publication WHERE pubname = 'supabase_realtime'),
  'supabase_realtime publishes DELETE events (postgres_changes event=DELETE path)'
);

SELECT * FROM finish();
ROLLBACK;
