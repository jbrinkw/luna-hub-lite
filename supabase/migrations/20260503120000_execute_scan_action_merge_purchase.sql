-- Pi USB scanner forwarder — merge purchase scans into matching lots.
--
-- Bug shape (user-reported 2026-05-03):
--   chefbyte.scan_transactions for a Pi USB user shows repeated rows
--   like "duplicate key value violates unique constraint
--   stock_lots_merge_key" — every purchase scan after the first one of
--   the same product on the same day errors out and fails to apply.
--
-- Root cause:
--   `private.execute_scan_action`'s purchase branch unconditionally
--   INSERTs into chefbyte.stock_lots. The web ScannerPage merge logic
--   collapses repeat purchases into the existing matching lot before
--   the cloud write, so it never hits this. The Pi USB path sends each
--   scan straight to execute_scan_action with no client-side merge,
--   and the second scan onward collides with the
--   `stock_lots_merge_key` UNIQUE INDEX on
--   (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31')).
--
-- Fix:
--   Use INSERT … ON CONFLICT … DO UPDATE — the canonical merge pattern
--   already used by `private.recompute_remaining_stock` (migration
--   20260303040500) and `private.unmark_meal_done` (20260305010000).
--   Targets the same expression (`COALESCE(expires_on, '9999-12-31')`)
--   so the conflict_target syntactically matches the unique index.
--   ``last_update_ts`` bumps on merge so realtime subscribers see the
--   movement.
--
-- Function body is otherwise unchanged from
-- 20260503100100_execute_scan_action_fn.sql; only the purchase branch
-- INSERT becomes an UPSERT.

CREATE OR REPLACE FUNCTION private.execute_scan_action(
  p_user_id            UUID,
  p_product_id         UUID,
  p_mode               TEXT,
  p_qty                NUMERIC,
  p_unit               TEXT,
  p_nutrition_snapshot JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tz                       TEXT;
  v_dsh                      INTEGER;
  v_logical_date             DATE;
  v_default_location         UUID;
  v_lot_id                   UUID;
  v_food_log_id              UUID;
  v_cart_item_id             UUID;
  v_shelf_life_days          INT;
  v_expires_on               DATE;
BEGIN
  -- Resolve logical_date from the user's profile (timezone + day_start_hour).
  SELECT timezone, day_start_hour
    INTO v_tz, v_dsh
    FROM hub.profiles
   WHERE user_id = p_user_id;
  IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
  IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
  v_logical_date := private.get_logical_date(now(), v_tz, v_dsh);

  IF p_mode = 'purchase' THEN
    SELECT default_shelf_life_days
      INTO v_shelf_life_days
      FROM chefbyte.products
     WHERE product_id = p_product_id
       AND user_id    = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_not_found_or_unauthorized';
    END IF;

    SELECT location_id
      INTO v_default_location
      FROM chefbyte.locations
     WHERE user_id = p_user_id
     ORDER BY created_at ASC
     LIMIT 1;

    IF v_default_location IS NULL THEN
      RAISE EXCEPTION 'no_location_configured';
    END IF;

    IF v_shelf_life_days IS NOT NULL AND v_shelf_life_days > 0 THEN
      v_expires_on := v_logical_date + (v_shelf_life_days || ' days')::interval;
    ELSE
      v_expires_on := NULL;
    END IF;

    -- Merge-or-insert: when the (user, product, location, expires_on)
    -- tuple already has a stock_lots row, increment its qty instead of
    -- erroring on the unique index. Uses the same conflict_target
    -- expression as the merge_key so postgres recognizes the match
    -- (NULL-safe via the COALESCE sentinel).
    INSERT INTO chefbyte.stock_lots (
      user_id, product_id, location_id,
      qty_containers, expires_on,
      last_update_source, last_update_ts
    ) VALUES (
      p_user_id, p_product_id, v_default_location,
      COALESCE(p_qty, 1), v_expires_on,
      'manual', now()
    )
    ON CONFLICT (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31'::date))
    DO UPDATE SET
      qty_containers     = chefbyte.stock_lots.qty_containers + EXCLUDED.qty_containers,
      last_update_source = 'manual',
      last_update_ts     = now()
    RETURNING lot_id INTO v_lot_id;

    RETURN jsonb_build_object('applied_lot_id', v_lot_id);

  ELSIF p_mode IN ('consume_macros', 'consume_no_macros') THEN
    PERFORM 1 FROM chefbyte.products
      WHERE product_id = p_product_id
        AND user_id    = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_not_found_or_unauthorized';
    END IF;

    PERFORM private.consume_product(
      p_user_id              => p_user_id,
      p_product_id           => p_product_id,
      p_qty                  => COALESCE(p_qty, 1),
      p_unit                 => COALESCE(p_unit, 'serving'),
      p_log_macros           => (p_mode = 'consume_macros'),
      p_logical_date         => v_logical_date,
      p_confirm_large_amount => TRUE
    );

    IF p_mode = 'consume_macros' THEN
      SELECT log_id
        INTO v_food_log_id
        FROM chefbyte.food_logs
       WHERE user_id      = p_user_id
         AND product_id   = p_product_id
         AND logical_date = v_logical_date
       ORDER BY created_at DESC
       LIMIT 1;
    END IF;

    -- applied_lot_id intentionally NULL for consume — multiple lots may
    -- have been touched (FEFO waterfall), and the audit row's primary
    -- void hook for consume is applied_food_log_id (delete the food_log
    -- on void). Stock decrements are not directly reversible from a
    -- single lot id without losing FEFO semantics.
    RETURN jsonb_build_object(
      'applied_food_log_id', v_food_log_id,
      'applied_lot_id',      NULL::uuid
    );

  ELSIF p_mode = 'shopping' THEN
    INSERT INTO chefbyte.shopping_list (user_id, product_id, qty_containers)
    VALUES (p_user_id, p_product_id, COALESCE(p_qty, 1))
    ON CONFLICT (user_id, product_id) DO UPDATE
       SET qty_containers = chefbyte.shopping_list.qty_containers + EXCLUDED.qty_containers
    RETURNING cart_item_id INTO v_cart_item_id;

    RETURN jsonb_build_object('applied_cart_item_id', v_cart_item_id);

  ELSE
    RAISE EXCEPTION 'unknown_mode: %', p_mode;
  END IF;
END;
$$;

-- Re-run grants in case CREATE OR REPLACE dropped them. Original grants
-- from 20260503100100_execute_scan_action_fn.sql preserved verbatim.
REVOKE ALL ON FUNCTION private.execute_scan_action(
  UUID, UUID, TEXT, NUMERIC, TEXT, JSONB
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.execute_scan_action(
  UUID, UUID, TEXT, NUMERIC, TEXT, JSONB
) TO authenticated, service_role;

COMMENT ON FUNCTION private.execute_scan_action(
  UUID, UUID, TEXT, NUMERIC, TEXT, JSONB
) IS
  'Apply a scan to chefbyte state (purchase / consume_macros / '
  'consume_no_macros / shopping). Purchase merges into existing matching '
  'lots via ON CONFLICT on stock_lots_merge_key (mirrors the web '
  'ScannerPage merge so Pi USB and web behave identically). Returns '
  'JSONB with applied_lot_id / applied_food_log_id / applied_cart_item_id '
  'keys for the scan_transactions audit row. Consume modes delegate to '
  'private.consume_product (FEFO waterfall + qty bounds + macros invariant).';
