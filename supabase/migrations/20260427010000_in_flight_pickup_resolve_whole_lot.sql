-- TTL-expired in-flight pickup: resolve the WHOLE lot, not a fraction.
--
-- CONTEXT (Bug 2026-04-27)
-- ------------------------
-- User repro:
--   1. User picks up a chocolate-milk bottle off the shelf (REMOVE event
--      measured delta_g that corresponded to ~0.532 containers, because
--      the scale briefly saw a partial reading / weight-settling drift).
--   2. Pi fast-path writes ``in_flight_pickup`` + stamps
--      ``stock_lots.in_flight_since`` on cloud.
--   3. TTL expires (4h). Pi's ``_reap_expired_in_flight`` flips local lot
--      to ``out`` and emits cloud ``consumed`` (delta=pickup_weight_g,
--      ~472g = 0.306 containers on a 1537g net-weight product) +
--      ``in_flight_return`` (marker clear).
--   4. Cloud's ``consumed`` branch decremented qty_containers by the
--      measured fraction (1.000 → 0.468 in the field; 0.306 → 0 in the
--      test seed). The ``in_flight_return`` branch cleared the marker.
--   5. User placed the bottle back on the shelf. Pi classifier matched
--      the ``recently_out`` lot. Pi emitted ``added`` → cloud's
--      ``resolve_add_to_shelf_lot`` step-2 (tracked lot with qty > 0)
--      bumped qty_containers by the new weight instead of reviving the
--      empty lot.
--   Net result: cloud shows phantom 0.468 qty + bumps on every place-back,
--   diverging from Pi reality.
--
-- USER DIRECTIVE
-- --------------
--   "It should have removed the whole lot when the TTL expired. The
--    system should allow for legal room, so if for some reason there's
--    a mismatch between the quantities, it should still remove the whole
--    lot when an item is removed, not just exactly its weight."
--
-- DESIGN (Option B in the fix brief)
-- ----------------------------------
--   Modify the ``consumed`` branch of ``private.apply_shelf_event`` so
--   that when the event's ``p_pi_event_id`` matches a lot's current
--   ``pickup_event_id`` (i.e. this consumed event is RESOLVING the prior
--   in-flight pickup — TTL reap or classifier-driven close), the handler
--   zeros qty_containers completely AND clears in_flight_since /
--   pickup_event_id. This is tolerant of weight-reading drift: no matter
--   what fractional delta the Pi sends, a pickup-resolving consumed
--   event always removes the whole lot.
--
--   Fractional decrements remain correct for the normal (non-in-flight)
--   path, e.g. a live_scale one-shot ``consumed`` against a non-in-flight
--   lot.
--
-- PLACE-BACK REVIVAL
-- ------------------
--   Once the lot is at qty=0 + in_flight_since=NULL, a subsequent
--   ``added`` event for the same (user, product) on the same tracked
--   source now falls through step-1 (no in-flight match) and step-2
--   (no qty>0 lot) in ``resolve_add_to_shelf_lot``, and lands in step-4
--   ``empty-lot reuse`` from migration 20260425070000. That step bumps
--   qty 0 → N and re-stamps last_update_source / ts. No new lot row is
--   minted; the existing row is revived. UI re-renders as on-shelf.
--
-- NON-GOALS
-- ---------
--   * Does NOT touch food_logs / macros. The ``consumed`` branch still
--     inserts a food_logs row for the fractional servings — consistent
--     with "full container presumed lost" semantics. Users can review +
--     delete the row from /chef/macros if they actually didn't consume
--     the item.
--   * Does NOT add a new event_kind. Reuses ``consumed`` with an inline
--     guard on ``pickup_event_id``.
--   * Does NOT modify the Pi. The reaper keeps emitting ``consumed`` +
--     ``in_flight_return`` exactly as before.
--
-- IDEMPOTENCY
-- -----------
--   The shelf_event_log UNIQUE(user_id, client_event_id) still dedups at
--   the top of the function; the branch only fires the first time an
--   event lands.

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
  v_pickup_event_id  UUID;
  v_consumed_qty     NUMERIC;
  v_is_pickup_close  BOOLEAN;
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
  -- Early branch: in_flight_pickup / in_flight_return
  -- (preserved from 20260425080000 — no semantic change)
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

      UPDATE chefbyte.stock_lots
         SET in_flight_since = p_occurred_at,
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

    -- p_event_kind = 'in_flight_return'
    SELECT lot_id INTO v_lot_id
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND in_flight_since IS NOT NULL
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
           pickup_event_id = NULL,
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
  -- Legacy body — consumed / depleted / added / refilled
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
    -- NEW 2026-04-27: pickup-close detection.
    -- Before the normal lot selection, check whether this consumed/
    -- depleted event is RESOLVING a prior in_flight_pickup. Match is:
    --   * p_pi_event_id parses as UUID
    --   * exactly one lot for (user, product) has that as pickup_event_id
    --
    -- When matched, we bypass the normal FEFO pick-the-qty>0-lot logic
    -- and instead WHOLE-LOT-remove the in-flight lot regardless of
    -- delta_g (user directive: weight drift must not leave phantom qty).
    IF p_pi_event_id IS NOT NULL AND char_length(p_pi_event_id) = 36 THEN
      BEGIN
        v_pickup_event_id := p_pi_event_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_pickup_event_id := NULL;
      END;
    ELSE
      v_pickup_event_id := NULL;
    END IF;

    v_is_pickup_close := FALSE;
    IF v_pickup_event_id IS NOT NULL THEN
      SELECT lot_id, qty_containers
        INTO v_lot_id, v_consumed_qty
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
         AND pickup_event_id = v_pickup_event_id
       LIMIT 1;
      IF v_lot_id IS NOT NULL THEN
        v_is_pickup_close := TRUE;
      END IF;
    END IF;

    IF v_is_pickup_close THEN
      -- Whole-lot removal. Zero qty + clear in_flight markers. The
      -- companion ``in_flight_return`` emit from the Pi is now a no-op
      -- for the marker (already NULL) but still lands as applied=true
      -- via the shelf_event_log dedup path — safe and idempotent.
      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at,
             in_flight_since    = NULL,
             pickup_event_id    = NULL
       WHERE lot_id = v_lot_id
       RETURNING qty_containers INTO v_new_qty;

      -- Macros still get credited for the mass the Pi reported as
      -- consumed (honors the "full container presumed lost" directive
      -- via whatever mass the Pi emits — TTL reap emits pickup_weight_g,
      -- classifier emits measured delta). Users can delete the food_log
      -- row from /chef/macros if inaccurate. We use ABS(v_delta_c) so a
      -- depleted/consumed with small delta still logs its servings.
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

      v_result := ROW(v_lot_id, true, 'pickup_close_whole_lot');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    -- Normal (non-pickup-close) path — unchanged.
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

      v_result := ROW(v_lot_id, true, 'resolved_add');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    -- Non-tracked (catch_all) path
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

COMMENT ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) IS
  'Cloud-side applier for Pi shelf events. A consumed/depleted event '
  'whose p_pi_event_id matches a lot''s pickup_event_id is treated as a '
  'whole-lot removal (zero qty + clear in_flight markers) regardless of '
  'delta_g — tolerates weight-reading drift per user directive 2026-04-27. '
  'Place-back revival flows through resolve_add_to_shelf_lot''s step-4 '
  'empty-lot-reuse path.';

COMMIT;
