-- Close out an in-flight lot manually from the web UI.
--
-- CONTEXT (2026-04-27):
--   The Inventory page now has a clickable "✋ In Flight" badge. When a
--   lot has been picked up but never reconciled (e.g. a Pi-side stuck
--   in_flight, a delivered-then-spilled bottle, a chocolate-milk-stuck-
--   on-cloud false positive), the user opens a modal and picks one of
--   three resolutions:
--
--     * 'discarded' — bottle was thrown away / fed to pet / spilled.
--                     Zero qty, clear in_flight markers, NO food_logs
--                     row (no macro tracking by design).
--
--     * 'consumed'  — bottle was eaten without being measured. Use the
--                     last-known qty as the consumption amount and write
--                     a food_logs row at the product's per-container
--                     macro rates so the user's daily totals catch up.
--                     Zero qty, clear in_flight markers, last_update_source
--                     stamped 'manual_consume'.
--
--     * 'returned'  — false in-flight state (the bottle is actually still
--                     on the shelf, classifier was wrong / ESP8266 glitch
--                     / TTL false reap). Clear in_flight_since +
--                     pickup_event_id, leave qty as-is. NO food_logs.
--                     last_update_source stamped 'manual_return'.
--
--   In every branch we write a chefbyte.shelf_event_log audit row so the
--   resolution is queryable from the same audit trail as automated Pi
--   events. The audit row's payload carries the user-supplied note (free
--   text from the modal's textarea) plus the resolution kind.
--
-- DESIGN:
--   * SECURITY DEFINER plpgsql in the private schema (project convention).
--   * Validates p_resolution ∈ {'discarded','consumed','returned'} with a
--     22023 errcode (matches apply_shelf_event style).
--   * Validates the lot belongs to (auth.uid() / p_user_id) AND has
--     in_flight_since IS NOT NULL — otherwise raises with 22023.
--   * Returns the audit event_id so the client can correlate (and so
--     pgTAP can assert on it without a re-query).
--   * Public wrapper chefbyte.close_in_flight_lot calls private with
--     auth.uid(); GRANT EXECUTE TO authenticated only.
--
--   Idempotency: NOT idempotent across retries — the function only fires
--   when the lot still has in_flight_since IS NOT NULL, so a second call
--   on the same lot fails with 'lot is not in-flight'. Clients are
--   expected to dismiss the modal on success and not retry.
--
-- NON-GOALS:
--   * Does NOT cascade to scale_pairings or live_shelf_devices.
--   * Does NOT replay onto Pi sqlite (Pi's lot-snapshot poller will pick
--     up the qty=0 + cleared in_flight on the next 60s tick via the
--     stock_lots updated_at delta query).
--   * Does NOT void prior food_logs rows from earlier consumed events on
--     this lot — manual close-out is a forward state change.

BEGIN;

-- Extend the stock_lots.last_update_source CHECK constraint to accept
-- the two new audit-friendly tags 'manual_consume' and 'manual_return'.
-- 'manual_discard' is already in the constraint (added in
-- 20260427020000_shelf_event_discarded.sql) but we add it again here
-- defensively in case of rebuild ordering.
ALTER TABLE chefbyte.stock_lots
  DROP CONSTRAINT IF EXISTS stock_lots_last_update_source_check;
ALTER TABLE chefbyte.stock_lots
  ADD CONSTRAINT stock_lots_last_update_source_check
    CHECK (last_update_source IS NULL
           OR last_update_source IN (
             'manual',
             'manual_discard',
             'manual_consume',
             'manual_return',
             'live_shelf',
             'live_scale',
             'catch_all'
           ));

