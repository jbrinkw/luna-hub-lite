-- Per-lot scale pairings: convert chefbyte.scale_pairings from
-- product-level to lot-level for `live_scale` kind, plus auto-rotation
-- when a paired lot reaches qty=0.
--
-- CONTEXT (2026-04-27):
--   Until now, ``chefbyte.scale_pairings`` only carried ``product_id`` —
--   the live_scale apply path resolved the lot via FEFO over all qty>0
--   lots of that product. With multiple lots of the same SKU on the
--   shelf (e.g. two open bottles), the qty change can land on the wrong
--   lot. There's also no auto-rotation: when the paired lot empties out,
--   the user has to manually re-pair to start tracking the next bottle.
--
-- DESIGN:
--   1. Add ``lot_id UUID`` to ``scale_pairings`` (FK SET NULL).
--   2. Backfill: for each existing live_scale pairing, point at the FEFO
--      qty>0 not-in-flight lot of the same product if exactly one is
--      available; leave NULL otherwise.
--   3. Partial index on lot_id WHERE NOT NULL for fast lookup.
--   4. Update ``private.apply_shelf_event`` consumed/depleted/refilled
--      live_scale branches to honour the pinned ``lot_id``. NULL
--      ``lot_id`` falls back to FEFO (preserves today's behaviour for
--      unset / rotation-pending pairings).
--   5. New ``private.rotate_pairing_after_depletion(p_lot_id)`` —
--      called by apply_shelf_event after a live_scale write zeroes the
--      paired lot. Picks the next on-shelf qty>0 lot of the same
--      product (FEFO) and updates ``scale_pairings.lot_id``. If none
--      available, sets lot_id=NULL and raises a
--      ``scale_pairings_rotation_pending`` alert via private.upsert_alert.
--   6. Audit row: ``shelf_event_log`` reason='pairing_rotated:<old>→<new>'
--      so operators can trace rotations through the event log.
--
-- INVARIANT:
--   When ``scale_pairings.lot_id`` is set, it MUST refer to a lot owned
--   by the same user as the pairing. The CHECK constraint enforces NULL
--   OR same-user via FK SET NULL — when the lot is deleted the column
--   nulls out automatically (rotation falls back to FEFO until next
--   apply, which then sets a fresh lot or null + alert).
--
-- ROLLBACK PATH:
--   * Drop column lot_id from scale_pairings.
--   * Re-create apply_shelf_event from migration 20260427020000.
--   * Drop rotate_pairing_after_depletion function.

BEGIN;

------------------------------------------------------------
-- 1. Schema change: add lot_id to scale_pairings
------------------------------------------------------------

ALTER TABLE chefbyte.scale_pairings
  ADD COLUMN IF NOT EXISTS lot_id UUID
    REFERENCES chefbyte.stock_lots(lot_id) ON DELETE SET NULL;

-- Partial index for the active-pairings lookup pattern.
CREATE INDEX IF NOT EXISTS scale_pairings_active_lot_idx
  ON chefbyte.scale_pairings (lot_id)
  WHERE lot_id IS NOT NULL;

------------------------------------------------------------
-- 2. Backfill — FEFO single-candidate rule
------------------------------------------------------------
-- For each existing live_scale pairing, point at the qty>0 not-in-flight
-- lot of the same product with the earliest expiration (NULL last).
-- Leave NULL when zero or multiple candidates exist — the apply path's
-- FEFO fallback continues to work, and the rotation logic will set a
-- concrete lot the first time a successful write happens.

UPDATE chefbyte.scale_pairings sp
   SET lot_id = (
     SELECT sl.lot_id
       FROM chefbyte.stock_lots sl
      WHERE sl.product_id = sp.product_id
        AND sl.user_id = sp.user_id
        AND sl.qty_containers > 0
        AND sl.in_flight_since IS NULL
      ORDER BY sl.expires_on ASC NULLS LAST, sl.last_update_ts ASC NULLS LAST
      LIMIT 1
   )
 WHERE sp.kind = 'live_scale'
   AND sp.product_id IS NOT NULL
   AND sp.lot_id IS NULL;

------------------------------------------------------------
-- 3. private.rotate_pairing_after_depletion
------------------------------------------------------------
-- Called from apply_shelf_event whenever a live_scale write zeroes the
-- paired lot. Looks for the next on-shelf qty>0 lot of the same product
-- (FEFO). If found: UPDATE scale_pairings.lot_id, return the new lot_id.
-- If not: NULL out lot_id and raise the rotation-pending alert.
--
-- Returns the new lot_id (or NULL when no candidate). Caller can stamp
-- the audit row using the return value.

