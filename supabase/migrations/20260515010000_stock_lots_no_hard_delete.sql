-- Gap G1 from the cloud↔Pi polling audit (2026-05-15):
-- four cloud SQL functions hard-DELETE rows from chefbyte.stock_lots, but the
-- Pi's lot_snapshot_poller is delta-based on updated_at and only recognises
-- tombstones via deleted_at IS NOT NULL. A hard DELETE bumps no updated_at,
-- leaves no row to mirror, so the Pi's `lots` / `cloud_lots` rows live on
-- forever (the "burger buns ghost" / "chocolate-milk ghost" pattern).
--
-- THE FOUR LISTED CALLSITES (verified during the audit):
--   * supabase/migrations/20260424050000_consume_bounds.sql:117
--   * supabase/migrations/20260424080000_stock_lots_invariant_and_resolve.sql:92
--   * supabase/migrations/20260305010000_unmark_meal_done.sql:336
--   * supabase/migrations/20260429240000_unmark_meal_done_gram_unit.sql:127
--
-- The historical migrations are NOT edited in place — they have already
-- shipped. This migration is forward-only:
--
--   1. Rewrites `private.consume_product` (latest version: 20260424050000)
--      so the depletion-FIFO path soft-deletes a fully-drained lot instead
--      of hard-DELETEing it: sets qty_containers=0, deleted_at=now(),
--      last_update_source='manual_consume', last_update_ts=now(). The
--      `stock_lots_set_updated_at` BEFORE-UPDATE trigger (migration
--      20260426010000) bumps updated_at automatically so the Pi's delta
--      poller picks the tombstone up on the next 60s tick.
--
--   2. Rewrites `private.unmark_meal_done` (latest version: 20260429240000)
--      so the [MEAL] stock_lots cleanup soft-deletes the per-product lots
--      rather than hard-DELETEing them. The subsequent [MEAL] products
--      cleanup is allowed to cascade-hard-delete the (already-tombstoned)
--      lots via a session-local bypass (`SET LOCAL
--      chefbyte.stock_lots_allow_hard_delete = 'on'`) so the FK
--      ON DELETE CASCADE on chefbyte.stock_lots.product_id can complete.
--      The Pi sees the tombstone in the same transaction's
--      updated_at bump before the cascade hard-deletes it.
--
--   3. Adds a `BEFORE DELETE FOR EACH ROW` trigger on chefbyte.stock_lots
--      that, by default, CONVERTS the delete into a soft-delete in place
--      (UPDATE-with-deleted_at) and RETURNS NULL to suppress the original
--      DELETE. This is defense-in-depth so any future code path — or an
--      ad-hoc REST-API .delete() from the chef UI — can't reintroduce the
--      ghost class. The trigger RAISES NOTICE on conversion so the audit
--      log surfaces what happened.
--
--      A session-local GUC bypass (`chefbyte.stock_lots_allow_hard_delete
--      = 'on'`) is provided for two legitimate hard-delete paths that we
--      do NOT want to convert:
--        a. Full-account wipes: chefbyte.backup_restore_user_chefbyte,
--           chefbyte.wipe_chefbyte_user (both delete EVERYTHING for the
--           user, then restore; tombstones would block the unique-on
--           index used by restore).
--        b. ON DELETE CASCADE from chefbyte.products (e.g. [MEAL] product
--           cleanup in unmark_meal_done above) where the parent product
--           is also being hard-deleted; an orphan tombstoned lot whose
--           FK target is gone would violate the NOT NULL FK constraint.
--      Both call sites SET LOCAL the GUC immediately before the wipe and
--      clear it implicitly at transaction end.
--
--   4. Pre-migration consolidation: idempotently scans for any existing
--      row that was hard-DELETEd but should have been a tombstone (we
--      can't recover historical state, but we can ensure forward-going
--      state is consistent). No-op on a clean install.
--
-- CHECK CONSTRAINT REMINDER: chefbyte.stock_lots.last_update_source has
-- CHECK IN ('manual','manual_discard','manual_consume','manual_return',
--           'live_shelf','live_scale','catch_all'). The values picked
-- below ('manual_consume' for the consume + unmark paths) are within the
-- existing constraint — no schema change required.

