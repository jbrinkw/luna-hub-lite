-- Populate ``stock_lots.pickup_weight_g`` on live_shelf in_flight_pickup.
--
-- 2026-04-28 — gap closure for the catch-all delta-capture redesign.
--
-- BUG:
--   Layer 3 of the catch-all redesign (migration 20260427120000) added
--   ``stock_lots.pickup_weight_g`` so the cloud can compute consumption
--   against the lot's pickup baseline. The catch-all branches of
--   ``apply_shelf_event`` populate it correctly, but the existing
--   live_shelf in_flight_pickup branch (originally introduced in
--   20260425080000 and lifted into 20260427130000) was overlooked: it
--   stamps in_flight_since + pickup_event_id but never writes
--   pickup_weight_g.
--
--   Why it matters: the same compute step
--     consumption_g = pickup_weight_g - return_g
--   is used by the future TTL-based macro reconciler for live_shelf
--   in-flight sessions that don't see a clean in_flight_return. With
--   pickup_weight_g NULL on live_shelf rows, the reconciler has nothing
--   to subtract against and macros silently drop to zero.
--
-- FIX:
--   Patch the existing ``private.apply_shelf_event`` so the live_shelf
--   in_flight_pickup branch's UPDATE additionally writes
--   ``pickup_weight_g = abs(p_delta_g)``.
--
--   The Pi payload's ``p_delta_g`` is the measured weight the user
--   removed (NEGATIVE — weight left the shelf); ``abs()`` yields the
--   positive magnitude. We guard the assignment with a ``> 0`` check so
--   the ``stock_lots_pickup_weight_g_check`` (NULL OR > 0) constraint
--   is never violated on a malformed zero-delta payload.
--
-- IMPLEMENTATION:
--   ``apply_shelf_event`` is ~1000 lines. Re-emitting it verbatim risks
--   drift with the 20260428020000 (catch-all reaper toctou) and
--   20260428010000 (pairing rotation threshold) revisions. Instead we
--   pull the current function source via ``pg_get_functiondef``, splice
--   the single UPDATE block, and re-execute the result. The block
--   match is exact (whitespace + quoting) so any future edit that
--   moves the UPDATE will fail this migration loudly rather than
--   silently dropping the patch.
--
-- IDEMPOTENCY:
--   Re-running this migration is a no-op-or-error: the second run
--   won't find the OLD block (already replaced) and the patch will
--   raise. Wrap in a guard that detects the new block already being
--   present.
--
-- MUTATION DISCIPLINE:
--   Companion pgTAP probe
--   ``supabase/tests/chefbyte/pickup_weight_g_populated.test.sql``
--   plants an in_flight_pickup event and asserts the resolved lot's
--   pickup_weight_g IS NOT NULL AND equals abs(p_delta_g). Reverting
--   the splice flips the assertion to NULL and the probe fails.

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
      '20260428050000: private.apply_shelf_event not found — cannot patch';
  END IF;

  -- Old block: the live_shelf in_flight_pickup UPDATE that does NOT
  -- set pickup_weight_g. The exact whitespace must match the source
  -- emitted by 20260427130000.
  v_old_block := E'      UPDATE chefbyte.stock_lots\n'
              || E'         SET in_flight_since = p_occurred_at,\n'
              || E'             in_flight_kind  = ''live_shelf'',\n'
              || E'             pickup_event_id = COALESCE(v_pi_event_uuid, pickup_event_id),\n'
              || E'             last_update_ts  = p_occurred_at\n'
              || E'       WHERE lot_id = v_lot_id\n'
              || E'         AND user_id = p_user_id;';

  -- New block: same semantics + pickup_weight_g population.
  v_new_block := E'      UPDATE chefbyte.stock_lots\n'
              || E'         SET in_flight_since = p_occurred_at,\n'
              || E'             in_flight_kind  = ''live_shelf'',\n'
              || E'             pickup_event_id = COALESCE(v_pi_event_uuid, pickup_event_id),\n'
              || E'             pickup_weight_g = CASE\n'
              || E'               WHEN abs(COALESCE(p_delta_g, 0)) > 0\n'
              || E'                 THEN abs(p_delta_g)\n'
              || E'               ELSE pickup_weight_g\n'
              || E'             END,\n'
              || E'             last_update_ts  = p_occurred_at\n'
              || E'       WHERE lot_id = v_lot_id\n'
              || E'         AND user_id = p_user_id;';

  v_pos_old := position(v_old_block IN v_src);
  v_pos_new := position(v_new_block IN v_src);

  IF v_pos_new > 0 THEN
    -- Already patched (idempotent re-run on a freshly reset DB where
    -- migrations 20260427130000 + 20260428050000 both applied in
    -- order — the second run sees the new block and exits cleanly).
    RAISE NOTICE
      '20260428050000: pickup_weight_g patch already present, no-op';
    RETURN;
  END IF;

  IF v_pos_old = 0 THEN
    RAISE EXCEPTION
      '20260428050000: in_flight_pickup UPDATE block not found in '
      'private.apply_shelf_event source — schema drift suspected. '
      'Manual reconciliation required.';
  END IF;

  v_src := replace(v_src, v_old_block, v_new_block);

  -- ``pg_get_functiondef`` returns a fully-qualified
  -- ``CREATE OR REPLACE FUNCTION ... LANGUAGE ... AS $...$`` snippet
  -- that we can replay verbatim. Empty SET search_path is preserved.
  EXECUTE v_src;
