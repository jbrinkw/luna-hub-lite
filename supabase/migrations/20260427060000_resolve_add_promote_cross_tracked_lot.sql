-- Fix: cloud-side gap in private.resolve_add_to_shelf_lot when a tracked
-- lot for the same (user, product) exists under the OTHER tracked source
-- (live_scale ↔ live_shelf transfer).
--
-- CONTEXT (2026-04-27, post f34b811):
--   The 2026-04-27 inventory-only matching migration
--   (20260427050000_resolve_add_promote_untracked_lot.sql) added step 2.5
--   to promote a single untracked qty>0 lot to live_shelf. But its
--   predicate explicitly filters OUT lots tracked by the OTHER scale
--   source:
--
--       AND (last_update_source IS NULL
--            OR last_update_source NOT IN ('live_shelf','live_scale'))
--
--   This leaves a gap. When a user physically transfers a tracked lot
--   between a live_scale (e.g. countertop scale-03) and the live_shelf
--   (fridge shelf scale-01), no branch matches:
--     * Step 1 (in_flight)         — no in_flight_since on the lot
--     * Step 2 (same-source tracked) — last_update_source is the OTHER
--                                       tracked source, not p_shelf_source
--     * Step 2.5 (untracked promote) — predicate excludes tracked lots
--     * Step 3 (weight-match move)   — same predicate as step 2.5
--                                       (excludes tracked lots)
--     * Step 4 (empty-lot reuse)     — qty>0, doesn't match
--     * Step 5 (mint)                — INSERT collides with
--                                       stock_lots_merge_key
--                                       (user, product, location, expires_on)
--                                       → 23505 → apply_shelf_event rolls
--                                       back → POST /shelf-ingest/event
--                                       500 → Pi outbox retries forever
--
-- USER SYMPTOM:
--   Two stuck cloud_outbox rows on the Pi for the user's pulled chicken
--   container, last touched 2026-04-22 on a live_scale (counter scale).
--   On 2026-04-27 the user placed the same physical container on the
--   live_shelf for fridge weight tracking. The Pi's classifier
--   identified the product visually and emitted an `added` event with
--   kind=live_shelf — and got a 500 every retry. Cloud
--   stock_lots.qty_containers stayed pinned to the old live_scale value;
--   the live-shelf badge never appeared in the inventory page.
--
-- FIX:
--   Insert step 2.6 BEFORE step 3 (weight-match) that promotes a single
--   tracked qty>0 lot under the OTHER tracked source to p_shelf_source.
--   The semantics mirror step 2.5 (single-lot guard, qty bumped by
--   placed_weight/net_weight), and the "cross-tracked promotion" is
--   audited via a new shelf_event_log.reason='promoted_cross_tracked_lot'.
--
-- INVARIANT PRESERVED:
--   stock_lots_one_per_tracked_shelf is a partial unique on
--   (user, product, last_update_source) WHERE qty_containers > 0 AND
--   last_update_source IN ('live_shelf','live_scale'). Step 2 already
--   guards against double-tracking on the SAME source. The new branch
--   flips the source from one tracked literal to the other on a single
--   row — at most one (user, product, p_shelf_source) qty>0 row still
--   holds because step 2 catches any pre-existing same-source row first.
--   The previous source-row simply disappears as the row's
--   last_update_source is overwritten — exactly the "transfer" semantic.
--
-- COUNT GUARD:
--   Like step 2.5, fires only when EXACTLY ONE qty>0 lot exists under
--   the OTHER tracked source for this (user, product). Multi-lot
--   ambiguity (two scales tracking the same SKU) falls through to
--   step 3's weight-match arbiter — that's still the right choice for
--   "pick the most likely lot when there are multiple candidates".
--
-- ROLLBACK PATH:
--   Drop this migration to revert to the 20260427050000 body. The new
--   branch only PROMOTES rows — no data shape change, no schema change.

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
  v_other_src       TEXT;
  v_cross_lot       UUID;
  v_cross_count     INTEGER;
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
  --    shelf, that's the single-source-of-truth — just increment.
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
  --   See migration 20260427050000 for the full rationale (decision #45 /
  --   inventory-only matching). Single-lot path; multi-lot ambiguity
  --   falls through to step 3.
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

  -- 2.6) NEW: Promote a single qty>0 lot tracked by the OTHER
  --      scale source (live_scale ↔ live_shelf transfer).
  --
  --   Scenario: user has been tracking a chicken container on the
  --   countertop scale (live_scale) for portioning. Today they put
  --   the same physical container in the fridge on the live_shelf.
  --   The Pi visually identifies the product and fires an `added`
  --   event with kind=live_shelf. Without this branch:
  --     * Step 2 misses (last_update_source='live_scale' ≠ 'live_shelf')
  --     * Step 2.5 misses (the predicate excludes tracked lots)
  --     * Step 3 misses (same exclusion as 2.5)
  --     * Step 4 misses (qty > 0)
  --     * Step 5 hits stock_lots_merge_key violation → 500 → Pi retries
  --
  --   Semantically, this IS a tracked-source migration — the user is
  --   physically moving the tracked container from one shelf to the
  --   other. Promote (i.e. flip last_update_source) and bump qty by
  --   the placed mass, mirroring step 2's behaviour for same-source.
  --
  --   Single-lot guard mirrors step 2.5: when two tracked lots exist
  --   under the other source (multiple paired scales of the same SKU),
  --   step 3's weight-match is a stronger arbiter and we defer.
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

  -- 4) Empty-lot reuse (migration 20260425070000).
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
