-- 2026-04-29: private.apply_shelf_event — strict pre-insert validation.
--
-- PROBLEM (FINAL_PLAN.md Change A):
--   apply_shelf_event currently writes a shelf_event_log row first, then
--   checks whether the product_id exists and whether net_weight_g is set.
--   On failure it returns ``applied=false`` with reason strings like
--   ``'product not found'`` or ``'product missing net_weight_g'``.
--   The edge function (shelf-ingest) forwards these as HTTP 200 + success-
--   shaped body — the Pi worker sees ``applied=false`` with unexpected
--   reason, logs a warning, and still calls ``mark_sent`` (acks the row).
--   The event is silently swallowed.
--
-- FIX:
--   1. Validate product_id existence BEFORE the shelf_event_log INSERT.
--      Unknown product_id → RAISE EXCEPTION with SQLSTATE '23503' (FK
--      violation class — product_id is unknown, nothing was committed).
--   2. Validate net_weight_g BEFORE the INSERT.
--      Missing net_weight_g → RAISE EXCEPTION with SQLSTATE '22023'
--      (invalid argument — data contract failure).
--   3. No shelf_event_log row is written for these branches — the INSERT
--      never executes.
--   4. The edge function's ``if (error)`` branch fires on any RPC raise
--      → HTTP 5xx or 422. The Pi worker dead-letters the row (per the
--      companion worker.py change).
--
-- SCOPE: validates only the outer product-lookup that gates the
--   non-in_flight, non-catch_all, non-discarded path.
--
--   Excluded event_kinds (have their own post-insert validation and/or
--   valid soft-no-op semantics for unknown products):
--     * in_flight_pickup, in_flight_return — post-insert; idempotent
--     * catch_all_first_measurement, catch_all_second_measurement — post-insert
--     * discarded — designed to be a soft no-op for unknown/cross-device
--       product_ids (operator removes a phantom item from the Pi UI)
--
--   Covered event_kinds (the outer product SELECT immediately below the
--   INSERT already gated these; we just move the gate before the INSERT):
--     * consumed, depleted, added, refilled, live_weight_sync
--
-- IMPLEMENTATION: pg_get_functiondef splice. We insert the two RAISE
--   checks between the existing ``client_event_id required`` check and
--   the ``INSERT INTO chefbyte.shelf_event_log`` — the unique anchor
--   that appears exactly once in the body. Idempotent: if the sentinel
--   string ``'23503_strict_pre_insert'`` is already present, no-op.
--
-- COMPANION TESTS:
--   * supabase/tests/chefbyte/apply_shelf_event_strict.test.sql
--     — throws_ok on phantom product_id + missing net_weight_g
--   * supabase/functions/shelf-ingest/_tests/contract.test.ts
--     — HTTP contract: phantom product_id → 4xx/5xx, NOT 200+applied=false
--   * hardware/live-shelf/server/cloud/tests/test_worker.py
--     — Pi pytest: 5xx → dead-letter, NOT mark_sent

BEGIN;

