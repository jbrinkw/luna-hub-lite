-- Cloud-authoritative logical_date derivation for Pi-driven events.
--
-- RATIONALE (Pi-clock skew / NTP drift):
--   The Raspberry Pi running live-shelf rarely reboots. NTP can drift or
--   fail to converge over long uptimes. Events emitted by the Pi are
--   stamped with `occurred_at` from the Pi's clock and posted to cloud.
--   Previously, private.apply_shelf_event called private.get_logical_date
--   with `p_occurred_at` — so a Pi clock that had drifted near the user's
--   day_start_hour rollover would attribute food_logs / shelf events to
--   the wrong logical_date (e.g. yesterday's macros dropped into today,
--   or vice versa).
--
--   This migration flips logical_date derivation to cloud `now()` for
--   every Pi-driven RPC. The Pi-supplied `occurred_at` is preserved in
--   shelf_event_log.payload and on stock_lots.last_update_ts for
--   forensics and display — it just does NOT drive date attribution.
--
--   Do NOT revert "why are we ignoring the event's own timestamp" — the
--   cloud is the authoritative clock. The Pi has a drift monitor
--   (server/cloud/client.py) that warns when its own clock strays
--   > 60s from cloud; this migration is the server-side half of the
--   same fix.
--
-- Functions touched:
--   1. private.apply_shelf_event — hot path; every Pi shelf/scale event
--      lands here. food_logs.logical_date now uses now().
--   2. private.apply_event_override — retro edits to past events. Also
--      switches to now() for consistency with apply_shelf_event (both
--      are ultimately Pi-originated event contexts).
--
-- Functions NOT touched (deliberate):
--   * private.consume_product — called from web UI (browser clock, which
--     is also client-side but a different bug class). Handled elsewhere.
--   * private.mark_meal_done — uses meal.logical_date that was stored at
--     schedule time by the user; retroactive now() would break meal
--     planning semantics.
--   * private.get_logical_date — the primitive. Still accepts a caller
--     timestamp; callers decide whether to pass now() or a stored one.

BEGIN;

------------------------------------------------------------
-- 1. private.apply_shelf_event: logical_date from cloud now()
------------------------------------------------------------
-- Full CREATE OR REPLACE of the 10-arg signature (matches the version
-- in 20260422020000_stock_lots_in_flight.sql). Only change vs. that
-- version: v_logical_date now derives from now() instead of
-- p_occurred_at. All other semantics — including the stock_lots
-- last_update_ts = p_occurred_at write — are preserved.

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
  -- Cloud-authoritative logical_date. See migration header for rationale.
  v_logical_date := private.get_logical_date(now(), v_tz, v_dsh);

  IF p_event_kind IN ('consumed','depleted') THEN
    SELECT lot_id, last_update_source, last_update_ts
      INTO v_lot_id, v_lot_src, v_lot_ts
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id AND product_id = p_product_id
       AND qty_containers > 0
     ORDER BY expires_on ASC NULLS LAST
     LIMIT 1;

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

    v_result := ROW(v_lot_id, true,
                    CASE WHEN p_event_kind = 'depleted' THEN 'depleted'
                         ELSE 'decremented' END);
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;

  ELSIF p_event_kind IN ('added','refilled') THEN
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

    -- Put-back-on-shelf flow also closes any in-flight window on this lot.
    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(qty_containers + v_delta_c, 0),
           last_update_source = p_kind,
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           pickup_event_id    = NULL
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

------------------------------------------------------------
-- 2. private.apply_event_override: logical_date from cloud now()
------------------------------------------------------------
-- Full CREATE OR REPLACE of the 11-arg signature (matches the version
-- in 20260422040000_classifier_review.sql). Only change vs. that
-- version: the food_logs.logical_date on re-apply derives from now()
-- instead of the stored v_orig_occurred. Same rationale as apply_shelf_event
-- above — the Pi clock is not authoritative.

