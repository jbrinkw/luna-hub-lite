-- Tighten pairing-rotation triggers + auto-set expires_on on minted lots.
--
-- CONTEXT (2026-04-28):
--   Two production bugs surfaced together:
--
--   ISSUE 1 — minted lots have NULL expires_on
--     Cloud-side mint path (resolve_add_to_shelf_lot step 5) writes
--     stock_lots without expires_on. The web UI's Inventory page renders
--     "—" for the expiration column on every imported lot, which the
--     user expects to auto-fill from products.default_shelf_life_days
--     (the LLM-suggested shelf life captured at analyze-product time).
--     The scanner Purchase mode already does this client-side via
--     ScannerPage.computeExpiresOn — the cloud just never copied the
--     pattern, so any path that mints through the resolver (live_scale
--     wizard save, live_shelf placement events) skipped it.
--
--   ISSUE 2 — paired live_scale lots get stranded at sub-display qty
--     User report: chocolate-milk lot fdc13e0c-… shows "0.0 ctn" in the
--     Inventory lot view AND still carries the "On Scale" badge. Direct
--     DB inspection: lot is at qty_containers = 0.005, the pairing's
--     scale_pairings.lot_id still points at it. The auto-rotation hook
--     in apply_shelf_event only fires when v_new_qty <= 0 — but scale
--     noise / quantization regularly drops a paired lot to 0.001-0.01
--     ctn instead of exact zero. The pairing then refuses to rotate
--     because the predicate never trips, and the badge keeps lighting
--     up forever.
--
--     Compounding the issue: private.close_in_flight_lot (called from
--     the in-flight close-out modal) zeros the qty for the 'discarded'
--     and 'consumed' resolution branches but never calls
--     rotate_pairing_after_depletion. So even if the user manually
--     closes a stuck in-flight lot, the pairing stays pinned to a
--     qty=0 lot.
--
-- DESIGN:
--   1. Bump the rotation threshold in apply_shelf_event from
--      `v_new_qty <= 0` to `v_new_qty < 0.01`. Sub-display qty (rendered
--      as "0.0 ctn" via toFixed(1)) is treated as "depleted" for the
--      rotation hook — which is exactly the user-facing semantics. The
--      0.01 threshold is generous enough to absorb scale noise (real
--      products report deltas of ~0.5g on a ~1500g container = ~3e-4
--      ctn quantization) without ever firing on a legitimate "low but
--      usable" lot.
--   2. Add the rotation hook to private.close_in_flight_lot for the
--      'discarded' and 'consumed' branches (both paths zero qty). The
--      'returned' branch preserves qty so no rotation needed.
--   3. resolve_add_to_shelf_lot step 5 (mint) computes
--        expires_on = (current_date + products.default_shelf_life_days)
--      when the product has a shelf life on file; leaves NULL otherwise.
--      Local-date math, not UTC — matches the scanner client-side
--      computeExpiresOn helper so cloud-minted lots show the same
--      expiration day as scanner-purchased lots. Same treatment is
--      applied to the catch_all mint branch in apply_shelf_event's
--      added/refilled path.
--   4. Backfill: any existing live_scale pairing whose pinned lot is
--      currently at qty < 0.01 + not in_flight runs through
--      rotate_pairing_after_depletion to clear stranded pins from
--      pre-fix data (covers the chocolate-milk lot specifically).
--
--   resolve_add_to_shelf_lot body is otherwise BYTE-FOR-BYTE identical
--   to the 20260427060000_resolve_add_promote_cross_tracked_lot.sql
--   baseline. apply_shelf_event body is BYTE-FOR-BYTE identical to the
--   20260427130000_catch_all_delta_apply.sql baseline EXCEPT the two
--   threshold lines in the consumed/depleted rotation predicate.
--
-- INVARIANT PRESERVED:
--   * Rotation still rotates exactly once per zero-crossing — the
--     predicate change just widens the trigger window from {0} to
--     [0, 0.01). Once rotation fires, scale_pairings.lot_id is repointed
--     and the original lot drops out of the rotation candidate query.
--   * Pickup-close (whole-lot in-flight close-out) still zeros qty
--     unconditionally — no behaviour change there.
--
-- NON-GOALS:
--   * Does NOT touch the catch-all event branches. Those are the
--     subject of an in-flight Codex review — leaving alone per
--     repo-coordination convention.
--   * Does NOT change the 'returned' branch of close_in_flight_lot.
--     'returned' preserves qty by design; rotation should NOT fire
--     when the user marks the lot "actually still on the shelf".
--   * Does NOT touch the analyze-product edge function. It already
--     prompts for + validates default_shelf_life_days; the issue is
--     just that mint paths weren't reading it back.
--
-- ROLLBACK PATH:
--   * Restore the pre-fix apply_shelf_event from
--     20260427130000_catch_all_delta_apply.sql.
--   * Restore the pre-fix close_in_flight_lot from
--     20260427110000_close_in_flight_lot_rpc.sql.
--   * Restore resolve_add_to_shelf_lot from
--     20260427060000_resolve_add_promote_cross_tracked_lot.sql.