DO $patch$
DECLARE
  v_src       TEXT;
  v_old_block TEXT;
  v_new_block TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private'
     AND p.proname = 'apply_shelf_event';

  IF v_src IS NULL THEN
    RAISE EXCEPTION
      '20260429340000: private.apply_shelf_event not found — cannot patch';
  END IF;

  -- Idempotency: if already patched, skip.
  IF position('23503_strict_pre_insert' IN v_src) > 0 THEN
    RAISE NOTICE
      '20260429340000: apply_shelf_event already has strict pre-insert checks, no-op';
    RETURN;
  END IF;

  ------------------------------------------------------------
  -- Splice: insert product_id existence + net_weight_g checks
  -- BEFORE the shelf_event_log INSERT.
  --
  -- Anchor (appears exactly once in the function body):
  --   IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
  --     RAISE EXCEPTION 'client_event_id required' USING ERRCODE = '22023';
  --   END IF;
  --
  --   INSERT INTO chefbyte.shelf_event_log (
  --
  -- We extend the existing validation block to add two RAISE checks
  -- between the END IF; and the INSERT INTO.
  ------------------------------------------------------------

  v_old_block :=
    E'  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN\n'
    || E'    RAISE EXCEPTION ''client_event_id required'' USING ERRCODE = ''22023'';\n'
    || E'  END IF;\n'
    || E'\n'
    || E'  INSERT INTO chefbyte.shelf_event_log (';

  v_new_block :=
    E'  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN\n'
    || E'    RAISE EXCEPTION ''client_event_id required'' USING ERRCODE = ''22023'';\n'
    || E'  END IF;\n'
    || E'\n'
    || E'  -- 20260429340000 (23503_strict_pre_insert): validate product_id and\n'
    || E'  -- net_weight_g BEFORE writing a log row. On failure the RPC raises;\n'
    || E'  -- the edge function propagates as HTTP 5xx/422; the Pi worker dead-letters.\n'
    || E'  --\n'
    || E'  -- Excluded: in_flight_pickup/return (post-insert idempotent guards),\n'
    || E'  -- catch_all_first/second_measurement (post-insert branch checks),\n'
    || E'  -- discarded (valid soft no-op for cross-device phantom product_ids).\n'
    || E'  IF p_event_kind NOT IN (\n'
    || E'      ''in_flight_pickup'', ''in_flight_return'',\n'
    || E'      ''catch_all_first_measurement'', ''catch_all_second_measurement'',\n'
    || E'      ''discarded''\n'
    || E'  ) THEN\n'
    || E'    -- RAISE ''23503'' if product_id is unknown for this user.\n'
    || E'    IF NOT EXISTS (\n'
    || E'      SELECT 1 FROM chefbyte.products\n'
    || E'       WHERE product_id = p_product_id AND user_id = p_user_id\n'
    || E'    ) THEN\n'
    || E'      RAISE EXCEPTION ''product_id % not found for user %'',\n'
    || E'        p_product_id, p_user_id\n'
    || E'        USING ERRCODE = ''23503'';\n'
    || E'    END IF;\n'
    || E'\n'
    || E'    -- RAISE ''22023'' if net_weight_g is missing/zero.\n'
    || E'    IF NOT EXISTS (\n'
    || E'      SELECT 1 FROM chefbyte.products\n'
    || E'       WHERE product_id = p_product_id AND user_id = p_user_id\n'
    || E'         AND net_weight_g IS NOT NULL AND net_weight_g > 0\n'
    || E'    ) THEN\n'
    || E'      RAISE EXCEPTION ''product % has NULL/zero net_weight_g'',\n'
    || E'        p_product_id\n'
    || E'        USING ERRCODE = ''22023'';\n'
    || E'    END IF;\n'
    || E'  END IF;\n'
    || E'\n'
    || E'  INSERT INTO chefbyte.shelf_event_log (';

  IF position(v_old_block IN v_src) = 0 THEN
    RAISE EXCEPTION
      '20260429340000: anchor block not found in apply_shelf_event body — '
      'migration is stale vs the current function text. Check for a '
      'preceding splice that rewrote the client_event_id check or the '
      'INSERT INTO chefbyte.shelf_event_log line.';
  END IF;

  -- Verify the anchor is unique (appears exactly once).
  IF (LENGTH(v_src) - LENGTH(REPLACE(v_src, v_old_block, '')))
     / LENGTH(v_old_block) <> 1 THEN
    RAISE EXCEPTION
      '20260429340000: anchor block appears more than once in '
      'apply_shelf_event — cannot safely splice. Inspect the function body.';
  END IF;

  v_src := REPLACE(v_src, v_old_block, v_new_block);

  -- Strip the leading CREATE OR REPLACE FUNCTION signature that
  -- pg_get_functiondef prepends — we need the raw $$…$$ body for
  -- CREATE OR REPLACE to accept the full reconstructed definition.
  EXECUTE v_src;
END;
$patch$;

-- Re-grant EXECUTE (CREATE OR REPLACE strips grants on some PG versions).
REVOKE ALL ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, TEXT
) TO service_role;

COMMIT;