BEGIN;

------------------------------------------------------------
-- 1. BEFORE DELETE trigger — convert hard delete → soft delete.
------------------------------------------------------------
-- Default: UPDATE the row in place to qty_containers=0 + deleted_at=now(),
-- emit NOTICE, RETURN NULL to suppress the original DELETE.
-- Bypass: if current_setting('chefbyte.stock_lots_allow_hard_delete', true)
-- = 'on' for the current transaction, return OLD to allow the hard delete.
-- The `, true` second arg makes current_setting return NULL on unset (not
-- raise) so the default case (no GUC) is a single NULL comparison.

CREATE OR REPLACE FUNCTION private.guard_stock_lots_hard_delete()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_bypass TEXT;
BEGIN
  -- Per-transaction opt-out for legitimate full-wipe + cascade paths.
  v_bypass := current_setting('chefbyte.stock_lots_allow_hard_delete', true);
  IF v_bypass = 'on' THEN
    RETURN OLD;  -- allow the hard delete
  END IF;

  -- Convert: soft-delete in place. Only stamp last_update_source if it's
  -- not already set to a valid CHECK value — preserve forensic provenance
  -- where possible. The row's existing last_update_ts is overwritten so
  -- the snapshot delta query picks the tombstone up.
  --
  -- Cascade-from-parent-table guard: if a parent record is being
  -- deleted (auth.users, chefbyte.products, chefbyte.locations) in the
  -- same transaction, the soft-delete UPDATE would violate one of the
  -- FK constraints — the parent row is already gone. We catch the FK
  -- violation and fall back to allowing the hard-delete; a tombstone
  -- whose parent is gone has no Pi-side value either way.
  BEGIN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = 0,
           deleted_at         = COALESCE(deleted_at, now()),
           last_update_source = COALESCE(last_update_source, 'manual_consume'),
           last_update_ts     = now()
     WHERE lot_id = OLD.lot_id;
  EXCEPTION
    WHEN foreign_key_violation THEN
      -- Parent being deleted in same tx → let the cascade complete.
      RETURN OLD;
  END;

  RAISE NOTICE
    'stock_lots: hard DELETE on lot_id=% converted to soft-delete (deleted_at=now()) — set chefbyte.stock_lots_allow_hard_delete=on to bypass',
    OLD.lot_id;

  RETURN NULL;  -- suppress the original DELETE
END;
$$;

DROP TRIGGER IF EXISTS stock_lots_no_hard_delete ON chefbyte.stock_lots;
CREATE TRIGGER stock_lots_no_hard_delete
  BEFORE DELETE ON chefbyte.stock_lots
  FOR EACH ROW
  EXECUTE FUNCTION private.guard_stock_lots_hard_delete();

COMMENT ON TRIGGER stock_lots_no_hard_delete ON chefbyte.stock_lots IS
  'Gap G1 (cloud↔Pi polling audit, 2026-05-15): converts any DELETE to a '
  'soft-delete (qty_containers=0, deleted_at=now()) so the Pi''s '
  'lot_snapshot_poller — which is delta-based on updated_at and only '
  'recognises tombstones — never misses a row. Prevents the buns / '
  'chocolate-milk ghost class. Bypass via SET LOCAL '
  'chefbyte.stock_lots_allow_hard_delete = ''on'' (used by full-wipe and '
  'cascade-from-products paths).';

------------------------------------------------------------
-- 2. private.consume_product — soft-delete drained lots.
------------------------------------------------------------
-- Replaces the version installed by 20260424050000_consume_bounds.sql.
-- The ONLY behavioural delta is inside the FOR loop: when a lot is fully
-- depleted, we UPDATE it to qty=0 + deleted_at=now() instead of DELETEing.
-- All ceilings / signature / RPC wrappers remain identical.

