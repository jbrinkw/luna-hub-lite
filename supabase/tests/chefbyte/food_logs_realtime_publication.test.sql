-- Asserts that chefbyte.food_logs and chefbyte.temp_items are members of
-- the `supabase_realtime` publication so the MacroPage's Realtime
-- subscription can deliver postgres_changes events.
--
-- Why pin this in pgTAP: a future migration that rebuilds the
-- publication, drops + re-creates either table, or runs ALTER
-- PUBLICATION ... DROP TABLE on these would silently break the macros
-- "live update on Pi event" path. The MacroPage would still load the
-- correct totals on initial fetch and on manual refresh, so a manual
-- smoke test wouldn't catch it. This pgTAP probe fails loudly the
-- moment publication membership is lost.
--
-- See: 20260427070000_food_logs_realtime_publication.sql for the ADD
-- and the diagnostic story behind why this regression slipped through.

BEGIN;
SELECT plan(2);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname    = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename  = 'food_logs'
  ),
  'chefbyte.food_logs is a member of supabase_realtime publication'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname    = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename  = 'temp_items'
  ),
  'chefbyte.temp_items is a member of supabase_realtime publication'
);

SELECT * FROM finish();
ROLLBACK;
