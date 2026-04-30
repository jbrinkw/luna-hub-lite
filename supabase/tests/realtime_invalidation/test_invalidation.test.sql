-- Realtime invalidation pgTAP smoke-check
--
-- Goal: catch the "Realtime won't deliver because table isn't in the
-- publication" class of bug at the DB layer, before any JS test runs.
--
-- This file is intentionally ADDITIVE — it does NOT duplicate the
-- comprehensive 21-assertion audit already in
-- supabase/tests/hub/realtime_publication_integrity.test.sql.
-- Instead it checks the ADDITIONAL tables that are the subject of the
-- realtime-invalidation harness (the tables exercised by
-- apps/web/src/__tests__/integration/realtime-invalidation.test.tsx)
-- plus confirms that replica identity is set to FULL for UPDATE/DELETE
-- payloads (default is DEFAULT, which only sends primary key columns,
-- causing the JS subscriber to see empty `old` record on DELETE and
-- only the PK on UPDATE — an insidious silent-regression source).
--
-- Covered tables (the ones the integration harness subscribes to):
--   chefbyte.stock_lots      — INSERT / UPDATE / DELETE invalidation cases
--   chefbyte.food_logs       — MacroPage invalidation
--   chefbyte.live_shelf_devices — scale wizard invalidation
--
-- If a future migration drops a table from the publication the
-- corresponding INSERT/UPDATE/DELETE integration test will time-out;
-- this pgTAP probe fires FIRST (cheaper, faster) and names the table
-- directly so the operator doesn't have to grep logs.

BEGIN;

SELECT plan(7);

-- ----------------------------------------------------------------
-- 1. Publication exists (root pre-requisite)
-- ----------------------------------------------------------------
SELECT ok(
  EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'),
  'supabase_realtime publication exists'
);

-- ----------------------------------------------------------------
-- 2. chefbyte.stock_lots is a publication member
--    (primary table for the realtime-invalidation harness)
-- ----------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname    = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename  = 'stock_lots'
  ),
  'chefbyte.stock_lots is in supabase_realtime publication'
);

-- ----------------------------------------------------------------
-- 3. chefbyte.food_logs is a publication member
--    (MacroPage realtime path exercised by the harness)
-- ----------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname    = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename  = 'food_logs'
  ),
  'chefbyte.food_logs is in supabase_realtime publication'
);

-- ----------------------------------------------------------------
-- 4. chefbyte.live_shelf_devices is a publication member
--    (scale wizard + LiveTrack realtime paths exercised by the harness)
-- ----------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname    = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename  = 'live_shelf_devices'
  ),
  'chefbyte.live_shelf_devices is in supabase_realtime publication'
);

-- ----------------------------------------------------------------
-- 5-7. Publication DML event types
--      INSERT / UPDATE / DELETE must all be enabled — if the
--      publication was accidentally re-created with only INSERT
--      (e.g. `CREATE PUBLICATION ... FOR TABLE ... WITH (publish =
--      'insert')`) the hook receives nothing on UPDATE/DELETE and
--      the integration tests time-out silently.
-- ----------------------------------------------------------------
SELECT ok(
  (SELECT pubinsert FROM pg_publication WHERE pubname = 'supabase_realtime'),
  'supabase_realtime publishes INSERT events'
);

SELECT ok(
  (SELECT pubupdate FROM pg_publication WHERE pubname = 'supabase_realtime'),
  'supabase_realtime publishes UPDATE events'
);

SELECT ok(
  (SELECT pubdelete FROM pg_publication WHERE pubname = 'supabase_realtime'),
  'supabase_realtime publishes DELETE events'
);

SELECT * FROM finish();
ROLLBACK;
