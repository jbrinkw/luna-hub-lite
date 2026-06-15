-- meal_done_identity_and_tagging
--
-- Fixes two meal-execution-cluster audit findings (deep audit 2026-06-03):
--
--   H-10 (UNMARK-WRONG, theme T8) — name-based [MEAL] product identity
--   deletes the WRONG product.
--     private.unmark_meal_done reconstructed the BARE [MEAL] product name
--     ('[MEAL] '||name||' '||MM-DD) and deleted products WHERE name = that
--     bare string. But private.generate_meal_product_name appends an HH:MM
--     (then HH:MM:SS) time suffix when a same-name product already exists
--     (a NOT EXISTS check, NOT a constraint — there is no UNIQUE on
--     chefbyte.products.name). So the 2nd meal-prep of the same recipe on
--     the same logical_date creates a *suffixed* product, while unmark only
--     ever matched the *bare* name. Result (reproduced live): unmark(meal2)
--     destroyed meal1's bare-named product+lots, orphaned meal2's suffixed
--     product, and crossed the completed_at flags — no recovery path.
--
--     FIX (durable, per theme T8): persist the chosen product_id at mark
--     time, delete BY id at unmark.
--       * Add chefbyte.meal_plan_entries.meal_product_id UUID
--         REFERENCES chefbyte.products(product_id) ON DELETE SET NULL.
--       * mark_meal_done writes the [MEAL] product_id it created onto the
--         entry.
--       * unmark_meal_done soft-deletes that product's lots + hard-deletes
--         the product BY id (the FK ON DELETE SET NULL auto-clears the
--         pointer). It also clears any STALE pointer to a co-name sibling.
--       * Backfill: pre-fix completed meal-prep entries have NULL
--         meal_product_id. For those, unmark falls back to the legacy
--         bare-name match (best-effort) — see the NULL-fallback note below.
--
--   H-14 (mark_meal_done over-tag, theme T6) — tagging the meal's food_logs
--   via `WHERE created_at = now()` (transaction-start) over-tags any
--   UNRELATED food_log inserted in the same transaction before
--   mark_meal_done (its meal_id is overwritten; it appears in food_log_ids).
--     Latent today (each PostgREST .rpc() is its own txn) but a future
--     trigger/batched insert corrupts macro attribution.
--
--     FIX: tag by the SPECIFIC food_log_id returned from each of the meal's
--     own consume_product calls.
--       * private.consume_product now surfaces 'food_log_id' in its return
--         JSONB (purely additive — every existing caller reads other keys
--         or PERFORMs the call).
--       * mark_meal_done collects each returned food_log_id into a UUID[]
--         and sets meal_id on exactly those ids (replacing the
--         created_at=now() UPDATE).
--
-- NULL-FALLBACK DECISION (H-10 backfill):
--   Existing completed meal-prep entries predating this migration have
--   meal_product_id = NULL. We choose a *best-effort legacy name-match*
--   fallback (the exact old behaviour) ONLY when meal_product_id IS NULL,
--   rather than a hard no-op, because:
--     (a) For a backfill entry there was at most ONE [MEAL] product per
--         (recipe/product, logical_date) at the time it was marked under
--         the old code OR — in the degenerate same-date collision — the
--         old code was *already* going to mis-target; the name-match
--         reproduces the prior (imperfect) behaviour without regressing it
--         and without crashing.
--     (b) A no-op would strand the [MEAL] product/lot as permanent ghost
--         inventory on every legacy undo — strictly worse for the common
--         single-meal case, which the name-match cleans up correctly.
--   New entries (meal_product_id IS NOT NULL) NEVER take the name-match
--   path, so the H-10 wrong-deletion is eliminated going forward.
--
-- STRUCTURAL ENABLER (no UNIQUE on products.name): intentionally NOT added.
--   [MEAL] products legitimately collide by design — generate_meal_product_name
--   disambiguates with a time suffix precisely because two same-recipe preps
--   on one date are valid. A UNIQUE(user_id, name) would reject the 2nd
--   legitimate prep outright (and break the time-suffix helper's own Layer-3
--   fallback). The id-based identity fix removes the *correctness* dependence
--   on name uniqueness, which is the right resolution; a name UNIQUE would be
--   an incorrect over-constraint. (See report.)

BEGIN;

------------------------------------------------------------
-- 0. Schema: persist the [MEAL] product id on the meal entry.
------------------------------------------------------------
ALTER TABLE chefbyte.meal_plan_entries
  ADD COLUMN IF NOT EXISTS meal_product_id UUID
    REFERENCES chefbyte.products(product_id) ON DELETE SET NULL;

