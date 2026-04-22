-- Cloud-side handler for Pi "in_flight_pickup" and "in_flight_return" events.
--
-- CONTEXT (Bug 2026-04-22):
--   When the Pi live-shelf detects a REMOVE event and the classifier
--   identifies a known lot, the Pi transitions the lot to status=
--   'in_flight' locally and writes BOTH an `in_flight_pickup` session
--   resolution AND a belt-and-suspenders `consumed_or_removed`
--   resolution for the same REMOVE (reconcile.py Pass 2 — C3 skip only
--   triggers when a terminal in_flight_return already exists).
--
--   The `consumed_or_removed` row leaks to cloud as a `consumed` event
--   with the full pickup mass, which zeros stock_lots.qty_containers.
--   The Pi is still tracking the bottle as physically in-flight, but
--   /chef/inventory hides it because qty=0.
--
--   Meanwhile the `in_flight_pickup` resolution is explicitly dropped
--   by the Pi's PATTERN_TO_EVENT_KIND mapping (value = None) so cloud
--   never learns about the pickup state. `stock_lots.in_flight_since`
--   was added in 20260422020000 but no code path SETS it.
--
-- DESIGN:
--   Extend apply_shelf_event to accept two new event kinds BEFORE the
--   existing net_weight_g guards:
--     * `in_flight_pickup`  — stamps `in_flight_since` + `pickup_event_id`
--                             on the most-recent qty>0 lot for the
--                             (user, product). Does NOT decrement qty.
--                             Falls back to any existing in_flight lot,
--                             then to the newest lot of any qty — the
--                             goal is a cloud-visible in-flight marker
--                             even after the companion `consumed` event
--                             has zero'd qty.
--     * `in_flight_return`  — clears `in_flight_since` + `pickup_event_id`
--                             on the matching lot. Does NOT mutate qty.
--                             The accompanying `consumed` event (if any)
--                             handles the consumption separately.
--
--   Both are idempotent via the existing shelf_event_log dedup
--   (UNIQUE(user_id, client_event_id)).
--
--   The rest of apply_shelf_event's body is preserved verbatim from
--   20260424080000_stock_lots_invariant_and_resolve.sql — only the
--   early-branch in_flight_* handlers are new.
--
-- NON-GOALS:
--   * Does NOT adjust macros / food_logs. Macros land via the
--     `consumed_or_removed` dual-write on the Pi today.
--   * Does NOT make the Pi's dual-resolution behaviour "correct" — it
--     just prevents the cloud state from diverging visibly.
--   * Does NOT backfill the current chocolate-milk divergence; a
--     companion commit adds a manual fix.

BEGIN;

-- Drop the legacy 9-arg overload (pre-pi_event_id). The event_overrides
-- migration (20260421040000) added the 10-arg version but left the
-- 9-arg in place, which is legal overloading. Ambiguity-wise Postgres
-- picks the best match by signature, but having two overloads at all
-- is a foot-gun — a caller that somehow drops to 9 positional args
-- would hit the OLD function body without the in_flight_* branches,
-- returning 'unknown event_kind'. Drop it explicitly so only the
-- modern 10-arg version is reachable.
DROP FUNCTION IF EXISTS private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT
);

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
  -- (NEW 20260425080000 — no net_weight_g / food_logs side effects)
  ------------------------------------------------------------

  IF p_event_kind IN ('in_flight_pickup','in_flight_return') THEN
    -- Guard: product must exist for this user (ownership check).
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

    -- Parse Pi event id into UUID if it looks well-formed. Bad shapes
    -- just leave pickup_event_id NULL — the badge still renders off
    -- in_flight_since alone.
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
      -- Find the most-recent qty>0 tracked-shelf lot for this (user,
      -- product). Prefer a lot whose last_update_source matches p_kind
      -- so a live_shelf pickup doesn't spuriously mark a live_scale lot.
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
        -- Fallback 1: an existing in_flight lot (idempotent re-pickup,
        -- or companion consumed event already zero'd qty).
        SELECT lot_id INTO v_lot_id
          FROM chefbyte.stock_lots
         WHERE user_id = p_user_id
           AND product_id = p_product_id
           AND in_flight_since IS NOT NULL
         ORDER BY in_flight_since DESC
         LIMIT 1;
      END IF;

      IF v_lot_id IS NULL THEN
        -- Fallback 2: any lot for this product — newest last_update_ts.
        -- Handles the common case where the companion consumed event
        -- fired earlier and zero'd qty before the in_flight_pickup
        -- arrived. Still want the in_flight marker to land somewhere
        -- so inventory UI can keep the lot visible.
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
      -- Cloud never saw the pickup (Pi was offline when pickup fired,
      -- or migration wasn't live yet) — return applied=true with a no-op
      -- reason so the Pi's retry worker doesn't re-send.
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
  -- Legacy body — preserved verbatim from 20260424080000 so the
  -- existing consumed/depleted/added/refilled paths are unchanged.
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
  'Cloud-side applier for Pi shelf events. Accepts consumed/depleted/added/'
  'refilled (existing) + in_flight_pickup/in_flight_return (added '
  '20260425080000 to mirror Pi-side in-flight state into cloud '
  'stock_lots.in_flight_since). Idempotent via shelf_event_log '
  'UNIQUE(user_id, client_event_id).';

COMMIT;
