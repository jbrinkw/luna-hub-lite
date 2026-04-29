-- 2026-04-29: live_shelf partial-place macro consumption.
--
-- DESIGN RULE (from user, 2026-04-29):
--   When a partial bottle of product P is placed on a live_shelf scale
--   and matched to an existing lot of P that was imported within the
--   last 6 hours, the consumed amount is
--       consumed_g = (product.gross_weight_g - placement_weight_g)
--   and that amount should be written as a ``chefbyte.food_logs`` macro
--   entry. This captures the typical pattern of "intake a fresh bottle,
--   drink some, place it back on the shelf".
--
--   Exception: if the OLDEST stock_lots row for product P is older than
--   6 hours, do NOT write a macro entry. We don't know what was already
--   consumed before scanning, and counting now would risk double-counting.
--
-- WHY HERE:
--   Today the live_shelf ``added`` / ``refilled`` branch in
--   ``private.apply_shelf_event`` calls ``private.resolve_add_to_shelf_lot``
--   and returns immediately. No food_logs row is written for an ADD,
--   even when the placement is clearly a partially-consumed return of a
--   freshly-intaked bottle. We splice a freshness check + food_logs
--   INSERT after the resolver returns.
--
-- IMPLEMENTATION:
--   pg_get_functiondef splice (same surgical pattern as
--   20260429110000_food_logs_usage_kind.sql). We:
--
--     1. Find the unique post-resolver block in the live_shelf
--        added/refilled branch (the ROW(v_lot_id, true, 'resolved_add')
--        construction).
--     2. Insert a freshness check + macro write AFTER the live_scale
--        pairing update and BEFORE the v_result construction.
--     3. Use ``usage_kind='partial_place_consume'`` for the food_logs
--        row when the lot is fresh, and ``usage_kind='partial_place_skipped_stale_lot'``
--        on the shelf_event_log reason when stale.
--
--   The freshness window is the OLDEST stock_lots row for the
--   user+product (per the user's spec: "if the oldest stock_lots row
--   for product P is older than 6 hours"). NOT the resolved lot — the
--   resolved lot may be brand-new (mint path) but the user may have an
--   older lot of the same product they intaked weeks ago, in which
--   case we shouldn't count macros (could double-count from the older
--   bottle that was opened first).
--
-- FRESHNESS RATIONALE (6h):
--   * 6 hours is long enough to cover "scan bottle in, leave for a
--     coffee break, come back and put it on shelf".
--   * Short enough that the user is confident no consumption happened
--     outside the import flow.
--
-- INVARIANTS PRESERVED:
--   * The mint / move / promote / revive paths in resolve_add_to_shelf_lot
--     are untouched — placement-weight stock arithmetic stays identical.
--   * Existing food_logs INSERTs in consumed/depleted branches are
--     unmodified.
--   * Backwards-compat: a placement on a stale-lot product writes
--     nothing to food_logs (= old behavior).
--
-- COMPANION TEST:
--   ``supabase/tests/chefbyte/live_shelf_partial_place_macros.test.sql``
--   covers both fresh-lot (food_logs row written, macros scaled by
--   consumed grams) and stale-lot (no food_logs, reason on log)
--   scenarios.

BEGIN;

------------------------------------------------------------
-- Splice apply_shelf_event to add partial-place macro logging.
------------------------------------------------------------

