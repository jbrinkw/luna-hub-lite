-- single_track (live_scale) NEVER mints a new lot.
--
-- CONTEXT (2026-04-28):
--   Tonight's bug: user scanned a gallon of milk → wizard inserted a
--   stock_lots row with qty_containers=1.0. User placed the bottle on
--   scale-03 (live_scale). Pi emitted kind='live_scale',
--   event_kind='refilled', delta_g=3677.856g. apply_shelf_event routed
--   to private.resolve_add_to_shelf_lot which hit step 2.5
--   (promote_untracked_lot) — the wizard-created lot matched the
--   "single qty>0 untracked lot" predicate, so the resolver promoted it
--   to live_scale AND added (delta_g / net_weight_g) ≈ 0.972 → qty
--   became 1.972 instead of staying at 1.0.
--
--   The resolver's ADD-style semantics are wrong for a single-track
--   measurement scale. live_scale's purpose is "measure the one bottle
--   sitting on me" — every event represents the CURRENT mass on the
--   scale (an absolute value), not an incremental delta to be added on
--   top of existing inventory.
--
-- HARD RULE (per user, this migration enforces it structurally):
--   single_track (live_scale) NEVER mints a new lot. The scale either:
--     1. Pulls from existing non-tracked inventory (claims an unpaired
--        lot of the same product via scale_pairings.lot_id), OR
--     2. Ignores the event entirely (no DB mutation; reason logged).
--
-- DESIGN:
--   * New helper: private.apply_live_scale_measurement
--       Given a paired live_scale + a measured weight, looks up the
--       lot via scale_pairings; if pairing.lot_id is NULL, attempts to
--       claim a single unpaired qty>0 lot of the same product; if no
--       unique candidate exists, REJECTS the event with
--       reason='live_scale_no_unpaired_lot_ignore' or
--       'live_scale_ambiguous_unpaired_lots_ignore'. SET semantics
--       (qty := measured_weight / net_weight_g). Never INSERTs a row.
--
--   * apply_shelf_event:
--       - New optional parameter p_after_weight_g (the absolute mass on
--         the scale at the time of the event). When omitted, the
--         legacy delta_g is reinterpreted as "absolute weight" for the
--         live_scale + (added/refilled) branch (matches the empirical
--         Pi behaviour: today's emitter sends absolute weight when
--         before_weight_g==0, which is the canonical placement event).
--       - The live_scale + (added/refilled) branch now routes through
--         apply_live_scale_measurement instead of resolve_add_to_shelf_lot.
--         The live_shelf branch is unchanged.
--
--   * resolve_add_to_shelf_lot — defense in depth:
--       Reject p_shelf_source='live_scale' at the top with a
--       fingerprint message ('single_track_minted_a_lot'). Any caller
--       that still tries to mint via this function fails loudly.
--
-- INVARIANT:
--   For any live_scale (added|refilled) event applied successfully,
--   the count of stock_lots rows for (user_id, product_id) AFTER the
--   event MUST equal the count BEFORE. New rows are forbidden.
--
-- ROLLBACK:
--   Drop this migration; the prior body (20260428010000) remains the
--   active definition. resolve_add_to_shelf_lot regains its live_scale
--   path. Note that doing so re-introduces the qty-doubling bug above.

BEGIN;

------------------------------------------------------------
-- 1. Helper — private.apply_live_scale_measurement
------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.apply_live_scale_measurement(
  p_user_id         UUID,
  p_device_id       UUID,
  p_scale_id        TEXT,
  p_product_id      UUID,
  p_after_weight_g  NUMERIC,
  p_occurred_at     TIMESTAMPTZ
) RETURNS chefbyte.shelf_event_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_net_g           NUMERIC;
  v_pinned_lot      UUID;
  v_lot_src         TEXT;
  v_lot_ts          TIMESTAMPTZ;
  v_unpaired_lot    UUID;
  v_unpaired_count  INTEGER;
  v_new_qty         NUMERIC;
  v_result          chefbyte.shelf_event_result;
