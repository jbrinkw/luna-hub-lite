-- Live_scale claim path: include qty=0 lots as valid claim targets.
--
-- CONTEXT (2026-04-28, follow-up to 20260428060000_live_scale_never_mints):
--   The chocolate-milk scenario (production repro 2026-04-22) involves
--   a lot that was depleted to qty=0 on live_shelf, then a live_scale
--   refill on a paired scale. Under the previous helper logic the
--   claim-or-ignore branch only matched qty>0 unpaired lots, so an
--   empty lot would fall through to live_scale_no_unpaired_lot_ignore
--   even when it's the obvious claim target.
--
--   Per the user's hard rule: "Pulls from existing non-tracked
--   inventory (matches an unpaired lot of the same product, claims it
--   via auto-pairing)". An empty lot from a previous live_shelf
--   depletion IS existing non-tracked inventory — claiming it (and
--   SET-resurrecting qty) is the user's intent.
--
--   What we MUST NOT do is mint a brand-new lot. Reusing an existing
--   one (qty=0 or qty>0) is fine. The single_track_never_mints rule
--   stands.
--
-- DESIGN CHANGE:
--   apply_live_scale_measurement's claim branch:
--     * Drop the qty_containers > 0 filter on the candidate query.
--     * Order qty>0 candidates BEFORE qty=0 candidates so a "one
--       active + one empty lot" scenario picks the active one.
--     * v_unpaired_count > 1 still means "ambiguous, ignore" — multiple
--       qty>0 lots OR an active+empty pair both fall through to ignore.
--       Wait — actually the active+empty pair is unambiguous because
--       active is preferred via ORDER BY. Only multiple lots of the
--       SAME tier (both qty>0 OR both qty=0) is genuinely ambiguous.
--       The LIMIT 2 + count check still works: ORDER BY picks the
--       active one as winner; count>1 means there's a second candidate
--       at any tier, which IS still ambiguous (we can't safely pick
--       between two qty>0 lots, and an active+empty case is rare
--       enough that ignoring is the safer default — the user can
--       manually resolve via the inventory page).

BEGIN;

CREATE OR REPLACE FUNCTION private.apply_live_scale_measurement(
  p_user_id         UUID,
  p_device_id       UUID,
  p_scale_id        TEXT,
  p_product_id      UUID,
  p_after_weight_g  NUMERIC,
  p_occurred_at     TIMESTAMPTZ
) RETURNS chefbyte.shelf_event_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_net_g           NUMERIC;
  v_pinned_lot      UUID;
  v_lot_src         TEXT;
  v_lot_ts          TIMESTAMPTZ;
  v_unpaired_lot    UUID;
  v_unpaired_count  INTEGER;
  v_new_qty         NUMERIC;
  v_result          chefbyte.shelf_event_result;
BEGIN
  SELECT net_weight_g INTO v_net_g
    FROM chefbyte.products
   WHERE product_id = p_product_id AND user_id = p_user_id;

  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
    RETURN v_result;
  END IF;

  SELECT lot_id INTO v_pinned_lot
    FROM chefbyte.scale_pairings
   WHERE user_id = p_user_id
     AND device_id = p_device_id
     AND scale_id = p_scale_id
     AND kind = 'live_scale';

  IF NOT FOUND THEN
    v_result := ROW(NULL::UUID, false, 'live_scale_no_pairing_ignore');
    RETURN v_result;
  END IF;

  IF v_pinned_lot IS NOT NULL THEN
    SELECT lot_id, last_update_source, last_update_ts
      INTO v_pinned_lot, v_lot_src, v_lot_ts
      FROM chefbyte.stock_lots
     WHERE lot_id = v_pinned_lot
       AND user_id = p_user_id
       AND product_id = p_product_id;

    IF NOT FOUND THEN
      v_result := ROW(NULL::UUID, false, 'live_scale_paired_lot_missing_ignore');
      RETURN v_result;
    END IF;

    IF v_lot_src = 'manual' AND v_lot_ts IS NOT NULL
       AND v_lot_ts > p_occurred_at THEN
      v_result := ROW(v_pinned_lot, false, 'stale: manual edit is newer');
      RETURN v_result;
    END IF;

    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(p_after_weight_g / v_net_g, 0),
           last_update_source = 'live_scale',
           last_update_ts     = p_occurred_at,
           in_flight_since    = NULL,
           in_flight_kind     = NULL,
           pickup_event_id    = NULL,
           pickup_weight_g    = NULL
     WHERE lot_id = v_pinned_lot
     RETURNING qty_containers INTO v_new_qty;

    v_result := ROW(v_pinned_lot, true, 'live_scale_set_qty');
    RETURN v_result;
  END IF;

  -- Pairing exists, lot_id NULL — claim a single unpaired lot
  -- (qty>0 or qty=0). Active lots are preferred. Multiple candidates
  -- of any tier means "ambiguous, ignore".
  SELECT lot_id, COUNT(*) OVER ()
    INTO v_unpaired_lot, v_unpaired_count
    FROM chefbyte.stock_lots sl
   WHERE sl.user_id = p_user_id
     AND sl.product_id = p_product_id
     AND NOT EXISTS (
       SELECT 1 FROM chefbyte.scale_pairings sp
        WHERE sp.user_id = p_user_id
          AND sp.kind = 'live_scale'
          AND sp.lot_id = sl.lot_id
     )
   ORDER BY
     CASE WHEN sl.qty_containers > 0 THEN 0 ELSE 1 END,
     sl.created_at ASC
   LIMIT 2;

  IF v_unpaired_lot IS NULL THEN
    v_result := ROW(NULL::UUID, false, 'live_scale_no_unpaired_lot_ignore');
    RETURN v_result;
  END IF;

  IF v_unpaired_count > 1 THEN
    v_result := ROW(NULL::UUID, false, 'live_scale_ambiguous_unpaired_lots_ignore');
    RETURN v_result;
  END IF;

  UPDATE chefbyte.scale_pairings
     SET lot_id = v_unpaired_lot
   WHERE user_id = p_user_id
     AND device_id = p_device_id
     AND scale_id = p_scale_id
     AND kind = 'live_scale';

  UPDATE chefbyte.stock_lots
     SET qty_containers     = GREATEST(p_after_weight_g / v_net_g, 0),
         last_update_source = 'live_scale',
         last_update_ts     = p_occurred_at,
         in_flight_since    = NULL,
         in_flight_kind     = NULL,
         pickup_event_id    = NULL,
         pickup_weight_g    = NULL
   WHERE lot_id = v_unpaired_lot
   RETURNING qty_containers INTO v_new_qty;

  v_result := ROW(v_unpaired_lot, true, 'live_scale_claimed_and_set');
  RETURN v_result;
END;
$$;

COMMIT;
