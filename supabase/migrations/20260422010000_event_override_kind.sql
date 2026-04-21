-- Event Viewer: independent stock/macros + event-kind override.
--
-- Lets a user retroactively flip a Pi-emitted event between consumed /
-- depleted / added / refilled at the cloud layer without touching the
-- immutable Pi-side log. The reconciler computes an EFFECTIVE kind via
-- COALESCE(override, pi-original) and reverses the stock direction +
-- macro side-effect accordingly.
--
-- Sign convention (mirrors apply_shelf_event):
--   consumed / depleted → stock DECREMENT (delta_c applied as-is; Pi
--     sends negative grams so delta_c is negative), food_logs row for
--     the servings consumed.
--   added / refilled    → stock INCREMENT (Pi sends positive grams so
--     delta_c is positive), NO food_logs row.
--
-- When the effective kind flips direction, the reconciler must undo the
-- opposite-direction side-effect before applying the new one.

------------------------------------------------------------
-- 1. event_overrides.event_kind_override
------------------------------------------------------------

ALTER TABLE chefbyte.event_overrides
  ADD COLUMN IF NOT EXISTS event_kind_override TEXT NULL;

-- Constrain to the same set apply_shelf_event accepts, plus NULL = inherit.
ALTER TABLE chefbyte.event_overrides
  DROP CONSTRAINT IF EXISTS event_overrides_event_kind_override_chk;
ALTER TABLE chefbyte.event_overrides
  ADD CONSTRAINT event_overrides_event_kind_override_chk
  CHECK (
    event_kind_override IS NULL
    OR event_kind_override IN ('consumed','depleted','added','refilled')
  );

