-- Fix: chocolate-milk 500-error on live_scale refill when empty lot exists.
--
-- CONTEXT
--   Production repro (2026-04-22): scale-03 is paired to chocolate milk,
--   net_weight_g=1537.822. User consumes a bottle down to 0 on scale-01
--   (live_shelf), leaving a row:
--     stock_lots(qty_containers=0.000, last_update_source='live_shelf',
--                location_id=<fridge>, expires_on=NULL)
--   User places a fresh 1663g bottle on scale-03 (live_scale). Pi enqueues
--   a live_scale refilled event. Edge fn calls
--     private.apply_shelf_event → private.resolve_add_to_shelf_lot(...)
--   which walks:
--     1) in_flight lookup          — no match (in_flight_since IS NULL)
--     2) tracked lot for shelf_src — no match (qty_containers > 0 filter
--                                    skips the empty live_shelf row, AND
--                                    the filter is last_update_source
--                                    = 'live_scale' which also wouldn't
--                                    match the live_shelf-sourced empty)
--     3) pantry MOVE candidates    — none
--     4) MINT: INSERT INTO stock_lots(..., location_id=<fridge>, expires_on=NULL)
--   That INSERT violates the unique index `stock_lots_merge_key` on
--   (user_id, product_id, location_id, COALESCE(expires_on,'9999-12-31'))
--   because the empty live_shelf row already occupies that key.
--   Postgres raises 23505. Every statement inside apply_shelf_event
--   (including the `INSERT INTO shelf_event_log ...` at the top) is
--   rolled back atomically — net result: zero shelf_event_log rows, zero
--   stock writes, Pi retries forever with 500. User sees "nothing happens
--   when I place an item on the scale."
--
-- FIX
--   Before the MINT branch in resolve_add_to_shelf_lot, look for an
--   EMPTY lot (qty_containers <= 0) for the same (user, product) and
--   REUSE it: bump qty_containers with the placed weight, stamp
--   last_update_source / last_update_ts, clear any in_flight bookkeeping.
--   This covers:
--     * Cross-source empty lot (consumed-to-zero on live_shelf, refilled
--       on live_scale) — the physical bottle is the same product; one
--       row suffices.
--     * Same-source empty lot (consumed-to-zero on live_scale, refilled
--       on live_scale) — should also reuse, never violate merge_key.
--   Choice strategy: pick the empty lot whose merge-key tuple (location,
--   expires_on) matches what the mint would have produced (fallback
--   location, NULL expires_on). If multiple empty rows exist, take the
--   most recently updated one — that's the "last seen" container.
--
-- INVARIANT PRESERVED
--   stock_lots_one_per_tracked_shelf (partial on qty_containers > 0) stays
--   intact: the reused row bumps qty from 0 → N, which transitions it
--   INTO the invariant predicate. At most one qty>0 row per
--   (user,product,live_scale) still holds because the resolver's step-2
--   would have caught any existing qty>0 live_scale lot first.
--
-- NON-GOALS
--   * Does NOT alter the partial unique index.
--   * Does NOT change the MOVE-vs-MINT pantry resolution.
--   * catch_all (non-tracked) path is unaffected — it's a separate branch
--     in apply_shelf_event.

BEGIN;

CREATE OR REPLACE FUNCTION private.resolve_add_to_shelf_lot(
  p_user_id           UUID,
  p_product_id        UUID,
  p_shelf_source      TEXT,   -- 'live_shelf' or 'live_scale'
  p_fallback_location UUID,   -- used ONLY if we mint and there's no existing live_shelf location reference
  p_placed_weight_g   NUMERIC,
  p_event_id          UUID,   -- shelf_event_log.event_id for audit correlation
  p_occurred_at       TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_net_g         NUMERIC;
  v_tolerance     NUMERIC;
  v_tracked_lot   UUID;
  v_match_count   INTEGER;
  v_match_lot_id  UUID;
  v_match_ids     UUID[];
  v_qty_from_mass NUMERIC;
  v_new_lot       UUID;
  v_dup_target    UUID;
  v_empty_lot     UUID;
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

  -- Per-product tolerance, floored at 50g for small containers.
  v_tolerance := GREATEST(50.0, v_net_g * 0.05);

  -- 1) If an in-flight lot for this product exists (picked up
  --    off a scale/shelf and not yet reconciled), that's the
  --    closest natural owner of the incoming mass — close the
  --    in-flight window on it and stamp it as this shelf.
  --    Prevents a MINT from stealing the "add" from a lot that
  --    was only picked up seconds ago.
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

  -- 2) If a lot for this product ALREADY lives on this tracked
  --    shelf, that's the single-source-of-truth — just increment
  --    it. The invariant guarantees at most one such row.
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

  -- 3) Look for a weight-matching lot stored elsewhere (pantry,
  --    fridge, manual edits — anything NOT already tracked).
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

    -- Before moving, make sure no tracked lot already exists for
    -- this product (belt-and-braces — the tracked-lot SELECT above
    -- would normally catch this). If it does, bail to mint path.
    SELECT lot_id INTO v_dup_target
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = p_product_id
       AND last_update_source = p_shelf_source
       AND qty_containers > 0
       AND lot_id <> v_match_lot_id
     LIMIT 1;

    IF v_dup_target IS NOT NULL THEN
      -- Can't move — would violate invariant. Consolidate into the
      -- existing tracked lot instead.
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

    -- Audit lifecycle event. Piggybacks on shelf_event_log.reason
    -- so debuggers can see the move decision inline with the event.
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

  -- 4) NEW: Empty-lot reuse. Before minting a fresh row that would
  --    collide with an existing empty lot on the
  --    stock_lots_merge_key(user, product, location, COALESCE(expires_on))
  --    unique index, reuse the empty lot. Prefer one that matches the
  --    fallback_location / null-expires_on tuple that the mint would
  --    have produced (those are the ones that would cause 23505);
  --    fall back to ANY empty lot for this product.
  --
  --    Rationale: a consumed-to-zero lot on one tracked source
  --    (live_shelf) followed by a refill on another source
  --    (live_scale) is the same physical container — promote it
  --    back into "in stock" by flipping qty 0 → N and stamping the
  --    new source. Same-source empty refill collapses cleanly too.
  --    See migration header for the production repro this fixes.
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
    -- Broader sweep: any empty lot for this product, regardless of
    -- location/expires. If we can reuse one whose merge-key differs,
    -- great — set its location to the fallback so future events
    -- converge. (Still safe: we only flip qty 0 → N, and the
    -- tracked-shelf invariant is partial on qty > 0 so the reused
    -- row can still coexist with anything qty=0 elsewhere.)
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

COMMIT;
