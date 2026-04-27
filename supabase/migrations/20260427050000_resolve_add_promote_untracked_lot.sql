-- Fix: cloud-side counterpart to the Pi-side inventory_only candidate
-- pool fix (2026-04-27). Decision #45 codified "weight mismatches are
-- EXPECTED on live-shelf transfers — items normally arrive weighing
-- significantly less than the original tracked weight." The Pi-side
-- ``_apply_lot_update_from_classification`` was rewritten to honour
-- this (lot-picker no longer filters on weight), but the cloud-side
-- ``private.resolve_add_to_shelf_lot`` was left with the original
-- weight-tolerance gate on its "promote untracked lot" branch (step
-- 3), so a place event for a Gatorade bottle with qty=1, net_weight=900g,
-- placed-weight=663g would:
--
--   * Step 1 (in_flight)         — no match
--   * Step 2 (already-tracked)   — no match (last_update_source IS NULL,
--                                  not 'live_shelf')
--   * Step 3 (weight-match move) — REJECTED: |900-663| = 237g > 50g tolerance
--   * Step 4 (empty-lot reuse)   — no match (qty>0)
--   * Step 5 (mint)              — INSERT collides with stock_lots_merge_key
--                                  (user_id, product_id, location_id,
--                                  COALESCE(expires_on,'9999-12-31')) →
--                                  23505 → entire apply_shelf_event rolls
--                                  back → POST /shelf-ingest/event 5xx →
--                                  Pi outbox retries forever.
--
-- The user's symptom: place a Gatorade on the live-shelf, the inventory
-- page shows the row but never gets the "live-scale tracked" badge,
-- AND the Pi outbox accumulates failed events. After the Pi-side fix
-- in this commit (inventory_only candidate pool branch), the
-- classifier returns the correct product, the Pi mints a local lots
-- row, and the cloud emit fires — only to be rejected by step 5 here.
--
-- FIX
-- Insert a NEW step 2.5 between the already-tracked check (step 2) and
-- the weight-match move (step 3) that matches an untracked qty>0 lot
-- for this (user, product) and promotes it directly. This mirrors
-- decision #45's "weight is no longer a hard filter" rule on the
-- cloud side. The new branch fires ONLY when there is exactly one
-- untracked qty>0 lot — multi-lot ambiguity falls through to step 3
-- (weight tiebreaker) so the user's ranking expectation is preserved.
--
-- INVARIANT PRESERVED
-- ``stock_lots_one_per_tracked_shelf`` (partial unique on
-- (user, product, last_update_source) WHERE qty_containers > 0 AND
-- last_update_source IN ('live_shelf','live_scale')) stays intact.
-- The new branch flips ``last_update_source`` 'NULL' → 'live_shelf'
-- on a row that previously had no tracked-shelf flag, transitioning
-- it INTO the invariant predicate. Step 2 above already guards
-- against double-tracking — at most one qty>0 row per (user, product,
-- live_shelf) still holds because step 2 catches any pre-existing
-- live_shelf row first.
--
-- ROLLBACK PATH
-- Drop this migration: ``BEGIN; DROP FUNCTION ...; <prior CREATE>;
-- COMMIT;`` — the function body before this migration is the same
-- as 20260425070000_resolve_add_reuse_empty_lot.sql. The new step
-- only adds rows; nothing in the prior contract changes.

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

  -- 2.5) NEW: Promote a single untracked qty>0 lot.
  --
  --   Decision #45 / 2026-04-27 inventory-only matching: the user
  --   intaked the product through the inventory page (creating a
  --   stock_lot with last_update_source IS NULL — manual / scanner /
  --   default), then placed it on the live-shelf. The Pi-side
  --   classifier identified the product visually (inventory_only
  --   candidate-pool branch). Cloud-side: this is the SAME physical
  --   container — promote the existing untracked lot to
  --   ``last_update_source = p_shelf_source``, regardless of how
  --   much its current qty*net_weight differs from the placed mass
  --   (consumption between purchase and shelf-pairing is the
  --   expected case, NOT the edge case).
  --
  --   Constraint: only fires when EXACTLY ONE untracked qty>0 lot
  --   exists for this (user, product). Multi-lot ambiguity falls
  --   through to step 3's weight-match arbiter to keep the
  --   "pick the most likely lot when there are choices" semantics.
  --
  --   Side effect: the qty is bumped by (placed_weight / net_weight),
  --   matching step 2's behaviour. Mathematically identical to a
  --   first-time live_shelf place where step 5 minted a fresh row
  --   at qty = placed_weight/net_weight, except we instead PROMOTE
  --   the existing row and ADD to its qty.
  --
  --   Why a count guard: when the user has 2 untracked containers of
  --   the same SKU (e.g. one in the fridge and one in the cabinet,
  --   both manually intaked), the visual classifier has no way to
  --   distinguish them — step 3's weight-match is a stronger arbiter
  --   in that case. The single-lot path is the one decision #45
  --   targets: "user intaked once, placed once."
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

  -- 4) Empty-lot reuse (migration 20260425070000). Before minting a
  --    fresh row that would collide with an existing empty lot on
  --    the stock_lots_merge_key unique index, reuse the empty lot.
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