BEGIN;

------------------------------------------------------------
-- 1. resolve_add_to_shelf_lot — mint path sets expires_on
------------------------------------------------------------
-- Body is byte-for-byte the 20260427060000 baseline EXCEPT the step-5
-- INSERT, which now writes expires_on derived from
-- products.default_shelf_life_days (using the user's logical "today"
-- per their day-boundary).

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
  v_shelf_life_days INTEGER;
  v_user_tz         TEXT;
  v_user_dsh        INTEGER;
  v_today           DATE;
  v_expires_on      DATE;
BEGIN
  IF p_shelf_source NOT IN ('live_shelf','live_scale') THEN
    RAISE EXCEPTION 'invalid shelf_source: %', p_shelf_source USING ERRCODE = '22023';
  END IF;

  SELECT net_weight_g INTO v_net_g
    FROM chefbyte.products
   WHERE product_id = p_product_id AND user_id = p_user_id;

  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    RAISE EXCEPTION 'product % missing net_weight_g', p_product_id USING ERRCODE = '22023';
  END IF;

  v_tolerance := GREATEST(50.0, v_net_g * 0.05);

  -- 1) In-flight lot wins.
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

  -- 2) Already-tracked on this shelf — increment.
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

  -- 2.5) Promote a single untracked qty>0 lot.
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

  -- 2.6) Promote a single qty>0 lot tracked by the OTHER scale source.
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

  -- 3) Weight-match move.
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

  -- 4) Empty-lot reuse.
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

  -- 5) No empty lot to reuse — mint a fresh one.
  --
  -- 2026-04-28: auto-set expires_on from products.default_shelf_life_days
  -- using the user's logical "today" (timezone + day_start_hour). Mirrors
  -- the scanner client-side computeExpiresOn helper.
  SELECT default_shelf_life_days INTO v_shelf_life_days
    FROM chefbyte.products
   WHERE product_id = p_product_id AND user_id = p_user_id;

  IF v_shelf_life_days IS NOT NULL AND v_shelf_life_days > 0 THEN
    SELECT timezone, day_start_hour INTO v_user_tz, v_user_dsh
      FROM hub.profiles WHERE user_id = p_user_id;
    IF v_user_tz  IS NULL THEN v_user_tz  := 'UTC'; END IF;
    IF v_user_dsh IS NULL THEN v_user_dsh := 0;     END IF;
    v_today := private.get_logical_date(now(), v_user_tz, v_user_dsh);
    v_expires_on := v_today + v_shelf_life_days;
  ELSE
    v_expires_on := NULL;
  END IF;

  INSERT INTO chefbyte.stock_lots
    (user_id, product_id, location_id, qty_containers,
     expires_on, last_update_source, last_update_ts)
  VALUES
    (p_user_id, p_product_id, p_fallback_location, v_qty_from_mass,
     v_expires_on, p_shelf_source, p_occurred_at)
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

COMMENT ON FUNCTION private.resolve_add_to_shelf_lot(
  UUID, UUID, TEXT, UUID, NUMERIC, UUID, TIMESTAMPTZ
) IS
  'Cloud-side MOVE-vs-MINT resolver. Called by apply_shelf_event from '
  'live_shelf/live_scale added/refilled events. As of 2026-04-28 the '
  'mint branch (step 5) auto-populates expires_on from '
  'products.default_shelf_life_days using the user logical "today".';

