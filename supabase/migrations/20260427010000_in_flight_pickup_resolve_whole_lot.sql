-- TTL-expired in-flight pickup: resolve the WHOLE lot, not a fraction.
--
-- ─── DEAD MIGRATION (consolidated 2026-04-27) ──────────────────────
--
-- AUDIT NOTE 2026-04-27 (Audit B):
--   The body of this migration has been removed because it was fully
--   shadowed by the LATER migration ``20260427020000_shelf_event_discarded.sql``
--   which uses ``CREATE OR REPLACE FUNCTION private.apply_shelf_event(...)``
--   with the same 10-arg signature. On a fresh ``supabase db reset`` the
--   ordering is:
--
--       20260427010000  → defined apply_shelf_event with whole-lot logic
--       20260427020000  → CREATE OR REPLACE — overwrote it WITH the same
--                          whole-lot logic preserved verbatim PLUS the
--                          new ``discarded`` branch
--
--   Result: the body in 20260427010000 was dead from the moment it was
--   committed. The pgTAP regression tests for whole-lot resolution
--   (``supabase/tests/chefbyte/in_flight_pickup_resolve_whole_lot.test.sql``)
--   pass because they exercise the LIVE production behaviour — i.e. the
--   function as redefined by 20260427020000. Mutation testing confirms
--   this: mutating the body here had no effect on any test; mutating
--   the body in 20260427020000 tripped 5 of 9 subtests.
--
-- WHY KEEP THE FILE AT ALL:
--   This migration has already been applied in production. We MUST NOT
--   revert applied migrations — fix forward only. Replacing the body
--   with a comment-only no-op is safe because:
--
--     * Production: function is currently defined by 20260427020000's
--       CREATE OR REPLACE. This file's body was dead anyway. No-op'ing
--       it changes nothing about live state.
--     * Fresh ``db reset``: this migration becomes a comment, then
--       20260427020000 defines apply_shelf_event from scratch (its
--       CREATE OR REPLACE includes the full whole-lot + discarded
--       logic). Identical end state.
--
--   Removing the file would break the migration ordering / hash chain
--   in environments tracking applied migrations by filename.
--
-- WHERE THE LIVE LOGIC NOW LIVES:
--   ``supabase/migrations/20260427020000_shelf_event_discarded.sql``
--   contains the canonical apply_shelf_event body, including the
--   pickup-close whole-lot branch originally introduced here.
--
-- ORIGINAL CONTEXT (preserved for archeology):
--   * User repro: chocolate-milk pickup where TTL reap emitted consumed
--     with delta_g translating to a fractional decrement, leaving a
--     phantom 0.468 qty after a place-back loop.
--   * Directive: "It should have removed the whole lot when the TTL
--     expired ... if for some reason there's a mismatch between the
--     quantities, it should still remove the whole lot."
--   * Fix: detect ``p_pi_event_id == lot.pickup_event_id`` in the
--     consumed branch and zero qty + clear in_flight markers regardless
--     of delta_g.

BEGIN;

-- Intentionally empty — see header. The function body is canonical in
-- 20260427020000_shelf_event_discarded.sql.
DO $$ BEGIN
  PERFORM 1;
END $$;

COMMIT;
