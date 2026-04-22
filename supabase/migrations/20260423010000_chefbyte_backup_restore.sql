-- ChefByte Backup & Restore
--
-- Adds a pair of SECURITY DEFINER RPCs the Settings UI can call to:
--   (a) download a JSON snapshot of all of the caller's user-scoped ChefByte
--       state, and
--   (b) wipe that state and replace it with a previously-downloaded snapshot,
--       all in a single transaction that rolls back on any failure.
--
-- CONTEXT (Jeremy, 2026-04-23):
--   MCP tool surface has no delete paths for food_logs / temp_items / recipes
--   / products, so an accidental AI write is permanent. A manual
--   backup → restore lets the user snapshot a known-good state and roll
--   back to it whenever something goes sideways.
--
-- ------------------------------------------------------------------------
-- INCLUDED TABLES (user-scoped, stable state worth restoring)
-- ------------------------------------------------------------------------
--   locations              — user's storage locations (Fridge / Pantry / ...)
--   products               — product catalog (macros, weights, Walmart links)
--   stock_lots             — lot-based inventory (qty × location × expiry)
--   recipes                — user recipes
--   recipe_ingredients     — recipe line items
--   meal_plan_entries      — scheduled meals (regular + meal-prep)
--   food_logs              — macro history (logged consumption, incl. Pi-driven)
--   temp_items             — quick-add (non-product) macro items
--   shopping_list          — pending + purchased items
--   user_config            — macro goals + per-user prefs (goal_calories, etc.)
--
-- ------------------------------------------------------------------------
-- EXCLUDED TABLES (Pi-owned / device state / ephemeral)
-- ------------------------------------------------------------------------
--   shelf_event_log            — Pi-owned; service_role-only INSERT; Pi will
--                                 re-emit any new events after restore.
--   event_overrides            — references shelf_event_log.client_event_id;
--                                 dangling without the log. Not backed up.
--   livetrack_import_sessions  — per-session throwaway with 10min expiry.
--   live_shelf_devices         — Pi hardware state; restoring stale rows
--                                 could conflict with current pairings.
--                                 The user re-pairs (registers) the Pi after
--                                 restore if they want to sync again.
--   scale_pairings             — cascades from live_shelf_devices; excluded
--                                 for the same reason.
--
-- ------------------------------------------------------------------------
-- SCHEMA VERSIONING
-- ------------------------------------------------------------------------
-- Stored as a constant on each backup blob. Bumped by hand whenever a
-- migration changes the shape of any INCLUDED table (ADD/DROP/RENAME
-- COLUMN, constraint change, etc.). Restore rejects a mismatch up-front.
-- Initial version = this migration's timestamp.
--
-- ------------------------------------------------------------------------
-- RESTORE SEMANTICS (critical)
-- ------------------------------------------------------------------------
-- * WIPE-AND-RESTORE. All included-table rows for the caller are deleted
--   before any backup row is inserted. No partial-merge, no conflict UI.
-- * FK ORDER MATTERS. Wipe runs children → parents; insert runs parents
--   → children. PK UUIDs from the backup are preserved so cross-table
--   references (stock_lots.product_id, recipe_ingredients.recipe_id,
--   food_logs.meal_id → meal_plan_entries.meal_id, etc.) stay linked.
-- * SINGLE TRANSACTION. The whole thing runs in one plpgsql function body
--   — any error anywhere aborts and rolls back to the pre-call state.
-- * user_id GUARD. Every row in the payload must carry user_id =
--   auth.uid(). Any row that doesn't causes the entire restore to abort.
--   This keeps a leaked / stolen backup from being used to cross-pollute
--   another account.
-- * SIDE-EFFECT-FREE. food_logs.source_client_event_id tags are preserved
--   as opaque text. Because we excluded shelf_event_log, those tags point
--   to nothing, which is fine — the column has no FK and the tag only
--   drives apply_event_override reconciliation, which won't fire without
--   a matching log row.
--
-- ========================================================================

