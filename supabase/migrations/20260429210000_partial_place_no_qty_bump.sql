-- 2026-04-29: live_shelf partial-bottle return MUST NOT bump qty_containers.
--
-- USER-VISIBLE BUG (production, 2026-04-29):
--   user "jdb" sees lots with fractional qty > 1.0:
--     * Gatorade Glacier Freeze:           qty=2.350 (live_shelf)
--     * Pulled Rotisserie Seasoned Chicken: qty=1.377 (live_shelf)
--     * Whole Milk 1L:                     qty=3.500 (live_shelf, older)
--   Manual entries (Hamburger Buns, Parmesan, Chocolate Milk) read qty=1.0.
--   The fractional remainder (e.g. 0.350, 0.377) is exactly
--   ``placement_weight_g / net_weight_g`` for a partial bottle.
--
-- ROOT CAUSE:
--   ``private.resolve_add_to_shelf_lot`` (last touched in migration
--   20260427060000_resolve_add_promote_cross_tracked_lot.sql) accumulates
--   qty whenever a placement event arrives for a product with an existing
--   qty>0 lot. Specifically the offending arithmetic appears in FOUR
--   places:
--
--     step 1 (in_flight pickup return), line 132:
--         qty_containers = GREATEST(qty_containers + (p_placed_weight_g / v_net_g), 0)
--     step 2 (same-source qty>0),       line 153:
--         qty_containers = qty_containers + (p_placed_weight_g / v_net_g)
--     step 2.5 (untracked promote),     line 179:
--         qty_containers = qty_containers + (p_placed_weight_g / v_net_g)
--     step 2.6 (cross-tracked promote), line 234:
--         qty_containers = qty_containers + (p_placed_weight_g / v_net_g)
--
--   When a user puts a half-empty Gatorade back on the shelf (delta_g
--   ~206g for a 591g net product), the resolver finds the existing lot,
--   adds 206/591 = 0.349 to qty_containers (originally 1.0 from the
--   wizard) → 1.349. Repeat the cycle the next day (consume part, put
--   back) and qty drifts further.
--
-- USER'S RULE (verbatim):
--   "a lot should not be much more than 1 and only that for error
--   bounds with hardware weight tracking. don't put a hard limit on
--   ctn per lot but fix the underlying issue."
--
-- DESIGN — "1 lot row = 1 physical container":
--
--   The conceptual model: each ``stock_lots`` row represents exactly
--   ONE physical container. Partial-fill state lives in
--   ``last_observed_weight_g`` (populated either here on placement, or
--   continuously by the live_weight_sync poller). Qty is not the right
--   field to track grams.
--
--   Rules per resolver step:
--
--     * NEW container on a previously-untracked product (qty<=0 OR no
--       prior lot) → mint/revive at qty = 1.0. Record the placement
--       weight in last_observed_weight_g so the UI shows fill state
--       immediately.
--
--     * RETURN of a partial bottle to a product with an existing qty>0
--       lot (steps 1, 2, 2.5, 2.6) → preserve qty, flip last_update_source
--       (only step 2.5/2.6/in_flight transitions actually flip), update
--       last_observed_weight_g. Do NOT add ``placed/net`` to qty.
--
--     * step 3 (weight-match move) already preserves qty — only flips
--       source. Untouched here.
--
--     * step 4 (empty-lot revive) — currently writes
--       ``v_qty_from_mass = placed/net`` which can be > 1 for full
--       bottles or fractional for partials. Rewrite to qty=1.0 +
--       record observation.
--
--     * step 5 (mint) — same; mint at qty=1.0.
--
-- WHY NO HEURISTIC GATE (delta_g < gross_weight_g * 0.85):
--   The original spec proposed gating on ``p_delta_g <
--   gross_weight_g * 0.85`` to detect "partial" placements. But:
--     1. ``products.gross_weight_g`` is NULLABLE, and inspection of the
--        three production-bad rows shows ALL THREE products have
--        gross_weight_g = NULL (Gatorade, Chicken, Milk). The heuristic
--        would no-op on the exact rows we need to fix.
--     2. Even with gross set, the rule "qty represents physical
--        container count" is the underlying truth. A full bottle is
--        still ONE container, not ``gross/net`` fractional containers.
--
--   So we apply the unconditional rule: existing qty>0 lot → preserve
--   qty. This is conceptually cleaner AND fixes the production data.
--
-- INVARIANT PRESERVED:
--   * stock_lots_one_per_tracked_shelf — at most one qty>0 row per
--     (user, product, last_update_source). Step 2/2.5/2.6 still
--     promote in place; the row count is unchanged.
--   * apply_shelf_event signature, partial_place_macros splice, and
--     live_weight_sync flow are untouched.
--   * Mint path of resolve_add_to_shelf_lot still inserts a row
--     (qty=1.0 instead of placed/net).
--
-- COMPANION TESTS:
--   * supabase/tests/chefbyte/live_shelf_lot_qty_clamp.test.sql — pgTAP
--     invariant: every live_shelf-tracked qty>0 lot has qty <=
--     1.0 + 0.05 (the user's "error bounds" allowance).
--   * Updates to resolve_add_promote_untracked_lot.test.sql +
--     resolve_add_promote_cross_tracked_lot.test.sql to flip the
--     "qty bumped" assertions to "qty preserved at 1.0".

BEGIN;

------------------------------------------------------------
-- 1. Rewrite resolve_add_to_shelf_lot with the new rule.
------------------------------------------------------------

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
  v_new_lot         UUID;
  v_dup_target      UUID;
  v_empty_lot       UUID;
  v_untracked_lot   UUID;
  v_untracked_count INTEGER;
  v_other_src       TEXT;
  v_cross_lot       UUID;
  v_cross_count     INTEGER;
  v_observed_g      NUMERIC;
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

  -- Per-product tolerance, floored at 50g for small containers (used by
  -- step 3's weight-match arbiter only).
  v_tolerance := GREATEST(50.0, v_net_g * 0.05);

  -- Sanitised observed weight: GREATEST(0, placed) so the
  -- last_observed_weight_g >= 0 CHECK constraint is never violated.
  v_observed_g := GREATEST(p_placed_weight_g, 0);

  -- 1) In-flight pickup return.
  --    User picked the bottle UP earlier (in_flight_since stamped),
  --    now placed it BACK on the same/another tracked shelf. Close the
  --    in-flight window. Preserve qty (the lot still represents one
  --    physical container — the user moved it, not split it).
  SELECT lot_id INTO v_tracked_lot
    FROM chefbyte.stock_lots
   WHERE user_id = p_user_id
     AND product_id = p_product_id
     AND in_flight_since IS NOT NULL
   ORDER BY in_flight_since DESC NULLS LAST
   LIMIT 1;

  IF v_tracked_lot IS NOT NULL THEN
    UPDATE chefbyte.stock_lots
       SET last_update_source     = p_shelf_source,
           last_update_ts         = p_occurred_at,
           in_flight_since        = NULL,
           pickup_event_id        = NULL,
           last_observed_weight_g = v_observed_g,
           last_observed_at       = p_occurred_at
     WHERE lot_id = v_tracked_lot;
    RETURN v_tracked_lot;
  END IF;

  -- 2) Same-source tracked qty>0 lot exists (already tracked on the
  --    incoming shelf for this product). The placement is a return of
  --    that same physical bottle. Preserve qty, refresh observation.
  SELECT lot_id INTO v_tracked_lot
    FROM chefbyte.stock_lots
   WHERE user_id = p_user_id
     AND product_id = p_product_id
     AND last_update_source = p_shelf_source
     AND qty_containers > 0
   LIMIT 1;

  IF v_tracked_lot IS NOT NULL THEN
    UPDATE chefbyte.stock_lots
       SET last_update_source     = p_shelf_source,
           last_update_ts         = p_occurred_at,
           in_flight_since        = NULL,
           pickup_event_id        = NULL,
           last_observed_weight_g = v_observed_g,
           last_observed_at       = p_occurred_at
     WHERE lot_id = v_tracked_lot;
    RETURN v_tracked_lot;
  END IF;

  -- 2.5) Untracked qty>0 lot exists for this product. The user just
  --      added a manual lot (or scanner intake). Promote it: flip
  --      source, preserve qty (the lot still represents 1 container),
  --      record observation. Single-lot guard mirrors prior behaviour.
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
       SET last_update_source     = p_shelf_source,
           last_update_ts         = p_occurred_at,
           in_flight_since        = NULL,
           pickup_event_id        = NULL,
           last_observed_weight_g = v_observed_g,
           last_observed_at       = p_occurred_at
     WHERE lot_id = v_untracked_lot;

    IF p_event_id IS NOT NULL THEN
      UPDATE chefbyte.shelf_event_log
         SET reason = 'promoted_untracked_lot'
       WHERE event_id = p_event_id;
    END IF;

    RETURN v_untracked_lot;
  END IF;

  -- 2.6) Cross-tracked-source promotion (live_scale ↔ live_shelf
  --      transfer). Same physical bottle moved between paired devices.
  --      Preserve qty + flip source.
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
       SET last_update_source     = p_shelf_source,
           last_update_ts         = p_occurred_at,
           in_flight_since        = NULL,
           pickup_event_id        = NULL,
           last_observed_weight_g = v_observed_g,
           last_observed_at       = p_occurred_at
     WHERE lot_id = v_cross_lot;

    IF p_event_id IS NOT NULL THEN
      UPDATE chefbyte.shelf_event_log
         SET reason = 'promoted_cross_tracked_lot'
       WHERE event_id = p_event_id;
    END IF;

    RETURN v_cross_lot;
  END IF;

  -- 3) Weight-match move arbiter (multi-untracked-lot disambiguator).
  --    Picks among multiple qty>0 untracked lots by weight match. We
  --    only flip source here — qty was already at the chosen value.
  --    Behaviour preserved from previous migration; the only change is
  --    we ALSO record the observation now.
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

    -- Preserve old "duplicate target absorbs" semantic: if a same-source
    -- tracked qty>0 lot exists alongside the match candidate, return
    -- that one (preserve qty, do NOT bump).
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
         SET last_update_source     = p_shelf_source,
             last_update_ts         = p_occurred_at,
             in_flight_since        = NULL,
             pickup_event_id        = NULL,
             last_observed_weight_g = v_observed_g,
             last_observed_at       = p_occurred_at
       WHERE lot_id = v_dup_target;
      RETURN v_dup_target;
    END IF;

    UPDATE chefbyte.stock_lots
       SET last_update_source     = p_shelf_source,
           last_update_ts         = p_occurred_at,
           in_flight_since        = NULL,
           pickup_event_id        = NULL,
           last_observed_weight_g = v_observed_g,
           last_observed_at       = p_occurred_at
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

  -- 4) Empty-lot reuse — revive at qty=1.0 (one container) regardless
  --    of placement weight (partial or full). Observation captures the
  --    fill level.
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
       SET qty_containers         = 1.0,
           last_update_source     = p_shelf_source,
           last_update_ts         = p_occurred_at,
           location_id            = COALESCE(location_id, p_fallback_location),
           in_flight_since        = NULL,
           pickup_event_id        = NULL,
           last_observed_weight_g = v_observed_g,
           last_observed_at       = p_occurred_at
     WHERE lot_id = v_empty_lot;

    IF p_event_id IS NOT NULL THEN
      UPDATE chefbyte.shelf_event_log
         SET reason = 'revived_empty_lot'
       WHERE event_id = p_event_id;
    END IF;

    RETURN v_empty_lot;
  END IF;

  -- 5) Mint a fresh lot at qty=1.0 (one physical container).
  --    Record the placement weight as the initial observation.
  --    expires_on auto-populated from products.default_shelf_life_days
  --    using the user's logical "today" (preserved from migration
  --    20260428010000 — the scanner client mirrors this same compute).
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
     expires_on, last_update_source, last_update_ts,
     last_observed_weight_g, last_observed_at)
  VALUES
    (p_user_id, p_product_id, p_fallback_location, 1.0,
     v_expires_on, p_shelf_source, p_occurred_at,
     v_observed_g, p_occurred_at)
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
-- 2. Backfill: clamp affected production rows to qty=1.0.
------------------------------------------------------------
-- Touches any live_shelf-tracked row with qty in (1.05, 5.0). The
-- lower bound preserves the user's "error bounds" allowance (no
-- legitimate hardware row should land in (1.0, 1.05]); the upper
-- bound avoids touching wildly anomalous rows that may indicate a
-- different bug class. As of 2026-04-29 prod state, this targets
-- exactly 3 rows: Gatorade (2.350), Chicken (1.377), Whole Milk (3.500).

UPDATE chefbyte.stock_lots
   SET qty_containers = 1.0
 WHERE last_update_source = 'live_shelf'
   AND qty_containers > 1.05
   AND qty_containers < 5.0;

COMMIT;
