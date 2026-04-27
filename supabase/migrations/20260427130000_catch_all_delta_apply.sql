-- Catch-all delta-capture apply paths.
--
-- CONTEXT (2026-04-27):
--   Companion to 20260427120000_catch_all_delta_capture_model.sql. That
--   migration added in_flight_kind + pickup_weight_g columns; this one
--   wires them into apply_shelf_event with two new event_kinds:
--
--     * catch_all_first_measurement — opens a delta-capture session.
--       Snapshots the measured weight, sets stock_lots.qty_containers
--       to match (= weight_g / net_weight_g), stamps in_flight_since +
--       in_flight_kind='catch_all' + pickup_weight_g + pickup_event_id.
--       NO food_logs row (this is reconciliation, not consumption).
--
--     * catch_all_second_measurement — closes the session. Looks up
--       the first measurement via pickup_event_id, computes
--       delta_g = pickup_weight_g - second_weight_g, updates qty to
--       match the new measured weight (= second_weight_g /
--       net_weight_g), clears the in_flight markers, and writes a
--       food_logs row for the consumed delta (delta_g / net_weight_g
--       servings × per-serving macros).
--
--   The function body is the 20260427080000 baseline (live_scale lot
--   pinning + rotation, in_flight_pickup/return + discarded branches)
--   PLUS the two new branches and the in_flight_kind / pickup_weight_g
--   bookkeeping on existing branches.
--
-- PROTOCOL — what the Pi sends:
--   For catch_all_first_measurement:
--     delta_g       = MEASURED weight in grams (positive). Reused
--                     parameter slot — the cloud uses this as the
--                     "absolute weight on the scale", not as a delta.
--     pi_event_id   = the Pi's scale_events.event_id for this first
--                     event. Stamped onto stock_lots.pickup_event_id so
--                     the second measurement can reference it.
--
--   For catch_all_second_measurement:
--     delta_g       = MEASURED weight in grams at the second reading.
--                     The cloud computes
--                     consumption_g = pickup_weight_g - delta_g
--                     and rejects the event when this is non-positive.
--     pi_event_id   = the Pi's scale_events.event_id for the FIRST
--                     event (i.e. the pickup_event_id stamp). The cloud
--                     looks up the lot by (user_id, product_id,
--                     in_flight_kind='catch_all', pickup_event_id =
--                     this pi_event_id::uuid).
--
-- IDEMPOTENCY:
--   shelf_event_log dedup on (user_id, client_event_id) — a retry
--   replays the cached result.

BEGIN;

