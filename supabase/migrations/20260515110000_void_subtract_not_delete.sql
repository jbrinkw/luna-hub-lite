-- ════════════════════════════════════════════════════════════════════════════
-- H-11 / A5-01 — void_scan_transaction must SUBTRACT the scan qty, not zero the lot.
-- ════════════════════════════════════════════════════════════════════════════
-- DATA-LOSS BUG (financial correctness):
--   private.void_scan_transaction reverses an applied PURCHASE scan with
--     DELETE FROM chefbyte.stock_lots WHERE lot_id = applied_lot_id
--   The G1 BEFORE-DELETE guard (stock_lots_no_hard_delete, 20260515010000)
--   converts that DELETE into a soft-delete that zeroes the ENTIRE lot
--   (qty_containers = 0, deleted_at = now()) — regardless of how much THIS
--   scan actually contributed.
--
--   But the purchase writer (private.execute_scan_action, 20260503120000)
--   MERGES purchases into an existing matching lot via
--     INSERT … ON CONFLICT DO UPDATE
--       SET qty_containers = qty_containers + EXCLUDED.qty_containers
--   and returns the MERGED lot's id. So two same-day purchases of the same
--   product (or a purchase merged onto a pre-existing lot) share ONE lot_id.
--   Voiding one of them zeroes the WHOLE lot — destroying the pre-existing
--   stock AND any sibling purchase's stock. Whole-lot zeroing = silent loss.
--
-- THE FIX (no schema change):
--   chefbyte.scan_transactions.qty already stores the per-scan quantity
--   (web ScannerPage writes qty:args.qty; Pi execute_scan_and_record writes
--   qty=p_qty). For a PURCHASE, execute_scan_action adds exactly
--   COALESCE(qty,1) CONTAINERS to the lot (the purchase branch ignores unit).
--   So the reversible delta IS COALESCE(qty,1). Replace the whole-lot DELETE
--   with a SUBTRACT of that delta, floored at 0:
--
--     qty_containers := GREATEST(qty_containers - COALESCE(v_qty,1), 0)
--
--   * applied_lot_id is non-NULL ONLY for purchase mode (consume returns NULL,
--     shopping uses applied_cart_item_id), so this branch only ever touches
--     purchases. The food_log + cart_item DELETE branches are unchanged.
--   * On a FULL reversal (qty would reach 0) we explicitly set deleted_at=now()
--     so the lot becomes a tombstone — respecting the G1 soft-delete model and
--     the Pi lot_snapshot delta poller (a 0-qty lot must carry deleted_at).
--     No DELETE is issued, so the G1 BEFORE-DELETE guard is not involved; the
--     T1 BEFORE-UPDATE revive trigger (stock_lots_revive_on_positive_qty,
--     20260515030000) fires but its qty>0 guard is FALSE at qty=0, so the
--     tombstone stays tombstoned.
--   * On a PARTIAL reversal (qty stays > 0) the lot remains live; the T1 revive
--     trigger clears any stale deleted_at so the surviving stock is visible +
--     FEFO-spendable. We do NOT set deleted_at in that case.
--
--   last_update_source='manual' is within the existing CHECK
--   ('manual','manual_discard','manual_consume','manual_return','live_shelf',
--    'live_scale','catch_all'); last_update_ts=now() bumps the row so the Pi's
--   delta poller picks the change up (the stock_lots_set_updated_at trigger
--   also bumps updated_at on UPDATE).
--
-- Body is identical to 20260503100200 EXCEPT the lot-reversal branch (and the
-- two new qty/mode locals + refreshed COMMENT). SECURITY DEFINER and
-- SET search_path = '' preserved; REVOKE/GRANT re-applied.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION private.void_scan_transaction(
  p_transaction_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id              UUID;
  v_status               TEXT;
  v_mode                 TEXT;
  v_qty                  NUMERIC;
  v_applied_lot_id       UUID;
  v_applied_food_log_id  UUID;
  v_applied_cart_item_id UUID;
BEGIN
  SELECT user_id, status, mode, qty,
         applied_lot_id, applied_food_log_id, applied_cart_item_id
    INTO v_user_id, v_status, v_mode, v_qty,
         v_applied_lot_id, v_applied_food_log_id, v_applied_cart_item_id
    FROM chefbyte.scan_transactions
   WHERE transaction_id = p_transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction_not_found';
  END IF;

  -- Already voided -> idempotent no-op.
  IF v_status = 'voided' THEN
    RETURN;
  END IF;

  -- Reverse the recorded side-effects. Each branch is guarded by a non-NULL
  -- check; the ON DELETE SET NULL on applied_*_id FKs means the column already
  -- reflects whether the target row still exists.

  -- PURCHASE reversal: applied_lot_id is non-NULL only for purchase mode, and
  -- the writer MERGED COALESCE(qty,1) containers onto a possibly-shared lot.
  -- SUBTRACT exactly that contribution (floored at 0) instead of zeroing the
  -- whole lot — a sibling purchase's stock and any pre-existing stock survive.
  -- Tombstone (deleted_at) only on a full reversal to 0; a partial reversal
  -- keeps the lot live (the T1 revive trigger clears any stale deleted_at).
  IF v_applied_lot_id IS NOT NULL THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(qty_containers - COALESCE(v_qty, 1), 0),
           deleted_at         = CASE
                                  WHEN qty_containers - COALESCE(v_qty, 1) <= 0
                                    THEN now()
                                  ELSE deleted_at
                                END,
           last_update_source = 'manual',
           last_update_ts     = now()
     WHERE lot_id = v_applied_lot_id;
  END IF;

  IF v_applied_food_log_id IS NOT NULL THEN
    DELETE FROM chefbyte.food_logs
     WHERE log_id = v_applied_food_log_id;
  END IF;

  IF v_applied_cart_item_id IS NOT NULL THEN
    DELETE FROM chefbyte.shopping_list
     WHERE cart_item_id = v_applied_cart_item_id;
  END IF;

  UPDATE chefbyte.scan_transactions
     SET status = 'voided'
   WHERE transaction_id = p_transaction_id;
END;
$$;

REVOKE ALL ON FUNCTION private.void_scan_transaction(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.void_scan_transaction(UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION private.void_scan_transaction(UUID) IS
  'Reverse the side-effects of an applied scan_transactions row and flip '
  'status=''voided''. PURCHASE reversal SUBTRACTS the scan''s qty '
  '(COALESCE(qty,1) containers) from the merged applied_lot — floored at 0 — '
  'instead of deleting/zeroing the whole lot, so a shared lot (two same-day '
  'purchases, or a purchase merged onto pre-existing stock) keeps the '
  'sibling/pre-existing quantity (H-11 / A5-01 data-loss fix). A full '
  'reversal to 0 sets deleted_at (tombstone for the Pi delta poller); a '
  'partial reversal leaves the lot live (T1 revive trigger clears stale '
  'deleted_at). consume/shopping still delete the food_log / cart item. '
  'Idempotent on already-voided rows; raises ''transaction_not_found'' on '
  'a missing UUID.';
