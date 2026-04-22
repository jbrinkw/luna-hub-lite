-- Stock-lot invariant: at most ONE lot per (user_id, product_id) for each
-- tracked shelf source + a MOVE-vs-MINT resolver RPC.
--
-- CONTEXT:
--   Chocolate-milk bug (2026-04-22): user picks up a 472g partial
--   bottle of chocolate milk off the live shelf, walks it to the
--   fridge, later returns with a FULL 1672g bottle and places it on
--   the shelf. Classifier's replacement branch correctly closes the
--   in_flight 472g lot as "consumed" (old mass presumed eaten) —
--   but NEVER emits an ADD for the replacement 1672g container.
--   Result: a physical bottle sitting on the shelf that inventory
--   can't see. The Pi explicitly punts: "we have no authoritative
--   product_id to mint against" (scale_events.py:1049-1051) — but
--   in practice the classifier DID pick a lot with a known product.
--
-- DESIGN:
--   Invariant: for each user, at most ONE lot per product PER
--   "tracked shelf source" (last_update_source IN
--   ('live_shelf','live_scale')) where qty_containers > 0. This
--   disambiguates the replacement branch: the mint path can safely
--   upsert rather than risking duplicates.
--
--   MOVE-vs-MINT resolver: when an ADD event on a tracked shelf
--   needs to produce a lot, first check if the SAME product
--   already exists as a lot STORED ELSEWHERE (pantry / fridge /
--   manual) whose "weight" (qty_containers * net_weight_g)
--   matches the placed mass within max(50g, 5%). If so, MOVE
--   that lot onto the tracked shelf instead of minting a new
--   one — "the user brought the bottle back from the pantry".
--   Multi-candidate picks nearest expires_on.
--
--   Preserves Agent 1's logical_date-from-cloud-now() edit (migration
--   20260424060000): we wrap the existing apply_shelf_event body
--   and only swap the inline INSERT in the new-lot branch for a call
--   to the resolver.
--
-- NON-GOALS:
--   * Does NOT constrain the general (non-tracked) case. A user can
--     still have multiple pantry lots of milk. Only the shelf is
--     flat.
--   * Does NOT backfill historical shelf_event_log rows.
--   * Scanner-purchase flow is unchanged — always mints.

BEGIN;

------------------------------------------------------------
-- 1. Pre-existing violation consolidation
------------------------------------------------------------
-- Scan for rows that would violate the invariant and fold them.
-- Keeps the lot with the earliest expires_on (NULLS LAST), sums
-- qty_containers onto it, DELETEs the rest. Runs BEFORE the unique
-- index so an existing dataset migrates cleanly.
--
-- Empty lots (qty_containers <= 0) are left untouched — the unique
-- index is partial on qty_containers > 0, so they never conflict.

DO $$
DECLARE
  v_group           RECORD;
  v_keep_lot_id     UUID;
  v_sum_qty         NUMERIC;
  v_count_collapsed INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT user_id, product_id, last_update_source
      FROM chefbyte.stock_lots
     WHERE last_update_source IN ('live_shelf','live_scale')
       AND qty_containers > 0
     GROUP BY user_id, product_id, last_update_source
    HAVING COUNT(*) > 1
  LOOP
    SELECT lot_id INTO v_keep_lot_id
      FROM chefbyte.stock_lots
     WHERE user_id = v_group.user_id
       AND product_id = v_group.product_id
       AND last_update_source = v_group.last_update_source
       AND qty_containers > 0
     ORDER BY expires_on ASC NULLS LAST, created_at ASC
     LIMIT 1;

    SELECT SUM(qty_containers) INTO v_sum_qty
      FROM chefbyte.stock_lots
     WHERE user_id = v_group.user_id
       AND product_id = v_group.product_id
       AND last_update_source = v_group.last_update_source
       AND qty_containers > 0;

    UPDATE chefbyte.stock_lots
       SET qty_containers = v_sum_qty
     WHERE lot_id = v_keep_lot_id;

    DELETE FROM chefbyte.stock_lots
     WHERE user_id = v_group.user_id
       AND product_id = v_group.product_id
       AND last_update_source = v_group.last_update_source
       AND qty_containers > 0
       AND lot_id <> v_keep_lot_id;

    v_count_collapsed := v_count_collapsed + 1;
  END LOOP;

  IF v_count_collapsed > 0 THEN
    RAISE NOTICE
      'stock_lots invariant: consolidated % (user_id, product_id, source) duplicate groups',
      v_count_collapsed;
  END IF;
END
$$;

