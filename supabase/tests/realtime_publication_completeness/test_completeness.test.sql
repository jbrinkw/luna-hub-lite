-- realtime_publication_completeness/test_completeness.test.sql
--
-- GATE: Every table in chefbyte, coachbyte, and hub schemas must be either:
--   (a) a member of the `supabase_realtime` publication, OR
--   (b) listed in the opt-out registry with a non-empty reason.
--
-- WHY THIS EXISTS
-- ---------------
-- Missing publication membership causes Supabase Realtime to return
-- `status: error` for postgres_changes channels. The page still loads
-- (initial HTTP fetch succeeds), so smoke tests pass — but live updates
-- silently stop working. We've hit this repeatedly:
--   * 2026-04-19: live_shelf_devices missing → Scales tab went stale
--   * 2026-04-21: livetrack_import_sessions, event_overrides missing
--   * 2026-04-27: hub.alerts, food_logs, temp_items missing → macro page stale
--   * 2026-04-27: 9-table backfill (products, stock_lots, …) missing
--   * 2026-04-29: mcp_tool_logs missing → ExtensionCard tail stale
--   * 2026-04-29: review_queue missing → ReviewsPage stale
--
-- This gate is EXPECTED TO FAIL if U1 hasn't yet added a missing table to
-- the publication. That's its whole point. U1 adds the tables; this gate
-- stays to prevent future regressions.
--
-- HOW THE GATE WORKS
-- ------------------
-- 1. Enumerate pg_class for relkind='r' tables in chefbyte/coachbyte/hub.
-- 2. For each table, pass if:
--      * It is in pg_publication_tables (pubname='supabase_realtime'), OR
--      * It appears in _realtime_opt_out with a non-empty reason.
-- 3. plan(N) = total tables surveyed. A new table not in publication AND
--    not in opt-out causes an unexpected failing test, making the gap visible.
--
-- USAGE
-- -----
--   flock /tmp/luna-supabase.lock supabase test db \
--     supabase/tests/realtime_publication_completeness/test_completeness.test.sql

BEGIN;

-- Opt-out registry (mirrored from opt_out_registry.sql; inlined because
-- `supabase test db` invokes psql from the repo root, making \ir resolve
-- relative to cwd rather than the test file's directory).
--
-- To update this list: also update opt_out_registry.sql (kept as
-- authoritative human-readable source) and paste the INSERT block here.
CREATE TEMP TABLE IF NOT EXISTS _realtime_opt_out (
  schema_name  text NOT NULL,
  table_name   text NOT NULL,
  reason       text NOT NULL CHECK (reason <> ''),
  PRIMARY KEY  (schema_name, table_name)
);

INSERT INTO _realtime_opt_out (schema_name, table_name, reason) VALUES
  ('chefbyte', 'liquidtrack_devices',
   'Retired legacy device table superseded by live_shelf_devices. No UI subscribes to it.'),
  ('chefbyte', 'liquidtrack_events',
   'Retired legacy event table superseded by shelf_event_log. No UI subscribes to it.'),
  ('chefbyte', 'live_shelf_device_state_changes',
   'Append-only audit ledger — UI reads aggregated state from live_shelf_devices, not this log.'),
  ('chefbyte', 'pi_lot_snapshots',
   'Append-only snapshot table for cloud-sync reconciliation. Pi writes, no browser channel subscribes.'),
  ('chefbyte', 'walmart_quota',
   'Rate-limit accounting table. No user-facing UI subscribes — counter checked server-side only.'),
  ('chefbyte', 'recipe_ingredients',
   'Fetched eagerly with parent recipe; RecipesPage subscribes to chefbyte.recipes, not this join table.'),
  ('chefbyte', 'user_config',
   'Single-row config per user (units, scanner mode). Read once on mount; no live-update need.'),
  ('coachbyte', 'exercises',
   'Global + user exercise library. Read-only in normal flow; no live-update need in current UI.'),
  ('coachbyte', 'splits',
   'Weekly split config. Edited on SplitPage; page unmounts on save, no cross-tab subscription need.'),
  ('coachbyte', 'daily_plans',
   'Wrapper record for a training day. TodayPage subscribes to planned_sets/completed_sets/timers, not this parent.'),
  ('coachbyte', 'user_settings',
   'Per-user CoachByte prefs (rest duration etc.). Read once on mount; no live-update need.'),
  ('hub', 'profiles',
   'Single-row per user. Loaded by AppProvider once; no cross-tab live-update requirement.'),
  ('hub', 'api_keys',
   'SHA-256-hashed key store. Managed on AccountPage; no live-update requirement.'),
  ('hub', 'extension_settings',
   'Vault-backed extension config. Managed on ExtensionSettingsPage; no live-update requirement.'),
  ('hub', 'user_tool_config',
   'MCP tool enable/disable toggles. Managed on ToolConfigPage; no live-update requirement.'),
  ('hub', 'agent_settings',
   'Agent-level prompt/config rows. Read on mount; no cross-tab live-update requirement.');

-- Count tables to set plan(N). Subquery materialised once.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*)
    INTO n
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname IN ('chefbyte', 'coachbyte', 'hub')
     AND c.relkind = 'r';
  PERFORM plan(n);
END $$;

-- Assert each table: in publication OR in opt-out with reason.
SELECT
  CASE
    WHEN (
      EXISTS (
        SELECT 1
          FROM pg_publication_tables
         WHERE pubname     = 'supabase_realtime'
           AND schemaname  = ns.nspname
           AND tablename   = c.relname
      )
    ) THEN ok(
      TRUE,
      ns.nspname || '.' || c.relname
        || ' — in supabase_realtime publication'
    )
    WHEN (
      EXISTS (
        SELECT 1
          FROM _realtime_opt_out o
         WHERE o.schema_name = ns.nspname
           AND o.table_name  = c.relname
           AND o.reason     <> ''
      )
    ) THEN ok(
      TRUE,
      ns.nspname || '.' || c.relname
        || ' — opt-out: '
        || (SELECT o.reason
              FROM _realtime_opt_out o
             WHERE o.schema_name = ns.nspname
               AND o.table_name  = c.relname
             LIMIT 1)
    )
    ELSE ok(
      FALSE,
      ns.nspname || '.' || c.relname
        || ' — MISSING from supabase_realtime publication and no opt-out registered'
    )
  END
FROM pg_class c
JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE ns.nspname IN ('chefbyte', 'coachbyte', 'hub')
  AND c.relkind = 'r'
ORDER BY ns.nspname, c.relname;

SELECT * FROM finish();
ROLLBACK;
