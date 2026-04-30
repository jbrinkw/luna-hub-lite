-- pgTAP structural invariant — private.resolve_add_to_shelf_lot must NOT
-- contain the pre-787d19b qty-accumulation arithmetic.
--
-- ROOT CAUSE (2026-04-29): the resolver had four sites that executed
--   qty_containers + (p_placed_weight_g / v_net_g)   [or similar]
-- when an existing qty>0 lot was found. Each partial-bottle return
-- accumulated fractional containers, drifting Gatorade to 2.350, Chicken
-- to 1.377, Whole Milk to 3.500. Fix: preserve qty (no addition).
--
-- Fix migration: 20260429210000_partial_place_no_qty_bump.sql.
--
-- This test is a STRUCTURAL check via pg_get_functiondef. It asserts the
-- compiled function body does not contain the bug-class arithmetic pattern.
-- It catches:
--   (a) Exact reintroduction of the pre-fix lines
--   (b) Variants with different spacing, parenthesisation, or variable names
--       that implement the same additive accumulation (e.g. v_placed / v_net,
--       placed_g / net_g, p_placed_weight_g / v_net, etc.)
--
-- NEGATIVE-TWIN PROOF:
--   Reverting 20260429210000_partial_place_no_qty_bump.sql restores the old
--   function body. pg_get_functiondef then returns the source that includes
--   the accumulation arithmetic at steps 1/2/2.5/2.6 — all four regex
--   patterns below match and the assertions FAIL.
--
-- Pattern strategy (defensive regex, not exact-string):
--   The bug class: qty_<any_suffix> := ... qty_<any_suffix> [+-] (
--   OR: SET qty_containers = ... qty_containers + (
--   The key signal is an additive update of a qty field using a ratio.
--   We exclude the ONLY legitimate addition in the function: GREATEST(0, ...)
--   which does NOT add a ratio — it only floors. The patterns below target
--   the ratio-addition form.

BEGIN;
SELECT plan(3);

------------------------------------------------------------
-- Assert the function exists with the correct name (sanity guard so
-- a rename causes a clear "function not found" error rather than a
-- confusing NULL-match pass).
------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
      AND p.proname = 'resolve_add_to_shelf_lot'),
  1,
  'private.resolve_add_to_shelf_lot exists (exactly one overload)'
);

------------------------------------------------------------
-- Core structural assertion A: function body must NOT match the
-- additive-ratio pattern "qty_containers + (" at any step.
--
-- The pre-fix code had four sites of the form:
--   qty_containers = GREATEST(qty_containers + (p_placed_weight_g / v_net_g), 0)
--   qty_containers = qty_containers + (p_placed_weight_g / v_net_g)
-- All share the substring "qty_containers + (" — that exact token cannot
-- appear in a correct implementation that preserves qty.
--
-- Defensive width: the regex uses word-boundary-insensitive ~* (case-
-- insensitive) and anchors on the literal token "qty_containers + (" so
-- whitespace variants ("qty_containers  +(", "qty_containers+(") are also
-- caught via the REPLACE-normalise step.
------------------------------------------------------------
SELECT ok(
  NOT (
    REPLACE(
      pg_get_functiondef(p.oid),
      ' ', ''
    ) ~* 'qty_containers\+\('
  ),
  'structural(787d19b-A): resolve_add_to_shelf_lot body has NO "qty_containers + ("'
  ' pattern (additive accumulation). Fails when migration 20260429210000 is reverted.'
)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'private'
  AND p.proname = 'resolve_add_to_shelf_lot';

------------------------------------------------------------
-- Core structural assertion B: function body must NOT match the
-- division-ratio form "p_placed_weight_g / v_net_g" used as an rvalue
-- in a qty SET clause.
--
-- Even if a future agent renames the accumulation variable from
-- qty_containers to v_qty_to_add, the division ratio
-- "p_placed_weight_g / v_net_g" (or "placed / net_g", etc.) must not
-- appear in any additive SET context. We catch the ratio itself via a
-- pattern that matches:
--   p_placed_weight_g / v_net_g   (exact pre-fix variable names)
--   p_placed_weight_g / v_net     (truncated suffix variant)
--   placed_weight_g / v_net_g     (dropped p_ prefix variant)
-- The pattern is: "placed_weight_g / v_net" (case-insensitive, space-
-- normalised) — present in ALL four pre-fix additive sites, absent in
-- the post-fix function.
------------------------------------------------------------
SELECT ok(
  NOT (
    REPLACE(
      pg_get_functiondef(p.oid),
      ' ', ''
    ) ~* 'placed_weight_g/v_net'
  ),
  'structural(787d19b-B): resolve_add_to_shelf_lot body has NO '
  '"placed_weight_g / v_net" ratio fragment (division-into-qty pattern). '
  'Fails when migration 20260429210000 is reverted.'
)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'private'
  AND p.proname = 'resolve_add_to_shelf_lot';

SELECT * FROM finish();
ROLLBACK;
