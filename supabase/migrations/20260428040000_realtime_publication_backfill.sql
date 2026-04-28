-- Backfill missing tables into the `supabase_realtime` publication.
--
-- Why: `apps/web/src/__tests__/.../useRealtimeInvalidation` calls subscribe
-- to a number of tables that were never explicitly added to the
-- publication. We caught this with the new pgTAP probe
-- `supabase/tests/hub/realtime_publication_integrity.test.sql` which
-- hardcodes the union of (schema, table) tuples the React app's
-- `useRealtimeInvalidation` hook touches and asserts each is a
-- publication member. Nine probes failed on the first run:
--
--   * chefbyte.stock_lots          — Inventory + Home pages
--   * chefbyte.products            — Inventory + Settings pages
--   * chefbyte.meal_plan_entries   — MealPlan + Home pages
--   * chefbyte.shopping_list       — Shopping + Home pages
--   * chefbyte.shelf_event_log     — EventViewer + ChefLayout
--   * chefbyte.locations           — Settings page
--   * coachbyte.planned_sets       — Today (CoachByte) page
--   * coachbyte.completed_sets     — Today (CoachByte) page
--   * coachbyte.timers             — Today (CoachByte) page rest-timer
--   * hub.app_activations          — AppProvider activation gate
--
-- Symptom of the missing publication membership: Supabase Realtime
-- responds `status: error` for `postgres_changes` channels filtered on
-- these tables. The user-visible failure mode is "page loads correctly
-- but never updates" — a hard bug to spot in QA because the initial
-- HTTP fetch always succeeds.
--
-- Each ALTER is wrapped in a guard so re-running this migration is a
-- no-op (deploys + local reset are both idempotent), and the final
-- table list lives behind a single migration so a future operator can
-- audit publication membership by scanning `*_realtime_publication*` /
-- `*_publication_backfill*` filenames in `supabase/migrations/`.

DO $$
DECLARE
  -- Two-element rows: (schema, table). plpgsql doesn't have first-class
  -- pair tuples without a custom type, so we encode as `schema.table`
  -- and split inside the loop. All entries are validated to be
  -- well-formed via the unnest list literal — no runtime input here.
  t TEXT;
  s TEXT;
  tbl TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'chefbyte.stock_lots',
    'chefbyte.products',
    'chefbyte.meal_plan_entries',
    'chefbyte.shopping_list',
    'chefbyte.shelf_event_log',
    'chefbyte.locations',
    'coachbyte.planned_sets',
    'coachbyte.completed_sets',
    'coachbyte.timers',
    'hub.app_activations'
  ] LOOP
    s := split_part(t, '.', 1);
    tbl := split_part(t, '.', 2);
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = s
         AND tablename = tbl
    ) THEN
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime ADD TABLE %I.%I', s, tbl
      );
    END IF;
  END LOOP;
END $$;