CREATE OR REPLACE FUNCTION private.apply_shelf_event(
  p_user_id         UUID,
  p_device_id       UUID,
  p_scale_id        TEXT,
  p_kind            TEXT,
  p_event_kind      TEXT,
  p_product_id      UUID,
  p_delta_g         NUMERIC,
  p_occurred_at     TIMESTAMPTZ,
  p_client_event_id TEXT,
  p_pi_event_id     TEXT DEFAULT NULL
) RETURNS chefbyte.shelf_event_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing_applied BOOLEAN;
  v_existing_lot     UUID;
  v_existing_reason  TEXT;
  v_log_id           UUID;
  v_net_g            NUMERIC;
  v_svg_per          NUMERIC;
  v_cal              NUMERIC;
  v_carbs            NUMERIC;
  v_protein          NUMERIC;
  v_fat              NUMERIC;
  v_delta_c          NUMERIC;
  v_lot_id           UUID;
  v_loc_id           UUID;
  v_tz               TEXT;
  v_dsh              INTEGER;
  v_logical_date     DATE;
  v_new_qty          NUMERIC;
  v_servings         NUMERIC;
  v_insert_qty       NUMERIC;
  v_lot_src          TEXT;
  v_lot_ts           TIMESTAMPTZ;
  v_result           chefbyte.shelf_event_result;
  v_pi_event_uuid    UUID;
  v_pickup_lot_id    UUID;
  v_already_zero     BOOLEAN;
  v_pinned_lot       UUID;
  v_rotated_to       UUID;
  -- catch-all delta-capture locals
  v_pickup_weight_g  NUMERIC;
  v_consumption_g    NUMERIC;
  v_measured_g       NUMERIC;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('live_shelf','live_scale','catch_all') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO chefbyte.shelf_event_log (
    user_id, device_id, client_event_id, payload, applied, reason, pi_event_id
  ) VALUES (
    p_user_id, p_device_id, p_client_event_id,
    jsonb_build_object(
      'scale_id', p_scale_id,
      'kind', p_kind,
      'event_kind', p_event_kind,
      'product_id', p_product_id,
      'delta_g', p_delta_g,
      'occurred_at', p_occurred_at,
      'pi_event_id', p_pi_event_id
    ),
    false, 'pending', p_pi_event_id
  )
  ON CONFLICT (user_id, client_event_id) DO NOTHING
  RETURNING event_id INTO v_log_id;

  IF v_log_id IS NULL THEN
    UPDATE chefbyte.shelf_event_log
       SET pi_event_id = p_pi_event_id
     WHERE user_id = p_user_id
       AND client_event_id = p_client_event_id
       AND pi_event_id IS NULL
       AND p_pi_event_id IS NOT NULL;

    SELECT applied, resolved_lot_id, reason
      INTO v_existing_applied, v_existing_lot, v_existing_reason
      FROM chefbyte.shelf_event_log
     WHERE user_id = p_user_id AND client_event_id = p_client_event_id;
    v_result := ROW(v_existing_lot, v_existing_applied, v_existing_reason);
    RETURN v_result;
  END IF;

  ------------------------------------------------------------
  -- Early branch: in_flight_pickup / in_flight_return (live_shelf)
  ------------------------------------------------------------

  IF p_event_kind IN ('in_flight_pickup','in_flight_return') THEN
    IF NOT EXISTS (
      SELECT 1 FROM chefbyte.products
       WHERE product_id = p_product_id AND user_id = p_user_id
    ) THEN
      v_result := ROW(NULL::UUID, false, 'product not found');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF p_pi_event_id IS NOT NULL AND char_length(p_pi_event_id) = 36 THEN
      BEGIN
        v_pi_event_uuid := p_pi_event_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_pi_event_uuid := NULL;
      END;
    ELSE
      v_pi_event_uuid := NULL;
    END IF;

    IF p_event_kind = 'in_flight_pickup' THEN
      SELECT lot_id INTO v_lot_id
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
         AND qty_containers > 0
       ORDER BY
         CASE WHEN last_update_source = p_kind THEN 0 ELSE 1 END,
         expires_on ASC NULLS LAST,
         last_update_ts DESC NULLS LAST
       LIMIT 1;

      IF v_lot_id IS NULL THEN
        SELECT lot_id INTO v_lot_id
          FROM chefbyte.stock_lots
         WHERE user_id = p_user_id
           AND product_id = p_product_id
           AND in_flight_since IS NOT NULL
         ORDER BY in_flight_since DESC
         LIMIT 1;
      END IF;

      IF v_lot_id IS NULL THEN
        SELECT lot_id INTO v_lot_id
          FROM chefbyte.stock_lots
         WHERE user_id = p_user_id
           AND product_id = p_product_id
         ORDER BY last_update_ts DESC NULLS LAST, created_at DESC
         LIMIT 1;
      END IF;

      IF v_lot_id IS NULL THEN
        v_result := ROW(NULL::UUID, false, 'no lot for product to mark in_flight');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;

      -- Stamp in_flight_kind='live_shelf' so the catch_all reaper /
      -- second-measurement lookup can't claim this row.
      UPDATE chefbyte.stock_lots
         SET in_flight_since = p_occurred_at,
             in_flight_kind  = 'live_shelf',
             pickup_event_id = COALESCE(v_pi_event_uuid, pickup_event_id),
             last_update_ts  = p_occurred_at
       WHERE lot_id = v_lot_id
         AND user_id = p_user_id;

      v_result := ROW(v_lot_id, true, 'in_flight_since stamped');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    -- p_event_kind = 'in_flight_return' (live_shelf only — catch_all
    -- has its own dedicated second-measurement branch).
    SELECT lot_id INTO v_lot_id
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND in_flight_since IS NOT NULL
       AND COALESCE(in_flight_kind, 'live_shelf') = 'live_shelf'
     ORDER BY in_flight_since DESC
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      v_result := ROW(NULL::UUID, true, 'no in_flight lot to clear (no-op)');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    UPDATE chefbyte.stock_lots
       SET in_flight_since = NULL,
           in_flight_kind  = NULL,
           pickup_event_id = NULL,
           pickup_weight_g = NULL,
           last_update_ts  = p_occurred_at
     WHERE lot_id = v_lot_id
       AND user_id = p_user_id;

    v_result := ROW(v_lot_id, true, 'in_flight_since cleared');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  ------------------------------------------------------------
  -- New branch: catch_all_first_measurement
  --
  -- Reconciles stock_lots.qty_containers to match the measured
  -- weight, stamps in_flight_kind='catch_all' for the second-event
  -- pickup. NO food_logs (this is reconciliation, not consumption).
  ------------------------------------------------------------

  IF p_event_kind = 'catch_all_first_measurement' THEN
    IF p_kind <> 'catch_all' THEN
      v_result := ROW(NULL::UUID, false, 'catch_all_first_measurement requires kind=catch_all');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    v_measured_g := p_delta_g;
    IF v_measured_g IS NULL OR v_measured_g <= 0 THEN
      v_result := ROW(NULL::UUID, false, 'first measurement requires positive weight');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT net_weight_g INTO v_net_g
      FROM chefbyte.products
     WHERE product_id = p_product_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      v_result := ROW(NULL::UUID, false, 'product not found');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF v_net_g IS NULL OR v_net_g <= 0 THEN
      v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF p_pi_event_id IS NOT NULL AND char_length(p_pi_event_id) = 36 THEN
      BEGIN
        v_pi_event_uuid := p_pi_event_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_pi_event_uuid := NULL;
      END;
    ELSE
      v_pi_event_uuid := NULL;
    END IF;

    SELECT lot_id INTO v_lot_id
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND qty_containers > 0
     ORDER BY expires_on ASC NULLS LAST,
              last_update_ts DESC NULLS LAST
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      SELECT lot_id INTO v_lot_id
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
       ORDER BY last_update_ts DESC NULLS LAST, created_at DESC
       LIMIT 1;
    END IF;

    IF v_lot_id IS NULL THEN
      SELECT location_id INTO v_loc_id
        FROM chefbyte.locations
       WHERE user_id = p_user_id
       ORDER BY created_at ASC
       LIMIT 1;

      IF v_loc_id IS NULL THEN
        v_result := ROW(NULL::UUID, false, 'user has no locations');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;

      INSERT INTO chefbyte.stock_lots (
        user_id, product_id, location_id, qty_containers,
        last_update_source, last_update_ts,
        in_flight_since, in_flight_kind,
        pickup_event_id, pickup_weight_g
      ) VALUES (
        p_user_id, p_product_id, v_loc_id,
        v_measured_g / v_net_g,
        p_kind, p_occurred_at,
        p_occurred_at, 'catch_all',
        v_pi_event_uuid, v_measured_g
      )
      RETURNING lot_id INTO v_lot_id;

      v_result := ROW(v_lot_id, true, 'catch_all_first_measurement (new lot)');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    UPDATE chefbyte.stock_lots
       SET qty_containers     = v_measured_g / v_net_g,
           in_flight_since    = p_occurred_at,
           in_flight_kind     = 'catch_all',
           pickup_event_id    = COALESCE(v_pi_event_uuid, pickup_event_id),
           pickup_weight_g    = v_measured_g,
           last_update_source = p_kind,
           last_update_ts     = p_occurred_at
     WHERE lot_id = v_lot_id
       AND user_id = p_user_id;

    v_result := ROW(v_lot_id, true, 'catch_all_first_measurement');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  ------------------------------------------------------------
  -- New branch: catch_all_second_measurement
  ------------------------------------------------------------

  IF p_event_kind = 'catch_all_second_measurement' THEN
    IF p_kind <> 'catch_all' THEN
      v_result := ROW(NULL::UUID, false, 'catch_all_second_measurement requires kind=catch_all');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    v_measured_g := p_delta_g;
    IF v_measured_g IS NULL OR v_measured_g < 0 THEN
      v_result := ROW(NULL::UUID, false, 'second measurement requires non-negative weight');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT net_weight_g, servings_per_container,
           calories_per_serving, carbs_per_serving,
           protein_per_serving, fat_per_serving
      INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
      FROM chefbyte.products
     WHERE product_id = p_product_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      v_result := ROW(NULL::UUID, false, 'product not found');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF v_net_g IS NULL OR v_net_g <= 0 THEN
      v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF p_pi_event_id IS NULL OR char_length(p_pi_event_id) <> 36 THEN
      v_result := ROW(NULL::UUID, false, 'second measurement requires pi_event_id (first event ref)');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;
    BEGIN
      v_pi_event_uuid := p_pi_event_id::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_pi_event_uuid := NULL;
    END;

    IF v_pi_event_uuid IS NULL THEN
      v_result := ROW(NULL::UUID, false, 'second measurement pi_event_id is not a valid uuid');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT lot_id, pickup_weight_g
      INTO v_lot_id, v_pickup_weight_g
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND in_flight_kind = 'catch_all'
       AND pickup_event_id = v_pi_event_uuid
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      v_result := ROW(NULL::UUID, false, 'no in-flight catch_all lot for pickup_event_id');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF v_pickup_weight_g IS NULL OR v_pickup_weight_g <= 0 THEN
      v_result := ROW(v_lot_id, false, 'in-flight catch_all lot missing pickup_weight_g');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    v_consumption_g := v_pickup_weight_g - v_measured_g;
    IF v_consumption_g <= 0 THEN
      v_result := ROW(v_lot_id, false, 'second measurement is not lighter than first');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT timezone, day_start_hour INTO v_tz, v_dsh
      FROM hub.profiles WHERE user_id = p_user_id;
    IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
    IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
    v_logical_date := private.get_logical_date(p_occurred_at, v_tz, v_dsh);

    UPDATE chefbyte.stock_lots
       SET qty_containers     = v_measured_g / v_net_g,
           in_flight_since    = NULL,
           in_flight_kind     = NULL,
           pickup_event_id    = NULL,
           pickup_weight_g    = NULL,
           last_update_source = p_kind,
           last_update_ts     = p_occurred_at
     WHERE lot_id = v_lot_id
       AND user_id = p_user_id;

    v_servings := (v_consumption_g / v_net_g) * COALESCE(v_svg_per, 0);

    IF v_servings > 0 THEN
      INSERT INTO chefbyte.food_logs
        (user_id, product_id, logical_date, qty_consumed, unit,
         calories, carbs, protein, fat, source_client_event_id)
      VALUES
        (p_user_id, p_product_id, v_logical_date, v_servings, 'serving',
         v_servings * COALESCE(v_cal,     0),
         v_servings * COALESCE(v_carbs,   0),
         v_servings * COALESCE(v_protein, 0),
         v_servings * COALESCE(v_fat,     0),
         p_client_event_id);
    END IF;

    v_result := ROW(v_lot_id, true, 'catch_all_second_measurement_consumed');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  ------------------------------------------------------------
  -- Early branch: discarded
  ------------------------------------------------------------

  IF p_event_kind = 'discarded' THEN
    IF NOT EXISTS (
      SELECT 1 FROM chefbyte.products
       WHERE product_id = p_product_id AND user_id = p_user_id
    ) THEN
      v_result := ROW(NULL::UUID, false, 'product not found');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT lot_id INTO v_lot_id
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND qty_containers > 0
     ORDER BY
       CASE WHEN last_update_source = p_kind THEN 0 ELSE 1 END,
       expires_on ASC NULLS LAST,
       last_update_ts DESC NULLS LAST
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      SELECT lot_id INTO v_lot_id
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
         AND in_flight_since IS NOT NULL
       ORDER BY in_flight_since DESC
       LIMIT 1;
    END IF;

    IF v_lot_id IS NULL THEN
      SELECT lot_id INTO v_lot_id
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
       ORDER BY last_update_ts DESC NULLS LAST, created_at DESC
       LIMIT 1;
    END IF;

    IF v_lot_id IS NULL THEN
      v_result := ROW(NULL::UUID, true, 'no lot for product (idempotent no-op)');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT (qty_containers = 0 AND in_flight_since IS NULL
            AND pickup_event_id IS NULL)
      INTO v_already_zero
      FROM chefbyte.stock_lots
     WHERE lot_id = v_lot_id;

    UPDATE chefbyte.stock_lots
       SET qty_containers     = 0,
           in_flight_since    = NULL,
           in_flight_kind     = NULL,
           pickup_event_id    = NULL,
           pickup_weight_g    = NULL,
           last_update_source = 'manual_discard',
           last_update_ts     = p_occurred_at
     WHERE lot_id = v_lot_id
       AND user_id = p_user_id;

    v_result := ROW(
      v_lot_id,
      true,
      CASE WHEN COALESCE(v_already_zero, false)
           THEN 'discarded (idempotent no-op)'
           ELSE 'discarded' END
    );
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  ------------------------------------------------------------
  -- Legacy body — preserved verbatim from 20260427080000
  -- (live_scale lot pinning + rotation + pickup-resolve detection +
  --  consumed/depleted FEFO + added/refilled paths).
  ------------------------------------------------------------

  SELECT net_weight_g, servings_per_container,
         calories_per_serving, carbs_per_serving,
         protein_per_serving, fat_per_serving
    INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
    FROM chefbyte.products
   WHERE product_id = p_product_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    v_result := ROW(NULL::UUID, false, 'product not found');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  v_delta_c := p_delta_g / v_net_g;

  SELECT timezone, day_start_hour INTO v_tz, v_dsh
    FROM hub.profiles WHERE user_id = p_user_id;
  IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
  IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
  v_logical_date := private.get_logical_date(now(), v_tz, v_dsh);

  IF p_event_kind IN ('consumed','depleted') THEN
    IF p_pi_event_id IS NOT NULL AND char_length(p_pi_event_id) = 36 THEN
      BEGIN
        v_pi_event_uuid := p_pi_event_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_pi_event_uuid := NULL;
      END;
    ELSE
      v_pi_event_uuid := NULL;
    END IF;

    IF v_pi_event_uuid IS NOT NULL THEN
      SELECT lot_id INTO v_pickup_lot_id
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
         AND pickup_event_id = v_pi_event_uuid
       ORDER BY in_flight_since DESC NULLS LAST
       LIMIT 1;
    END IF;

    IF v_pickup_lot_id IS NOT NULL THEN
      v_lot_id := v_pickup_lot_id;
      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             in_flight_since    = NULL,
             in_flight_kind     = NULL,
             pickup_event_id    = NULL,
             pickup_weight_g    = NULL,
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_lot_id
       RETURNING qty_containers INTO v_new_qty;

      v_servings := ABS(v_delta_c) * COALESCE(v_svg_per, 0);
      IF v_servings > 0 THEN
        INSERT INTO chefbyte.food_logs
          (user_id, product_id, logical_date, qty_consumed, unit,
           calories, carbs, protein, fat, source_client_event_id)
        VALUES
          (p_user_id, p_product_id, v_logical_date, v_servings, 'serving',
           v_servings * COALESCE(v_cal,     0),
           v_servings * COALESCE(v_carbs,   0),
           v_servings * COALESCE(v_protein, 0),
           v_servings * COALESCE(v_fat,     0),
           p_client_event_id);
      END IF;

      IF p_kind = 'live_scale' THEN
        v_rotated_to := private.rotate_pairing_after_depletion(v_lot_id);
      END IF;

      v_result := ROW(v_lot_id, true,
        CASE WHEN p_kind = 'live_scale' AND v_rotated_to IS NOT NULL
             THEN 'pickup_close_whole_lot:rotated'
             WHEN p_kind = 'live_scale'
             THEN 'pickup_close_whole_lot:rotation_pending'
             ELSE 'pickup_close_whole_lot' END);
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    -- Per-lot pinning for live_scale
    IF p_kind = 'live_scale' THEN
      SELECT lot_id INTO v_pinned_lot
        FROM chefbyte.scale_pairings
       WHERE user_id = p_user_id
         AND device_id = p_device_id
         AND scale_id = p_scale_id
         AND kind = 'live_scale';
    ELSE
      v_pinned_lot := NULL;
    END IF;

    IF v_pinned_lot IS NOT NULL THEN
      SELECT lot_id, last_update_source, last_update_ts
        INTO v_lot_id, v_lot_src, v_lot_ts
        FROM chefbyte.stock_lots
       WHERE lot_id = v_pinned_lot
         AND user_id = p_user_id
         AND product_id = p_product_id;

      IF NOT FOUND THEN
        v_lot_id := NULL;
      END IF;
    ELSE
      v_lot_id := NULL;
    END IF;

    IF v_lot_id IS NULL THEN
      SELECT lot_id, last_update_source, last_update_ts
        INTO v_lot_id, v_lot_src, v_lot_ts
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id AND product_id = p_product_id
         AND qty_containers > 0
       ORDER BY expires_on ASC NULLS LAST
       LIMIT 1;
    END IF;

    IF v_lot_id IS NULL THEN
      v_result := ROW(NULL::UUID, false, 'no lot with stock to decrement');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF v_lot_src = 'manual' AND v_lot_ts IS NOT NULL
       AND v_lot_ts > p_occurred_at THEN
      v_result := ROW(v_lot_id, false, 'stale: manual edit is newer');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF p_event_kind = 'depleted' THEN
      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_lot_id
       RETURNING qty_containers INTO v_new_qty;
    ELSE
      UPDATE chefbyte.stock_lots
         SET qty_containers     = GREATEST(qty_containers + v_delta_c, 0),
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_lot_id
       RETURNING qty_containers INTO v_new_qty;
    END IF;

    v_servings := ABS(v_delta_c) * COALESCE(v_svg_per, 0);

    IF v_servings > 0 THEN
      INSERT INTO chefbyte.food_logs
        (user_id, product_id, logical_date, qty_consumed, unit,
         calories, carbs, protein, fat, source_client_event_id)
      VALUES
        (p_user_id, p_product_id, v_logical_date, v_servings, 'serving',
         v_servings * COALESCE(v_cal,     0),
         v_servings * COALESCE(v_carbs,   0),
         v_servings * COALESCE(v_protein, 0),
         v_servings * COALESCE(v_fat,     0),
         p_client_event_id);
    END IF;

    IF p_kind = 'live_scale' AND v_new_qty IS NOT NULL AND v_new_qty <= 0 THEN
      v_rotated_to := private.rotate_pairing_after_depletion(v_lot_id);
    END IF;

    v_result := ROW(v_lot_id, true,
      CASE
        WHEN p_kind = 'live_scale' AND v_new_qty IS NOT NULL AND v_new_qty <= 0
             AND v_rotated_to IS NOT NULL
          THEN CASE WHEN p_event_kind = 'depleted'
                    THEN 'depleted:rotated' ELSE 'decremented:rotated' END
        WHEN p_kind = 'live_scale' AND v_new_qty IS NOT NULL AND v_new_qty <= 0
          THEN CASE WHEN p_event_kind = 'depleted'
                    THEN 'depleted:rotation_pending'
                    ELSE 'decremented:rotation_pending' END
        WHEN p_event_kind = 'depleted' THEN 'depleted'
        ELSE 'decremented'
      END);
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;

  ELSIF p_event_kind IN ('added','refilled') THEN
    IF p_kind IN ('live_shelf','live_scale') THEN
      SELECT location_id INTO v_loc_id
        FROM chefbyte.locations
       WHERE user_id = p_user_id
       ORDER BY created_at ASC
       LIMIT 1;

      IF v_loc_id IS NULL THEN
        v_result := ROW(NULL::UUID, false, 'user has no locations');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;

      v_lot_id := private.resolve_add_to_shelf_lot(
        p_user_id, p_product_id, p_kind, v_loc_id,
        GREATEST(p_delta_g, 0), v_log_id, p_occurred_at
      );

      IF p_kind = 'live_scale' AND v_lot_id IS NOT NULL THEN
        UPDATE chefbyte.scale_pairings
           SET lot_id = v_lot_id
         WHERE user_id = p_user_id
           AND device_id = p_device_id
           AND scale_id = p_scale_id
           AND kind = 'live_scale'
           AND lot_id IS NULL;
      END IF;

      v_result := ROW(v_lot_id, true, 'resolved_add');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT lot_id, last_update_source, last_update_ts
      INTO v_lot_id, v_lot_src, v_lot_ts
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id AND product_id = p_product_id
       AND qty_containers > 0
     ORDER BY created_at ASC
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      SELECT location_id INTO v_loc_id
        FROM chefbyte.locations
       WHERE user_id = p_user_id
       ORDER BY created_at ASC
       LIMIT 1;

      IF v_loc_id IS NULL THEN
        v_result := ROW(NULL::UUID, false, 'user has no locations');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;

      v_insert_qty := GREATEST(v_delta_c, 0);

      INSERT INTO chefbyte.stock_lots
        (user_id, product_id, location_id, qty_containers,
         last_update_source, last_update_ts)
      VALUES
        (p_user_id, p_product_id, v_loc_id, v_insert_qty, p_kind, p_occurred_at)
      RETURNING lot_id INTO v_lot_id;

      v_result := ROW(v_lot_id, true, 'new lot created');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF v_lot_src = 'manual' AND v_lot_ts IS NOT NULL
       AND v_lot_ts > p_occurred_at THEN
      v_result := ROW(v_lot_id, false, 'stale: manual edit is newer');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(qty_containers + v_delta_c, 0),
           last_update_source = p_kind,
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           in_flight_kind     = NULL,
           pickup_event_id    = NULL,
           pickup_weight_g    = NULL
     WHERE lot_id = v_lot_id
     RETURNING qty_containers INTO v_new_qty;

    v_result := ROW(v_lot_id, true, 'incremented');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;

  ELSE
    v_result := ROW(NULL::UUID, false, 'unknown event_kind');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) IS
  'Cloud-side applier for Pi shelf events. Accepts consumed/depleted/added/'
  'refilled (existing) + in_flight_pickup/in_flight_return (live_shelf '
  'flow) + discarded (manual user discard) + catch_all_first_measurement '
  '/ catch_all_second_measurement (delta-capture flow, added 20260427130000). '
  'The delta-capture branches use stock_lots.in_flight_kind to distinguish '
  'catch_all in-flight state from live_shelf in-flight state. Live_scale '
  'per-lot pinning + auto-rotation preserved from 20260427080000.';

COMMIT;