END
$patch$;

-- Companion fix: in_flight_return (the inverse of pickup) should also
-- clear pickup_weight_g back to NULL when a live_shelf return event
-- arrives, so the lot doesn't carry a stale pickup baseline forward
-- onto its NEXT in-flight cycle. We patch the same way.
DO $patch_return$
DECLARE
  v_src        TEXT;
  v_old_block  TEXT;
  v_new_block  TEXT;
  v_pos_new    INTEGER;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private'
     AND p.proname = 'apply_shelf_event';

  -- Try to find the in_flight_return UPDATE that doesn't clear
  -- pickup_weight_g. It lives just below the in_flight_pickup branch.
  v_old_block := E'    UPDATE chefbyte.stock_lots\n'
              || E'       SET in_flight_since = NULL,\n'
              || E'           in_flight_kind  = NULL,\n'
              || E'           pickup_event_id = NULL,\n'
              || E'           last_update_ts  = p_occurred_at\n'
              || E'     WHERE lot_id = v_lot_id\n'
              || E'       AND user_id = p_user_id;';

  v_new_block := E'    UPDATE chefbyte.stock_lots\n'
              || E'       SET in_flight_since = NULL,\n'
              || E'           in_flight_kind  = NULL,\n'
              || E'           pickup_event_id = NULL,\n'
              || E'           pickup_weight_g = NULL,\n'
              || E'           last_update_ts  = p_occurred_at\n'
              || E'     WHERE lot_id = v_lot_id\n'
              || E'       AND user_id = p_user_id;';

  v_pos_new := position(v_new_block IN v_src);
  IF v_pos_new > 0 THEN
    RAISE NOTICE '20260428050000: in_flight_return clear already present';
    RETURN;
  END IF;

  IF position(v_old_block IN v_src) = 0 THEN
    -- Block isn't present in the expected shape — possibly a different
    -- shape due to subsequent migrations. Don't fail; the pickup
    -- patch is the load-bearing one for this fix.
    RAISE NOTICE
      '20260428050000: in_flight_return clear block not found, '
      'skipping (non-fatal — pickup patch is the load-bearing change)';
    RETURN;
  END IF;

  v_src := replace(v_src, v_old_block, v_new_block);
  EXECUTE v_src;
END
$patch_return$;

COMMIT;