BEGIN
  SELECT net_weight_g INTO v_net_g
    FROM chefbyte.products
   WHERE product_id = p_product_id AND user_id = p_user_id;

  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
    RETURN v_result;
  END IF;

  SELECT lot_id INTO v_pinned_lot
    FROM chefbyte.scale_pairings
   WHERE user_id = p_user_id
     AND device_id = p_device_id
     AND scale_id = p_scale_id
     AND kind = 'live_scale';

  IF NOT FOUND THEN
    v_result := ROW(NULL::UUID, false, 'live_scale_no_pairing_ignore');
    RETURN v_result;
  END IF;

  IF v_pinned_lot IS NOT NULL THEN
    SELECT lot_id, last_update_source, last_update_ts
      INTO v_pinned_lot, v_lot_src, v_lot_ts
      FROM chefbyte.stock_lots
     WHERE lot_id = v_pinned_lot
       AND user_id = p_user_id
       AND product_id = p_product_id;

    IF NOT FOUND THEN
      v_result := ROW(NULL::UUID, false, 'live_scale_paired_lot_missing_ignore');
      RETURN v_result;
    END IF;

    IF v_lot_src = 'manual' AND v_lot_ts IS NOT NULL
       AND v_lot_ts > p_occurred_at THEN
      v_result := ROW(v_pinned_lot, false, 'stale: manual edit is newer');
      RETURN v_result;
    END IF;

    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(p_after_weight_g / v_net_g, 0),
           last_update_source = 'live_scale',
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           in_flight_kind     = NULL,
           pickup_event_id    = NULL,
           pickup_weight_g    = NULL
     WHERE lot_id = v_pinned_lot
     RETURNING qty_containers INTO v_new_qty;

    v_result := ROW(v_pinned_lot, true, 'live_scale_set_qty');
    RETURN v_result;
  END IF;

  -- Pairing exists, lot_id NULL — try to claim a single unpaired lot.
  SELECT lot_id, COUNT(*) OVER ()
    INTO v_unpaired_lot, v_unpaired_count
    FROM chefbyte.stock_lots sl
   WHERE sl.user_id = p_user_id
     AND sl.product_id = p_product_id
     AND sl.qty_containers > 0
     AND NOT EXISTS (
       SELECT 1 FROM chefbyte.scale_pairings sp
        WHERE sp.user_id = p_user_id
          AND sp.kind = 'live_scale'
          AND sp.lot_id = sl.lot_id
     )
   ORDER BY sl.created_at ASC
   LIMIT 2;

  IF v_unpaired_lot IS NULL THEN
    v_result := ROW(NULL::UUID, false, 'live_scale_no_unpaired_lot_ignore');
    RETURN v_result;
  END IF;

  IF v_unpaired_count > 1 THEN
    v_result := ROW(NULL::UUID, false, 'live_scale_ambiguous_unpaired_lots_ignore');
    RETURN v_result;
  END IF;

  UPDATE chefbyte.scale_pairings
     SET lot_id = v_unpaired_lot
   WHERE user_id = p_user_id
     AND device_id = p_device_id
     AND scale_id = p_scale_id
     AND kind = 'live_scale';

  UPDATE chefbyte.stock_lots
     SET qty_containers     = GREATEST(p_after_weight_g / v_net_g, 0),
         last_update_source = 'live_scale',
         last_update_ts     = p_occurred_at,
         in_flight_since    = NULL,
         in_flight_kind     = NULL,
         pickup_event_id    = NULL,
         pickup_weight_g    = NULL
   WHERE lot_id = v_unpaired_lot
   RETURNING qty_containers INTO v_new_qty;

  v_result := ROW(v_unpaired_lot, true, 'live_scale_claimed_and_set');
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.apply_live_scale_measurement(
  UUID, UUID, TEXT, UUID, NUMERIC, TIMESTAMPTZ
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_live_scale_measurement(
  UUID, UUID, TEXT, UUID, NUMERIC, TIMESTAMPTZ
) TO service_role;

------------------------------------------------------------
-- 2. resolve_add_to_shelf_lot — defense-in-depth reject
------------------------------------------------------------
-- Re-create the function with an early reject for live_scale callers.
-- Body otherwise verbatim from 20260427060000.

CREATE OR REPLACE FUNCTION private.resolve_add_to_shelf_lot(
  p_user_id           UUID,
  p_product_id        UUID,
  p_shelf_source      TEXT,
  p_fallback_location UUID,
  p_placed_weight_g   NUMERIC,
  p_event_id          UUID,
  p_occurred_at       TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_net_g           NUMERIC;
  v_tolerance       NUMERIC;
  v_tracked_lot     UUID;
  v_match_count     INTEGER;
  v_match_lot_id    UUID;
  v_match_ids       UUID[];
  v_qty_from_mass   NUMERIC;
  v_new_lot         UUID;
  v_dup_target      UUID;
  v_empty_lot       UUID;
  v_untracked_lot   UUID;
  v_untracked_count INTEGER;
  v_other_src       TEXT;
  v_cross_lot       UUID;
  v_cross_count     INTEGER;
BEGIN
  IF p_shelf_source NOT IN ('live_shelf','live_scale') THEN
    RAISE EXCEPTION 'invalid shelf_source: %', p_shelf_source USING ERRCODE = '22023';
  END IF;

  -- Defense in depth (2026-04-28): live_scale is a SINGLE-TRACK
  -- measurement scale. It must NEVER mint a lot. The legitimate path
  -- lives in private.apply_live_scale_measurement.
  IF p_shelf_source = 'live_scale' THEN
    RAISE EXCEPTION
      'single_track_minted_a_lot: resolve_add_to_shelf_lot must not be '
      'called with shelf_source=live_scale (route through '
      'private.apply_live_scale_measurement instead)'
      USING ERRCODE = '22023';
  END IF;

  SELECT net_weight_g INTO v_net_g
    FROM chefbyte.products
   WHERE product_id = p_product_id AND user_id = p_user_id;

  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    RAISE EXCEPTION 'product % missing net_weight_g', p_product_id USING ERRCODE = '22023';
  END IF;

  v_tolerance := GREATEST(50.0, v_net_g * 0.05);

  SELECT lot_id INTO v_tracked_lot
    FROM chefbyte.stock_lots
   WHERE user_id = p_user_id
     AND product_id = p_product_id
     AND in_flight_since IS NOT NULL
   ORDER BY in_flight_since DESC NULLS LAST
   LIMIT 1;

  IF v_tracked_lot IS NOT NULL THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(qty_containers + (p_placed_weight_g / v_net_g), 0),
           last_update_source = p_shelf_source,
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           pickup_event_id    = NULL
     WHERE lot_id = v_tracked_lot;
    RETURN v_tracked_lot;
  END IF;

  SELECT lot_id INTO v_tracked_lot
    FROM chefbyte.stock_lots
   WHERE user_id = p_user_id
     AND product_id = p_product_id
     AND last_update_source = p_shelf_source
     AND qty_containers > 0
   LIMIT 1;

  IF v_tracked_lot IS NOT NULL THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = qty_containers + (p_placed_weight_g / v_net_g),
           last_update_source = p_shelf_source,
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           pickup_event_id    = NULL
     WHERE lot_id = v_tracked_lot;
    RETURN v_tracked_lot;
  END IF;

  SELECT lot_id, COUNT(*) OVER ()
    INTO v_untracked_lot, v_untracked_count
    FROM chefbyte.stock_lots
   WHERE user_id = p_user_id
     AND product_id = p_product_id
     AND qty_containers > 0
     AND (last_update_source IS NULL
          OR last_update_source NOT IN ('live_shelf','live_scale'))
   ORDER BY last_update_ts DESC NULLS LAST, created_at DESC
   LIMIT 1;

  IF v_untracked_lot IS NOT NULL AND v_untracked_count = 1 THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = qty_containers + (p_placed_weight_g / v_net_g),
           last_update_source = p_shelf_source,
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           pickup_event_id    = NULL
     WHERE lot_id = v_untracked_lot;

    IF p_event_id IS NOT NULL THEN
      UPDATE chefbyte.shelf_event_log
         SET reason = 'promoted_untracked_lot'
       WHERE event_id = p_event_id;
    END IF;

    RETURN v_untracked_lot;
  END IF;

  v_other_src := CASE p_shelf_source
                   WHEN 'live_shelf' THEN 'live_scale'
                   WHEN 'live_scale' THEN 'live_shelf'
                 END;

  SELECT lot_id, COUNT(*) OVER ()
    INTO v_cross_lot, v_cross_count
    FROM chefbyte.stock_lots
   WHERE user_id = p_user_id
     AND product_id = p_product_id
     AND qty_containers > 0
     AND last_update_source = v_other_src
   ORDER BY last_update_ts DESC NULLS LAST, created_at DESC
   LIMIT 1;

  IF v_cross_lot IS NOT NULL AND v_cross_count = 1 THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = qty_containers + (p_placed_weight_g / v_net_g),
           last_update_source = p_shelf_source,
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           pickup_event_id    = NULL
     WHERE lot_id = v_cross_lot;

    IF p_event_id IS NOT NULL THEN
      UPDATE chefbyte.shelf_event_log
         SET reason = 'promoted_cross_tracked_lot'
       WHERE event_id = p_event_id;
    END IF;

    RETURN v_cross_lot;
  END IF;

  SELECT array_agg(lot_id ORDER BY expires_on ASC NULLS LAST, created_at ASC)
    INTO v_match_ids
    FROM chefbyte.stock_lots
   WHERE user_id = p_user_id
     AND product_id = p_product_id
     AND qty_containers > 0
     AND (last_update_source IS NULL
          OR last_update_source NOT IN ('live_shelf','live_scale'))
     AND ABS((qty_containers * v_net_g) - p_placed_weight_g) <= v_tolerance;

  v_match_count := COALESCE(array_length(v_match_ids, 1), 0);

  IF v_match_count >= 1 THEN
    v_match_lot_id := v_match_ids[1];

    SELECT lot_id INTO v_dup_target
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND last_update_source = p_shelf_source
       AND qty_containers > 0
       AND lot_id <> v_match_lot_id
     LIMIT 1;

    IF v_dup_target IS NOT NULL THEN
      UPDATE chefbyte.stock_lots
         SET qty_containers     = qty_containers + (p_placed_weight_g / v_net_g),
             last_update_source = p_shelf_source,
             last_update_ts     = p_occurred_at,
             in_flight_since    = NULL,
             pickup_event_id    = NULL
       WHERE lot_id = v_dup_target;
      RETURN v_dup_target;
    END IF;

    UPDATE chefbyte.stock_lots
       SET last_update_source = p_shelf_source,
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           pickup_event_id    = NULL
     WHERE lot_id = v_match_lot_id;

    IF p_event_id IS NOT NULL THEN
      UPDATE chefbyte.shelf_event_log
         SET reason = CASE
               WHEN v_match_count = 1 THEN 'moved_to_shelf'
               ELSE 'moved_to_shelf_multi_candidate:'
                    || v_match_count::text
             END
       WHERE event_id = p_event_id;
    END IF;

    RETURN v_match_lot_id;
  END IF;

  v_qty_from_mass := GREATEST(p_placed_weight_g / v_net_g, 0);

  SELECT lot_id INTO v_empty_lot
    FROM chefbyte.stock_lots
   WHERE user_id = p_user_id
     AND product_id = p_product_id
     AND qty_containers <= 0
     AND location_id  IS NOT DISTINCT FROM p_fallback_location
     AND expires_on   IS NULL
   ORDER BY last_update_ts DESC NULLS LAST, created_at DESC
   LIMIT 1;

  IF v_empty_lot IS NULL THEN
    SELECT lot_id INTO v_empty_lot
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND qty_containers <= 0
     ORDER BY last_update_ts DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF v_empty_lot IS NOT NULL THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = v_qty_from_mass,
           last_update_source = p_shelf_source,
           last_update_ts     = p_occurred_at,
           location_id        = COALESCE(location_id, p_fallback_location),
           in_flight_since    = NULL,
           pickup_event_id    = NULL
     WHERE lot_id = v_empty_lot;

    IF p_event_id IS NOT NULL THEN
      UPDATE chefbyte.shelf_event_log
         SET reason = 'revived_empty_lot'
       WHERE event_id = p_event_id;
    END IF;

    RETURN v_empty_lot;
  END IF;

  -- Step 5: mint. Unreachable for live_scale (early reject above).
  INSERT INTO chefbyte.stock_lots
    (user_id, product_id, location_id, qty_containers,
     last_update_source, last_update_ts)
  VALUES
    (p_user_id, p_product_id, p_fallback_location, v_qty_from_mass,
     p_shelf_source, p_occurred_at)
  RETURNING lot_id INTO v_new_lot;

  IF p_event_id IS NOT NULL THEN
    UPDATE chefbyte.shelf_event_log
       SET reason = 'minted_on_shelf'
     WHERE event_id = p_event_id;
  END IF;

  RETURN v_new_lot;
END;
$$;

REVOKE ALL ON FUNCTION private.resolve_add_to_shelf_lot(
  UUID, UUID, TEXT, UUID, NUMERIC, UUID, TIMESTAMPTZ
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.resolve_add_to_shelf_lot(
  UUID, UUID, TEXT, UUID, NUMERIC, UUID, TIMESTAMPTZ
) TO service_role;

------------------------------------------------------------
-- 3. apply_shelf_event — drop old 10-arg, create 11-arg overload
------------------------------------------------------------
-- Drop the 10-arg signature first to avoid overload ambiguity. The
-- 11-arg signature with DEFAULT NULL on p_after_weight_g is fully
-- backwards-compatible with all existing 10-arg callers (positional
-- 10-arg and named 10-arg both resolve to the new signature with
-- p_after_weight_g=NULL).

DROP FUNCTION IF EXISTS private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
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
  p_pi_event_id     TEXT DEFAULT NULL,
  p_after_weight_g  NUMERIC DEFAULT NULL
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
  v_pickup_weight_g  NUMERIC;
  v_consumption_g    NUMERIC;
  v_measured_g       NUMERIC;
  v_live_scale_qty_g NUMERIC;
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
      'pi_event_id', p_pi_event_id,
      'after_weight_g', p_after_weight_g
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
  -- in_flight_pickup — verbatim from 20260427130000
  ------------------------------------------------------------
  IF p_event_kind = 'in_flight_pickup' THEN
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

    DECLARE
      v_existing_pickup_lot UUID;
      v_pickup_pi_uuid      UUID;
    BEGIN
      IF p_pi_event_id IS NULL OR char_length(p_pi_event_id) <> 36 THEN
        v_result := ROW(NULL::UUID, false, 'in_flight_pickup requires pi_event_id (uuid)');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;
      BEGIN
        v_pickup_pi_uuid := p_pi_event_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_result := ROW(NULL::UUID, false, 'in_flight_pickup pi_event_id not a valid uuid');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END;

      SELECT lot_id INTO v_existing_pickup_lot
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
         AND pickup_event_id = v_pickup_pi_uuid;

      IF v_existing_pickup_lot IS NOT NULL THEN
        v_result := ROW(v_existing_pickup_lot, true, 'in_flight_pickup_already_marked');
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
         AND in_flight_since IS NULL
       ORDER BY expires_on ASC NULLS LAST
       LIMIT 1;

      IF v_lot_id IS NULL THEN
        v_result := ROW(NULL::UUID, false, 'no on-shelf lot to pickup');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;

      UPDATE chefbyte.stock_lots
         SET in_flight_since    = p_occurred_at,
             in_flight_kind     = 'live_shelf',
             pickup_event_id    = v_pickup_pi_uuid,
             pickup_weight_g    = NULLIF(GREATEST(p_delta_g, 0), 0),
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_lot_id;

      v_result := ROW(v_lot_id, true, 'in_flight_since set');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END;

  ELSIF p_event_kind = 'in_flight_return' THEN
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

    DECLARE
      v_return_pi_uuid UUID;
    BEGIN
      IF p_pi_event_id IS NULL OR char_length(p_pi_event_id) <> 36 THEN
        v_result := ROW(NULL::UUID, false, 'in_flight_return requires pi_event_id (uuid)');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;
      BEGIN
        v_return_pi_uuid := p_pi_event_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_result := ROW(NULL::UUID, false, 'in_flight_return pi_event_id not a valid uuid');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END;

      UPDATE chefbyte.stock_lots
         SET in_flight_since    = NULL,
             in_flight_kind     = NULL,
             pickup_event_id    = NULL,
             pickup_weight_g    = NULL,
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE user_id = p_user_id
         AND product_id = p_product_id
         AND pickup_event_id = v_return_pi_uuid
       RETURNING lot_id INTO v_lot_id;

      IF v_lot_id IS NULL THEN
        v_result := ROW(NULL::UUID, false, 'no in_flight lot for pickup_event_id');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;

      v_result := ROW(v_lot_id, true, 'in_flight_since cleared');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END;
  END IF;

  ------------------------------------------------------------
  -- discarded — verbatim from 20260427130000
  ------------------------------------------------------------
  IF p_event_kind = 'discarded' THEN
    SELECT lot_id, qty_containers
      INTO v_lot_id, v_new_qty
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND qty_containers > 0
     ORDER BY expires_on ASC NULLS LAST, created_at ASC
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      SELECT lot_id, qty_containers
        INTO v_lot_id, v_new_qty
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
         AND in_flight_since IS NOT NULL
       ORDER BY in_flight_since DESC NULLS LAST
       LIMIT 1;
    END IF;

    v_already_zero := (v_lot_id IS NOT NULL AND COALESCE(v_new_qty,0) <= 0);

    IF v_lot_id IS NOT NULL AND NOT v_already_zero THEN
      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             in_flight_since    = NULL,
             in_flight_kind     = NULL,
             pickup_event_id    = NULL,
             pickup_weight_g    = NULL,
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_lot_id;
    ELSIF v_lot_id IS NOT NULL AND v_already_zero THEN
      UPDATE chefbyte.stock_lots
         SET in_flight_since    = NULL,
             in_flight_kind     = NULL,
             pickup_event_id    = NULL,
             pickup_weight_g    = NULL,
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_lot_id;
    END IF;

    v_result := ROW(v_lot_id,
      v_lot_id IS NOT NULL,
      CASE WHEN v_lot_id IS NULL THEN 'no lot to discard'
           WHEN v_already_zero
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
  -- catch_all_first_measurement / catch_all_second_measurement
  -- — verbatim from 20260427130000.
  ------------------------------------------------------------
  IF p_event_kind = 'catch_all_first_measurement' THEN
    DECLARE
      v_first_pi_uuid UUID;
      v_first_lot     UUID;
    BEGIN
      IF p_kind <> 'catch_all' THEN
        v_result := ROW(NULL::UUID, false,
          'catch_all_first_measurement requires kind=catch_all');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;
      IF p_pi_event_id IS NULL OR char_length(p_pi_event_id) <> 36 THEN
        v_result := ROW(NULL::UUID, false,
          'catch_all_first_measurement requires pi_event_id (uuid)');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;
      BEGIN
        v_first_pi_uuid := p_pi_event_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_result := ROW(NULL::UUID, false,
          'catch_all_first_measurement pi_event_id not a valid uuid');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END;
      IF p_delta_g IS NULL OR p_delta_g <= 0 THEN
        v_result := ROW(NULL::UUID, false,
          'catch_all_first_measurement requires positive delta_g');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;

      SELECT net_weight_g INTO v_net_g
        FROM chefbyte.products
       WHERE product_id = p_product_id AND user_id = p_user_id;
      IF v_net_g IS NULL OR v_net_g <= 0 THEN
        v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;

      v_measured_g := p_delta_g;

      SELECT lot_id INTO v_first_lot
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
         AND qty_containers > 0
         AND in_flight_since IS NULL
       ORDER BY expires_on ASC NULLS LAST, created_at ASC
       LIMIT 1;

      IF v_first_lot IS NULL THEN
        v_result := ROW(NULL::UUID, false, 'no on-shelf lot to reconcile');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;

      UPDATE chefbyte.stock_lots
         SET qty_containers     = GREATEST(v_measured_g / v_net_g, 0),
             in_flight_since    = p_occurred_at,
             in_flight_kind     = 'catch_all',
             pickup_event_id    = v_first_pi_uuid,
             pickup_weight_g    = v_measured_g,
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_first_lot;

      v_result := ROW(v_first_lot, true, 'catch_all_first_measurement_applied');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END;
  END IF;

  IF p_event_kind = 'catch_all_second_measurement' THEN
    DECLARE
      v_first_pi_uuid UUID;
      v_first_lot     UUID;
    BEGIN
      IF p_kind <> 'catch_all' THEN
        v_result := ROW(NULL::UUID, false,
          'catch_all_second_measurement requires kind=catch_all');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;
      IF p_pi_event_id IS NULL OR char_length(p_pi_event_id) <> 36 THEN
        v_result := ROW(NULL::UUID, false,
          'catch_all_second_measurement requires pi_event_id (uuid of first event)');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;
      BEGIN
        v_first_pi_uuid := p_pi_event_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_result := ROW(NULL::UUID, false,
          'catch_all_second_measurement pi_event_id not a valid uuid');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END;
      IF p_delta_g IS NULL OR p_delta_g < 0 THEN
        v_result := ROW(NULL::UUID, false,
          'catch_all_second_measurement requires non-negative delta_g');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;

      SELECT net_weight_g, servings_per_container,
             calories_per_serving, carbs_per_serving,
             protein_per_serving, fat_per_serving
        INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
        FROM chefbyte.products
       WHERE product_id = p_product_id AND user_id = p_user_id;
      IF v_net_g IS NULL OR v_net_g <= 0 THEN
        v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;

      SELECT lot_id, pickup_weight_g
        INTO v_first_lot, v_pickup_weight_g
        FROM chefbyte.stock_lots
       WHERE user_id = p_user_id
         AND product_id = p_product_id
         AND in_flight_kind = 'catch_all'
         AND pickup_event_id = v_first_pi_uuid
       ORDER BY in_flight_since DESC NULLS LAST
       LIMIT 1;

      IF v_first_lot IS NULL OR v_pickup_weight_g IS NULL THEN
        v_result := ROW(NULL::UUID, false, 'no first measurement to close');
        UPDATE chefbyte.shelf_event_log SET applied=false, reason=v_result.reason WHERE event_id=v_log_id;
        RETURN v_result;
      END IF;

      v_measured_g := p_delta_g;
      v_consumption_g := v_pickup_weight_g - v_measured_g;
      IF v_consumption_g <= 0 THEN
        UPDATE chefbyte.stock_lots
           SET qty_containers     = GREATEST(v_measured_g / v_net_g, 0),
               in_flight_since    = NULL,
               in_flight_kind     = NULL,
               pickup_event_id    = NULL,
               pickup_weight_g    = NULL,
               last_update_source = p_kind,
               last_update_ts     = p_occurred_at
         WHERE lot_id = v_first_lot;

        v_result := ROW(v_first_lot, true, 'catch_all_second_no_consumption');
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;

      v_servings := (v_consumption_g / v_net_g) * COALESCE(v_svg_per, 0);

      SELECT timezone, day_start_hour INTO v_tz, v_dsh
        FROM hub.profiles WHERE user_id = p_user_id;
      IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
      IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
      v_logical_date := private.get_logical_date(now(), v_tz, v_dsh);

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

      UPDATE chefbyte.stock_lots
         SET qty_containers     = GREATEST(v_measured_g / v_net_g, 0),
             in_flight_since    = NULL,
             in_flight_kind     = NULL,
             pickup_event_id    = NULL,
             pickup_weight_g    = NULL,
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_first_lot;

      v_result := ROW(v_first_lot, true, 'catch_all_second_measurement_applied');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END;
  END IF;

  ------------------------------------------------------------
  -- consumed/depleted/added/refilled — verbatim 20260427130000
  -- with the live_scale ADD branch redirected.
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
    -- ────────────────────────────────────────────────────────────
    -- live_scale: SET semantics + claim-or-ignore. NEVER mints.
    -- ────────────────────────────────────────────────────────────
    IF p_kind = 'live_scale' THEN
      v_live_scale_qty_g := COALESCE(p_after_weight_g, GREATEST(p_delta_g, 0));

      v_result := private.apply_live_scale_measurement(
        p_user_id, p_device_id, p_scale_id, p_product_id,
        v_live_scale_qty_g, p_occurred_at
      );

      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    -- live_shelf branch unchanged.
    IF p_kind = 'live_shelf' THEN
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

    -- catch_all (manual / non-live_scale ADD) — preserved verbatim.
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

------------------------------------------------------------
-- 4. apply_shelf_event_admin — overload accepting p_after_weight_g
------------------------------------------------------------
-- Backwards-compatible: existing 10-arg signatures are preserved
-- (20260421040000 + earlier). New 11-arg overload accepts the
-- absolute weight from the Pi and forwards it to apply_shelf_event.

CREATE OR REPLACE FUNCTION chefbyte.apply_shelf_event_admin(
  p_user_id         UUID,
  p_device_id       UUID,
  p_scale_id        TEXT,
  p_kind            TEXT,
  p_event_kind      TEXT,
  p_product_id      UUID,
  p_delta_g         NUMERIC,
  p_occurred_at     TIMESTAMPTZ,
  p_client_event_id TEXT,
  p_pi_event_id     TEXT,
  p_after_weight_g  NUMERIC
) RETURNS chefbyte.shelf_event_result
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.apply_shelf_event(
    p_user_id, p_device_id, p_scale_id, p_kind,
    p_event_kind, p_product_id, p_delta_g, p_occurred_at,
    p_client_event_id, p_pi_event_id, p_after_weight_g
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, NUMERIC
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, NUMERIC
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, NUMERIC
) TO service_role;

COMMIT;
