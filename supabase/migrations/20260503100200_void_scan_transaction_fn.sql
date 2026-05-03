-- Pi USB scanner forwarder (Task 3): private.void_scan_transaction
--
-- Reverses the side-effects recorded on an applied scan_transactions
-- row, then flips status='voided'. This is the audit-row "undo" hook
-- surfaced by the Settings -> Scanner Transactions tab.
--
-- Per-mode contract (see private.execute_scan_action for the writer
-- side):
--   * purchase           — applied_lot_id points at the freshly minted
--                          chefbyte.stock_lots row. Void deletes it.
--   * consume_macros     — applied_lot_id is intentionally NULL (the
--                          FEFO waterfall touches multiple lots, so
--                          there is no single lot to roll back).
--                          applied_food_log_id points at the
--                          chefbyte.food_logs row written by
--                          private.consume_product. Void deletes it.
--                          Stock decrements are NOT reversed — see
--                          comment in execute_scan_action_fn.sql.
--   * consume_no_macros  — applied_lot_id NULL, applied_food_log_id
--                          NULL (no food_log written). Void only
--                          flips status; this is the documented
--                          irreversible mode.
--   * shopping           — applied_cart_item_id points at the
--                          shopping_list row. Void deletes it.
--
-- Idempotency: voiding an already-voided row is a no-op (returns
-- without raising). This protects the UI from double-click /
-- realtime-replay scenarios.
--
-- Errors:
--   * transaction_not_found — the UUID does not match any row.
--
-- The function is contract-driven on the audit row; it does not care
-- HOW the FK targets were created. ON DELETE SET NULL on every
-- applied_*_id FK already gracefully tolerates a target that was
-- deleted out-of-band (the column is then NULL and the corresponding
-- DELETE step becomes a no-op).

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
  v_applied_lot_id       UUID;
  v_applied_food_log_id  UUID;
  v_applied_cart_item_id UUID;
BEGIN
  SELECT user_id, status,
         applied_lot_id, applied_food_log_id, applied_cart_item_id
    INTO v_user_id, v_status,
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

  -- Reverse recorded side-effects. Each DELETE is guarded by a non-NULL
  -- check; the ON DELETE SET NULL on applied_*_id FKs means the column
  -- already reflects whether the target row still exists.
  IF v_applied_lot_id IS NOT NULL THEN
    DELETE FROM chefbyte.stock_lots
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
  'Reverse the side-effects of an applied scan_transactions row '
  '(delete stock_lot / food_log / shopping_list cart item if recorded) '
  'and flip status=''voided''. Idempotent on already-voided rows; '
  'raises ''transaction_not_found'' on missing UUID.';