DO $patch$
DECLARE
  v_src             TEXT;
  v_old_block       TEXT;
  v_new_block       TEXT;
  v_old_count       INTEGER := 0;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private'
     AND p.proname = 'apply_shelf_event';

  IF v_src IS NULL THEN
    RAISE EXCEPTION
      '20260429180000: private.apply_shelf_event not found — cannot patch';
  END IF;

  -- Idempotency: if already patched, skip.
  IF position('partial_place_consume' IN v_src) > 0 THEN
    RAISE NOTICE
      '20260429180000: apply_shelf_event already has partial_place_consume, no-op';
    RETURN;
  END IF;

  ------------------------------------------------------------
  -- Splice 2: rewrite the live_shelf/live_scale ``added``/``refilled``
  -- branch to compute partial-place macros after the resolver returns.
  --
  -- The current branch is (lines 899-918 of canonical
  -- 20260427130000_catch_all_delta_apply.sql)::
  --
  --     v_lot_id := private.resolve_add_to_shelf_lot(
  --       p_user_id, p_product_id, p_kind, v_loc_id,
  --       GREATEST(p_delta_g, 0), v_log_id, p_occurred_at
  --     );
  --
  --     IF p_kind = 'live_scale' AND v_lot_id IS NOT NULL THEN
  --       UPDATE chefbyte.scale_pairings ...
  --     END IF;
  --
  --     v_result := ROW(v_lot_id, true, 'resolved_add');
  --
  -- We splice in macro logic between the pairing-update IF block and
  -- the v_result construction. We anchor on the unique line that opens
  -- the v_result construction: ``    v_result := ROW(v_lot_id, true,
  -- 'resolved_add');``. That literal appears exactly once in the
  -- function body.
  ------------------------------------------------------------

  v_old_block :=
    E'    v_result := ROW(v_lot_id, true, ''resolved_add'');';

  -- The new block:
  --   1. Default: skip macro write.
  --   2. Only for live_shelf (per user spec — live_scale is a separate
  --      device flow with its own macro semantics via consumed events).
  --   3. Look up product gross_weight_g + macros (re-fetch since we
  --      didn't bind them at the top of this branch).
  --   4. Look up oldest stock_lots.created_at for this user+product.
  --   5. If oldest_age <= 6h: compute consumed_g and write food_logs
  --      with usage_kind='partial_place_consume'.
  --   6. If oldest_age > 6h: write reason='partial_place_skipped_stale_lot'
  --      on the shelf_event_log row.
  --   7. Fall through to the existing v_result := ROW(...) line.
  v_new_block :=
       E'    -- Partial-place macro logging (2026-04-29 design rule).\n'
    || E'    -- When a partial bottle is placed on a live_shelf scale and the\n'
    || E'    -- oldest lot for this product is < 6h old, log the consumed\n'
    || E'    -- delta (gross - placement) as a food_logs macro entry. Stale\n'
    || E'    -- products skip the write to avoid double-counting from\n'
    || E'    -- pre-scan consumption. Locals scoped to a nested DECLARE so\n'
    || E'    -- we don''t have to splice the outer DECLARE block.\n'
    || E'    DECLARE\n'
    || E'      v_pp_gross_g       NUMERIC;\n'
    || E'      v_pp_oldest_age_s  NUMERIC;\n'
    || E'      v_pp_consumed_g    NUMERIC;\n'
    || E'      v_pp_macro_logged  BOOLEAN := false;\n'
    || E'      v_pp_svg_per       NUMERIC;\n'
    || E'      v_pp_cal           NUMERIC;\n'
    || E'      v_pp_carbs         NUMERIC;\n'
    || E'      v_pp_protein       NUMERIC;\n'
    || E'      v_pp_fat           NUMERIC;\n'
    || E'      v_pp_servings      NUMERIC;\n'
    || E'    BEGIN\n'
    || E'      IF p_kind = ''live_shelf'' AND v_lot_id IS NOT NULL\n'
    || E'         AND p_delta_g > 0 THEN\n'
    || E'        SELECT gross_weight_g, servings_per_container,\n'
    || E'               calories_per_serving, carbs_per_serving,\n'
    || E'               protein_per_serving, fat_per_serving\n'
    || E'          INTO v_pp_gross_g, v_pp_svg_per, v_pp_cal,\n'
    || E'               v_pp_carbs, v_pp_protein, v_pp_fat\n'
    || E'          FROM chefbyte.products\n'
    || E'         WHERE product_id = p_product_id AND user_id = p_user_id;\n'
    || E'\n'
    || E'        IF v_pp_gross_g IS NOT NULL AND v_pp_gross_g > p_delta_g THEN\n'
    || E'          v_pp_consumed_g := v_pp_gross_g - p_delta_g;\n'
    || E'\n'
    || E'          SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))\n'
    || E'            INTO v_pp_oldest_age_s\n'
    || E'            FROM chefbyte.stock_lots\n'
    || E'           WHERE user_id = p_user_id\n'
    || E'             AND product_id = p_product_id;\n'
    || E'\n'
    || E'          IF v_pp_oldest_age_s IS NOT NULL\n'
    || E'             AND v_pp_oldest_age_s <= 6 * 3600 THEN\n'
    || E'            v_pp_servings := (v_pp_consumed_g / v_pp_gross_g)\n'
    || E'                             * COALESCE(v_pp_svg_per, 0);\n'
    || E'            IF v_pp_servings > 0 THEN\n'
    || E'              INSERT INTO chefbyte.food_logs\n'
    || E'                (user_id, product_id, logical_date, qty_consumed, unit,\n'
    || E'                 calories, carbs, protein, fat,\n'
    || E'                 source_client_event_id, usage_kind)\n'
    || E'              VALUES\n'
    || E'                (p_user_id, p_product_id, v_logical_date,\n'
    || E'                 v_pp_servings, ''serving'',\n'
    || E'                 v_pp_servings * COALESCE(v_pp_cal,     0),\n'
    || E'                 v_pp_servings * COALESCE(v_pp_carbs,   0),\n'
    || E'                 v_pp_servings * COALESCE(v_pp_protein, 0),\n'
    || E'                 v_pp_servings * COALESCE(v_pp_fat,     0),\n'
    || E'                 p_client_event_id, ''partial_place_consume'');\n'
    || E'              v_pp_macro_logged := true;\n'
    || E'            END IF;\n'
    || E'          ELSIF v_pp_oldest_age_s IS NOT NULL THEN\n'
    || E'            UPDATE chefbyte.shelf_event_log\n'
    || E'               SET reason = ''partial_place_skipped_stale_lot''\n'
    || E'             WHERE event_id = v_log_id;\n'
    || E'          END IF;\n'
    || E'        END IF;\n'
    || E'      END IF;\n'
    || E'\n'
    || E'      v_result := ROW(v_lot_id, true,\n'
    || E'        CASE WHEN v_pp_macro_logged\n'
    || E'             THEN ''resolved_add:partial_place_consume''\n'
    || E'             ELSE ''resolved_add'' END);\n'
    || E'    END;';

  IF position(v_old_block IN v_src) = 0 THEN
    RAISE EXCEPTION
      '20260429180000: live_shelf added/refilled branch shape did not match '
      'expected (looking for v_result := ROW(v_lot_id, true, ''resolved_add''));'
      ' pg_get_functiondef format may have shifted';
  END IF;

  v_src := replace(v_src, v_old_block, v_new_block);

  ------------------------------------------------------------
  -- Recreate. CREATE OR REPLACE FUNCTION is fine here — the parameter
  -- list is unchanged from the prior migration (11 args).
  ------------------------------------------------------------
  EXECUTE v_src;
END
$patch$;

------------------------------------------------------------
-- Document canonical usage_kind values.
------------------------------------------------------------

COMMENT ON COLUMN chefbyte.food_logs.usage_kind IS
  'Provenance discriminator for consumption events. Canonical values: '
  '``in_flight_ttl_expired``, ``in_flight_return``, '
  '``in_flight_replaced_new_item``, ``reconciler_use_return``, '
  '``single_item_consumed`` (Pi-emitted via apply_shelf_event); '
  '``partial_place_consume`` (cloud-side, written when a partially '
  'consumed container is placed on a live_shelf scale within 6h of '
  'the oldest lot for the product). NULL = pre-discriminator row '
  'or older Pi binaries.';

COMMIT;
