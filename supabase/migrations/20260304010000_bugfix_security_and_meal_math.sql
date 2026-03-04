-- Bugfix migration: security privilege escalation + meal consumption math
--
-- Fixes:
-- 1. REVOKE EXECUTE FROM PUBLIC on all admin wrappers (cross-user data manipulation)
-- 2. REVOKE EXECUTE FROM PUBLIC on all schema-level SECURITY DEFINER functions
-- 3. Fix mark_meal_done: product-based meals pass 'serving' instead of 'container'
-- 4. Fix mark_meal_done: recipe ingredients scale by servings/base_servings
-- 5. Add CHECK constraints for non-negative quantities
-- 6. Fix get_logical_date volatility: IMMUTABLE -> STABLE

------------------------------------------------------------
-- 1. REVOKE admin wrapper access from PUBLIC (CRITICAL)
------------------------------------------------------------
-- By default, PostgreSQL grants EXECUTE to PUBLIC. The explicit
-- GRANT TO service_role does NOT revoke from PUBLIC. Any authenticated
-- user could call these with arbitrary user_id params.

REVOKE EXECUTE ON FUNCTION coachbyte.ensure_daily_plan_admin(UUID, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION coachbyte.complete_next_set_admin(UUID, UUID, INTEGER, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.consume_product_admin(UUID, UUID, NUMERIC, TEXT, BOOLEAN, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.mark_meal_done_admin(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.get_daily_macros_admin(UUID, DATE) FROM PUBLIC;

-- Also revoke from encrypted credentials admin wrapper
REVOKE EXECUTE ON FUNCTION hub.get_extension_credentials_admin(UUID, TEXT) FROM PUBLIC;

------------------------------------------------------------
-- 2. REVOKE anon access from SECURITY DEFINER RPC wrappers
------------------------------------------------------------
-- anon has USAGE on these schemas but should not call functions.
-- auth.uid() returns NULL for anon, so calls fail silently or error,
-- but we should block at the permission level for defense-in-depth.

-- Hub functions
REVOKE EXECUTE ON FUNCTION hub.activate_app(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION hub.deactivate_app(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION hub.save_extension_credentials(TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION hub.get_extension_credentials(TEXT) FROM anon;

-- CoachByte functions
REVOKE EXECUTE ON FUNCTION coachbyte.ensure_daily_plan(DATE) FROM anon;
REVOKE EXECUTE ON FUNCTION coachbyte.complete_next_set(UUID, INTEGER, NUMERIC) FROM anon;

-- ChefByte functions
REVOKE EXECUTE ON FUNCTION chefbyte.consume_product(UUID, NUMERIC, TEXT, BOOLEAN, DATE) FROM anon;
REVOKE EXECUTE ON FUNCTION chefbyte.mark_meal_done(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION chefbyte.get_daily_macros(DATE) FROM anon;

------------------------------------------------------------
-- 3. Fix get_logical_date volatility (IMMUTABLE -> STABLE)
------------------------------------------------------------
-- Timezone conversion depends on mutable tzdata database.
-- IMMUTABLE allows aggressive caching that can produce wrong results
-- after a tzdata update.

CREATE OR REPLACE FUNCTION private.get_logical_date(
  ts TIMESTAMPTZ,
  tz TEXT,
  day_start_hour INTEGER
)
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (
    (ts AT TIME ZONE tz) - (day_start_hour || ' hours')::interval
  )::date;
$$;

------------------------------------------------------------
-- 4. Fix mark_meal_done: product-based meals + recipe scaling
------------------------------------------------------------
-- Bug A: Product-based meals passed 'container' as unit but servings
--         count as qty. Should pass 'serving'.
-- Bug B: Recipe ingredients scaled by meal.servings directly instead
--         of (meal.servings / recipe.base_servings).

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
  v_meal RECORD;
  v_recipe RECORD;
  v_ingredient RECORD;
  v_consume_result JSONB;
  v_logical_date DATE;
  v_meal_product_id UUID;
  v_meal_product_name TEXT;
  v_total_cal NUMERIC(10,3) := 0;
  v_total_carbs NUMERIC(10,3) := 0;
  v_total_protein NUMERIC(10,3) := 0;
  v_total_fat NUMERIC(10,3) := 0;
  v_location_id UUID;
  v_completed_at TIMESTAMPTZ;
  v_scale_factor NUMERIC(10,3);
BEGIN
  -- Fetch meal entry and verify ownership
  SELECT * INTO v_meal
  FROM chefbyte.meal_plan_entries
  WHERE meal_id = p_meal_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meal not found or not owned by user';
  END IF;

  -- Check if already completed
  IF v_meal.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Meal already completed'
    );
  END IF;

  -- Use the meal's logical_date directly (it's stored on the entry)
  v_logical_date := v_meal.logical_date;

  -- Recipe-based meal
  IF v_meal.recipe_id IS NOT NULL THEN
    -- Fetch recipe for name and base_servings
    SELECT * INTO v_recipe
    FROM chefbyte.recipes
    WHERE recipe_id = v_meal.recipe_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Recipe not found or not owned by user';
    END IF;

    -- FIX: Scale factor = meal.servings / recipe.base_servings
    -- e.g., recipe defines ingredients for 4 servings, meal wants 2 → scale 0.5
    v_scale_factor := v_meal.servings / GREATEST(v_recipe.base_servings, 0.001);

    -- Process each ingredient
    FOR v_ingredient IN
      SELECT ri.product_id, ri.quantity, ri.unit
      FROM chefbyte.recipe_ingredients ri
      WHERE ri.recipe_id = v_meal.recipe_id AND ri.user_id = p_user_id
    LOOP
      -- FIX: Use scale_factor instead of raw servings
      v_consume_result := private.consume_product(
        p_user_id,
        v_ingredient.product_id,
        v_ingredient.quantity * v_scale_factor,
        v_ingredient.unit,
        NOT v_meal.meal_prep,
        v_logical_date
      );

      -- Accumulate total macros for meal-prep product creation
      IF v_meal.meal_prep THEN
        v_total_cal := v_total_cal + COALESCE((v_consume_result->'macros'->>'calories')::numeric, 0);
        v_total_carbs := v_total_carbs + COALESCE((v_consume_result->'macros'->>'carbs')::numeric, 0);
        v_total_protein := v_total_protein + COALESCE((v_consume_result->'macros'->>'protein')::numeric, 0);
        v_total_fat := v_total_fat + COALESCE((v_consume_result->'macros'->>'fat')::numeric, 0);
      END IF;
    END LOOP;

    -- Meal prep: create [MEAL] product + stock lot
    IF v_meal.meal_prep THEN
      v_meal_product_name := '[MEAL] ' || v_recipe.name || ' ' || to_char(v_logical_date, 'MM-DD');

      INSERT INTO chefbyte.products (
        user_id, name,
        servings_per_container,
        calories_per_serving,
        carbs_per_serving,
        protein_per_serving,
        fat_per_serving,
        is_placeholder
      ) VALUES (
        p_user_id,
        v_meal_product_name,
        v_meal.servings,
        v_total_cal / GREATEST(v_meal.servings, 0.001),
        v_total_carbs / GREATEST(v_meal.servings, 0.001),
        v_total_protein / GREATEST(v_meal.servings, 0.001),
        v_total_fat / GREATEST(v_meal.servings, 0.001),
        false
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

  -- Product-based meal (no recipe)
  ELSIF v_meal.product_id IS NOT NULL THEN
    -- FIX: Pass 'serving' as unit (v_meal.servings is a serving count, not containers)
    v_consume_result := private.consume_product(
      p_user_id,
      v_meal.product_id,
      v_meal.servings,
      'serving',
      NOT v_meal.meal_prep,
      v_logical_date
    );

    -- If product-based meal prep, create [MEAL] product + lot
    IF v_meal.meal_prep THEN
      DECLARE
        v_source_product RECORD;
      BEGIN
        SELECT * INTO v_source_product
        FROM chefbyte.products
        WHERE product_id = v_meal.product_id AND user_id = p_user_id;

        v_meal_product_name := '[MEAL] ' || v_source_product.name || ' ' || to_char(v_logical_date, 'MM-DD');

        v_total_cal := COALESCE((v_consume_result->'macros'->>'calories')::numeric, 0);
        v_total_carbs := COALESCE((v_consume_result->'macros'->>'carbs')::numeric, 0);
        v_total_protein := COALESCE((v_consume_result->'macros'->>'protein')::numeric, 0);
        v_total_fat := COALESCE((v_consume_result->'macros'->>'fat')::numeric, 0);

        INSERT INTO chefbyte.products (
          user_id, name,
          servings_per_container,
          calories_per_serving,
          carbs_per_serving,
          protein_per_serving,
          fat_per_serving,
          is_placeholder
        ) VALUES (
          p_user_id,
          v_meal_product_name,
          v_meal.servings,
          v_total_cal / GREATEST(v_meal.servings, 0.001),
          v_total_carbs / GREATEST(v_meal.servings, 0.001),
          v_total_protein / GREATEST(v_meal.servings, 0.001),
          v_total_fat / GREATEST(v_meal.servings, 0.001),
          false
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
      END;
    END IF;
  END IF;

  -- Mark meal as completed
  v_completed_at := now();
  UPDATE chefbyte.meal_plan_entries
  SET completed_at = v_completed_at
  WHERE meal_id = p_meal_id;

  RETURN jsonb_build_object(
    'success', true,
    'completed_at', v_completed_at
  );
END;
$$;

------------------------------------------------------------
-- 5. CHECK constraints for non-negative quantities
------------------------------------------------------------
-- Prevents negative consumption, negative stock, and
-- negative quantities being passed to functions.

ALTER TABLE chefbyte.stock_lots
  ADD CONSTRAINT stock_lots_qty_nonneg CHECK (qty_containers >= 0);

ALTER TABLE chefbyte.food_logs
  ADD CONSTRAINT food_logs_qty_nonneg CHECK (qty_consumed >= 0);

ALTER TABLE chefbyte.recipe_ingredients
  ADD CONSTRAINT recipe_ingredients_qty_pos CHECK (quantity > 0);

ALTER TABLE chefbyte.shopping_list
  ADD CONSTRAINT shopping_list_qty_pos CHECK (qty_containers > 0);

ALTER TABLE chefbyte.recipes
  ADD CONSTRAINT recipes_base_servings_pos CHECK (base_servings > 0);

ALTER TABLE chefbyte.meal_plan_entries
  ADD CONSTRAINT meal_plan_servings_pos CHECK (servings > 0);

------------------------------------------------------------
-- 6. Add PRIMARY KEY to app_activations for Realtime support
------------------------------------------------------------
-- Supabase Realtime requires a PK for row-level change tracking.

ALTER TABLE hub.app_activations
  ADD COLUMN activation_id UUID DEFAULT gen_random_uuid();

ALTER TABLE hub.app_activations
  ADD PRIMARY KEY (activation_id);

------------------------------------------------------------
-- 7. Fix pgcrypto search_path in encryption functions
------------------------------------------------------------
-- The encryption functions use SET search_path = '' for security,
-- but pgcrypto is installed in the 'extensions' schema. Must
-- qualify pgp_sym_encrypt/decrypt with extensions. prefix.

CREATE OR REPLACE FUNCTION private.save_extension_credentials(
  p_user_id UUID,
  p_extension_name TEXT,
  p_credentials_json TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key TEXT;
BEGIN
  v_key := current_setting('app.settings.encryption_key');

  INSERT INTO hub.extension_settings (user_id, extension_name, credentials_encrypted, enabled)
  VALUES (
    p_user_id,
    p_extension_name,
    extensions.pgp_sym_encrypt(p_credentials_json, v_key),
    false
  )
  ON CONFLICT (user_id, extension_name)
  DO UPDATE SET credentials_encrypted = extensions.pgp_sym_encrypt(p_credentials_json, v_key);
END;
$$;

CREATE OR REPLACE FUNCTION private.get_extension_credentials(
  p_user_id UUID,
  p_extension_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key TEXT;
  v_encrypted TEXT;
BEGIN
  v_key := current_setting('app.settings.encryption_key');

  SELECT credentials_encrypted INTO v_encrypted
  FROM hub.extension_settings
  WHERE user_id = p_user_id
    AND extension_name = p_extension_name;

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN extensions.pgp_sym_decrypt(v_encrypted::bytea, v_key);
END;
$$;