------------------------------------------------------------
-- 1. private.export_chefbyte_backup() → JSONB
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.export_chefbyte_backup()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_result  JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Use to_jsonb(row) per table so newly-added columns are automatically
  -- included in future backups without a code change. COALESCE ensures we
  -- always return a JSON array (never NULL), even for empty tables.
  SELECT jsonb_build_object(
    'schema_version', '20260423010000',
    'generated_at',   to_jsonb(now()),
    'user_id',        to_jsonb(v_user_id),
    'tables', jsonb_build_object(
      'locations', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.locations t WHERE t.user_id = v_user_id
      ), '[]'::jsonb),
      'products', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.products t WHERE t.user_id = v_user_id
      ), '[]'::jsonb),
      'stock_lots', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.stock_lots t WHERE t.user_id = v_user_id
      ), '[]'::jsonb),
      'recipes', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.recipes t WHERE t.user_id = v_user_id
      ), '[]'::jsonb),
      'recipe_ingredients', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.recipe_ingredients t WHERE t.user_id = v_user_id
      ), '[]'::jsonb),
      'meal_plan_entries', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.meal_plan_entries t WHERE t.user_id = v_user_id
      ), '[]'::jsonb),
      'food_logs', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.food_logs t WHERE t.user_id = v_user_id
      ), '[]'::jsonb),
      'temp_items', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.temp_items t WHERE t.user_id = v_user_id
      ), '[]'::jsonb),
      'shopping_list', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.shopping_list t WHERE t.user_id = v_user_id
      ), '[]'::jsonb),
      'user_config', COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
          FROM chefbyte.user_config t WHERE t.user_id = v_user_id
      ), '[]'::jsonb)
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.export_chefbyte_backup() FROM PUBLIC;

------------------------------------------------------------
-- 2. private.restore_chefbyte_backup(JSONB) → JSONB
------------------------------------------------------------
-- Wipe-and-restore. See the header comment for the full contract.

