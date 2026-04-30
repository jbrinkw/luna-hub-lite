-- ============================================================
-- Realtime publication completeness audit — 2026-04-30
-- ============================================================
-- Root cause of "Walmart link added to milk, went to shopping
-- list, had to refresh": chefbyte.products was missing from the
-- supabase_realtime publication (and several other tables).
--
-- The backfill migration (20260428040000) fixed most holes
-- found by the pgTAP probe at that time. This migration closes
-- the remaining gaps by doing a complete enumeration of all
-- chefbyte/coachbyte/hub tables and deciding YES/NO per table
-- with an explicit rationale.
--
-- Tables ADDED here:
--   chefbyte.recipes          — RecipesPage subscribes via
--                               useRealtimeInvalidation for live
--                               cookability recalc when stock changes
--   chefbyte.recipe_ingredients — Same hook on RecipesPage;
--                               ingredient list changes (MCP tool
--                               writes) must reflect without refresh
--
-- All other tables that were already in the publication are
-- handled by prior migrations (see grep for
-- ALTER PUBLICATION supabase_realtime ADD TABLE in
-- 20260419080000, 20260427070000, 20260428040000,
-- 20260429140000). This migration is strictly additive.
--
-- ============================================================
-- Tables intentionally NOT added (and why):
-- ============================================================
--
-- chefbyte.user_config
--   Config key-value store (macro goals). No UI component
--   subscribes; values load on mount and are mutated only by
--   the logged-in user in the same session. Realtime would be
--   redundant and wastes a WS channel.
--
-- chefbyte.walmart_quota
--   Server-side rate-limit counters only. Never read or
--   rendered directly by the React UI.
--
-- chefbyte.pi_lot_snapshots
--   Append-only telemetry written by the Pi; the UI renders
--   summaries via shelf_event_log, not raw snapshots. No
--   useRealtimeInvalidation call site references this table.
--
-- chefbyte.live_shelf_device_state_changes
--   Internal state-ledger table used by the Pi state machine.
--   The UI polls live_shelf_devices (already in publication)
--   for device state; the ledger rows are not rendered directly.
--
-- coachbyte.daily_plans
--   Written by ensure_daily_plan RPC; the UI reads it once on
--   page load (TodayPage) and never subscribes. Planned/completed
--   set channels handle the real-time side.
--
-- coachbyte.exercises
--   Global + user exercise library. Rarely changes; loaded once
--   with a 10-min stale time. No subscription call site.
--
-- coachbyte.splits
--   Weekly split configuration. User edits live in SplitPage;
--   only the editing user is on that page at a time. No
--   subscription call site.
--
-- coachbyte.user_settings
--   Per-user CoachByte preferences. Mutated only in settings UI
--   by the same session. No subscription call site.
--
-- hub.profiles
--   Timezone / day_start_hour. Mutated only in Hub profile page
--   by the same session. No subscription call site.
--
-- hub.agent_settings
--   MCP/AI agent config. Read once on mount; no live-update UI.
--
-- hub.extension_settings
--   Vault-backed extension credentials. Sensitive; rendering is
--   form-based (one-time load). No subscription call site.
--
-- hub.api_keys
--   SHA-256 hashed keys. Listed in Hub settings on page load;
--   no live-tile that needs push updates. No subscription.
--
-- hub.user_tool_config
--   Tool toggle table. Same session makes the toggle; no
--   cross-session use case. No subscription call site.
-- ============================================================

DO $$
DECLARE
  t   TEXT;
  s   TEXT;
  tbl TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- RecipesPage: useRealtimeInvalidation subscribes to both for
    -- cookability refresh when stock or ingredients change via MCP tools.
    'chefbyte.recipes',
    'chefbyte.recipe_ingredients'
  ] LOOP
    s   := split_part(t, '.', 1);
    tbl := split_part(t, '.', 2);
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname    = 'supabase_realtime'
         AND schemaname = s
         AND tablename  = tbl
    ) THEN
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime ADD TABLE %I.%I', s, tbl
      );
    END IF;
  END LOOP;
END $$;
