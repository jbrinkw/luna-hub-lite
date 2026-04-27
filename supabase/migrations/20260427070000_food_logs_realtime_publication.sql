-- Add chefbyte.food_logs and chefbyte.temp_items to the supabase_realtime
-- publication so the MacroPage's `useRealtimeInvalidation('chef-macros',
-- [{food_logs}, {temp_items}])` actually delivers postgres_changes events.
--
-- WHY THIS REGRESSION SLIPPED IN
-- ------------------------------
-- The MacroPage subscribes to INSERT events on these two tables to
-- invalidate its TanStack Query cache when a Pi shelf event lands a
-- new food_logs row, when a meal is marked done, or when the user
-- types in a temp item from another tab. Neither table was ever added
-- to the `supabase_realtime` publication. Without that, supabase
-- realtime returns `status: error` for the per-table channel and the
-- subscription silently never fires — the user keeps seeing stale
-- macros until they refresh.
--
-- HOW IT WAS DIAGNOSED
-- --------------------
-- 2026-04-27 21:05 EDT — Pi session bd7f8795 logged a Gatorade
-- consumed event (296.7g, scale-01 live_shelf). The full chain
-- worked end-to-end:
--
--   Pi cloud_outbox 66 (consumed,-296.74g) sent OK 21:08:06
--     → chefbyte.shelf_event_log ed896f05 applied=true reason=decremented
--       → chefbyte.food_logs 5ac6c1c4 logical_date=2026-04-27 (✓ correct)
--         → get_daily_macros for 2026-04-27 returns 238.78 cal (✓)
--
-- But the user reported "not seeing this in macros" because their
-- MacroPage tab was open BEFORE the event landed and Realtime never
-- delivered the INSERT. Manual refresh would surface the row;
-- Realtime is supposed to make the refresh unnecessary.
--
-- IDEMPOTENT
-- ----------
-- Only adds the table to the publication if not already present. Safe
-- to run on dev/staging/prod where prior manual ALTERs may exist.
--
-- TEST COVERAGE
-- -------------
-- pgTAP: supabase/tests/chefbyte/food_logs_realtime_publication.test.sql
--   (asserts both tables are in pg_publication_tables under
--   pubname='supabase_realtime')
-- Integration: apps/web/src/__tests__/integration/realtime/subscriptions.test.ts
--   (round-trip INSERT probe — fails if either table drops out of the
--   publication or RLS filters block delivery)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'food_logs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.food_logs';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'temp_items'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.temp_items';
  END IF;
END $$;