CREATE OR REPLACE FUNCTION private.restore_chefbyte_backup(p_backup JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id       UUID := (SELECT auth.uid());
  v_schema_ver    TEXT;
  v_backup_uid    UUID;
  v_tables        JSONB;
  v_wiped         JSONB := '{}'::jsonb;
  v_restored      JSONB := '{}'::jsonb;
  v_expected_ver  CONSTANT TEXT := '20260423010000';
  v_count         INTEGER;
  -- Table name constants, ordered parents → children for insertion.
  v_insert_order  CONSTANT TEXT[] := ARRAY[
    'locations',
    'products',
    'stock_lots',
    'recipes',
    'recipe_ingredients',
    'meal_plan_entries',
    'food_logs',
    'temp_items',
    'shopping_list',
    'user_config'
  ];
  v_tbl           TEXT;
  v_rows          JSONB;
  v_bad_rows      INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF p_backup IS NULL OR jsonb_typeof(p_backup) <> 'object' THEN
    RAISE EXCEPTION 'backup payload must be a JSON object';
  END IF;

  -- ----- 1. Validate schema_version -----
  v_schema_ver := p_backup->>'schema_version';
  IF v_schema_ver IS NULL THEN
    RAISE EXCEPTION 'backup missing schema_version field';
  END IF;
  IF v_schema_ver <> v_expected_ver THEN
    RAISE EXCEPTION
      'schema_version mismatch: backup=% expected=%',
      v_schema_ver, v_expected_ver
      USING HINT = 'Backups must match the current ChefByte schema version.';
  END IF;

  -- ----- 2. Validate user_id field in payload -----
  v_backup_uid := NULLIF(p_backup->>'user_id','')::UUID;
  IF v_backup_uid IS NULL THEN
    RAISE EXCEPTION 'backup missing user_id field';
  END IF;
  IF v_backup_uid <> v_user_id THEN
    RAISE EXCEPTION
      'backup belongs to a different user — cannot restore';
  END IF;

  -- ----- 3. Grab tables container -----
  v_tables := p_backup->'tables';
  IF v_tables IS NULL OR jsonb_typeof(v_tables) <> 'object' THEN
    RAISE EXCEPTION 'backup.tables must be an object';
  END IF;

  -- ----- 4. Per-row user_id guard across ALL included tables -----
  -- Any row whose user_id differs from the caller aborts the whole
  -- restore. We check this BEFORE wiping so on failure nothing is lost.
  FOREACH v_tbl IN ARRAY v_insert_order LOOP
    v_rows := COALESCE(v_tables->v_tbl, '[]'::jsonb);
    IF jsonb_typeof(v_rows) <> 'array' THEN
      RAISE EXCEPTION 'backup.tables.% must be an array', v_tbl;
    END IF;
    SELECT COUNT(*) INTO v_bad_rows
      FROM jsonb_array_elements(v_rows) elem
      WHERE (elem->>'user_id')::UUID IS DISTINCT FROM v_user_id;
    IF v_bad_rows > 0 THEN
      RAISE EXCEPTION
        'backup.tables.% contains % row(s) with a foreign user_id',
        v_tbl, v_bad_rows;
    END IF;
  END LOOP;

  -- ----- 5. Wipe existing rows (children → parents) -----
  -- Ordering is the reverse of insertion. Each DELETE returns the row
  -- count, folded into v_wiped so the caller sees what was removed.

  DELETE FROM chefbyte.user_config WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('user_config', v_count);

  DELETE FROM chefbyte.shopping_list WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('shopping_list', v_count);

  DELETE FROM chefbyte.temp_items WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('temp_items', v_count);

  DELETE FROM chefbyte.food_logs WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('food_logs', v_count);

  DELETE FROM chefbyte.meal_plan_entries WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('meal_plan_entries', v_count);

  DELETE FROM chefbyte.recipe_ingredients WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('recipe_ingredients', v_count);

  DELETE FROM chefbyte.recipes WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('recipes', v_count);

  DELETE FROM chefbyte.stock_lots WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('stock_lots', v_count);

  DELETE FROM chefbyte.products WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('products', v_count);

  DELETE FROM chefbyte.locations WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_wiped := v_wiped || jsonb_build_object('locations', v_count);

  -- ----- 6. Insert backup rows (parents → children) -----
  -- jsonb_populate_recordset tolerates extra keys and fills missing ones
  -- with the column default, so a slightly-older same-version backup
  -- still restores cleanly as long as the user_id guard + schema_version
  -- check pass.

  -- locations
  v_rows := COALESCE(v_tables->'locations', '[]'::jsonb);
  INSERT INTO chefbyte.locations
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.locations, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('locations', v_count);

  -- products
  v_rows := COALESCE(v_tables->'products', '[]'::jsonb);
  INSERT INTO chefbyte.products
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.products, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('products', v_count);

  -- stock_lots (FK → products, locations)
  v_rows := COALESCE(v_tables->'stock_lots', '[]'::jsonb);
  INSERT INTO chefbyte.stock_lots
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.stock_lots, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('stock_lots', v_count);

  -- recipes
  v_rows := COALESCE(v_tables->'recipes', '[]'::jsonb);
  INSERT INTO chefbyte.recipes
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.recipes, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('recipes', v_count);

  -- recipe_ingredients (FK → recipes, products)
  v_rows := COALESCE(v_tables->'recipe_ingredients', '[]'::jsonb);
  INSERT INTO chefbyte.recipe_ingredients
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.recipe_ingredients, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('recipe_ingredients', v_count);

  -- meal_plan_entries (FK → recipes, products)
  v_rows := COALESCE(v_tables->'meal_plan_entries', '[]'::jsonb);
  INSERT INTO chefbyte.meal_plan_entries
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.meal_plan_entries, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('meal_plan_entries', v_count);

  -- food_logs (FK → products, meal_plan_entries)
  v_rows := COALESCE(v_tables->'food_logs', '[]'::jsonb);
  INSERT INTO chefbyte.food_logs
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.food_logs, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('food_logs', v_count);

  -- temp_items
  v_rows := COALESCE(v_tables->'temp_items', '[]'::jsonb);
  INSERT INTO chefbyte.temp_items
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.temp_items, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('temp_items', v_count);

  -- shopping_list (FK → products)
  v_rows := COALESCE(v_tables->'shopping_list', '[]'::jsonb);
  INSERT INTO chefbyte.shopping_list
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.shopping_list, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('shopping_list', v_count);

  -- user_config (no FK beyond user_id)
  v_rows := COALESCE(v_tables->'user_config', '[]'::jsonb);
  INSERT INTO chefbyte.user_config
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.user_config, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('user_config', v_count);

  RETURN jsonb_build_object(
    'schema_version', v_expected_ver,
    'user_id',        to_jsonb(v_user_id),
    'wiped',          v_wiped,
    'restored',       v_restored
  );
END;
$$;

REVOKE ALL ON FUNCTION private.restore_chefbyte_backup(JSONB) FROM PUBLIC;

------------------------------------------------------------
-- 3. Public wrappers (chefbyte schema) — same pattern as apply_event_override
------------------------------------------------------------
-- Schema `private` isn't granted to authenticated. Wrappers live in the
-- exposed `chefbyte` schema as SECURITY DEFINER SQL functions that just
-- forward to the private implementation. auth.uid() resolves to the
-- caller's UID inside the private function because jwt claims propagate
-- through SECURITY DEFINER → SECURITY DEFINER.

CREATE OR REPLACE FUNCTION chefbyte.export_chefbyte_backup()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.export_chefbyte_backup();
$$;

REVOKE ALL ON FUNCTION chefbyte.export_chefbyte_backup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.export_chefbyte_backup() TO authenticated;

CREATE OR REPLACE FUNCTION chefbyte.restore_chefbyte_backup(p_backup JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.restore_chefbyte_backup(p_backup);
$$;

REVOKE ALL ON FUNCTION chefbyte.restore_chefbyte_backup(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.restore_chefbyte_backup(JSONB) TO authenticated;