COMMENT ON COLUMN chefbyte.meal_plan_entries.meal_product_id IS
  'The [MEAL] product created by mark_meal_done for this meal-prep entry. '
  'unmark_meal_done deletes BY this id (H-10 fix, theme T8). NULL for '
  'non-prep entries and for meal-prep entries completed before migration '
  '20260515100000 (those fall back to legacy bare-name matching on unmark). '
  'ON DELETE SET NULL so the product hard-delete during unmark auto-clears it.';

------------------------------------------------------------
-- 1. private.consume_product — surface the inserted food_log_id.
------------------------------------------------------------
-- Identical to the 20260515010000 version EXCEPT:
--   * the food_logs INSERT uses RETURNING log_id INTO v_food_log_id;
--   * the return JSONB gains 'food_log_id' (NULL when p_log_macros=false).
-- Purely additive to the contract.

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
  v_food_log_id UUID;

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

  -- FEFO depletion. A fully-drained lot is soft-deleted (qty=0,
  -- deleted_at=now()) so the Pi's lot_snapshot_poller picks the tombstone
  -- up via the updated_at bump from the stock_lots_set_updated_at trigger.
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
    )
    RETURNING log_id INTO v_food_log_id;
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
    'food_log_id', v_food_log_id,
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

COMMENT ON FUNCTION private.consume_product(UUID, UUID, NUMERIC, TEXT, BOOLEAN, DATE, BOOLEAN) IS
  'FEFO consume + macro log. Returns success, qty_consumed, food_log_id '
  '(the inserted chefbyte.food_logs.log_id, or NULL when p_log_macros=false), '
  'macros, stock_remaining. Soft-deletes fully-drained lots (Gap G1). '
  'food_log_id added by 20260515100000 so callers (mark_meal_done) can tag '
  'exactly the rows they created instead of WHERE created_at=now() (H-14).';

------------------------------------------------------------
-- 2. private.mark_meal_done — persist meal_product_id (H-10) + tag
--    food_logs by captured id (H-14).
------------------------------------------------------------
-- Based on the 20260430020000 (zero-shorts) version. Deltas:
--   * Capture v_consume_result->>'food_log_id' into v_new_log_ids after
--     every consume_product call (both branches).
--   * After creating each [MEAL] product, store its id on the entry via
--     v_meal_product_id (UPDATE meal_plan_entries.meal_product_id).
--   * Replace the `UPDATE food_logs ... WHERE created_at = now()` tag with
--     a tag on exactly the captured ids.