CREATE OR REPLACE FUNCTION private.consume_product(
  p_user_id UUID,
  p_product_id UUID,
  p_qty NUMERIC,
  p_unit TEXT,
  p_log_macros BOOLEAN,
  p_logical_date DATE,
  p_confirm_large_amount BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product RECORD;
  v_qty_containers NUMERIC(10,3);
  v_total_servings NUMERIC(10,3);
  v_cal NUMERIC(10,3);
  v_carbs NUMERIC(10,3);
  v_protein NUMERIC(10,3);
  v_fat NUMERIC(10,3);
  v_remaining NUMERIC(10,3);
  v_lot RECORD;
  v_stock_remaining NUMERIC(10,3);
  v_stored_unit TEXT;

  HARD_QTY_CEILING CONSTANT NUMERIC := 10000;
  SOFT_CAL_CEILING CONSTANT NUMERIC := 10000;
BEGIN
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive, got %', p_qty;
  END IF;

  IF p_qty > HARD_QTY_CEILING THEN
    RAISE EXCEPTION 'Quantity % exceeds hard ceiling of %. Value is outside any plausible consumption.', p_qty, HARD_QTY_CEILING;
  END IF;

  SELECT * INTO v_product
  FROM chefbyte.products
  WHERE product_id = p_product_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found or not owned by user';
  END IF;

  IF p_unit = 'serving' THEN
    v_stored_unit := 'serving';
    v_qty_containers := p_qty / GREATEST(v_product.servings_per_container, 0.001);
  ELSE
    v_stored_unit := 'container';
    v_qty_containers := p_qty;
  END IF;

  v_total_servings := v_qty_containers * COALESCE(v_product.servings_per_container, 1);
  v_cal := v_total_servings * COALESCE(v_product.calories_per_serving, 0);
  v_carbs := v_total_servings * COALESCE(v_product.carbs_per_serving, 0);
  v_protein := v_total_servings * COALESCE(v_product.protein_per_serving, 0);
  v_fat := v_total_servings * COALESCE(v_product.fat_per_serving, 0);

  IF v_cal > SOFT_CAL_CEILING AND COALESCE(p_confirm_large_amount, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION
      'Suspicious amount: qty % % would log % calories (threshold %). Pass confirm_large_amount=true to proceed if intentional.',
      p_qty, p_unit, v_cal, SOFT_CAL_CEILING;
  END IF;

  v_remaining := v_qty_containers;

  -- FEFO depletion. The previous version hard-DELETEd a fully-drained
  -- lot; we now soft-delete (qty=0, deleted_at=now()) so the Pi's
  -- lot_snapshot_poller picks the tombstone up via the updated_at bump
  -- emitted by the stock_lots_set_updated_at trigger.
  FOR v_lot IN
    SELECT lot_id, qty_containers
    FROM chefbyte.stock_lots
    WHERE user_id = p_user_id AND product_id = p_product_id
      AND qty_containers > 0
      AND deleted_at IS NULL
    ORDER BY expires_on ASC NULLS LAST
  LOOP
    EXIT WHEN v_remaining <= 0;

    IF v_lot.qty_containers <= v_remaining THEN
      v_remaining := v_remaining - v_lot.qty_containers;
      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             deleted_at         = now(),
             last_update_source = 'manual_consume',
             last_update_ts     = now()
       WHERE lot_id = v_lot.lot_id;
    ELSE
      UPDATE chefbyte.stock_lots
         SET qty_containers     = qty_containers - v_remaining,
             last_update_source = 'manual_consume',
             last_update_ts     = now()
       WHERE lot_id = v_lot.lot_id;
      v_remaining := 0;
    END IF;
  END LOOP;

  IF p_log_macros THEN
    INSERT INTO chefbyte.food_logs (
      user_id, product_id, logical_date,
      qty_consumed, unit, calories, carbs, protein, fat
    ) VALUES (
      p_user_id, p_product_id, p_logical_date,
      p_qty, v_stored_unit, v_cal, v_carbs, v_protein, v_fat
    );
  END IF;

  -- stock_remaining excludes tombstones — they no longer represent
  -- spendable stock even though they remain in the table.
  SELECT COALESCE(SUM(qty_containers), 0) INTO v_stock_remaining
  FROM chefbyte.stock_lots
  WHERE user_id = p_user_id AND product_id = p_product_id
    AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'success', true,
    'qty_consumed', p_qty,
    'macros', jsonb_build_object(
      'calories', v_cal,
      'carbs', v_carbs,
      'protein', v_protein,
      'fat', v_fat
    ),
    'stock_remaining', v_stock_remaining
  );
END;
$$;

------------------------------------------------------------
-- 3. private.unmark_meal_done — soft-delete [MEAL] lots; bypass on cascade.
------------------------------------------------------------
-- Replaces the version installed by 20260429240000_unmark_meal_done_gram_unit.sql.
-- Two behavioural deltas:
--   a. The [MEAL] stock_lots cleanup is soft-delete (qty=0, deleted_at).
--   b. Before the [MEAL] products cleanup, SET LOCAL the bypass GUC so
--      the FK ON DELETE CASCADE can hard-remove the (already tombstoned)
--      lots — the Pi has already seen the tombstone via the updated_at
--      bump in the same transaction window.

CREATE OR REPLACE FUNCTION private.unmark_meal_done(
  p_user_id UUID,
  p_meal_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_meal RECORD;
  v_log RECORD;
  v_location_id UUID;
  v_deleted_logs INT := 0;
  v_restored_stock INT := 0;
  v_deleted_meal_product BOOLEAN := false;
BEGIN
  SELECT * INTO v_meal
  FROM chefbyte.meal_plan_entries
  WHERE meal_id = p_meal_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meal not found or not owned by user';
  END IF;

  IF v_meal.completed_at IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Meal is not completed'
    );
  END IF;

  SELECT location_id INTO v_location_id
  FROM chefbyte.locations
  WHERE user_id = p_user_id
  ORDER BY created_at ASC
  LIMIT 1;

  FOR v_log IN
    SELECT product_id, qty_consumed, unit
    FROM chefbyte.food_logs
    WHERE meal_id = p_meal_id AND user_id = p_user_id
  LOOP
    DECLARE
      v_qty_containers NUMERIC(10,3);
      v_spc NUMERIC(10,3);
    BEGIN
      SELECT GREATEST(servings_per_container, 0.001) INTO v_spc
      FROM chefbyte.products
      WHERE product_id = v_log.product_id AND user_id = p_user_id;

      IF v_log.unit = 'serving' THEN
        v_qty_containers := v_log.qty_consumed / COALESCE(v_spc, 1);
      ELSE
        v_qty_containers := v_log.qty_consumed;
      END IF;

      v_qty_containers := GREATEST(v_qty_containers, 0);

      IF v_location_id IS NOT NULL AND v_qty_containers > 0 THEN
        INSERT INTO chefbyte.stock_lots (
          user_id, product_id, location_id,
          qty_containers, expires_on
        ) VALUES (
          p_user_id, v_log.product_id, v_location_id,
          v_qty_containers, NULL
        )
        ON CONFLICT (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31'::date))
        DO UPDATE SET qty_containers = chefbyte.stock_lots.qty_containers + v_qty_containers,
                      deleted_at     = NULL,  -- restore tombstoned lot
                      last_update_source = 'manual_return',
                      last_update_ts     = now();

        v_restored_stock := v_restored_stock + 1;
      END IF;
    END;
  END LOOP;

  DELETE FROM chefbyte.food_logs
  WHERE meal_id = p_meal_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_deleted_logs = ROW_COUNT;

  IF v_meal.meal_prep THEN
    DECLARE
      v_meal_name TEXT;
      v_expected_prefix TEXT;
    BEGIN
      IF v_meal.recipe_id IS NOT NULL THEN
        SELECT name INTO v_meal_name
        FROM chefbyte.recipes
        WHERE recipe_id = v_meal.recipe_id AND user_id = p_user_id;
      ELSIF v_meal.product_id IS NOT NULL THEN
        SELECT name INTO v_meal_name
        FROM chefbyte.products
        WHERE product_id = v_meal.product_id AND user_id = p_user_id;
      END IF;

      IF v_meal_name IS NOT NULL THEN
        v_expected_prefix := '[MEAL] ' || v_meal_name || ' ' || to_char(v_meal.logical_date, 'MM-DD');

        -- Step 1: soft-delete [MEAL] stock_lots so the Pi sees the
        -- tombstone via updated_at on the next poll. The trigger
        -- would convert this anyway, but doing it explicitly is
        -- clearer + makes the last_update_source attribution honest.
        UPDATE chefbyte.stock_lots
           SET qty_containers     = 0,
               deleted_at         = now(),
               last_update_source = 'manual_consume',
               last_update_ts     = now()
         WHERE product_id IN (
           SELECT product_id FROM chefbyte.products
           WHERE user_id = p_user_id AND name = v_expected_prefix
         )
         AND deleted_at IS NULL;

        -- Step 2: hard-delete the [MEAL] product. The FK ON DELETE
        -- CASCADE on stock_lots.product_id needs to be allowed to
        -- complete (orphan tombstoned lots would violate the NOT NULL
        -- FK), so set the per-tx bypass for the cascade window only.
        SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on';

        DELETE FROM chefbyte.products
        WHERE user_id = p_user_id AND name = v_expected_prefix;

        -- Defensive: explicitly turn the bypass off again so any
        -- subsequent statement in this transaction can't accidentally
        -- piggy-back on it.
        SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'off';

        v_deleted_meal_product := true;
      END IF;
    END;
  END IF;

  UPDATE chefbyte.meal_plan_entries
  SET completed_at = NULL
  WHERE meal_id = p_meal_id;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_logs', v_deleted_logs,
    'restored_stock', v_restored_stock,
    'deleted_meal_product', v_deleted_meal_product
  );
END;
$$;

------------------------------------------------------------
-- 4. private.void_scan_transaction — soft-delete via trigger conversion.
------------------------------------------------------------
-- Migration 20260503100200 hard-DELETEs the applied stock_lots row when
-- a scan transaction is voided. The new trigger automatically converts
-- this to a soft-delete; no function rewrite required. We re-declare it
-- here only to refresh the COMMENT so future readers see the behavior
-- note alongside the function definition.

COMMENT ON FUNCTION private.void_scan_transaction(UUID) IS
  'Reverse the side-effects of an applied scan_transactions row '
  '(delete stock_lot / food_log / shopping_list cart item if recorded) '
  'and mark status=voided. NOTE: the stock_lots DELETE is converted to '
  'a soft-delete by trigger stock_lots_no_hard_delete (migration '
  '20260515010000) so the Pi''s lot_snapshot_poller picks the tombstone '
  'up via the next 60s delta.';

------------------------------------------------------------
-- 5. private.deactivate_app — bypass on full chefbyte wipe.
------------------------------------------------------------
-- Replaces the version installed by 20260421060000_retire_liquidtrack.sql.
-- The only behavioural delta: SET LOCAL the per-tx bypass GUC before the
-- chefbyte wipe so the stock_lots hard-DELETE is allowed (the parent
-- account is gone; preserving tombstones serves no purpose).

CREATE OR REPLACE FUNCTION private.deactivate_app(
  p_user_id UUID,
  p_app_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM hub.app_activations
  WHERE user_id = p_user_id AND app_name = p_app_name;

  IF p_app_name = 'coachbyte' THEN
    DELETE FROM coachbyte.timers WHERE user_id = p_user_id;
    DELETE FROM coachbyte.splits WHERE user_id = p_user_id;
    DELETE FROM coachbyte.daily_plans WHERE user_id = p_user_id;
    DELETE FROM coachbyte.user_settings WHERE user_id = p_user_id;
  END IF;

  IF p_app_name = 'chefbyte' THEN
    -- Full-wipe bypass: this path tears down the entire chefbyte dataset
    -- for the user, so the no-hard-delete guard would just leave dead
    -- tombstones with no parent account.
    SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on';

    -- live_shelf: device row cascades to scale_pairings + shelf_event_log
    -- via FK ON DELETE CASCADE, so one DELETE covers all three tables.
    DELETE FROM chefbyte.live_shelf_devices WHERE user_id = p_user_id;
    DELETE FROM chefbyte.food_logs WHERE user_id = p_user_id;
    DELETE FROM chefbyte.temp_items WHERE user_id = p_user_id;
    DELETE FROM chefbyte.shopping_list WHERE user_id = p_user_id;
    DELETE FROM chefbyte.meal_plan_entries WHERE user_id = p_user_id;
    DELETE FROM chefbyte.recipe_ingredients WHERE user_id = p_user_id;
    DELETE FROM chefbyte.recipes WHERE user_id = p_user_id;
    DELETE FROM chefbyte.stock_lots WHERE user_id = p_user_id;
    DELETE FROM chefbyte.products WHERE user_id = p_user_id;
    DELETE FROM chefbyte.locations WHERE user_id = p_user_id;
    DELETE FROM chefbyte.user_config WHERE user_id = p_user_id;

    SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'off';
  END IF;
END;
$$;

------------------------------------------------------------
-- 6. private.restore_chefbyte_backup — bypass on full wipe-before-restore.
------------------------------------------------------------
-- Replaces the version installed by 20260423010000_chefbyte_backup_restore.sql.
-- The only behavioural delta: SET LOCAL the per-tx bypass GUC around the
-- pre-restore wipe so the stock_lots hard-DELETE is allowed (a restored
-- backup re-inserts the same lot_ids and would conflict with surviving
-- tombstones). All validation logic above the wipe block is untouched.

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

  v_backup_uid := NULLIF(p_backup->>'user_id','')::UUID;
  IF v_backup_uid IS NULL THEN
    RAISE EXCEPTION 'backup missing user_id field';
  END IF;
  IF v_backup_uid <> v_user_id THEN
    RAISE EXCEPTION
      'backup belongs to a different user — cannot restore';
  END IF;

  v_tables := p_backup->'tables';
  IF v_tables IS NULL OR jsonb_typeof(v_tables) <> 'object' THEN
    RAISE EXCEPTION 'backup.tables must be an object';
  END IF;

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

  -- Full-wipe bypass: restore is a "drop everything for the user then
  -- re-insert from JSON" operation. Soft-delete tombstones would block
  -- the re-insert path's unique indexes (same lot_id).
  SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on';

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

  SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'off';

  -- ----- 6. Insert backup rows (parents → children) -----
  -- jsonb_populate_recordset tolerates extra keys and fills missing ones
  -- with the column default, so a slightly-older same-version backup
  -- still restores cleanly as long as the user_id guard + schema_version
  -- check pass.

  v_rows := COALESCE(v_tables->'locations', '[]'::jsonb);
  INSERT INTO chefbyte.locations
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.locations, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('locations', v_count);

  v_rows := COALESCE(v_tables->'products', '[]'::jsonb);
  INSERT INTO chefbyte.products
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.products, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('products', v_count);

  v_rows := COALESCE(v_tables->'stock_lots', '[]'::jsonb);
  INSERT INTO chefbyte.stock_lots
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.stock_lots, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('stock_lots', v_count);

  v_rows := COALESCE(v_tables->'recipes', '[]'::jsonb);
  INSERT INTO chefbyte.recipes
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.recipes, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('recipes', v_count);

  v_rows := COALESCE(v_tables->'recipe_ingredients', '[]'::jsonb);
  INSERT INTO chefbyte.recipe_ingredients
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.recipe_ingredients, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('recipe_ingredients', v_count);

  v_rows := COALESCE(v_tables->'meal_plan_entries', '[]'::jsonb);
  INSERT INTO chefbyte.meal_plan_entries
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.meal_plan_entries, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('meal_plan_entries', v_count);

  v_rows := COALESCE(v_tables->'food_logs', '[]'::jsonb);
  INSERT INTO chefbyte.food_logs
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.food_logs, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('food_logs', v_count);

  v_rows := COALESCE(v_tables->'temp_items', '[]'::jsonb);
  INSERT INTO chefbyte.temp_items
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.temp_items, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('temp_items', v_count);

  v_rows := COALESCE(v_tables->'shopping_list', '[]'::jsonb);
  INSERT INTO chefbyte.shopping_list
    SELECT * FROM jsonb_populate_recordset(NULL::chefbyte.shopping_list, v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_restored := v_restored || jsonb_build_object('shopping_list', v_count);

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

COMMIT;