------------------------------------------------------------
-- 2. private.apply_event_override — accept p_event_kind + reconcile
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.apply_event_override(
  p_client_event_id          TEXT,
  p_stock_qty_override       NUMERIC DEFAULT NULL,
  p_macros_servings_override NUMERIC DEFAULT NULL,
  p_calories_override        NUMERIC DEFAULT NULL,
  p_protein_override         NUMERIC DEFAULT NULL,
  p_carbs_override           NUMERIC DEFAULT NULL,
  p_fat_override             NUMERIC DEFAULT NULL,
  p_macro_logging_enabled    BOOLEAN DEFAULT TRUE,
  p_is_voided                BOOLEAN DEFAULT FALSE,
  p_event_kind               TEXT    DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id         UUID := (select auth.uid());
  v_override_id     UUID;
  v_prior           chefbyte.event_overrides%ROWTYPE;
  v_prior_found     BOOLEAN := FALSE;
  v_event_id        UUID;
  v_payload         JSONB;
  v_resolved_lot    UUID;
  v_applied         BOOLEAN;
  v_orig_product    UUID;
  v_orig_delta_g    NUMERIC;
  v_orig_kind       TEXT;        -- source kind (live_shelf/live_scale/…)
  v_orig_ek         TEXT;        -- pi-original event_kind
  v_orig_occurred   TIMESTAMPTZ;
  v_net_g           NUMERIC;
  v_svg_per         NUMERIC;
  v_cal             NUMERIC;
  v_carbs           NUMERIC;
  v_protein         NUMERIC;
  v_fat             NUMERIC;
  v_tz              TEXT;
  v_dsh             INTEGER;
  v_logical_date    DATE;
  -- Prior-effect (what's already in cloud state before this call).
  v_prior_ek        TEXT;
  v_prior_delta_c   NUMERIC;
  -- New effect.
  v_new_ek          TEXT;
  v_new_delta_c     NUMERIC;
  v_new_servings    NUMERIC;
  v_new_cal         NUMERIC;
  v_new_carbs       NUMERIC;
  v_new_protein     NUMERIC;
  v_new_fat         NUMERIC;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required';
  END IF;

  -- Validate p_event_kind up-front (cheap; no DB reads needed).
  IF p_event_kind IS NOT NULL
     AND p_event_kind NOT IN ('consumed','depleted','added','refilled') THEN
    RAISE EXCEPTION 'invalid event_kind: %', p_event_kind USING ERRCODE = '22023';
  END IF;

  -- Locate the Pi event (ownership-scoped).
  SELECT event_id, payload, resolved_lot_id, applied
    INTO v_event_id, v_payload, v_resolved_lot, v_applied
    FROM chefbyte.shelf_event_log
   WHERE user_id = v_user_id AND client_event_id = p_client_event_id;

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'event not found: %', p_client_event_id;
  END IF;

  v_orig_product  := NULLIF(v_payload->>'product_id','')::UUID;
  v_orig_delta_g  := (v_payload->>'delta_g')::NUMERIC;
  v_orig_kind     := v_payload->>'kind';
  v_orig_ek       := v_payload->>'event_kind';
  v_orig_occurred := (v_payload->>'occurred_at')::TIMESTAMPTZ;

  IF v_orig_product IS NULL THEN
    RAISE EXCEPTION 'event has no product_id — cannot reconcile';
  END IF;

  SELECT net_weight_g, servings_per_container,
         calories_per_serving, carbs_per_serving,
         protein_per_serving, fat_per_serving
    INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
    FROM chefbyte.products
   WHERE product_id = v_orig_product AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product not found for event';
  END IF;
  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    RAISE EXCEPTION 'product missing net_weight_g';
  END IF;

  SELECT timezone, day_start_hour INTO v_tz, v_dsh
    FROM hub.profiles WHERE user_id = v_user_id;
  IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
  IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
  v_logical_date := private.get_logical_date(v_orig_occurred, v_tz, v_dsh);

  -- Prior override (drives back-out math).
  SELECT * INTO v_prior
    FROM chefbyte.event_overrides
   WHERE user_id = v_user_id AND client_event_id = p_client_event_id;
  v_prior_found := FOUND;

  -- ---- STEP 1: back out the previously-applied effect ----
  -- The prior effect is (a) the prior override (if it existed and was
  -- not voided) or (b) the Pi-original apply (first edit).

  IF v_prior_found THEN
    IF NOT v_prior.is_voided THEN
      -- Effective kind of the prior override.
      v_prior_ek := COALESCE(v_prior.event_kind_override, v_orig_ek);
      -- Signed container delta actually applied by the prior:
      --   consumed/depleted → negative abs(delta_c)  (stock decrement)
      --   added/refilled    → positive abs(delta_c)  (stock increment)
      v_prior_delta_c := COALESCE(
        v_prior.stock_qty_override,
        CASE
          WHEN v_prior_ek IN ('consumed','depleted')
            THEN -ABS(v_orig_delta_g / v_net_g)
          ELSE  ABS(v_orig_delta_g / v_net_g)
        END
      );

      IF v_resolved_lot IS NOT NULL AND v_prior_delta_c IS NOT NULL THEN
        UPDATE chefbyte.stock_lots
           SET qty_containers     = GREATEST(qty_containers - v_prior_delta_c, 0),
               last_update_source = 'manual',
               last_update_ts     = now()
         WHERE lot_id = v_resolved_lot AND user_id = v_user_id;
      END IF;

      DELETE FROM chefbyte.food_logs
       WHERE user_id = v_user_id
         AND source_client_event_id = p_client_event_id;
    END IF;
  ELSE
    -- First edit: back out Pi-original if it actually touched cloud state.
    IF v_applied AND v_resolved_lot IS NOT NULL THEN
      -- Pi always applies delta_g / net_g with its own sign (negative for
      -- consumed, positive for added — see apply_shelf_event).
      v_prior_delta_c := v_orig_delta_g / v_net_g;
      UPDATE chefbyte.stock_lots
         SET qty_containers     = GREATEST(qty_containers - v_prior_delta_c, 0),
             last_update_source = 'manual',
             last_update_ts     = now()
       WHERE lot_id = v_resolved_lot AND user_id = v_user_id;
    END IF;
    DELETE FROM chefbyte.food_logs
     WHERE user_id = v_user_id
       AND source_client_event_id = p_client_event_id;
  END IF;

  -- ---- STEP 2: UPSERT the override row ----
  INSERT INTO chefbyte.event_overrides (
    user_id, client_event_id,
    stock_qty_override, macros_servings_override,
    calories_override, protein_override, carbs_override, fat_override,
    macro_logging_enabled, is_voided, event_kind_override, updated_at
  ) VALUES (
    v_user_id, p_client_event_id,
    p_stock_qty_override, p_macros_servings_override,
    p_calories_override, p_protein_override, p_carbs_override, p_fat_override,
    COALESCE(p_macro_logging_enabled, TRUE),
    COALESCE(p_is_voided, FALSE),
    p_event_kind,
    now()
  )
  ON CONFLICT (user_id, client_event_id) DO UPDATE SET
    stock_qty_override       = EXCLUDED.stock_qty_override,
    macros_servings_override = EXCLUDED.macros_servings_override,
    calories_override        = EXCLUDED.calories_override,
    protein_override         = EXCLUDED.protein_override,
    carbs_override           = EXCLUDED.carbs_override,
    fat_override             = EXCLUDED.fat_override,
    macro_logging_enabled    = EXCLUDED.macro_logging_enabled,
    is_voided                = EXCLUDED.is_voided,
    event_kind_override      = EXCLUDED.event_kind_override,
    updated_at               = now()
  RETURNING override_id INTO v_override_id;

  -- ---- STEP 3: if voided, stop (everything already backed out) ----
  IF COALESCE(p_is_voided, FALSE) THEN
    RETURN v_override_id;
  END IF;

  -- ---- STEP 4: compute effective new kind + re-apply stock ----
  v_new_ek := COALESCE(p_event_kind, v_orig_ek);

  -- Signed container delta for the new effect. Override wins if given;
  -- otherwise derive from the original grams-magnitude but with the sign
  -- dictated by the effective kind.
  v_new_delta_c := COALESCE(
    p_stock_qty_override,
    CASE
      WHEN v_new_ek IN ('consumed','depleted')
        THEN -ABS(v_orig_delta_g / v_net_g)
      ELSE  ABS(v_orig_delta_g / v_net_g)
    END
  );

  IF v_resolved_lot IS NOT NULL AND v_new_delta_c IS NOT NULL THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(qty_containers + v_new_delta_c, 0),
           last_update_source = 'manual',
           last_update_ts     = now()
     WHERE lot_id = v_resolved_lot AND user_id = v_user_id;
  END IF;

  -- ---- STEP 5: re-insert food_logs IF macro logging on AND consumption kind ----
  IF COALESCE(p_macro_logging_enabled, TRUE)
     AND v_new_ek IN ('consumed','depleted') THEN
    v_new_servings := COALESCE(
      p_macros_servings_override,
      ABS(v_new_delta_c) * COALESCE(v_svg_per, 0)
    );
    IF v_new_servings > 0 THEN
      v_new_cal     := COALESCE(p_calories_override, v_new_servings * COALESCE(v_cal,     0));
      v_new_carbs   := COALESCE(p_carbs_override,    v_new_servings * COALESCE(v_carbs,   0));
      v_new_protein := COALESCE(p_protein_override,  v_new_servings * COALESCE(v_protein, 0));
      v_new_fat     := COALESCE(p_fat_override,      v_new_servings * COALESCE(v_fat,     0));

      INSERT INTO chefbyte.food_logs
        (user_id, product_id, logical_date, qty_consumed, unit,
         calories, carbs, protein, fat, source_client_event_id)
      VALUES
        (v_user_id, v_orig_product, v_logical_date, v_new_servings, 'serving',
         v_new_cal, v_new_carbs, v_new_protein, v_new_fat, p_client_event_id);
    END IF;
  END IF;

  RETURN v_override_id;
END;
$$;

-- Old 9-arg signature still exists from the prior migration. Drop so
-- callers can't accidentally hit a stale overload.
DROP FUNCTION IF EXISTS private.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN
);

REVOKE ALL ON FUNCTION private.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT
) FROM PUBLIC;

