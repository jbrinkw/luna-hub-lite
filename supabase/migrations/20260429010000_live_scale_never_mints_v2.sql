-- single_track (live_scale) NEVER mints + NEVER accumulates qty.
--
-- USER BUG (2026-04-28):
--   "I just scanned a gallon of milk, bringing my inventory from 0 to 1
--    container, and then I put it on the single track scale, and now I
--    have 2 containers."
--
--   Sequence:
--     1. Scanner add → wizard inserts stock_lots row (qty=1.0,
--        last_update_source=NULL).
--     2. User places gallon on paired live_scale → Pi emits ``refilled``
--        with delta_g≈3677g.
--     3. apply_shelf_event's live_scale ADD branch routes through
--        private.resolve_add_to_shelf_lot, which hits step 2.5
--        (promote untracked lot) — promotes the wizard lot to
--        last_update_source='live_scale' AND ADDS qty (3677/3677 ≈ 1.0)
--        on top of the existing 1.0 → final qty = 2.0. User sees "2 ctn".
--
-- USER'S HARD RULE (this migration enforces it structurally):
--
--   A single-track (live_scale) ADD/refilled event MUST NEVER mint a new
--   stock_lots row, AND MUST NEVER accumulate qty onto an existing lot.
--   live_scale's job for ADD events is ONLY to claim an existing lot for
--   the paired product (auto-pair + flip last_update_source). Qty
--   tracking happens via consumed/depleted events later.
--
-- DESIGN — split the live_shelf/live_scale ADD branch into two:
--
--   * live_shelf ADD branch: UNCHANGED. Continues to route through
--     private.resolve_add_to_shelf_lot (which handles the legitimate
--     "promote untracked lot + add qty from placed weight" path that
--     the resolve_add_promote_* tests pin).
--
--   * live_scale ADD branch (NEW BEHAVIOUR): pure claim-or-no-op.
--       1. Find an existing lot for (user, product) using a tiered
--          search:
--            a. The currently-pinned lot via scale_pairings.lot_id
--               (already paired — flip the same lot).
--            b. An in-flight lot for this product (the user is moving
--               the bottle from shelf → scale; clear in_flight, claim).
--            c. Any qty>0 lot for this product, FEFO order.
--            d. Any qty=0 lot for this product (revive a previously
--               depleted lot rather than minting).
--       2. If a lot is found: UPDATE scale_pairings.lot_id, flip
--          last_update_source='live_scale', clear in_flight markers,
--          KEEP qty_containers UNCHANGED. Reason='live_scale_claim'.
--       3. If no lot is found: applied=true, no DB mutation, reason
--          ='live_scale_no_lot_no_op'. The event is acknowledged so
--          the EMIT→HANDLE matrix invariant is satisfied; the Pi's
--          retry queue clears.
--
--   The ADD branch NEVER mutates qty_containers. Stock-tracking from
--   the scale's continuous weight readings happens through the
--   consumed/depleted branches (which already handle live_scale
--   correctly).
--
-- WHY THE PREVIOUS ATTEMPT FAILED (commits 74a02407 + 2a14d4e6):
--
--   1. It introduced a new p_after_weight_g parameter on apply_shelf_event,
--      changing SET semantics. SET semantics broke
--      stock_lots_in_flight.test.sql case 6 because the test expected
--      in_flight_since to clear without setting qty.
--   2. It modified the discarded branch in passing (last_update_source
--      = p_kind instead of 'manual_discard'), breaking
--      shelf_event_discarded.test.sql.
--   3. It modified the in_flight_pickup/return branches' reason strings
--      and required-arg shapes, breaking
--      shelf_event_in_flight_pickup.test.sql.
--   4. It rejected p_shelf_source='live_scale' inside
--      resolve_add_to_shelf_lot, which broke the matrix EMIT→HANDLE
--      invariant for refilled events with no existing lot.
--
--   This migration is SURGICAL: only the live_shelf/live_scale ADD
--   branch's `IF p_kind IN ('live_shelf','live_scale') THEN ... END IF`
--   block is replaced. Every other branch (consumed, depleted, discarded,
--   in_flight_pickup, in_flight_return, catch_all_*) is byte-for-byte
--   untouched, preserving every existing test contract.
--
-- IMPLEMENTATION:
--   Reuse the same pg_get_functiondef-based splice pattern that
--   20260428050000_pickup_weight_g_for_live_shelf.sql introduced. Match
--   the exact source block emitted by 20260428010000 (verified via
--   `supabase db dump --local --schema private` before authoring this
--   migration).
--
-- INVARIANT PRESERVED:
--   * resolve_add_to_shelf_lot's signature + body unchanged. Tests for
--     resolve_add_promote_untracked_lot + resolve_add_promote_cross_tracked_lot
--     keep passing because they call with p_shelf_source='live_shelf' only.
--   * apply_shelf_event's signature unchanged (10-arg).
--   * apply_shelf_event_admin's signatures unchanged.
--   * shelf-ingest edge function does NOT need updating.
--
-- COMPANION TEST:
--   supabase/tests/invariants/live_scale_never_mints.test.sql (added
--   alongside this migration). 8 assertions covering: bug repro
--   (qty=1 stays at 1, no mint, claim flips source) + no-lot path
--   (no mint, applied=true). The mutation that re-introduces
--   `qty + delta_c` arithmetic on the live_scale ADD branch trips
--   assertion 2 (qty went up), the mutation that adds a `mint a new
--   row` fallback trips assertion 7 (a row appeared on a no-lot input).