------------------------------------------------------------
-- 2. apply_shelf_event — loosened rotation predicate
------------------------------------------------------------
-- Whole-body redefinition because plpgsql doesn't let us hot-patch a
-- single conditional. Kept BYTE-FOR-BYTE identical to the
-- 20260427130000 (catch_all_delta_apply) version EXCEPT for two lines
-- in the consumed/depleted branch where the rotation predicate
-- changes from `v_new_qty <= 0` to `v_new_qty < 0.01`, plus the
-- catch_all-fallback mint also picks up expires_on from the product.

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
  v_pickup_weight_g  NUMERIC;
  v_consumption_g    NUMERIC;
  v_measured_g       NUMERIC;
  v_shelf_life_days  INTEGER;
  v_user_tz          TEXT;
  v_user_dsh         INTEGER;
  v_today            DATE;
  v_expires_on       DATE;
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

  -- in_flight_pickup / in_flight_return branch
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

    -- p_event_kind = 'in_flight_return'
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
  -- catch_all_first_measurement / catch_all_second_measurement
  -- (verbatim from 20260427130000)
  ------------------------------------------------------------

  IF p_event_kind = 'catch_all_first_measurement' THEN
    IF p_kind <> 'catch_all' THEN
      v_result := ROW(NULL::UUID, false, 'catch_all_first_measurement requires kind=catch_all');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;
    IF p_delta_g IS NULL OR p_delta_g <= 0 THEN
      v_result := ROW(NULL::UUID, false, 'catch_all_first_measurement requires positive measured weight');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT net_weight_g INTO v_net_g
      FROM chefbyte.products
     WHERE product_id = p_product_id AND user_id = p_user_id;
    IF v_net_g IS NULL OR v_net_g <= 0 THEN
      v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    v_measured_g := p_delta_g;

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
     ORDER BY
       CASE WHEN last_update_source = p_kind THEN 0 ELSE 1 END,
       expires_on ASC NULLS LAST,
       last_update_ts DESC NULLS LAST
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
           SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;

      INSERT INTO chefbyte.stock_lots
        (user_id, product_id, location_id, qty_containers,
         last_update_source, last_update_ts,
         in_flight_since, in_flight_kind,
         pickup_event_id, pickup_weight_g)
      VALUES
        (p_user_id, p_product_id, v_loc_id,
         GREATEST(v_measured_g / v_net_g, 0),
         p_kind, p_occurred_at,
         p_occurred_at, 'catch_all',
         v_pi_event_uuid, v_measured_g)
      RETURNING lot_id INTO v_lot_id;

      v_result := ROW(v_lot_id, true, 'catch_all_first_measurement (new lot)');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(v_measured_g / v_net_g, 0),
           last_update_source = p_kind,
           last_update_ts     = p_occurred_at,
           in_flight_since    = p_occurred_at,
           in_flight_kind     = 'catch_all',
           pickup_event_id    = v_pi_event_uuid,
           pickup_weight_g    = v_measured_g
     WHERE lot_id = v_lot_id;

    v_result := ROW(v_lot_id, true, 'catch_all_first_measurement');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  IF p_event_kind = 'catch_all_second_measurement' THEN
    IF p_kind <> 'catch_all' THEN
      v_result := ROW(NULL::UUID, false, 'catch_all_second_measurement requires kind=catch_all');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;
    IF p_pi_event_id IS NULL OR char_length(p_pi_event_id) <> 36 THEN
      v_result := ROW(NULL::UUID, false, 'catch_all_second_measurement requires pi_event_id (first event UUID)');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    BEGIN
      v_pi_event_uuid := p_pi_event_id::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_result := ROW(NULL::UUID, false, 'catch_all_second_measurement: invalid pi_event_id');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END;

    SELECT net_weight_g, servings_per_container,
           calories_per_serving, carbs_per_serving,
           protein_per_serving, fat_per_serving
      INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
      FROM chefbyte.products
     WHERE product_id = p_product_id AND user_id = p_user_id;
    IF v_net_g IS NULL OR v_net_g <= 0 THEN
      v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT lot_id, pickup_weight_g INTO v_lot_id, v_pickup_weight_g
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND in_flight_kind = 'catch_all'
       AND pickup_event_id = v_pi_event_uuid
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      v_result := ROW(NULL::UUID, false, 'catch_all_second_measurement: no matching first measurement');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    IF v_pickup_weight_g IS NULL OR v_pickup_weight_g <= 0 THEN
      v_result := ROW(v_lot_id, false, 'catch_all_second_measurement: pickup_weight_g missing on lot');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    v_measured_g    := p_delta_g;
    v_consumption_g := v_pickup_weight_g - v_measured_g;
    IF v_consumption_g IS NULL OR v_consumption_g <= 0 THEN
      v_result := ROW(v_lot_id, false, 'catch_all_second_measurement: non-positive consumption');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    SELECT timezone, day_start_hour INTO v_tz, v_dsh
      FROM hub.profiles WHERE user_id = p_user_id;
    IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
    IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
    v_logical_date := private.get_logical_date(now(), v_tz, v_dsh);

    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(v_measured_g / v_net_g, 0),
           last_update_source = p_kind,
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           in_flight_kind     = NULL,
           pickup_event_id    = NULL,
           pickup_weight_g    = NULL
     WHERE lot_id = v_lot_id;

    v_servings := GREATEST(v_consumption_g / v_net_g, 0) * COALESCE(v_svg_per, 0);
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
       SET applied = v_result.applied, resolved_lot_id = v_result.resolved_lot_id, reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  -- discarded branch
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

    -- Per-lot pinning for live_scale.
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

    -- ROTATION PREDICATE (the user-visible fix in this migration).
    -- 2026-04-28: loosened from `<= 0` to `< 0.01`. Scale noise leaves
    -- a paired lot at qty=0.001-0.01 ctn ("0.0 ctn" in the toFixed(1)
    -- UI) and the old predicate refused to rotate, leaving the pairing
    -- pinned to a phantom-empty lot. The 0.01 threshold matches the
    -- UI's ON_SCALE_QTY_EPSILON in InventoryPage.tsx so the cloud and
    -- UI never disagree about "depleted".
    IF p_kind = 'live_scale' AND v_new_qty IS NOT NULL AND v_new_qty < 0.01 THEN
      v_rotated_to := private.rotate_pairing_after_depletion(v_lot_id);
    END IF;

    v_result := ROW(v_lot_id, true,
      CASE
        WHEN p_kind = 'live_scale' AND v_new_qty IS NOT NULL AND v_new_qty < 0.01
             AND v_rotated_to IS NOT NULL
          THEN CASE WHEN p_event_kind = 'depleted'
                    THEN 'depleted:rotated' ELSE 'decremented:rotated' END
        WHEN p_kind = 'live_scale' AND v_new_qty IS NOT NULL AND v_new_qty < 0.01
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

    -- catch_all path: mint a fresh lot when no qty>0 lot exists.
    -- 2026-04-28: this fallback also picks up expires_on from the
    -- product's default_shelf_life_days so the catch_all add path
    -- doesn't undercut the scanner-purchase / resolve_add expiry math.
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

      SELECT default_shelf_life_days INTO v_shelf_life_days
        FROM chefbyte.products
       WHERE product_id = p_product_id AND user_id = p_user_id;
      IF v_shelf_life_days IS NOT NULL AND v_shelf_life_days > 0 THEN
        SELECT timezone, day_start_hour INTO v_user_tz, v_user_dsh
          FROM hub.profiles WHERE user_id = p_user_id;
        IF v_user_tz  IS NULL THEN v_user_tz  := 'UTC'; END IF;
        IF v_user_dsh IS NULL THEN v_user_dsh := 0;     END IF;
        v_today := private.get_logical_date(now(), v_user_tz, v_user_dsh);
        v_expires_on := v_today + v_shelf_life_days;
      ELSE
        v_expires_on := NULL;
      END IF;

      INSERT INTO chefbyte.stock_lots
        (user_id, product_id, location_id, qty_containers,
         expires_on, last_update_source, last_update_ts)
      VALUES
        (p_user_id, p_product_id, v_loc_id, v_insert_qty,
         v_expires_on, p_kind, p_occurred_at)
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
  'Cloud-side applier for Pi shelf events. As of 2026-04-28: rotation '
  'predicate widened from `v_new_qty <= 0` to `v_new_qty < 0.01` to '
  'cover scale-noise residuals. catch_all fallback mint also picks up '
  'expires_on from products.default_shelf_life_days.';

------------------------------------------------------------
-- 3. close_in_flight_lot — rotation hook on discarded/consumed
------------------------------------------------------------
-- Modal-driven manual close-out of an in-flight lot. The discarded and
-- consumed branches zero qty; if the lot was paired, that means the
-- pairing is now stuck pointing at an empty lot. Add the same rotation
-- hook the apply_shelf_event consumed path uses.

CREATE OR REPLACE FUNCTION private.close_in_flight_lot(
  p_user_id    UUID,
  p_lot_id     UUID,
  p_resolution TEXT,
  p_note       TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lot           chefbyte.stock_lots%ROWTYPE;
  v_product       chefbyte.products%ROWTYPE;
  v_tz            TEXT;
  v_dsh           INTEGER;
  v_logical_date  DATE;
  v_now           TIMESTAMPTZ := now();
  v_event_id      UUID;
  v_qty           NUMERIC;
  v_servings      NUMERIC;
  v_client_evt    TEXT;
  v_was_paired    BOOLEAN;
  v_rotated_to    UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id required' USING ERRCODE = '22023';
  END IF;

  IF p_resolution IS NULL
     OR p_resolution NOT IN ('discarded','consumed','returned') THEN
    RAISE EXCEPTION 'invalid resolution: %', p_resolution
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_lot
    FROM chefbyte.stock_lots
   WHERE lot_id = p_lot_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot not found' USING ERRCODE = '22023';
  END IF;

  IF v_lot.in_flight_since IS NULL THEN
    RAISE EXCEPTION 'lot is not in-flight' USING ERRCODE = '22023';
  END IF;

  v_qty := v_lot.qty_containers;

  -- Capture whether the lot was paired BEFORE state change so the
  -- rotation hook fires only when it makes sense.
  SELECT EXISTS (
    SELECT 1 FROM chefbyte.scale_pairings
     WHERE lot_id = p_lot_id
       AND kind   = 'live_scale'
  ) INTO v_was_paired;

  v_client_evt := 'manual_close_'
                  || p_resolution || '_'
                  || p_lot_id::text || '_'
                  || replace(gen_random_uuid()::text, '-', '');

  IF p_resolution = 'discarded' THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = 0,
           in_flight_since    = NULL,
           in_flight_kind     = NULL,
           pickup_event_id    = NULL,
           pickup_weight_g    = NULL,
           last_update_source = 'manual_discard',
           last_update_ts     = v_now
     WHERE lot_id = p_lot_id
       AND user_id = p_user_id;

  ELSIF p_resolution = 'consumed' THEN
    SELECT * INTO v_product
      FROM chefbyte.products
     WHERE product_id = v_lot.product_id
       AND user_id    = p_user_id;

    IF NOT FOUND THEN
      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             in_flight_since    = NULL,
             in_flight_kind     = NULL,
             pickup_event_id    = NULL,
             pickup_weight_g    = NULL,
             last_update_source = 'manual_consume',
             last_update_ts     = v_now
       WHERE lot_id = p_lot_id
         AND user_id = p_user_id;
    ELSE
      SELECT timezone, day_start_hour INTO v_tz, v_dsh
        FROM hub.profiles WHERE user_id = p_user_id;
      IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
      IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
      v_logical_date := private.get_logical_date(v_now, v_tz, v_dsh);

      v_servings := COALESCE(v_qty, 0)
                    * COALESCE(v_product.servings_per_container, 0);

      IF v_servings > 0 THEN
        INSERT INTO chefbyte.food_logs (
          user_id, product_id, logical_date,
          qty_consumed, unit,
          calories, carbs, protein, fat,
          source_client_event_id
        ) VALUES (
          p_user_id, v_lot.product_id, v_logical_date,
          v_servings, 'serving',
          v_servings * COALESCE(v_product.calories_per_serving, 0),
          v_servings * COALESCE(v_product.carbs_per_serving,    0),
          v_servings * COALESCE(v_product.protein_per_serving,  0),
          v_servings * COALESCE(v_product.fat_per_serving,      0),
          v_client_evt
        );
      END IF;

      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             in_flight_since    = NULL,
             in_flight_kind     = NULL,
             pickup_event_id    = NULL,
             pickup_weight_g    = NULL,
             last_update_source = 'manual_consume',
             last_update_ts     = v_now
       WHERE lot_id = p_lot_id
         AND user_id = p_user_id;
    END IF;

  ELSE  -- returned
    UPDATE chefbyte.stock_lots
       SET in_flight_since    = NULL,
           in_flight_kind     = NULL,
           pickup_event_id    = NULL,
           pickup_weight_g    = NULL,
           last_update_source = 'manual_return',
           last_update_ts     = v_now
     WHERE lot_id = p_lot_id
       AND user_id = p_user_id;
  END IF;

  -- Rotate the pairing when discarded / consumed left the paired lot
  -- at qty=0. 'returned' preserves qty so MUST NOT rotate.
  IF v_was_paired AND p_resolution IN ('discarded','consumed') THEN
    v_rotated_to := private.rotate_pairing_after_depletion(p_lot_id);
  END IF;

  ----------------------------------------------------------
  -- Audit row in shelf_event_log
  ----------------------------------------------------------
  DECLARE
    v_device_id UUID;
  BEGIN
    SELECT device_id INTO v_device_id
      FROM chefbyte.live_shelf_devices
     WHERE user_id = p_user_id
     ORDER BY last_heartbeat_ts DESC NULLS LAST, created_at DESC
     LIMIT 1;

    IF v_device_id IS NULL THEN
      SELECT device_id INTO v_device_id
        FROM chefbyte.live_shelf_devices
       WHERE user_id = p_user_id
         AND import_key_hash = 'manual_close_in_flight_' || p_user_id::text
       LIMIT 1;

      IF v_device_id IS NULL THEN
        INSERT INTO chefbyte.live_shelf_devices (
          user_id, device_name, import_key_hash, is_active
        ) VALUES (
          p_user_id,
          'manual',
          'manual_close_in_flight_' || p_user_id::text,
          false
        )
        RETURNING device_id INTO v_device_id;
      END IF;
    END IF;

    INSERT INTO chefbyte.shelf_event_log (
      user_id, device_id, client_event_id, payload, applied, reason
    ) VALUES (
      p_user_id,
      v_device_id,
      v_client_evt,
      jsonb_build_object(
        'kind',         'manual_close',
        'event_kind',   p_resolution,
        'lot_id',       p_lot_id,
        'product_id',   v_lot.product_id,
        'qty_pre',      v_qty,
        'note',         p_note,
        'resolved_by',  p_user_id,
        'occurred_at',  v_now,
        'rotated_to',   v_rotated_to
      ),
      true,
      CASE WHEN v_was_paired AND p_resolution IN ('discarded','consumed')
        THEN CASE WHEN v_rotated_to IS NOT NULL
                  THEN p_resolution || ':rotated'
                  ELSE p_resolution || ':rotation_pending' END
        ELSE p_resolution
      END
    )
    RETURNING event_id INTO v_event_id;
  END;

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION private.close_in_flight_lot(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC;

COMMENT ON FUNCTION private.close_in_flight_lot(UUID, UUID, TEXT, TEXT) IS
  'Manually close out an in-flight stock_lot from the chef UI. As of '
  '2026-04-28 the discarded/consumed branches now rotate the live_scale '
  'pairing via private.rotate_pairing_after_depletion when the lot was '
  'paired — fixes the "in-flight close-out leaves stuck pairing" bug. '
  'returned still preserves qty without rotation.';

------------------------------------------------------------
-- 4. Backfill — clear stranded sub-display paired lots
------------------------------------------------------------
-- For every live_scale pairing whose pinned lot is currently at qty <
-- 0.01 and not in-flight, run rotation. This catches the chocolate-milk
-- lot fdc13e0c-… and any other pre-fix stragglers in one pass.

DO $$
DECLARE
  r RECORD;
  v_rotated UUID;
BEGIN
  FOR r IN
    SELECT sp.pairing_id, sp.lot_id
      FROM chefbyte.scale_pairings sp
      JOIN chefbyte.stock_lots sl ON sl.lot_id = sp.lot_id
     WHERE sp.kind = 'live_scale'
       AND sp.lot_id IS NOT NULL
       AND sl.qty_containers < 0.01
       AND sl.in_flight_since IS NULL
  LOOP
    v_rotated := private.rotate_pairing_after_depletion(r.lot_id);
    RAISE NOTICE 'backfill: rotated stranded paired lot % → %',
      r.lot_id, COALESCE(v_rotated::text, '(no candidate, alert raised)');
  END LOOP;
END;
$$;

COMMIT;