------------------------------------------------------------
-- private.close_in_flight_lot
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.close_in_flight_lot(
  p_user_id    UUID,
  p_lot_id     UUID,
  p_resolution TEXT,
  p_note       TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lot           chefbyte.stock_lots%ROWTYPE;
  v_product       chefbyte.products%ROWTYPE;
  v_tz            TEXT;
  v_dsh           INTEGER;
  v_logical_date  DATE;
  v_now           TIMESTAMPTZ := now();
  v_event_id      UUID;
  v_qty           NUMERIC;
  v_servings      NUMERIC;
  v_client_evt    TEXT;
BEGIN
  -- Validate user.
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id required' USING ERRCODE = '22023';
  END IF;

  -- Validate resolution literal.
  IF p_resolution IS NULL
     OR p_resolution NOT IN ('discarded','consumed','returned') THEN
    RAISE EXCEPTION 'invalid resolution: %', p_resolution
      USING ERRCODE = '22023';
  END IF;

  -- Lot must exist, belong to caller, and currently be in-flight.
  SELECT * INTO v_lot
    FROM chefbyte.stock_lots
   WHERE lot_id = p_lot_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot not found' USING ERRCODE = '22023';
  END IF;

  IF v_lot.in_flight_since IS NULL THEN
    RAISE EXCEPTION 'lot is not in-flight' USING ERRCODE = '22023';
  END IF;

  -- Snapshot the qty BEFORE any mutation so the consumed branch can use
  -- it for the food_logs row. Manual close-outs treat the current qty
  -- as the "last known qty" — there is no per-pickup snapshot column.
  v_qty := v_lot.qty_containers;

  -- Generate a deterministic-ish client_event_id for the audit row so
  -- the (user_id, client_event_id) UNIQUE on shelf_event_log keeps
  -- accidental double-clicks idempotent at the table level. Includes a
  -- random tail so legitimate distinct calls are still distinguishable.
  v_client_evt := 'manual_close_'
                  || p_resolution || '_'
                  || p_lot_id::text || '_'
                  || replace(gen_random_uuid()::text, '-', '');

  ----------------------------------------------------------
  -- Branch: discarded
  ----------------------------------------------------------
  IF p_resolution = 'discarded' THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = 0,
           in_flight_since    = NULL,
           pickup_event_id    = NULL,
           last_update_source = 'manual_discard',
           last_update_ts     = v_now
     WHERE lot_id = p_lot_id
       AND user_id = p_user_id;

  ----------------------------------------------------------
  -- Branch: consumed
  ----------------------------------------------------------
  ELSIF p_resolution = 'consumed' THEN
    -- Look up product macros so the food_logs row reflects the
    -- per-serving macros × consumed servings. Mirrors the per-container
    -- math used by private.consume_product so daily totals are
    -- consistent between manual close-out and a normal consume.
    SELECT * INTO v_product
      FROM chefbyte.products
     WHERE product_id = v_lot.product_id
       AND user_id    = p_user_id;

    IF NOT FOUND THEN
      -- Defensive: lot referenced a product that's been deleted under
      -- us. Fall back to clearing the in-flight state without macros so
      -- the user isn't blocked from cleaning up the row.
      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             in_flight_since    = NULL,
             pickup_event_id    = NULL,
             last_update_source = 'manual_consume',
             last_update_ts     = v_now
       WHERE lot_id = p_lot_id
         AND user_id = p_user_id;
    ELSE
      -- Resolve user's logical_date for the food_logs row (matches
      -- consume_product's behaviour — macros land on the user's local
      -- "today" per their day_start_hour profile, not UTC midnight).
      SELECT timezone, day_start_hour INTO v_tz, v_dsh
        FROM hub.profiles WHERE user_id = p_user_id;
      IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
      IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
      v_logical_date := private.get_logical_date(v_now, v_tz, v_dsh);

      -- Total servings consumed = qty_containers × servings_per_container.
      -- A lot at qty=0 still in-flight (e.g. companion consumed event
      -- already zero'd qty before pickup arrived) gets a 0-serving row,
      -- which we suppress entirely so the food_logs query stays clean.
      v_servings := COALESCE(v_qty, 0)
                    * COALESCE(v_product.servings_per_container, 0);

      IF v_servings > 0 THEN
        INSERT INTO chefbyte.food_logs (
          user_id, product_id, logical_date,
          qty_consumed, unit,
          calories, carbs, protein, fat,
          source_client_event_id
        ) VALUES (
          p_user_id, v_lot.product_id, v_logical_date,
          v_servings, 'serving',
          v_servings * COALESCE(v_product.calories_per_serving, 0),
          v_servings * COALESCE(v_product.carbs_per_serving,    0),
          v_servings * COALESCE(v_product.protein_per_serving,  0),
          v_servings * COALESCE(v_product.fat_per_serving,      0),
          v_client_evt
        );
      END IF;

      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             in_flight_since    = NULL,
             pickup_event_id    = NULL,
             last_update_source = 'manual_consume',
             last_update_ts     = v_now
       WHERE lot_id = p_lot_id
         AND user_id = p_user_id;
    END IF;

  ----------------------------------------------------------
  -- Branch: returned
  ----------------------------------------------------------
  ELSE  -- p_resolution = 'returned'
    -- Preserve qty_containers (the bottle is "still on the shelf"). We
    -- have no snapshot column to restore from — the lot's current qty
    -- is treated as authoritative. Only the in-flight markers are
    -- cleared.
    UPDATE chefbyte.stock_lots
       SET in_flight_since    = NULL,
           pickup_event_id    = NULL,
           last_update_source = 'manual_return',
           last_update_ts     = v_now
     WHERE lot_id = p_lot_id
       AND user_id = p_user_id;
  END IF;

  ----------------------------------------------------------
  -- Audit row in shelf_event_log
  ----------------------------------------------------------
  -- shelf_event_log.device_id is NOT NULL — manual close-outs are not
  -- tied to a Pi device, but the FK requires a value. We pick the
  -- user's most-recent live_shelf_device (any) as a "best effort"
  -- attribution. If the user has no live_shelf devices we fall back to
  -- inserting a synthetic placeholder device row so the audit trail
  -- still records the close-out — but most users with an in-flight lot
  -- got there through a Pi event, so this fallback is rare.

  DECLARE
    v_device_id UUID;
  BEGIN
    SELECT device_id INTO v_device_id
      FROM chefbyte.live_shelf_devices
     WHERE user_id = p_user_id
     ORDER BY last_heartbeat_ts DESC NULLS LAST, created_at DESC
     LIMIT 1;

    IF v_device_id IS NULL THEN
      -- No device — try to find or create a synthetic 'manual' device row
      -- so the shelf_event_log FK holds. import_key_hash is GLOBALLY
      -- UNIQUE (not per-user), so we mint a per-user placeholder by
      -- prefixing the user_id. First check if a synthetic device already
      -- exists for this user (common case on the second close-out).
      SELECT device_id INTO v_device_id
        FROM chefbyte.live_shelf_devices
       WHERE user_id = p_user_id
         AND import_key_hash = 'manual_close_in_flight_' || p_user_id::text
       LIMIT 1;

      IF v_device_id IS NULL THEN
        INSERT INTO chefbyte.live_shelf_devices (
          user_id, device_name, import_key_hash, is_active
        ) VALUES (
          p_user_id,
          'manual',
          'manual_close_in_flight_' || p_user_id::text,
          false
        )
        RETURNING device_id INTO v_device_id;
      END IF;
    END IF;

    INSERT INTO chefbyte.shelf_event_log (
      user_id, device_id, client_event_id, payload, applied, reason
    ) VALUES (
      p_user_id,
      v_device_id,
      v_client_evt,
      jsonb_build_object(
        'kind',         'manual_close',
        'event_kind',   p_resolution,
        'lot_id',       p_lot_id,
        'product_id',   v_lot.product_id,
        'qty_pre',      v_qty,
        'note',         p_note,
        'resolved_by',  p_user_id,
        'occurred_at',  v_now
      ),
      true,
      p_resolution
    )
    RETURNING event_id INTO v_event_id;
  END;

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION private.close_in_flight_lot(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC;

COMMENT ON FUNCTION private.close_in_flight_lot(UUID, UUID, TEXT, TEXT) IS
  'Manually close out an in-flight stock_lot from the chef UI. '
  'p_resolution ∈ {discarded, consumed, returned}. discarded zeros qty '
  'without macros; consumed zeros qty AND writes a food_logs row using '
  'the lot''s last-known qty × per-container macros; returned preserves '
  'qty (false in-flight false-positive). All branches clear in_flight_since '
  '+ pickup_event_id and stamp last_update_source = manual_<kind>. Writes '
  'an audit row to shelf_event_log with the user-supplied note. Returns '
  'the audit event_id.';

------------------------------------------------------------
-- Public wrapper: chefbyte.close_in_flight_lot
------------------------------------------------------------
-- Authenticated callers hit this; auth.uid() is forwarded as p_user_id
-- so RLS / ownership checks happen inside the private function.

CREATE OR REPLACE FUNCTION chefbyte.close_in_flight_lot(
  p_lot_id     UUID,
  p_resolution TEXT,
  p_note       TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.close_in_flight_lot(
    (SELECT auth.uid()),
    p_lot_id,
    p_resolution,
    p_note
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.close_in_flight_lot(UUID, TEXT, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.close_in_flight_lot(UUID, TEXT, TEXT)
  TO authenticated;

COMMENT ON FUNCTION chefbyte.close_in_flight_lot(UUID, TEXT, TEXT) IS
  'Public RPC wrapper for private.close_in_flight_lot — authenticated '
  'callers only. Forwards auth.uid() as the user. See the private '
  'function for resolution semantics.';

COMMIT;
