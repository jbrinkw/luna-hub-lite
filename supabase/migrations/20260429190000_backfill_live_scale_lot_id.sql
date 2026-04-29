-- ════════════════════════════════════════════════════════════════════════════
-- Backfill chefbyte.scale_pairings.lot_id for live_scale rows
-- ════════════════════════════════════════════════════════════════════════════
-- USER BUG (2026-04-29):
--   Single-track (live_scale) ``scale_pairings`` rows can have
--   ``product_id`` set but ``lot_id IS NULL``. When that happens the
--   apply_shelf_event live_scale branch falls through to the FEFO/heuristic
--   tier (see ``20260429010000_live_scale_never_mints_v2.sql`` resolver
--   tiers b → c → d), which is wrong the moment there is more than one
--   non-zero lot for the product. Recurring sync-drift bugs
--   (consumed/refilled events landing on the wrong lot, qty drifting)
--   trace back to this gap.
--
-- ROOT CAUSE:
--   The earlier lot-level migration (20260427080000_scale_pairings_lot_level)
--   only backfilled rows with **exactly one qty>0 not-in-flight lot** at
--   migration time. New pairings created AFTER that migration go through
--   the manual-pair flow in ``apps/web/src/components/chefbyte/ScalesTab.tsx``
--   (``pairScaleMutation``), which UPDATEs only ``product_id`` — never
--   ``lot_id``. A pair created BEFORE its first lot was minted, or paired
--   while the user had two lots and one later depleted, leaves the row in
--   the (product_id IS NOT NULL, lot_id IS NULL) state forever.
--
-- CONCRETE STATE (production, project btlfsxammjzkyluophgr):
--   * scale-03 (live_scale): product_id = b7024be0-…, lot_id = NULL,
--     exactly 1 stock_lot exists (54e90a06-…, qty=1, source='live_scale').
--   * scale-ls-A (live_scale): healthy reference — both pinned.
--   * scale-ls-B / scale-01 / scale-02 / cross-shared-01: product_id NULL,
--     so out of scope for this backfill.
--
-- SCOPE:
--   For every ``chefbyte.scale_pairings`` row where:
--     * kind = 'live_scale'
--     * product_id IS NOT NULL
--     * lot_id IS NULL
--   pick the matching ``stock_lots`` row using a tiered search and pin it.
--
--   Tier order (mirrors the apply_shelf_event live_scale resolver in
--   ``20260429010000_live_scale_never_mints_v2.sql`` so post-backfill behaviour
--   matches the FEFO/heuristic that is being replaced):
--     1. Lots already sourced from live_scale (qty>0, FEFO) — same product/user.
--     2. Any qty>0 not-in-flight lot (FEFO) — same product/user.
--     3. Any qty>0 lot (FEFO, ignore in_flight) — same product/user.
--     4. Any lot at all (qty=0 revive case, FEFO) — same product/user.
--   First tier with a row wins. ``ORDER BY expires_on NULLS LAST,
--   last_update_ts NULLS LAST`` to be deterministic.
--
-- IDEMPOTENCY:
--   The UPDATE is filtered to ``lot_id IS NULL`` so re-running on a
--   migrated DB is a no-op.
--
-- INVARIANT-PRESERVING:
--   The companion pgTAP file
--   ``supabase/tests/invariants/live_scale_pairing_has_lot_id.test.sql``
--   pins the rule going forward; CI fails if a future code path
--   reintroduces the gap.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE chefbyte.scale_pairings sp
   SET lot_id = COALESCE(
     -- Tier 1: lots sourced from live_scale, qty>0, FEFO.
     (SELECT sl.lot_id
        FROM chefbyte.stock_lots sl
       WHERE sl.user_id = sp.user_id
         AND sl.product_id = sp.product_id
         AND sl.qty_containers > 0
         AND sl.last_update_source = 'live_scale'
       ORDER BY sl.expires_on ASC NULLS LAST,
                sl.last_update_ts ASC NULLS LAST
       LIMIT 1),
     -- Tier 2: any qty>0 not-in-flight lot, FEFO.
     (SELECT sl.lot_id
        FROM chefbyte.stock_lots sl
       WHERE sl.user_id = sp.user_id
         AND sl.product_id = sp.product_id
         AND sl.qty_containers > 0
         AND sl.in_flight_since IS NULL
       ORDER BY sl.expires_on ASC NULLS LAST,
                sl.last_update_ts ASC NULLS LAST
       LIMIT 1),
     -- Tier 3: any qty>0 lot (ignore in_flight), FEFO.
     (SELECT sl.lot_id
        FROM chefbyte.stock_lots sl
       WHERE sl.user_id = sp.user_id
         AND sl.product_id = sp.product_id
         AND sl.qty_containers > 0
       ORDER BY sl.expires_on ASC NULLS LAST,
                sl.last_update_ts ASC NULLS LAST
       LIMIT 1),
     -- Tier 4: any lot at all (qty=0 revive case), FEFO.
     (SELECT sl.lot_id
        FROM chefbyte.stock_lots sl
       WHERE sl.user_id = sp.user_id
         AND sl.product_id = sp.product_id
       ORDER BY sl.expires_on ASC NULLS LAST,
                sl.last_update_ts ASC NULLS LAST
       LIMIT 1)
   )
 WHERE sp.kind = 'live_scale'
   AND sp.product_id IS NOT NULL
   AND sp.lot_id IS NULL;

COMMIT;