------------------------------------------------------------
-- 2. Partial unique index enforcing the invariant
------------------------------------------------------------
-- Predicate: only tracked sources, only live lots. Empty lots
-- (qty_containers = 0) are explicitly excluded so a re-used
-- "was depleted" lot can coexist with a freshly-minted one in
-- the ephemeral moment before the empty one is GC'd.

CREATE UNIQUE INDEX IF NOT EXISTS stock_lots_one_per_tracked_shelf
  ON chefbyte.stock_lots (user_id, product_id, last_update_source)
  WHERE last_update_source IN ('live_shelf','live_scale')
    AND qty_containers > 0;

------------------------------------------------------------
-- 3. private.resolve_add_to_shelf_lot — MOVE-vs-MINT resolver
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
  v_net_g         NUMERIC;
  v_tolerance     NUMERIC;
  v_tracked_lot   UUID;
  v_match_count   INTEGER;
  v_match_lot_id  UUID;
  v_match_ids     UUID[];
  v_qty_from_mass NUMERIC;
  v_new_lot       UUID;
  v_dup_target    UUID;
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

  -- 2) Look for a weight-matching lot stored elsewhere (pantry,
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

  -- 3) No match — mint a fresh lot.
  v_qty_from_mass := GREATEST(p_placed_weight_g / v_net_g, 0);

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
-- 4. chefbyte.resolve_add_to_shelf_lot_admin — authenticated wrapper
------------------------------------------------------------
-- Public wrapper for web UI (LiveTrack wizard, ScalesTab). Pulls
-- auth.uid() automatically so clients don't supply it.

CREATE OR REPLACE FUNCTION chefbyte.resolve_add_to_shelf_lot_admin(
  p_product_id        UUID,
  p_shelf_source      TEXT,
  p_fallback_location UUID,
  p_placed_weight_g   NUMERIC,
  p_occurred_at       TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (select auth.uid());
  v_ts      TIMESTAMPTZ := COALESCE(p_occurred_at, now());
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  RETURN private.resolve_add_to_shelf_lot(
    v_user_id, p_product_id, p_shelf_source, p_fallback_location,
    p_placed_weight_g, NULL, v_ts
  );
END;
$$;

REVOKE ALL ON FUNCTION chefbyte.resolve_add_to_shelf_lot_admin(
  UUID, TEXT, UUID, NUMERIC, TIMESTAMPTZ
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.resolve_add_to_shelf_lot_admin(
  UUID, TEXT, UUID, NUMERIC, TIMESTAMPTZ
) TO authenticated;

------------------------------------------------------------
-- 5. private.apply_shelf_event — route mint path through resolver
------------------------------------------------------------
-- PRESERVATION: This CREATE OR REPLACE is a near-verbatim copy of
-- the version in 20260424060000_logical_date_from_cloud_clock.sql
-- (Agent 1's cloud-authoritative logical_date fix). The ONLY change
-- is inside the ELSIF p_event_kind IN ('added','refilled') branch:
-- when we would otherwise INSERT a fresh stock_lots row inline, we
-- instead call private.resolve_add_to_shelf_lot (which may MOVE an
-- existing pantry lot or MINT a fresh one).
--
-- Preserved verbatim from Agent 1's version:
--   * Cloud-now() logical_date derivation at line `v_logical_date :=
--     private.get_logical_date(now(), v_tz, v_dsh);`
--   * stock_lots.last_update_ts = p_occurred_at writes (Pi timestamp
--     preserved for forensics even though logical_date is cloud-derived)
--   * Idempotency via shelf_event_log UNIQUE(user_id, client_event_id)
--   * pi_event_id back-fill on duplicate client_event_id
--   * in_flight_since/pickup_event_id cleared on add/refill
--
-- Changed: the fresh-lot INSERT (previously a direct INSERT INTO
-- stock_lots) now routes via resolve_add_to_shelf_lot so a pantry
-- lot of the same product with matching weight gets MOVED onto the
-- shelf instead of duplicated.

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
  -- Cloud-authoritative logical_date. Preserved verbatim from
  -- 20260424060000_logical_date_from_cloud_clock.sql — see that
  -- migration's header for rationale.
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
    -- Tracked-shelf events (live_shelf / live_scale) route through
    -- the MOVE-vs-MINT resolver. catch_all keeps the legacy inline
    -- INSERT path — it's explicitly the "unsorted" bucket and has
    -- no tracked-shelf invariant.
    IF p_kind IN ('live_shelf','live_scale') THEN
      -- Pick a fallback location in case the resolver mints:
      -- reuse the first location for this user (same logic the
      -- legacy mint path used). If the user has no locations,
      -- the resolver would fail, so guard first for a nicer error.
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
             -- Preserve reason the resolver wrote (moved/minted/etc.).
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    -- ── Non-tracked (catch_all) path — legacy behaviour preserved ──
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

COMMIT;