BEGIN;

DO $patch$
DECLARE
  v_src        TEXT;
  v_old_block  TEXT;
  v_new_block  TEXT;
  v_pos_old    INTEGER;
  v_pos_new    INTEGER;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private'
     AND p.proname = 'apply_shelf_event';

  IF v_src IS NULL THEN
    RAISE EXCEPTION
      '20260429010000: private.apply_shelf_event not found — cannot patch';
  END IF;

  -- Old block: the unified live_shelf/live_scale ADD path that routes
  -- BOTH kinds through resolve_add_to_shelf_lot. The exact whitespace
  -- must match the source emitted by 20260428010000. (verified via
  -- pg_get_functiondef on a fresh local DB before authoring this).
  v_old_block := E'    IF p_kind IN (''live_shelf'',''live_scale'') THEN\n'
              || E'      SELECT location_id INTO v_loc_id\n'
              || E'        FROM chefbyte.locations\n'
              || E'       WHERE user_id = p_user_id\n'
              || E'       ORDER BY created_at ASC\n'
              || E'       LIMIT 1;\n'
              || E'\n'
              || E'      IF v_loc_id IS NULL THEN\n'
              || E'        v_result := ROW(NULL::UUID, false, ''user has no locations'');\n'
              || E'        UPDATE chefbyte.shelf_event_log\n'
              || E'           SET applied = v_result.applied,\n'
              || E'               resolved_lot_id = v_result.resolved_lot_id,\n'
              || E'               reason = v_result.reason\n'
              || E'         WHERE event_id = v_log_id;\n'
              || E'        RETURN v_result;\n'
              || E'      END IF;\n'
              || E'\n'
              || E'      v_lot_id := private.resolve_add_to_shelf_lot(\n'
              || E'        p_user_id, p_product_id, p_kind, v_loc_id,\n'
              || E'        GREATEST(p_delta_g, 0), v_log_id, p_occurred_at\n'
              || E'      );\n'
              || E'\n'
              || E'      IF p_kind = ''live_scale'' AND v_lot_id IS NOT NULL THEN\n'
              || E'        UPDATE chefbyte.scale_pairings\n'
              || E'           SET lot_id = v_lot_id\n'
              || E'         WHERE user_id = p_user_id\n'
              || E'           AND device_id = p_device_id\n'
              || E'           AND scale_id = p_scale_id\n'
              || E'           AND kind = ''live_scale''\n'
              || E'           AND lot_id IS NULL;\n'
              || E'      END IF;\n'
              || E'\n'
              || E'      v_result := ROW(v_lot_id, true, ''resolved_add'');\n'
              || E'      UPDATE chefbyte.shelf_event_log\n'
              || E'         SET applied = v_result.applied,\n'
              || E'             resolved_lot_id = v_result.resolved_lot_id\n'
              || E'       WHERE event_id = v_log_id;\n'
              || E'      RETURN v_result;\n'
              || E'    END IF;';

  -- New block: split into two — live_shelf unchanged, live_scale gets
  -- the claim-or-no-op semantics.
  v_new_block := E'    IF p_kind = ''live_shelf'' THEN\n'
              || E'      SELECT location_id INTO v_loc_id\n'
              || E'        FROM chefbyte.locations\n'
              || E'       WHERE user_id = p_user_id\n'
              || E'       ORDER BY created_at ASC\n'
              || E'       LIMIT 1;\n'
              || E'\n'
              || E'      IF v_loc_id IS NULL THEN\n'
              || E'        v_result := ROW(NULL::UUID, false, ''user has no locations'');\n'
              || E'        UPDATE chefbyte.shelf_event_log\n'
              || E'           SET applied = v_result.applied,\n'
              || E'               resolved_lot_id = v_result.resolved_lot_id,\n'
              || E'               reason = v_result.reason\n'
              || E'         WHERE event_id = v_log_id;\n'
              || E'        RETURN v_result;\n'
              || E'      END IF;\n'
              || E'\n'
              || E'      v_lot_id := private.resolve_add_to_shelf_lot(\n'
              || E'        p_user_id, p_product_id, p_kind, v_loc_id,\n'
              || E'        GREATEST(p_delta_g, 0), v_log_id, p_occurred_at\n'
              || E'      );\n'
              || E'\n'
              || E'      v_result := ROW(v_lot_id, true, ''resolved_add'');\n'
              || E'      UPDATE chefbyte.shelf_event_log\n'
              || E'         SET applied = v_result.applied,\n'
              || E'             resolved_lot_id = v_result.resolved_lot_id\n'
              || E'       WHERE event_id = v_log_id;\n'
              || E'      RETURN v_result;\n'
              || E'    END IF;\n'
              || E'\n'
              || E'    IF p_kind = ''live_scale'' THEN\n'
              || E'      -- 2026-04-29 single_track-never-mints: ADD/refilled\n'
              || E'      -- events from a live_scale must NEVER mint a new lot\n'
              || E'      -- and MUST NEVER accumulate qty onto an existing lot.\n'
              || E'      -- The legitimate behaviour is ''claim an existing lot\n'
              || E'      -- for the paired product''. See migration\n'
              || E'      -- 20260429010000 header for the user-bug context.\n'
              || E'      --\n'
              || E'      -- Tier 1: pinned lot via scale_pairings.lot_id.\n'
              || E'      SELECT sp.lot_id INTO v_lot_id\n'
              || E'        FROM chefbyte.scale_pairings sp\n'
              || E'       WHERE sp.user_id = p_user_id\n'
              || E'         AND sp.device_id = p_device_id\n'
              || E'         AND sp.scale_id = p_scale_id\n'
              || E'         AND sp.kind = ''live_scale'';\n'
              || E'\n'
              || E'      IF v_lot_id IS NOT NULL THEN\n'
              || E'        -- Verify the pinned lot still exists for this user+product.\n'
              || E'        IF NOT EXISTS (\n'
              || E'          SELECT 1 FROM chefbyte.stock_lots\n'
              || E'           WHERE lot_id = v_lot_id\n'
              || E'             AND user_id = p_user_id\n'
              || E'             AND product_id = p_product_id\n'
              || E'        ) THEN\n'
              || E'          v_lot_id := NULL;\n'
              || E'        END IF;\n'
              || E'      END IF;\n'
              || E'\n'
              || E'      -- Tier 2: in-flight lot for this product (bottle moved\n'
              || E'      -- from shelf → scale).\n'
              || E'      IF v_lot_id IS NULL THEN\n'
              || E'        SELECT lot_id INTO v_lot_id\n'
              || E'          FROM chefbyte.stock_lots\n'
              || E'         WHERE user_id = p_user_id\n'
              || E'           AND product_id = p_product_id\n'
              || E'           AND in_flight_since IS NOT NULL\n'
              || E'         ORDER BY in_flight_since DESC NULLS LAST\n'
              || E'         LIMIT 1;\n'
              || E'      END IF;\n'
              || E'\n'
              || E'      -- Tier 3: any qty>0 lot for this product (FEFO).\n'
              || E'      IF v_lot_id IS NULL THEN\n'
              || E'        SELECT lot_id INTO v_lot_id\n'
              || E'          FROM chefbyte.stock_lots\n'
              || E'         WHERE user_id = p_user_id\n'
              || E'           AND product_id = p_product_id\n'
              || E'           AND qty_containers > 0\n'
              || E'         ORDER BY expires_on ASC NULLS LAST,\n'
              || E'                  last_update_ts DESC NULLS LAST,\n'
              || E'                  created_at DESC\n'
              || E'         LIMIT 1;\n'
              || E'      END IF;\n'
              || E'\n'
              || E'      -- Tier 4: any qty=0 lot for this product (revive\n'
              || E'      -- previously-depleted lot rather than minting).\n'
              || E'      IF v_lot_id IS NULL THEN\n'
              || E'        SELECT lot_id INTO v_lot_id\n'
              || E'          FROM chefbyte.stock_lots\n'
              || E'         WHERE user_id = p_user_id\n'
              || E'           AND product_id = p_product_id\n'
              || E'         ORDER BY last_update_ts DESC NULLS LAST,\n'
              || E'                  created_at DESC\n'
              || E'         LIMIT 1;\n'
              || E'      END IF;\n'
              || E'\n'
              || E'      IF v_lot_id IS NULL THEN\n'
              || E'        -- No candidate lot. Acknowledge with applied=true\n'
              || E'        -- (matrix EMIT→HANDLE invariant) but do NOT mint.\n'
              || E'        v_result := ROW(NULL::UUID, true, ''live_scale_no_lot_no_op'');\n'
              || E'        UPDATE chefbyte.shelf_event_log\n'
              || E'           SET applied = v_result.applied,\n'
              || E'               resolved_lot_id = v_result.resolved_lot_id,\n'
              || E'               reason = v_result.reason\n'
              || E'         WHERE event_id = v_log_id;\n'
              || E'        RETURN v_result;\n'
              || E'      END IF;\n'
              || E'\n'
              || E'      -- Claim the chosen lot. Flip last_update_source to\n'
              || E'      -- live_scale + clear in_flight markers + KEEP qty.\n'
              || E'      UPDATE chefbyte.stock_lots\n'
              || E'         SET last_update_source = ''live_scale'',\n'
              || E'             last_update_ts     = p_occurred_at,\n'
              || E'             in_flight_since    = NULL,\n'
              || E'             in_flight_kind     = NULL,\n'
              || E'             pickup_event_id    = NULL,\n'
              || E'             pickup_weight_g    = NULL\n'
              || E'       WHERE lot_id = v_lot_id\n'
              || E'         AND user_id = p_user_id;\n'
              || E'\n'
              || E'      -- Auto-pair the scale to the claimed lot.\n'
              || E'      UPDATE chefbyte.scale_pairings\n'
              || E'         SET lot_id = v_lot_id\n'
              || E'       WHERE user_id = p_user_id\n'
              || E'         AND device_id = p_device_id\n'
              || E'         AND scale_id = p_scale_id\n'
              || E'         AND kind = ''live_scale''\n'
              || E'         AND lot_id IS DISTINCT FROM v_lot_id;\n'
              || E'\n'
              || E'      v_result := ROW(v_lot_id, true, ''live_scale_claim'');\n'
              || E'      UPDATE chefbyte.shelf_event_log\n'
              || E'         SET applied = v_result.applied,\n'
              || E'             resolved_lot_id = v_result.resolved_lot_id,\n'
              || E'             reason = v_result.reason\n'
              || E'       WHERE event_id = v_log_id;\n'
              || E'      RETURN v_result;\n'
              || E'    END IF;';

  v_pos_new := position(v_new_block IN v_src);
  IF v_pos_new > 0 THEN
    RAISE NOTICE
      '20260429010000: live_scale claim-or-no-op patch already present, no-op';
    RETURN;
  END IF;

  v_pos_old := position(v_old_block IN v_src);
  IF v_pos_old = 0 THEN
    RAISE EXCEPTION
      '20260429010000: live_shelf/live_scale ADD block not found in '
      'private.apply_shelf_event source — schema drift suspected. '
      'Manual reconciliation required.';
  END IF;

  v_src := replace(v_src, v_old_block, v_new_block);
  EXECUTE v_src;
END
$patch$;

COMMIT;
