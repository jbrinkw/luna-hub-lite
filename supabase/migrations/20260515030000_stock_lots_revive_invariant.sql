-- ════════════════════════════════════════════════════════════════════════════
-- T1 — Ghost-stock / tombstone-merge class: structural fix (deep audit 2026-06-03).
-- ════════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE (recap): the G1 soft-delete model (20260515010000) drains a
-- fully-consumed lot to a TOMBSTONE (qty_containers=0, deleted_at=now()). The
-- `stock_lots_merge_key` unique index
--   (user_id, product_id, location_id, COALESCE(expires_on,'9999-12-31'))
-- is NOT partial on deleted_at, so the tombstone keeps occupying the merge
-- slot. Every merge writer then bumps qty ONTO the tombstone but leaves
-- deleted_at set → the result is `qty_containers > 0 AND deleted_at IS NOT NULL`:
-- stock that is invisible in every UI read (all filter `deleted_at IS NULL`)
-- and unspendable by consume_product's FEFO loop (also `deleted_at IS NULL`).
-- Pure silent data loss. Confirmed offenders: C-2 import, C-3 add-stock MCP,
-- H-1 execute_scan_action, H-12 resolve_add_to_shelf_lot, plus the live_scale
-- tier-4 claim and the A5-03 client undo path.
--
-- WHY A TRIGGER (not a partial index, not per-writer edits):
--   * A partial merge-key index was considered and REJECTED — it would let two
--     rows (one live, one tombstone) coexist on the same merge slot, which
--     splits stock across rows and breaks the "merge into ONE row" guarantee
--     the legit live-lot path depends on, and every writer's
--     ON CONFLICT/SELECT-then-UPDATE merge logic would have to learn about the
--     tombstone row. More moving parts, not fewer.
--   * Editing each merge writer to clear deleted_at is exactly the fragility we
--     are removing: six call sites today, an unknown number tomorrow, every one
--     a chance to forget. A future writer would silently reintroduce the ghost.
--
-- THE INVARIANT (server-side, one place, covers EVERY writer at once):
--   No chefbyte.stock_lots row may have qty_containers > 0 AND deleted_at
--   IS NOT NULL — that state is ALWAYS the ghost-stock bug. A
--   BEFORE INSERT OR UPDATE ... FOR EACH ROW trigger auto-clears deleted_at
--   whenever qty is positive. Writers merge onto the tombstone as before; the
--   trigger revives it IN PLACE (same lot_id, deleted_at set→NULL) — identical
--   to the existing client-side revive convention in InventoryPage.tsx:990-993
--   and the unmark_meal_done / resolve_add_to_shelf_lot revive paths.
--
-- COEXISTENCE WITH G1:
--   The G1 guard `guard_stock_lots_hard_delete` is a BEFORE DELETE trigger.
--   This is a BEFORE INSERT OR UPDATE trigger — a different event, so the two
--   never fire for the same operation and cannot conflict. (A consume that
--   drains a lot to qty=0 is an UPDATE that sets deleted_at WITH qty=0, so this
--   trigger's `qty_containers > 0` guard is FALSE and the tombstone is left
--   intact — draining still works.)
--
-- STYLE: mirrors private.set_stock_lots_updated_at (20260426010000) — plpgsql,
-- SET search_path = '', only touches the NEW record so no schema-qualified
-- table refs are required inside the body.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION private.stock_lots_revive_on_positive_qty()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  -- Positive stock can never be a tombstone. If a merge writer bumped qty
  -- onto a soft-deleted lot, revive it in place rather than leaving ghost
  -- stock that is invisible to every reader and unspendable by FEFO.
  IF NEW.qty_containers > 0 AND NEW.deleted_at IS NOT NULL THEN
    NEW.deleted_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_lots_revive_on_positive_qty ON chefbyte.stock_lots;
CREATE TRIGGER stock_lots_revive_on_positive_qty
  BEFORE INSERT OR UPDATE ON chefbyte.stock_lots
  FOR EACH ROW
  EXECUTE FUNCTION private.stock_lots_revive_on_positive_qty();

COMMENT ON TRIGGER stock_lots_revive_on_positive_qty ON chefbyte.stock_lots IS
  'T1 ghost-stock fix (deep audit 2026-06-03): enforces the invariant that no '
  'stock_lots row may have qty_containers > 0 AND deleted_at IS NOT NULL. When '
  'a merge writer bumps qty onto a tombstoned lot, deleted_at is auto-cleared '
  'so the lot is revived in place (same lot_id) — visible + spendable again. '
  'Server-side, so it covers every writer (DB RPCs, the add-stock MCP tool, the '
  'ScannerPage client undo) without per-writer edits. Distinct event from the '
  'G1 BEFORE DELETE guard stock_lots_no_hard_delete (20260515010000) — no '
  'conflict; a drain to qty=0+deleted_at is left intact.';

-- NOTE: the live_scale tier-4 CLAIM writer is the one ghost-stock path the
-- trigger CANNOT cover (it claims a tombstone for a scale while deliberately
-- KEEPING qty=0, so the `qty > 0` guard never fires). That fix is a fragile
-- text-splice of private.apply_shelf_event and is deliberately ISOLATED in a
-- SEPARATE migration (20260515050000) so a splice anchor-mismatch on prod
-- cannot abort this critical, robust trigger. See that file for the rationale.

COMMIT;
