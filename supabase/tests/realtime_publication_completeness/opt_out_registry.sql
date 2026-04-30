-- Realtime publication opt-out registry.
--
-- Every table in chefbyte, coachbyte, and hub schemas MUST either appear in
-- the `supabase_realtime` publication OR have a row here with a non-empty
-- reason documenting WHY it is intentionally excluded.
--
-- Loaded by: test_completeness.test.sql
-- Maintained by: engineering — add a row here before opting a new table out.

CREATE TEMP TABLE IF NOT EXISTS _realtime_opt_out (
  schema_name  text NOT NULL,
  table_name   text NOT NULL,
  reason       text NOT NULL CHECK (reason <> ''),
  PRIMARY KEY  (schema_name, table_name)
);

INSERT INTO _realtime_opt_out (schema_name, table_name, reason) VALUES

  -- chefbyte
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

  -- coachbyte
  ('coachbyte', 'exercises',
   'Global + user exercise library. Read-only in normal flow; no live-update need in current UI.'),

  ('coachbyte', 'splits',
   'Weekly split config. Edited on SplitPage; page unmounts on save, no cross-tab subscription need.'),

  ('coachbyte', 'daily_plans',
   'Wrapper record for a training day. TodayPage subscribes to planned_sets/completed_sets/timers, not this parent.'),

  ('coachbyte', 'user_settings',
   'Per-user CoachByte prefs (rest duration etc.). Read once on mount; no live-update need.'),

  -- hub
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