CREATE OR REPLACE FUNCTION private.apply_event_override(
  p_client_event_id              TEXT,
  p_stock_qty_override           NUMERIC DEFAULT NULL,
  p_macros_servings_override     NUMERIC DEFAULT NULL,
  p_calories_override            NUMERIC DEFAULT NULL,
  p_protein_override             NUMERIC DEFAULT NULL,
  p_carbs_override               NUMERIC DEFAULT NULL,
  p_fat_override                 NUMERIC DEFAULT NULL,
  p_macro_logging_enabled        BOOLEAN DEFAULT TRUE,
  p_is_voided                    BOOLEAN DEFAULT FALSE,
  p_event_kind                   TEXT    DEFAULT NULL,
  p_classifier_override_item_id  UUID    DEFAULT NULL
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
  v_orig_kind       TEXT;
  v_orig_ek         TEXT;
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
  v_prior_ek        TEXT;
  v_prior_delta_c   NUMERIC;
  v_new_ek          TEXT;
  v_new_delta_c     NUMERIC;
  v_new_servings    NUMERIC;
  v_new_cal         NUMERIC;
  v_new_carbs       NUMERIC;
  v_new_protein     NUMERIC;
  v_new_fat         NUMERIC;
  v_effective_product UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required';
  END IF;

  IF p_event_kind IS NOT NULL
     AND p_event_kind NOT IN ('consumed','depleted','added','refilled') THEN
    RAISE EXCEPTION 'invalid event_kind: %', p_event_kind USING ERRCODE = '22023';
  END IF;

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

  IF v_orig_product IS NULL AND p_classifier_override_item_id IS NULL THEN
    RAISE EXCEPTION 'event has no product_id — cannot reconcile';
  END IF;

  v_effective_product := COALESCE(p_classifier_override_item_id, v_orig_product);

  SELECT net_weight_g, servings_per_container,
         calories_per_serving, carbs_per_serving,
         protein_per_serving, fat_per_serving
    INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
    FROM chefbyte.products
   WHERE product_id = v_effective_product AND user_id = v_user_id;
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
  -- Cloud-authoritative logical_date. See migration header for rationale.
  v_logical_date := private.get_logical_date(now(), v_tz, v_dsh);

  SELECT * INTO v_prior
    FROM chefbyte.event_overrides
   WHERE user_id = v_user_id AND client_event_id = p_client_event_id;
  v_prior_found := FOUND;

  -- ---- STEP 1: back out prior effect ----
  IF v_prior_found THEN
    IF NOT v_prior.is_voided THEN
      v_prior_ek := COALESCE(v_prior.event_kind_override, v_orig_ek);
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
    IF v_applied AND v_resolved_lot IS NOT NULL THEN
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

  -- ---- STEP 2: UPSERT override row ----
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

  -- ---- STEP 3: classifier_status auto-transition ----
  IF NOT COALESCE(p_is_voided, FALSE) THEN
    UPDATE chefbyte.shelf_event_log
       SET classifier_status = CASE
              WHEN classifier_status = 'review' THEN 'classified'
              ELSE classifier_status
            END,
           classification = CASE
              WHEN p_classifier_override_item_id IS NOT NULL
                THEN COALESCE(classification, '{}'::jsonb)
                     || jsonb_build_object('item_id', p_classifier_override_item_id::text)
              ELSE classification
            END
     WHERE event_id = v_event_id
       AND user_id  = v_user_id;
  END IF;

  -- ---- STEP 4: if voided, stop ----
  IF COALESCE(p_is_voided, FALSE) THEN
    RETURN v_override_id;
  END IF;

  -- ---- STEP 5: re-apply stock + macros using the EFFECTIVE product ----
  v_new_ek := COALESCE(p_event_kind, v_orig_ek);

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
        (v_user_id, v_effective_product, v_logical_date, v_new_servings, 'serving',
         v_new_cal, v_new_carbs, v_new_protein, v_new_fat, p_client_event_id);
    END IF;
  END IF;

  RETURN v_override_id;
END;
$$;

REVOKE ALL ON FUNCTION private.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT, UUID
) FROM PUBLIC;

COMMIT;
