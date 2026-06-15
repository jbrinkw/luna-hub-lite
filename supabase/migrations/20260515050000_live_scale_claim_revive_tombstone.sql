-- ════════════════════════════════════════════════════════════════════════════
-- T1 ghost-stock — the ONE writer the revive trigger cannot cover (deep audit
-- 2026-06-03). Split out of 20260515030000 ON PURPOSE.
-- ════════════════════════════════════════════════════════════════════════════
-- The 20260515030000 revive trigger fixes every QTY-MERGE writer at once: it
-- clears deleted_at whenever a row is written with qty_containers > 0. That
-- covers import (C-2), scan-purchase (H-1), resolve_add_to_shelf_lot step-4
-- (H-12, revive-at-1.0), unmark_meal_done restore, the add-stock MCP tool, and
-- the ScannerPage client undo — they all set positive qty.
--
-- The live_scale tier-4 CLAIM is structurally different: it picks an existing
-- lot for the paired product (preferring qty=0 depleted lots in tier 4) and
-- "claims" it for the scale, DELIBERATELY KEEPING qty (the scale's subsequent
-- live_weight_sync sets the real qty). When the only candidate is a tombstone,
-- the claim UPDATE leaves qty=0 → the trigger's `qty > 0` guard is FALSE and the
-- lot stays a tombstone. Net: the scale auto-pairs to a DEAD lot (deleted_at
-- set) and every future weight sync targets an invisible, unspendable lot.
-- Same ghost class, but the trigger can't see it because "a scale is being
-- pinned to this lot" is not encoded in the row's qty.
--
-- Clearing deleted_at HERE does not reintroduce the per-writer fragility the
-- trigger removes — this is the claim writer honestly declaring "the scale now
-- tracks this lot, so it is live again" (the tier-4 comment's own word: "revive
-- previously-depleted lot"). Minimal targeted splice: add `deleted_at = NULL`
-- to the claim UPDATE's SET list.
--
-- WHY ITS OWN MIGRATION: this is a text-splice of private.apply_shelf_event via
-- pg_get_functiondef + REPLACE + EXECUTE — inherently more fragile than a plain
-- CREATE statement (it depends on the function body text matching). It carries
-- fail-loud guards (sentinel + single-anchor checks) so a stale anchor aborts
-- rather than silently no-op'ing. Isolating it means a prod anchor-mismatch
-- aborts ONLY this medium-severity fix, never the critical 20260515030000
-- revive trigger or the 20260515040000 shopping-list fix (which apply first).
-- ════════════════════════════════════════════════════════════════════════════

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
      '20260515050000: private.apply_shelf_event not found — cannot patch live_scale claim';
  END IF;

  -- Idempotency: the spliced revive line carries this sentinel marker.
  IF position('live_scale_claim_revive' IN v_src) > 0 THEN
    RAISE NOTICE
      '20260515050000: apply_shelf_event live_scale claim already revives tombstone, no-op';
    RETURN;
  END IF;

  -- Anchor: the claim UPDATE's SET list. Unique to the live_scale claim path
  -- (the only place that sets last_update_source='live_scale' together with the
  -- in-flight-marker clears + KEEP-qty). We extend the SET list to also clear
  -- deleted_at so a tombstone the scale claims is revived in place.
  v_old_block :=
    E'      UPDATE chefbyte.stock_lots\n'
    || E'         SET last_update_source = ''live_scale'',\n'
    || E'             last_update_ts     = p_occurred_at,\n'
    || E'             in_flight_since    = NULL,\n'
    || E'             in_flight_kind     = NULL,\n'
    || E'             pickup_event_id    = NULL,\n'
    || E'             pickup_weight_g    = NULL\n'
    || E'       WHERE lot_id = v_lot_id\n'
    || E'         AND user_id = p_user_id;';

  v_new_block :=
    E'      UPDATE chefbyte.stock_lots\n'
    || E'         SET last_update_source = ''live_scale'',\n'
    || E'             last_update_ts     = p_occurred_at,\n'
    || E'             in_flight_since    = NULL,\n'
    || E'             in_flight_kind     = NULL,\n'
    || E'             pickup_event_id    = NULL,\n'
    || E'             pickup_weight_g    = NULL,\n'
    || E'             deleted_at         = NULL  -- live_scale_claim_revive (T1): scale now tracks this lot → it is live again, even though the claim keeps qty=0\n'
    || E'       WHERE lot_id = v_lot_id\n'
    || E'         AND user_id = p_user_id;';

  IF position(v_old_block IN v_src) = 0 THEN
    RAISE EXCEPTION
      '20260515050000: live_scale claim UPDATE anchor not found in '
      'apply_shelf_event body — migration is stale vs the current function '
      'text. Inspect the live_scale tier-4 claim block.';
  END IF;

  IF (LENGTH(v_src) - LENGTH(REPLACE(v_src, v_old_block, '')))
     / LENGTH(v_old_block) <> 1 THEN
    RAISE EXCEPTION
      '20260515050000: live_scale claim UPDATE anchor appears more than once '
      'in apply_shelf_event — cannot safely splice.';
  END IF;

  v_src := REPLACE(v_src, v_old_block, v_new_block);
  EXECUTE v_src;
END;
$patch$;

-- Re-grant EXECUTE (CREATE OR REPLACE via the splice strips grants on some PG
-- versions). Mirrors the re-grant footer of 20260429340000.
REVOKE ALL ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, TEXT
) TO service_role;

COMMIT;
