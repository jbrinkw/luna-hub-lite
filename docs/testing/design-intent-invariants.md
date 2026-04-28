# Design-intent invariant tests

Tests that pin architectural rules so a future agent (or you) can't
silently regress them.

## Why

Tests pin behavior. Without invariant tests for **design rules**, behavior
gradually drifts from intent. The bug class:

1. Decision is made and code is written.
2. Months later, an unrelated refactor accidentally violates the
   decision. Existing unit tests still pass because they're testing
   "the code does what the code does," not "the code does what was
   designed."
3. Bug ships. User hits it. Decision-log entry rediscovered. Code
   re-fixed.
4. Repeat in 3 months for the same decision.

Real examples this pattern caught:

- **Decision #45** ("LiveTrack matches against existing inventory") was
  applied too broadly → live_shelf ADD pool wiped of catalog products
  (Gatorade Frost case). No test caught the over-application.
- **Decision #56** (catch-all delta-capture) was originally implemented
  as "single-item shelf substitute" until user explicitly clarified
  intent. No test asserted the design.
- `_mint_pi_lot_for_inventory_only_pick` was misnamed and confused
  subsequent agents into thinking it was a forbidden catalog-mint.

## The pattern

A design-intent invariant test follows this shape:

```text
1. Enumerate every instance of a pattern in the codebase
   (every table, every function, every event_kind, every shelf, ...).
2. Assert the invariant holds for each instance.
3. The deliverable is a list of N rows; if N is small, the test is
   suspiciously incomplete.
4. Mutating the design rule MUST trip the test with a concrete
   message naming WHICH instance regressed.
```

The reference implementation is `TestPromptPurity` in
`hardware/live-shelf/server/classifier/tests/test_prompt.py` (commit
`3b99043`). It enumerates every text block in the rendered classifier
prompt and greps for forbidden lot-level field names. Adding any
forbidden key → test fails immediately.

## What's pinned (current set)

| File                                                                             | Decision / spec pinned                                                                | Mutation trip                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `hardware/live-shelf/server/tests/invariants/test_pool_composition_per_shelf.py` | #45 / #54 / #56 — three-shelf-three-pool composition                                  | Flip `shelf_id == "live_shelf"` gate to `single_item` → 3 tests fail naming the leaking tier                                       |
| `hardware/live-shelf/server/tests/invariants/test_no_catalog_mint_naming.py`     | #45 retro — `_mint_pi_lot_for_inventory_only_pick` confusion                          | Add a `mint`-named function without the disambiguation phrase → test fails naming the offender                                     |
| `hardware/live-shelf/server/classifier/tests/test_prompt_purity_extended.py`     | #42 / #45 / #56 — classifier sees products only                                       | Inject `pickup_weight_g` into `Candidate.to_prompt_dict` → 5 tests fail across every shelf kind                                    |
| `supabase/tests/invariants/rls_canonical_pattern.test.sql`                       | CLAUDE.md — `(select auth.uid()) = user_id TO authenticated` everywhere               | Add a `USING(true)` policy → test fails listing the table::policy                                                                  |
| `supabase/tests/invariants/security_definer_pattern.test.sql`                    | CLAUDE.md — `private` schema = SECURITY DEFINER + `SET search_path = ''`              | `ALTER FUNCTION ... RESET search_path` → test fails naming the function                                                            |
| `supabase/tests/invariants/discarded_no_food_logs.test.sql`                      | #44 — manual discard does NOT track macros                                            | Add `INSERT INTO food_logs` to the `discarded` branch of `apply_shelf_event` → 4 cases fail with explicit "macro tracking" message |
| `supabase/tests/invariants/catch_all_ttl_passive.test.sql`                       | #56 — catch-all TTL clears markers, keeps qty, no food_logs                           | Add `qty_containers = 0` to `reap_catch_all_in_flight` → test fails: "have 0.000 want 0.500"                                       |
| `supabase/tests/invariants/live_shelf_ttl_macro_write.test.sql`                  | #43 / #56 Q6 — live_shelf TTL pickup-resolve writes food_logs for full mass           | Drop the food_logs INSERT in `pickup_close_whole_lot` branch → test fails with explicit "have 0 want 1" + macro-mass mismatch      |
| `supabase/tests/invariants/event_kind_emit_handle_matrix.test.sql`               | #44 / #56 + 2026-04-22 EMIT→HANDLE matrix                                             | Rename a branch IF condition to `_REGRESSION` → test fails listing the orphaned kind with `reason=unknown event_kind`              |
| `supabase/tests/invariants/scale_pairings_lot_id_consistency.test.sql`           | Migration 20260427080000 contract — pairings.lot_id matches user + product of the lot | Plant a cross-user / cross-product pair → test fails listing the offender                                                          |

## How to add a new invariant test

When you ship a new design decision:

### Step 1 — Identify the rule

Phrase it as a sentence the codebase MUST satisfy regardless of
implementation. Examples:

- "Every X has a Y."
- "X never contains Z."
- "When A, B is true."

Bad invariant: "the code calls foo()." (tautological — pins
implementation, not design.)

Good invariant: "the discarded event_kind never increments
food_logs." (pins WHY behavior must hold.)

### Step 2 — Enumerate every instance

The test must walk the whole population:

- Every table in `pg_policies` for an RLS rule.
- Every function in a schema for a SECURITY DEFINER rule.
- Every shelf kind for a pool composition rule.
- Every event_kind for an emit/handle matrix.

If you write a test that asserts the rule on ONE example, you're not
writing an invariant test — you're writing a unit test. The invariant
discipline is enumeration.

### Step 3 — Build the failure message to name the regressing instance

When the test fails, the engineer must immediately know WHICH instance
violated the rule. Patterns:

- pgTAP: build a `string_agg` of offenders into the assertion message.
- Python: collect offenders into a list and `pytest.fail(...)` with
  the list.

Anti-pattern: "RLS canonical pattern violated" (no instance named).
Correct: "NEEDS REVIEW: chefbyte.products::test_drift_policy".

### Step 4 — Mutation-verify

Temporarily break the design rule (in a way mirroring the bug class
the test pins). Assert the test fails AND the failure message names
the right instance. Restore the code. Record the mutation result in
the doc table above.

If the mutation doesn't trip the test, the test is too weak. Tighten
it before claiming the invariant is pinned.

### Step 5 — Document

Add a row to the table in this file. Cite the decision-log entry,
the file path, and the mutation result. The next engineer should be
able to read this doc and immediately know which rules are
test-protected and which are still on the honor system.

## File-layout convention

- `hardware/live-shelf/server/tests/invariants/` — Pi-side invariants
  (Python).
- `hardware/live-shelf/server/classifier/tests/test_prompt_purity*.py`
  — classifier-prompt invariants (kept next to the production
  module).
- `supabase/tests/invariants/` — DB-side invariants (pgTAP).
- `apps/web/src/__tests__/invariants/` — web-app invariants
  (vitest). Currently empty; reserved for the next batch.

## Related

- Decision log: `~/.claude/projects/-home-jeremy-luna-hub-lite/memory/decisions.md`
- Verification gates: `docs/VERIFY.md`
- pgTAP test runner: `npx supabase test db`
- Pi pytest runner: `cd hardware/live-shelf && .venv/bin/pytest`
