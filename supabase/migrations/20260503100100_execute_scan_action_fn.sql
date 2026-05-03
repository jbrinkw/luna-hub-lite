-- Pi USB scanner forwarder (Task 2): private.execute_scan_action
--
-- Single SECURITY DEFINER entry point for applying a scan to chefbyte
-- state. The Pi USB forwarder edge function and the web client both use
-- it (the web flow can call it directly via service_role, or a future
-- chefbyte.* public wrapper). Returns a JSONB payload whose
-- ``applied_*_id`` keys are recorded on the matching scan_transactions
-- row for audit + void semantics.
--
-- Modes:
--   * purchase           — mint a stock_lot in the oldest location.
--   * consume_macros     — FEFO waterfall across lots AND write a food_log.
--   * consume_no_macros  — FEFO waterfall across lots ONLY (no food_log).
--   * shopping           — upsert a shopping_list row (qty merged on conflict).
--
-- Notes:
--   * consume_* delegates to private.consume_product, which:
--       - validates qty (positive, hard ceiling 10000, soft calorie ceiling)
--       - waterfalls FEFO across ALL lots (NULLS LAST), not just one
--       - floors stock at 0 — macros are still logged for the full
--         consumed amount, matching the project-wide convention
--       - raises 'Product not found or not owned by user' on missing product
--   * purchase stamps expires_on from products.default_shelf_life_days
--     (matches web scanner — see ScannerPage.tsx::computeExpiresOn). This
--     is the canonical field for stock_lots.expires_on per
--     20260419090000_product_default_shelf_life.sql.
--   * logical_date is resolved from hub.profiles (timezone + day_start_hour)
--     using the canonical private.get_logical_date(ts, tz, dsh) primitive.
--   * stock_lots.updated_at is auto-bumped by the project's BEFORE UPDATE
--     trigger (set_stock_lots_updated_at), so no manual touch needed.

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
    -- Validate product exists for this user (canonical raise; mirrors
    -- consume_product's check so all branches behave consistently).
    SELECT default_shelf_life_days
      INTO v_shelf_life_days
      FROM chefbyte.products
     WHERE product_id = p_product_id
       AND user_id    = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_not_found_or_unauthorized';
    END IF;

    -- Pick the oldest location (first one seeded by activate_app — Fridge)
    -- so the lot lands somewhere sensible by default.
    SELECT location_id
      INTO v_default_location
      FROM chefbyte.locations
     WHERE user_id = p_user_id
     ORDER BY created_at ASC
     LIMIT 1;

    IF v_default_location IS NULL THEN
      RAISE EXCEPTION 'no_location_configured';
    END IF;

    -- Compute expires_on from default_shelf_life_days (NULL = non-perishable
    -- / unknown — leave expires_on unset to sort last in FEFO order).
    -- Mirrors apps/web/src/pages/chefbyte/ScannerPage.tsx::computeExpiresOn.
    IF v_shelf_life_days IS NOT NULL AND v_shelf_life_days > 0 THEN
      v_expires_on := v_logical_date + (v_shelf_life_days || ' days')::interval;
    ELSE
      v_expires_on := NULL;
    END IF;

    INSERT INTO chefbyte.stock_lots (
      user_id, product_id, location_id,
      qty_containers, expires_on,
      last_update_source, last_update_ts
    ) VALUES (
      p_user_id, p_product_id, v_default_location,
      COALESCE(p_qty, 1), v_expires_on,
      'manual', now()
    )
    RETURNING lot_id INTO v_lot_id;

    RETURN jsonb_build_object('applied_lot_id', v_lot_id);

  ELSIF p_mode IN ('consume_macros', 'consume_no_macros') THEN
    -- Validate product exists for this user. consume_product also raises on
    -- missing product, but its message ('Product not found or not owned by
    -- user') is human-prose; we want the canonical machine-readable form
    -- to match purchase + the test expectations.
    PERFORM 1 FROM chefbyte.products
      WHERE product_id = p_product_id
        AND user_id    = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_not_found_or_unauthorized';
    END IF;

    -- Delegate to canonical private.consume_product. This:
    --   * waterfalls FEFO across ALL lots (not just LIMIT 1)
    --   * validates qty > 0 and qty <= HARD_QTY_CEILING (10000)
    --   * gates suspicious calorie loads behind p_confirm_large_amount
    --     (we pass TRUE — the scan already confirmed the product, mirrors
    --     the human-UI scanner path described in 20260424050000_consume_bounds.sql)
    --   * conditionally writes a food_log when p_log_macros=TRUE
    --   * floors stock at 0 (macros still logged for full consumed amount)
    -- Errors ('Quantity must be positive', hard-ceiling, 'Product not
    -- found...') propagate upward — the cloud edge function wraps in a
    -- scan_transactions row with status='errored'.
    PERFORM private.consume_product(
      p_user_id              => p_user_id,
      p_product_id           => p_product_id,
      p_qty                  => COALESCE(p_qty, 1),
      p_unit                 => COALESCE(p_unit, 'serving'),
      p_log_macros           => (p_mode = 'consume_macros'),
      p_logical_date         => v_logical_date,
      p_confirm_large_amount => TRUE
    );

    -- consume_product does NOT return the food_log_id (it returns success +
    -- macros + stock_remaining only). Capture the freshly-inserted row by
    -- ordering on created_at DESC — safe within this single tx because
    -- consume_product just INSERTed it via SECURITY DEFINER (visible to us
    -- under the same role + xid) and concurrent writes from other tx's
    -- haven't been committed yet for this row's xact-visible window.
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
  'consume_no_macros / shopping). Returns JSONB with applied_lot_id, '
  'applied_food_log_id, and/or applied_cart_item_id keys for the '
  'scan_transactions audit row. Consume modes delegate to '
  'private.consume_product (FEFO waterfall + qty bounds + macros invariant).';
