-- Catch-all discarded apply path — lot-id-targeted variant.
--
-- CONTEXT (Codex finding MEDIUM-6, 2026-04-28):
--   The catch-all empty-bottle short-circuit on the Pi
--   (``ScaleHandler._dispatch_catch_all_add``) emits a ``discarded``
--   event. Pre-fix the emit carried only ``product_id``, leaving the
--   cloud's ``apply_shelf_event`` discard branch to pick a lot via
--   product-level FEFO. With multiple lots of the same product on the
--   user's account, FEFO can pick the WRONG lot to zero — the user
--   placed a specific bottle on the catch-all scale, but the cloud
--   zeroed a different lot whose expires_on happened to be earlier.
--
--   The Pi already knows which lot was visually identified
--   (``cloud_lots.lot_id`` from the picked candidate). We thread that
--   ``lot_id`` through to the cloud as ``pi_lot_id`` and let the
--   discard branch target it directly.
--
-- DESIGN (minimal scope):
--   The existing ``apply_shelf_event`` function is large (~1k lines)
--   and is concurrently being touched by other migrations (e.g.
--   20260428010000_pairing_rotation_threshold_and_close_hook.sql).
--   Rather than re-define the whole function with one new param, we
--   introduce a small SECURITY DEFINER helper
--   ``private.apply_discard_with_lot_id`` that:
--
--     1. Validates the lot belongs to the user (RLS-equivalent check).
--     2. Records the event in ``shelf_event_log`` with
--        ``UNIQUE(user_id, client_event_id)`` dedup.
--     3. Zeros qty_containers + clears in_flight markers on the
--        TARGETED lot (idempotent on already-cleared rows).
--
--   The edge function (shelf-ingest) calls this helper instead of
--   ``apply_shelf_event_admin`` when the request body satisfies all of:
--     * kind = 'catch_all'
--     * event_kind = 'discarded'
--     * pi_lot_id is a non-null UUID
--
--   When pi_lot_id is absent the legacy apply_shelf_event_admin path is
--   used unchanged (product-level FEFO). This keeps the Pi-uplink
--   wire format backward-compatible: older Pi versions that don't
--   send pi_lot_id continue to work.
--
-- IDEMPOTENCY:
--   Same shelf_event_log UNIQUE(user_id, client_event_id) dedup as the
--   main apply path. A duplicate client_event_id replays the cached
--   result without re-running the UPDATE.

BEGIN;