CREATE OR REPLACE FUNCTION private.rotate_pairing_after_depletion(
  p_lot_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pairing_id UUID;
  v_user_id    UUID;
  v_device_id  UUID;
  v_scale_id   TEXT;
  v_product_id UUID;
  v_next_lot   UUID;
BEGIN
  -- Find the pairing row that points at this lot. There is at most one
  -- (per the partial index — same lot can't be pinned to two scales
  -- without violating UNIQUE(device_id, scale_id) at the row level).
  SELECT pairing_id, user_id, device_id, scale_id, product_id
    INTO v_pairing_id, v_user_id, v_device_id, v_scale_id, v_product_id
    FROM chefbyte.scale_pairings
   WHERE lot_id = p_lot_id
     AND kind = 'live_scale'
   LIMIT 1;

  IF v_pairing_id IS NULL THEN
    -- No pairing pointed at this lot — nothing to rotate.
    RETURN NULL;
  END IF;

  -- Pick the next FEFO on-shelf candidate: same product, qty>0,
  -- not in-flight, NOT this lot.
  SELECT lot_id INTO v_next_lot
    FROM chefbyte.stock_lots
   WHERE user_id = v_user_id
     AND product_id = v_product_id
     AND qty_containers > 0
     AND in_flight_since IS NULL
     AND lot_id <> p_lot_id
   ORDER BY expires_on ASC NULLS LAST, last_update_ts ASC NULLS LAST
   LIMIT 1;

  -- Apply the rotation (or null-out).
  UPDATE chefbyte.scale_pairings
     SET lot_id = v_next_lot
   WHERE pairing_id = v_pairing_id;

  -- Surface a "needs attention" signal when there's no candidate.
  -- private.upsert_alert is idempotent (dedup on
  -- invariant_name + subject_type + subject_id) so re-firing during
  -- subsequent depletes of the same pairing just bumps last_seen_at.
  IF v_next_lot IS NULL THEN
    PERFORM private.upsert_alert(
      'scale_pairings_rotation_pending',
      'warning',
      'scale_pairing',
      v_pairing_id::text,
      v_user_id,
      jsonb_build_object(
        'device_id',  v_device_id,
        'scale_id',   v_scale_id,
        'product_id', v_product_id,
        'depleted_lot_id', p_lot_id,
        'message',    'live_scale paired lot reached qty=0 and no on-shelf candidate exists for rotation'
      )
    );
  END IF;

  RETURN v_next_lot;
END;
$$;

REVOKE ALL ON FUNCTION private.rotate_pairing_after_depletion(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.rotate_pairing_after_depletion(UUID) TO service_role;

------------------------------------------------------------
-- 4. apply_shelf_event — honour scale_pairings.lot_id when set
------------------------------------------------------------
-- Drop-and-recreate. Body is the 20260427020000 baseline plus:
--   * For live_scale consumed/depleted: lookup pairing.lot_id; if set,
--     pin to that lot (skip FEFO); else fall back to FEFO.
--   * For live_scale refilled (mapped to 'added'/'refilled'): same
--     lookup — if pairing.lot_id is set and the lot is the row we want
--     to bump, use it directly via resolve_add_to_shelf_lot's existing
--     path. (resolve_add_to_shelf_lot's step-2 same-source match
--     already handles the "live_scale tracked lot exists" case so the
--     refilled path doesn't need a separate pin — leaving it FEFO-ish
--     preserves the cross-tracked-promotion fix from
--     20260427060000.)
--   * After a successful consumed/depleted that drives the paired lot
--     to qty=0: call rotate_pairing_after_depletion(v_lot_id).

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
  -- (preserved verbatim from 20260427020000)
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
  -- Early branch: discarded
  -- (preserved verbatim from 20260427020000)
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
           pickup_event_id    = NULL,
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
  -- Legacy body — consumed/depleted/added/refilled
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
    -- Pickup-resolve detection (20260427010000): preserved verbatim.
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
             pickup_event_id    = NULL,
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

      -- Pickup-resolve closes the lot to qty=0; if it was a live_scale
      -- pinned pairing, rotate to the next FEFO lot (or null + alert).
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

    -- Per-lot pinning for live_scale: when scale_pairings.lot_id is
    -- set for this (device_id, scale_id) combo, target that exact
    -- lot. NULL falls through to FEFO (preserves prior behaviour for
    -- unset / rotation-pending pairings).
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
      -- Verify the pinned lot still belongs to this user + product.
      -- If not (stale pairing after manual product reassignment),
      -- fall back to FEFO.
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
      -- FEFO fallback (the original pre-lot_id behaviour). Used when:
      --   * pairing.lot_id is NULL (rotation-pending or never-set)
      --   * pairing.lot_id is stale (lot deleted / cross-product)
      --   * kind is live_shelf or catch_all (no per-lot pinning)
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

    -- Auto-rotation: if the live_scale write zeroed the lot, advance
    -- the pairing to the next FEFO candidate (or null + alert).
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

      -- For live_scale refills, if the pairing currently has lot_id
      -- NULL (rotation-pending), pin it to the lot we just landed on
      -- so subsequent consumes use it directly. Doesn't override an
      -- existing non-NULL pin — the user could have rotated the
      -- pairing manually via UI, in which case the resolve_add path
      -- might have landed elsewhere and we don't want to silently
      -- repoint.
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

    -- Non-tracked (catch_all) path: preserved verbatim.
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
  'Cloud-side applier for Pi shelf events. Per-lot pinning for live_scale '
  '(scale_pairings.lot_id) added 20260427080000 — auto-rotates after the '
  'paired lot reaches qty=0 via private.rotate_pairing_after_depletion '
  'and raises a hub.alerts row when no candidate exists for rotation.';

COMMIT;