------------------------------------------------------------
-- 3. chefbyte.apply_event_override — public wrapper
------------------------------------------------------------

CREATE OR REPLACE FUNCTION chefbyte.apply_event_override(
  p_client_event_id          TEXT,
  p_stock_qty_override       NUMERIC DEFAULT NULL,
  p_macros_servings_override NUMERIC DEFAULT NULL,
  p_calories_override        NUMERIC DEFAULT NULL,
  p_protein_override         NUMERIC DEFAULT NULL,
  p_carbs_override           NUMERIC DEFAULT NULL,
  p_fat_override             NUMERIC DEFAULT NULL,
  p_macro_logging_enabled    BOOLEAN DEFAULT TRUE,
  p_is_voided                BOOLEAN DEFAULT FALSE,
  p_event_kind               TEXT    DEFAULT NULL
) RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.apply_event_override(
    p_client_event_id,
    p_stock_qty_override,
    p_macros_servings_override,
    p_calories_override,
    p_protein_override,
    p_carbs_override,
    p_fat_override,
    p_macro_logging_enabled,
    p_is_voided,
    p_event_kind
  );
$$;

-- Drop the stale 9-arg wrapper from 20260421050000.
DROP FUNCTION IF EXISTS chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN
);

REVOKE ALL ON FUNCTION chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT
) TO authenticated;