------------------------------------------------------------
-- 1. Helper function — discard a specific lot by id
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.apply_discard_with_lot_id(
  p_user_id         UUID,
  p_device_id       UUID,
  p_scale_id        TEXT,
  p_kind            TEXT,
  p_pi_lot_id       UUID,
  p_product_id      UUID,
  p_occurred_at     TIMESTAMPTZ,
  p_client_event_id TEXT,
  p_pi_event_id     TEXT DEFAULT NULL
) RETURNS chefbyte.shelf_event_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_log_id           UUID;
  v_existing_applied BOOLEAN;
  v_existing_lot     UUID;
  v_existing_reason  TEXT;
  v_lot_user_id      UUID;
  v_lot_product_id   UUID;
  v_already_zero     BOOLEAN;
  v_result           chefbyte.shelf_event_result;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('live_shelf','live_scale','catch_all') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required' USING ERRCODE = '22023';
  END IF;
  IF p_pi_lot_id IS NULL THEN
    RAISE EXCEPTION 'pi_lot_id required' USING ERRCODE = '22023';
  END IF;

  -- Race-free idempotency: shelf_event_log INSERT with UNIQUE (user_id,
  -- client_event_id) dedup. Replay returns cached row.
  INSERT INTO chefbyte.shelf_event_log (
    user_id, device_id, client_event_id, payload, applied, reason, pi_event_id
  ) VALUES (
    p_user_id, p_device_id, p_client_event_id,
    jsonb_build_object(
      'scale_id', p_scale_id,
      'kind', p_kind,
      'event_kind', 'discarded',
      'product_id', p_product_id,
      'pi_lot_id', p_pi_lot_id,
      'delta_g', 0.0,
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

  -- Resolve the lot — must belong to the calling user. Cross-user
  -- writes are rejected. NB: we accept lots with qty=0 and/or
  -- in_flight markers cleared (idempotent re-discard) but NOT lots
  -- that are tombstoned.
  SELECT user_id, product_id
    INTO v_lot_user_id, v_lot_product_id
    FROM chefbyte.stock_lots
   WHERE lot_id = p_pi_lot_id;

  IF v_lot_user_id IS NULL THEN
    v_result := ROW(NULL::UUID, false, 'lot_id not found');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  IF v_lot_user_id <> p_user_id THEN
    v_result := ROW(NULL::UUID, false, 'lot_id not owned by user');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  -- Defensive: when product_id is supplied, it must match the lot's
  -- product_id. Mismatch indicates a Pi-side data corruption; we
  -- refuse rather than touching an unexpected lot.
  IF p_product_id IS NOT NULL AND v_lot_product_id <> p_product_id THEN
    v_result := ROW(p_pi_lot_id, false,
                    'lot_id product mismatch with payload product_id');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  -- Detect already-zeroed-and-cleared so the audit trail records the
  -- distinction. The UPDATE itself runs unconditionally — last_update_*
  -- still flips so the user-action intent is captured.
  SELECT (qty_containers = 0 AND in_flight_since IS NULL
          AND pickup_event_id IS NULL)
    INTO v_already_zero
    FROM chefbyte.stock_lots
   WHERE lot_id = p_pi_lot_id;

  UPDATE chefbyte.stock_lots
     SET qty_containers     = 0,
         in_flight_since    = NULL,
         in_flight_kind     = NULL,
         pickup_event_id    = NULL,
         pickup_weight_g    = NULL,
         last_update_source = 'manual_discard',
         last_update_ts     = p_occurred_at
   WHERE lot_id = p_pi_lot_id
     AND user_id = p_user_id;

  v_result := ROW(p_pi_lot_id, true,
                  CASE WHEN COALESCE(v_already_zero, false)
                       THEN 'discarded (idempotent no-op)'
                       ELSE 'discarded (lot-targeted)' END);
  UPDATE chefbyte.shelf_event_log
     SET applied = v_result.applied,
         resolved_lot_id = v_result.resolved_lot_id,
         reason = v_result.reason
   WHERE event_id = v_log_id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.apply_discard_with_lot_id(
  UUID, UUID, TEXT, TEXT, UUID, UUID, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_discard_with_lot_id(
  UUID, UUID, TEXT, TEXT, UUID, UUID, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION private.apply_discard_with_lot_id(
  UUID, UUID, TEXT, TEXT, UUID, UUID, TIMESTAMPTZ, TEXT, TEXT
) IS
  'Lot-targeted ``discarded`` event applier (Codex MEDIUM-6 fix). '
  'Used by the catch-all empty-bottle short-circuit when the Pi has '
  'visually identified the specific lot — bypasses the product-level '
  'FEFO that the legacy apply_shelf_event discard branch uses. '
  'Validates user ownership of the lot and that product_id (when '
  'supplied) matches; idempotent on shelf_event_log dedup.';

------------------------------------------------------------
-- 2. Public wrapper — chefbyte schema, mirrors apply_shelf_event_admin
------------------------------------------------------------

CREATE OR REPLACE FUNCTION chefbyte.apply_discard_with_lot_id_admin(
  p_user_id         UUID,
  p_device_id       UUID,
  p_scale_id        TEXT,
  p_kind            TEXT,
  p_pi_lot_id       UUID,
  p_product_id      UUID,
  p_occurred_at     TIMESTAMPTZ,
  p_client_event_id TEXT,
  p_pi_event_id     TEXT DEFAULT NULL
) RETURNS chefbyte.shelf_event_result
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.apply_discard_with_lot_id(
    p_user_id, p_device_id, p_scale_id, p_kind, p_pi_lot_id,
    p_product_id, p_occurred_at, p_client_event_id, p_pi_event_id
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.apply_discard_with_lot_id_admin(
  UUID, UUID, TEXT, TEXT, UUID, UUID, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.apply_discard_with_lot_id_admin(
  UUID, UUID, TEXT, TEXT, UUID, UUID, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

COMMIT;