CREATE OR REPLACE FUNCTION private.mark_meal_done(
  p_user_id UUID,
  p_meal_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_meal         RECORD;
  v_recipe       RECORD;
  v_ingredient   RECORD;
  v_consume_result JSONB;
  v_logical_date DATE;
  v_meal_product_id   UUID;
  v_meal_product_name TEXT;
  v_total_cal    NUMERIC(10,3) := 0;
  v_total_carbs  NUMERIC(10,3) := 0;
  v_total_protein NUMERIC(10,3) := 0;
  v_total_fat    NUMERIC(10,3) := 0;
  v_location_id  UUID;
  v_completed_at TIMESTAMPTZ;
  v_scale_factor NUMERIC(10,3);
  v_stock_available   NUMERIC(10,3);
  v_needed_containers NUMERIC(10,3);
  v_actual_containers NUMERIC(10,3);
  v_mode         TEXT;
  v_deducted     JSONB := '[]'::jsonb;
  v_partials     JSONB := '[]'::jsonb;
  v_food_log_ids JSONB := '[]'::jsonb;
  v_new_log_ids  UUID[] := ARRAY[]::uuid[];
  v_one_log_id   UUID;
  v_product      RECORD;
  v_net_weight_g NUMERIC(10,3);
BEGIN
  -- ------------------------------------------------------------------
  -- Lock + validate the meal_plan_entry row.
  -- ------------------------------------------------------------------
  SELECT * INTO v_meal
  FROM chefbyte.meal_plan_entries
  WHERE meal_id = p_meal_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meal not found or not owned by user';
  END IF;

  IF v_meal.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Meal already completed';
  END IF;

  v_logical_date := v_meal.logical_date;

  -- ------------------------------------------------------------------
  -- Branch 1: Recipe-based meal
  -- ------------------------------------------------------------------
  IF v_meal.recipe_id IS NOT NULL THEN
    SELECT * INTO v_recipe
    FROM chefbyte.recipes
    WHERE recipe_id = v_meal.recipe_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Recipe not found or not owned by user';
    END IF;

    v_scale_factor := v_meal.servings / GREATEST(v_recipe.base_servings, 0.001);
    v_mode := CASE WHEN v_meal.meal_prep THEN 'meal_prep' ELSE 'recipe' END;

    FOR v_ingredient IN
      SELECT ri.product_id, ri.quantity, ri.unit, p.name AS product_name,
             COALESCE(p.servings_per_container, 1) AS spc,
             p.net_weight_g
      FROM chefbyte.recipe_ingredients ri
      JOIN chefbyte.products p ON p.product_id = ri.product_id
      WHERE ri.recipe_id = v_meal.recipe_id AND ri.user_id = p_user_id
    LOOP
      -- Compute needed in containers.
      IF v_ingredient.unit = 'serving' THEN
        v_needed_containers := (v_ingredient.quantity * v_scale_factor)
                               / GREATEST(v_ingredient.spc, 0.001);
      ELSIF v_ingredient.unit = 'gram' THEN
        IF v_ingredient.net_weight_g IS NULL OR v_ingredient.net_weight_g <= 0 THEN
          RAISE EXCEPTION 'product missing net_weight_g for ingredient %',
            v_ingredient.product_name;
        END IF;
        v_needed_containers := (v_ingredient.quantity * v_scale_factor)
                               / v_ingredient.net_weight_g;
      ELSE
        -- 'container'
        v_needed_containers := v_ingredient.quantity * v_scale_factor;
      END IF;

      -- How much is actually available?
      SELECT COALESCE(SUM(qty_containers), 0) INTO v_stock_available
      FROM chefbyte.stock_lots
      WHERE user_id = p_user_id AND product_id = v_ingredient.product_id;

      -- Zero-shorts: take what is available, log a partial if short.
      v_actual_containers := LEAST(v_needed_containers, v_stock_available);

      IF v_stock_available < v_needed_containers THEN
        v_partials := v_partials || jsonb_build_object(
          'product_id', v_ingredient.product_id,
          'needed',     v_needed_containers,
          'available',  v_stock_available
        );
      END IF;

      -- Only consume if there is anything to take.
      IF v_actual_containers > 0 THEN
        v_consume_result := private.consume_product(
          p_user_id,
          v_ingredient.product_id,
          v_actual_containers,
          'container',
          NOT v_meal.meal_prep,
          v_logical_date,
          TRUE
        );

        -- H-14: capture THIS consume's food_log_id (non-prep meals log
        -- macros; meal_prep passes p_log_macros=false so food_log_id is
        -- NULL and nothing is collected).
        v_one_log_id := (v_consume_result->>'food_log_id')::uuid;
        IF v_one_log_id IS NOT NULL THEN
          v_new_log_ids := array_append(v_new_log_ids, v_one_log_id);
        END IF;
      ELSE
        -- Nothing in stock: skip consume, macros stay 0 for this ingredient.
        v_consume_result := jsonb_build_object(
          'success', true,
          'qty_consumed', 0,
          'macros', jsonb_build_object('calories',0,'carbs',0,'protein',0,'fat',0),
          'stock_remaining', 0
        );
      END IF;

      v_deducted := v_deducted || jsonb_build_object(
        'product_id', v_ingredient.product_id,
        'qty',        v_actual_containers,
        'unit',       'container'
      );

      IF v_meal.meal_prep THEN
        v_total_cal     := v_total_cal     + COALESCE((v_consume_result->'macros'->>'calories')::numeric, 0);
        v_total_carbs   := v_total_carbs   + COALESCE((v_consume_result->'macros'->>'carbs')::numeric, 0);
        v_total_protein := v_total_protein + COALESCE((v_consume_result->'macros'->>'protein')::numeric, 0);
        v_total_fat     := v_total_fat     + COALESCE((v_consume_result->'macros'->>'fat')::numeric, 0);
      END IF;
    END LOOP;

    IF v_meal.meal_prep THEN
      v_meal_product_name := private.generate_meal_product_name(
        p_user_id, v_recipe.name, v_logical_date
      );

      INSERT INTO chefbyte.products (
        user_id, name,
        servings_per_container,
        calories_per_serving,
        carbs_per_serving,
        protein_per_serving,
        fat_per_serving,
        is_placeholder,
        is_distinct_unit_item,
        default_recipe_unit
      ) VALUES (
        p_user_id,
        v_meal_product_name,
        v_meal.servings,
        v_total_cal     / GREATEST(v_meal.servings, 0.001),
        v_total_carbs   / GREATEST(v_meal.servings, 0.001),
        v_total_protein / GREATEST(v_meal.servings, 0.001),
        v_total_fat     / GREATEST(v_meal.servings, 0.001),
        false,
        true,
        'serving'
      )
      RETURNING product_id INTO v_meal_product_id;

      SELECT location_id INTO v_location_id
      FROM chefbyte.locations
      WHERE user_id = p_user_id
      ORDER BY created_at ASC
      LIMIT 1;

      IF v_location_id IS NULL THEN
        RAISE EXCEPTION 'No storage locations found for user';
      END IF;

      INSERT INTO chefbyte.stock_lots (
        user_id, product_id, location_id,
        qty_containers, expires_on
      ) VALUES (
        p_user_id, v_meal_product_id, v_location_id,
        1, v_logical_date + 7
      )
      ON CONFLICT (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31'::date))
      DO UPDATE SET qty_containers = chefbyte.stock_lots.qty_containers + 1;
    END IF;

  -- ------------------------------------------------------------------
  -- Branch 2: Product-based meal (no recipe)
  -- ------------------------------------------------------------------
  ELSIF v_meal.product_id IS NOT NULL THEN
    v_mode := CASE WHEN v_meal.meal_prep THEN 'meal_prep' ELSE 'product' END;

    SELECT * INTO v_product
    FROM chefbyte.products
    WHERE product_id = v_meal.product_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or not owned by user';
    END IF;

    -- Needed in containers (meal.servings is in servings).
    v_needed_containers := v_meal.servings
                           / GREATEST(COALESCE(v_product.servings_per_container, 1), 0.001);

    SELECT COALESCE(SUM(qty_containers), 0) INTO v_stock_available
    FROM chefbyte.stock_lots
    WHERE user_id = p_user_id AND product_id = v_meal.product_id;

    -- Zero-shorts.
    v_actual_containers := LEAST(v_needed_containers, v_stock_available);

    IF v_stock_available < v_needed_containers THEN
      v_partials := v_partials || jsonb_build_object(
        'product_id', v_meal.product_id,
        'needed',     v_needed_containers,
        'available',  v_stock_available
      );
    END IF;

    IF v_actual_containers > 0 THEN
      v_consume_result := private.consume_product(
        p_user_id,
        v_meal.product_id,
        v_actual_containers,
        'container',
        NOT v_meal.meal_prep,
        v_logical_date,
        TRUE
      );

      -- H-14: capture THIS consume's food_log_id.
      v_one_log_id := (v_consume_result->>'food_log_id')::uuid;
      IF v_one_log_id IS NOT NULL THEN
        v_new_log_ids := array_append(v_new_log_ids, v_one_log_id);
      END IF;
    ELSE
      v_consume_result := jsonb_build_object(
        'success', true,
        'qty_consumed', 0,
        'macros', jsonb_build_object('calories',0,'carbs',0,'protein',0,'fat',0),
        'stock_remaining', 0
      );
    END IF;

    v_deducted := v_deducted || jsonb_build_object(
      'product_id', v_meal.product_id,
      'qty',        v_actual_containers,
      'unit',       'container'
    );

    IF v_meal.meal_prep THEN
      v_meal_product_name := private.generate_meal_product_name(
        p_user_id, v_product.name, v_logical_date
      );

      v_total_cal     := COALESCE((v_consume_result->'macros'->>'calories')::numeric, 0);
      v_total_carbs   := COALESCE((v_consume_result->'macros'->>'carbs')::numeric, 0);
      v_total_protein := COALESCE((v_consume_result->'macros'->>'protein')::numeric, 0);
      v_total_fat     := COALESCE((v_consume_result->'macros'->>'fat')::numeric, 0);

      INSERT INTO chefbyte.products (
        user_id, name,
        servings_per_container,
        calories_per_serving,
        carbs_per_serving,
        protein_per_serving,
        fat_per_serving,
        is_placeholder,
        is_distinct_unit_item,
        default_recipe_unit
      ) VALUES (
        p_user_id,
        v_meal_product_name,
        v_meal.servings,
        v_total_cal     / GREATEST(v_meal.servings, 0.001),
        v_total_carbs   / GREATEST(v_meal.servings, 0.001),
        v_total_protein / GREATEST(v_meal.servings, 0.001),
        v_total_fat     / GREATEST(v_meal.servings, 0.001),
        false,
        true,
        'serving'
      )
      RETURNING product_id INTO v_meal_product_id;

      SELECT location_id INTO v_location_id
      FROM chefbyte.locations
      WHERE user_id = p_user_id
      ORDER BY created_at ASC
      LIMIT 1;

      IF v_location_id IS NULL THEN
        RAISE EXCEPTION 'No storage locations found for user';
      END IF;

      INSERT INTO chefbyte.stock_lots (
        user_id, product_id, location_id,
        qty_containers, expires_on
      ) VALUES (
        p_user_id, v_meal_product_id, v_location_id,
        1, v_logical_date + 7
      )
      ON CONFLICT (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31'::date))
      DO UPDATE SET qty_containers = chefbyte.stock_lots.qty_containers + 1;
    END IF;
  END IF;

  -- ------------------------------------------------------------------
  -- Mark meal completed.
  -- ------------------------------------------------------------------
  v_completed_at := now();
  UPDATE chefbyte.meal_plan_entries
  SET completed_at    = v_completed_at,
      meal_product_id = v_meal_product_id   -- H-10: NULL for non-prep meals
  WHERE meal_id = p_meal_id;

  -- ------------------------------------------------------------------
  -- H-14: tag exactly the food_logs this call created (by captured id),
  -- NOT by `created_at = now()` (which would sweep in any unrelated
  -- same-transaction insert).
  -- ------------------------------------------------------------------
  IF array_length(v_new_log_ids, 1) IS NOT NULL THEN
    UPDATE chefbyte.food_logs
    SET meal_id = p_meal_id
    WHERE user_id = p_user_id
      AND log_id = ANY(v_new_log_ids);

    v_food_log_ids := to_jsonb(v_new_log_ids);
  END IF;

  RETURN jsonb_build_object(
    'success',      true,
    'meal_id',      p_meal_id,
    'mode',         v_mode,
    'deducted',     v_deducted,
    'partials',     v_partials,
    'food_log_ids', v_food_log_ids,
    'completed_at', v_completed_at
  );
END;
$$;

------------------------------------------------------------
-- 3. private.unmark_meal_done — delete the [MEAL] product BY stored id
--    (H-10); legacy name-match only as the NULL-backfill fallback.
------------------------------------------------------------
-- Based on the 20260515010000 version (soft-delete lots + bypass-GUC
-- cascade hard-delete). Delta: the [MEAL] cleanup now targets
-- v_meal.meal_product_id by id; the bare-name reconstruction is kept
-- ONLY as the fallback when meal_product_id IS NULL (pre-migration rows).

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

  -- Restore ingredient stock from the meal's own food_logs (unchanged).
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
    -- ----------------------------------------------------------------
    -- H-10: delete the [MEAL] product BY the id stored at mark time.
    -- ----------------------------------------------------------------
    IF v_meal.meal_product_id IS NOT NULL THEN
      -- Step 1: soft-delete this product's stock_lots so the Pi sees the
      -- tombstone via updated_at on the next poll.
      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             deleted_at         = now(),
             last_update_source = 'manual_consume',
             last_update_ts     = now()
       WHERE user_id    = p_user_id
         AND product_id = v_meal.meal_product_id
         AND deleted_at IS NULL;

      -- Step 2: hard-delete the [MEAL] product BY id. The FK ON DELETE
      -- CASCADE on stock_lots.product_id needs the per-tx bypass so the
      -- (already tombstoned) lots can be removed without violating the
      -- NOT NULL FK. The FK ON DELETE SET NULL on
      -- meal_plan_entries.meal_product_id auto-clears our own pointer.
      SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on';

      DELETE FROM chefbyte.products
      WHERE product_id = v_meal.meal_product_id
        AND user_id = p_user_id;

      SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'off';

      v_deleted_meal_product := true;

    ELSE
      -- ----------------------------------------------------------------
      -- NULL-backfill fallback (pre-20260515100000 entries only):
      -- best-effort legacy bare-name match. New entries never reach here.
      -- ----------------------------------------------------------------
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

          SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on';

          DELETE FROM chefbyte.products
          WHERE user_id = p_user_id AND name = v_expected_prefix;

          SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'off';

          v_deleted_meal_product := true;
        END IF;
      END;
    END IF;
  END IF;

  -- Clear the pointer + completed_at. (If the product was hard-deleted by
  -- id the FK ON DELETE SET NULL already nulled meal_product_id; setting it
  -- again is harmless and also covers the fallback/no-product paths.)
  UPDATE chefbyte.meal_plan_entries
  SET completed_at    = NULL,
      meal_product_id = NULL
  WHERE meal_id = p_meal_id;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_logs', v_deleted_logs,
    'restored_stock', v_restored_stock,
    'deleted_meal_product', v_deleted_meal_product
  );
END;
$$;

COMMIT;
