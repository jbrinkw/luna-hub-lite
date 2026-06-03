# Deep Audit — Test Integrity Scorecard (2026-06-03)

Synthesis of the test-integrity track of the deep system audit. Two evidence streams feed this report:

1. **INSPECTION** — static mental-trace of each suite ("if I broke the feature, would this test fail?"), producing per-layer `tested / strong / suspect` tallies and named suspect tests.
2. **MUTATION** — live, reverted source/DDL mutations run against the actual running stack (Postgres container, vitest, pytest, Deno edge runtime), classifying each target as **RED-caught** (a real, load-bearing test) or **GREEN-false-pass** (the test stayed green while the feature was broken — a confirmed liar).

A test is a **PROVEN false-pass** only when a mutation that genuinely breaks the shipped behavior left its nominal guardian suite **fully green**. Everything else flagged by inspection but not yet mutated is a **suspect** (high-probability liar, not yet executed-to-proof).

**Headline:** 7 PROVEN false-passes (green-under-mutation). 38 RED-caught controls confirm the surrounding suites have real teeth. 68 inspection suspects remain across 9 layers, concentrated in the **gates** layer (34.8% suspect) and the **mock-under-test** / **spec-claims** families in web-unit.

> Cross-reference: ranked-defect doc `2026-06-03-deep-audit-FINDINGS.md`. The mutation work _proves_ several findings there (H-2/PR-DEAD, H-11/void-merge, H-19/TZ-TESTFALSE, H-20/recipe_ingredients) and **contradicts** one (H-18/C-3 chefbyte isError tests — see §2 caveat).

---

## 1. PROVEN false-passes (GREEN under mutation)

Seven mutations broke real shipped behavior and the nominal guardian suite stayed green. All mutations were reverted; source verified byte-identical after each run.

### FP-1 — `tz-dst-boundary.test.ts` never imports the function it claims to test (H-19 / TZ-TESTFALSE)

- **Layer:** web-unit
- **Target:** `apps/web/src/shared/dates.ts:25` (`todayStr` → `now.toLocaleDateString('sv-SE')`)
- **Mutation:** replaced with `now.toISOString().slice(0, 10)` — the **exact UTC bug the file's own comment (line 12) warns against**; returns the wrong calendar day near midnight in any non-UTC zone.
- **Guardian suites:** `apps/web/src/__tests__/unit/shared/tz-dst-boundary.test.ts`, `apps/web/src/__tests__/unit/pure/shared-dates.test.ts`
- **Result:** GREEN-false-pass.
  - `tz-dst-boundary.test.ts`: **10 passed (10)** under `TZ=America/New_York` despite the UTC bug.
  - `shared-dates.test.ts`: **8 passed (8)**.
- **Why it's a liar (verified in-repo):** `tz-dst-boundary.test.ts` imports only `{ describe, it, expect }` (line 26) and asserts a **private re-implementation** `getLogicalDate` defined inline at lines 41–81. It never imports `todayStr`. The shipped client date function can be arbitrarily broken with this suite staying green. `shared-dates.test.ts:10-14` is additionally tautological — its assertion mirrors the impl expression `new Date().toLocaleDateString('sv-SE')` and only diverges if the test run straddles midnight, and it never exercises `dayStartHour > 0`.
- **Severity:** HIGH. Pairs with shipped bug H-19 (web `todayStr()` ignores profile tz, written verbatim as `p_logical_date`).

### FP-2 — `TodayPage.prDetection.test.tsx` asserts against a fabricated mock the real RPC never returns (H-2 / PR-DEAD)

- **Layer:** web-unit
- **Target:** `apps/web/src/pages/coachbyte/TodayPage.tsx:503` (`const completedSetId = result?.[0]?.completed_set_id`)
- **Mutation:** forced `completedSetId = undefined`, mirroring the **real** RPC contract — per migration `20260422030000_complete_next_set_completed_flag.sql` the function `RETURNS TABLE(rest_seconds INTEGER, completed BOOLEAN)`, with **no `completed_set_id` column**.
- **Guardian suite:** `apps/web/src/__tests__/unit/coachbyte/TodayPage.prDetection.test.tsx` (`:217` undo-toast, `:195` PR-check loader)
- **Result:** GREEN-false-pass (partial) — **1 failed | 1 passed (2)**. The undo-toast test failed only because the mock itself fabricates the field; the PR-check loader test stayed GREEN (it asserts a SELECT-column string, not RPC-driven behavior).
- **Why it's a liar:** the test's mock (lines 58-68) **fabricates** `completed_set_id` / `planned_set_id` / `completed` that the live RPC never produces. In production, `TodayPage.tsx:559` (`if (completedSetId) setUndoSetId(...)`) and the PR self-exclusion at line 533 are **dead code**. The suite is green against the fabricated mock; the moment the mock matches reality, the undo-toast assertion breaks. Ground truth confirmed directly from the migration's `RETURNS TABLE` signature.
- **Severity:** HIGH. The undo toast and PR self-exclusion ship non-functional on the planned-completion path.

### FP-3 — Realtime completeness gate accepts a _factually false_ opt-out reason (H-20)

- **Layer:** pgTAP / gates
- **Target:** realtime publication membership of `chefbyte.recipe_ingredients`; gate at `supabase/tests/realtime_publication_completeness/test_completeness.test.sql` (opt-out row lines 64-65).
- **Mutation:** `ALTER PUBLICATION supabase_realtime DROP TABLE chefbyte.recipe_ingredients` — a table that **4 pages actually subscribe to**.
- **Guardian suite:** `test_completeness.test.sql`
- **Result:** GREEN-false-pass — **ok=36 not_ok=0** after the drop.
- **Why it's a liar (verified in-repo):** the opt-out registry CHECK is `reason text NOT NULL CHECK (reason <> '')` (line 49) and the assertion only tests membership-OR-non-empty-reason (lines 117-120). It **never validates that the reason is true**. The registered reason for `recipe_ingredients` (line 65) reads _"RecipesPage subscribes to chefbyte.recipes, not this join table"_ — but `apps/web/src/pages/chefbyte/RecipesPage.tsx:471` explicitly registers `{ schema:'chefbyte', table:'recipe_ingredients', queryKeys:[recipes] }` via `useRealtimeInvalidation`, for live MCP-inserted-recipe updates. The reason is factually false; dropping the table from realtime would silently break those live updates and the gate green-lights it.
- **Positive control (proves the gate has _some_ teeth):** dropping `chefbyte.food_logs` (a published table with **no** opt-out entry) went **RED** — `not ok 2 - chefbyte.food_logs — MISSING ... and no opt-out registered` (ok=35). So the gate catches missing-without-opt-out; the blind spot is specifically the unverified-reason escape hatch.
- **Severity:** HIGH.

### FP-4 — `consume_product` FEFO depletion loop's tombstone guard is untested (defense-in-depth gap)

- **Layer:** pgTAP / DB
- **Target:** `private.consume_product` FEFO depletion-loop predicate `AND deleted_at IS NULL` (the `FOR v_lot IN ...` loop), live def from migration chain (latest `20260515010000_stock_lots_no_hard_delete.sql:221-226`).
- **Mutation:** removed `AND deleted_at IS NULL` from the **depletion-loop SELECT only** (left the final `stock_remaining` aggregation's filter intact at line 264) — tombstoned/soft-deleted lots become eligible for re-consumption.
- **Guardian suites:** `supabase/tests/chefbyte/consume_product.test.sql` (38 tests), `lot_no_hard_delete.test.sql` (15 tests)
- **Result:** GREEN-false-pass — `consume_product` **ok=38 not_ok=0**, `lot_no_hard_delete` **ok=15 not_ok=0**, both identical to baseline.
- **Why it's a liar (with honest caveat):** no test ever places a lot in the `deleted_at IS NOT NULL` **AND** `qty > 0` state, so removing the loop's guard changes no observed behavior. **Caveat (reported as found):** for ordinary tombstones (`qty=0`) the loop's `qty_containers > 0` predicate already excludes them, so this guard is _partly_ defense-in-depth. It becomes truly load-bearing only for a **soft-delete-with-residual-qty** lot — exactly the state the void / partial-place paths can create (see FP-5 / H-11). Connects to the systemic tombstone-merge theme (MERGEKEY-ROOT).
- **Severity:** MEDIUM (load-bearing in conjunction with the void over-deletion bug).

### FP-5 — `execute_scan_action` purchase path has no cross-tenant test (GRANT-contained)

- **Layer:** pgTAP / DB
- **Target:** `private.execute_scan_action` purchase product lookup `WHERE product_id = p_product_id AND user_id = p_user_id` (the `AND user_id` clause), migration `20260503120000_execute_scan_action_merge_purchase.sql:78`.
- **Mutation:** dropped `AND user_id = p_user_id` (kept the `NOT FOUND` raise) — the merge writer would read **another user's** product (shelf-life) and create a lot referencing it.
- **Guardian suites:** `execute_scan_action.test.sql` (18), `scanner_wrappers_security.test.sql` (2), `scan_transactions.test.sql` (8)
- **Result:** GREEN-false-pass — all three identical to baseline (ok=18 / ok=2 / ok=8).
- **Why it's a liar:** no pgTAP test calls `execute_scan_action` with **one user's id and another user's product_id** for the purchase path. Test 16 only uses an all-zeros (non-existent) UUID, which the surviving `NOT FOUND` raise catches. So the _existence_ guard is tested (RED-caught when deleted entirely — see §3) but the _cross-tenant scope_ clause is not.
- **Blast-radius nuance (reported honestly):** `chefbyte.execute_scan_action` is `REVOKE`'d from `authenticated`/`anon` (the GRANT lockdown is RED-caught — §3), and the only real caller (`shelf-ingest` edge fn, service-role) supplies a _trusted device-owner_ `user_id`. Cross-tenant reachability via PostgREST is GRANT-contained. The missing assertion is still a real gap in defense-in-depth.
- **Severity:** MEDIUM (contained by GRANT; gap is in the in-function tenant guard test).

### FP-6 — Catch-all SECOND-measurement (return) dispatch has zero Pi coverage

- **Layer:** pi-pytest
- **Target:** `hardware/live-shelf/server/handlers/scale_events.py:~2596-2599` (catch-all SECOND-measurement cloud emit, `emit_catch_all_second_measurement(..., measured_weight_g=measured_g)`)
- **Mutation:** corrupted the emit argument `measured_weight_g=measured_g` → `measured_weight_g=-99999.0` — a nonsensical negative weight pushed to the cloud for the return measurement.
- **Guardian suite:** _none exists._ `test_catch_all_dispatch_end_to_end.py` only exercises the **FIRST** measurement.
- **Result:** GREEN-false-pass — **769 passed** (full `server/` + `cloud/` suite) with the corrupted weight in place.
- **Why it's a liar (verified in-repo):** `emit_catch_all_second_measurement` exists in `scale_events.py` but a repo-wide grep of `server/tests/` and `cloud/tests/` for `emit_catch_all_second_measurement` / `catch_all_second` returns **nothing**. The entire return-leg of the catch-all classifier dispatch — including the weight reported to the cloud — is untested.
- **Positive control:** flipping the FIRST/SECOND dispatch guard (so a FIRST event takes the SECOND branch) went **RED** via `test_catch_all_dispatch_end_to_end` (FIRST emit never fired). So the FIRST path is covered; only SECOND is dark.
- **Severity:** HIGH (coverage hole on a cloud-sync write path).

### FP-7 — Catch-all REMOVE-suppression branch is untested

- **Layer:** pi-pytest
- **Target:** `hardware/live-shelf/server/handlers/scale_events.py:4016` (`if shelf_id == "catch_all" and direction == "remove":`)
- **Mutation:** disabled the branch (`... and False`), so a catch-all REMOVE is **not** suppressed and falls through into the full session/classifier pipeline — violating the single-event placement model (commit `68abb2b`).
- **Guardian suite:** _none exists_ (should assert a catch-all REMOVE returns `suppressed:catch_all_remove` and writes no `scale_events` row).
- **Result:** GREEN-false-pass — **769 passed** with REMOVE-suppression entirely disabled.
- **Why it's a liar (verified in-repo):** the suppression branch and its `"suppressed": "catch_all_remove"` return exist at lines 4016-4042, but a grep of `server/tests/` for `catch_all_remove` returns nothing.
- **Asymmetry note:** a sibling experiment flipping the branch to suppress **ADD** instead was RED-caught via the well-covered ADD path — so only the REMOVE direction is dark.
- **Severity:** MEDIUM.

> **Eighth confirmed coverage hole (proven, not a "test" per se):** `repo.py:1456` — `list_user_inventory_lots_qty_gt_zero` base read. Dropping `AND cl.deleted_at IS NULL` (cloud-tombstone exclusion that feeds catch-all auto-import tare estimation) kept **178 passed** green. No test directly calls this base function with a tombstoned lot. A cloud-deleted lot could leak into the catch-all tare-write candidate pool. Listed under FP-row data and §4 (coverage holes) rather than as a guardian-test liar because there is no nominal guardian test to name.

---

## 2. RED-caught controls (the surrounding suites DO have teeth)

38 mutations broke real behavior and were caught. These establish that the false-passes above are _localized_ gaps, not symptoms of a uniformly hollow suite. Highlights by layer:

**pgTAP / DB (RED-caught):**

- RLS isolation — `hub.profiles` `USING (true)` → caught by `00_rls_pattern.test.sql` Test 2; `chefbyte.locations` `USING (true)` → caught by `rls_core.test.sql` Test 2.
- `consume_product` floor-at-0 (force partial-subtract on every lot → negative stock) → caught by `consume_product.test.sql` Tests 8-18, **and** backstopped by the `stock_lots_qty_nonneg` CHECK constraint.
- `complete_next_set` lowest-order pick (`ORDER BY ps."order"` → `DESC`) → caught by `complete_next_set.test.sql` Tests 3 & 6.
- `get_logical_date` tz handling (`AT TIME ZONE tz` → `'UTC'`) → caught by `get_logical_date_tz/test_tz_matrix.test.sql` across DST boundaries (NYC spring/fall, Honolulu). **The SQL-side tz contract is sound** even though the web-side mirror (FP-1) is a false-pass.
- `execute_scan_action` existence guard (delete `IF NOT FOUND ... RAISE`) → caught by Test 16.
- GRANT lockdown — re-`GRANT EXECUTE ... TO authenticated` on `chefbyte.execute_scan_action` → caught by `scanner_wrappers_security.test.sql` Test 1 (42501). **This is the real security guard on the merge writer.**
- Realtime gate positive control (drop `food_logs`, no opt-out) → caught (see FP-3).

**pgTAP — void_scan_transaction (RED-caught but pins the WRONG behavior — H-11):**

- Replacing the whole-lot `DELETE` with a correct partial qty-subtract went **RED** at `void_scan_transaction.test.sql` Tests 2 & 3 — but those tests **pin tombstone-via-DELETE**. Because the test seeds a dedicated `qty=1` lot == `qty=1` purchase, it **cannot distinguish** correct partial reversal from wrong whole-lot zeroing. A separate live merge-then-void proof (seed qty=5, purchase +1 → qty=6, void → live qty=0) showed the shipped `DELETE` **destroys all 5 pre-existing containers**. So this suite is simultaneously a true RED-catcher _and_ a guardian of a real over-deletion bug. Severity: HIGH (shipped bug H-11).

**web-unit (RED-caught):** epley 1RM divisor (`/30`→`/25`); macro 4-4-9 tolerance (`0.25`→`5.0`); keypad leading-zero replace; livetrack tag visibility membership + color machine (red/blue/normal); timer `expireTimerRpc` swallow semantics (25-cell matrix).

**pi-pytest (RED-caught):** in-flight TTL reaper boundary (both directions); G4 persist-failure watermark revert; catch-all FIRST dispatch; ingress cloud→pi kind-translate; `_kind_translate` PI↔CLOUD table + weight-sync poller runtime assertion; G2 `out` vs `lost`; tombstone→`lost`; malformed-row watermark advance; product soft-delete exclusion in `list_products`.

**app-tools + mcp-worker + edge-fn (RED-caught, 0 proven liars in this set):**

- `auth.ts:15` accept-on-failure (`return null` → `return 'user-abc'`) → caught by `auth.test.ts` (revoked/not-found/db-error all expect null).
- `set-price.ts` negative-price guard, `add-stock.ts` zero-qty boundary → caught by the **live-DB** `chefbyte-tools.test.ts` integration suite.
- `analyze-product` quota off-by-one (`>=`→`>` at 100) → caught (429 expected).
- `shelf-ingest` disabled-device guard + `client_event_id` gate → caught **after forced edge-runtime reload** (see caveat below).

> **Methodology caveat (edge-fn cache):** the Supabase `edge_runtime` container caches function bytecode and does **not** hot-reload `shelf-ingest` on file change. The first `shelf-ingest` mutation showed a **false GREEN** that was a stale-cache artifact; after `docker restart supabase_edge_runtime_luna-hub-lite` (verified with a `__probe` marker in the 401 body) the same mutation went RED. **RED edge-fn verdicts are sound** (stale code = original behavior = green, so a RED _must_ be the new code); only edge-fn GREENs require a forced reload to trust. This does not affect any §1 false-pass (none are edge-fn GREENs).

> **CONTRADICTION with FINDINGS H-18/C-3 (reported honestly):** the ranked-defect doc lists the chefbyte "isError-convention tests whose mock RPC always errors" + "stale lots excluded test" as suspected false-passes. The app-tools mutator reports these **do not exist** as mock-always-errors tests in `packages/app-tools/src/__tests__/integration/chefbyte-tools.test.ts` — it is a **real DB-backed** (live local Supabase), story-ordered integration suite with **no `vi.mock`/`vi.fn` and no `.skip`**; the `isError` guards are genuinely covered (set-price + add-stock mutations both went RED). **Scoring resolution:** the chefbyte integration `isError` tests are scored as **strong (RED-caught)**, _not_ as false-passes. The H-18/C-3 _shipped bug_ (import RPC fails under service-role `auth.uid()=NULL`) is a separate concern from the integration-test quality and is unaffected by this resolution. The two `mcp-iserror-convention.test.ts` cases (app-tools §7 below) are a _different_ file and remain suspect.

---

## 3. Per-layer scorecard

Counts are each finder's in-scope tally (mental-traced during inspection); they are **not** a single global de-duped denominator (a few files appear in more than one finder's scope, and "strong" excludes untraced tests). `Proven liars` = §1 green-under-mutation in that layer. `Suspects` = inspection-flagged, not yet executed-to-proof.

| Layer               |    Tested |    Strong | Suspects |                Proven liars | Suspect % | Notes                                                                                       |
| ------------------- | --------: | --------: | -------: | --------------------------: | --------: | ------------------------------------------------------------------------------------------- |
| **pgTAP**           |       118 |       100 |        8 | **2** (FP-4, FP-5) + FP-3\* |      6.8% | FP-3 (gate) also counts here; void-pin (H-11) is a RED-catcher of the wrong behavior        |
| **web-unit**        |       128 |        64 |       12 |          **2** (FP-1, FP-2) |      9.4% | Dominated by mock-under-test (onerror-rollback ×7) + spec-claims tautologies                |
| **web-integration** |        61 |        38 |        6 |                           0 |      9.8% | `encryption-roundtrip` no-data guard + scanner copy-of-logic suspects                       |
| **web-e2e**         |       392 |       300 |       10 |                           0 |      2.6% | Weak-assertion `toMatch(/\d/)` family (PRs, macros, meal-plan)                              |
| **pi-pytest**       |       132 |       150 |        3 |          **2** (FP-6, FP-7) |      2.3% | Mutation found 2 hard coverage holes inspection under-counted                               |
| **harness**         |        30 |        27 |        3 |                           0 |     10.0% | Self-tests; not deeply mutated this pass                                                    |
| **app-tools**       |       480 |       300 |       10 |                           0 |      2.1% | chefbyte integration RED-caught (contra H-18/C-3); `mcp-iserror-convention` remains suspect |
| **mcp-worker**      |       152 |       118 |        8 |                           0 |      5.3% | Unit auth RED-caught; gaps are _integration-only-coverage_ (registry/JWT)                   |
| **gates**           |        23 |        16 |        8 |                **1** (FP-3) |     34.8% | Worst suspect density; opt-out + invariant re-impl tautologies                              |
| **TOTALS**          | **1,516** | **1,113** |   **68** |                       **7** |  **4.5%** | + 1 proven coverage hole with no nominal guardian (repo.py:1456)                            |

\* FP-3 is a single defect that lives at the pgTAP/gates seam; counted once in the headline "7", shown in both rows for traceability.

**Reading the scores:**

- **gates (34.8% suspect)** is the weakest layer by far. Meta-gates that assert against their own re-implementations or unverified registries (opt-out reasons, invariant heartbeat re-impls, event-kind matrices) give a false sense of enforcement. FP-3 is the proven exemplar.
- **pi-pytest** has a _low_ suspect rate but the **highest count of proven hard coverage holes** (FP-6, FP-7, + repo.py:1456) — inspection under-counted these because the missing tests simply don't exist to flag. Mutation is the only way they surfaced.
- **web-unit** has the most _named_ suspects (12), almost all in two families: `onerror-rollback/*` (7 files testing in-file copies of production `onError` handlers) and `*-spec-claims.test.tsx` (assert test-local constants, never production code paths). FP-1 and FP-2 are the two from this layer that were executed to proof.
- **app-tools / mcp-worker / web-e2e** are the strongest (≤5.3% suspect, 0 proven liars in the mutated subset). Their gaps are mostly _layer-displacement_ (real coverage exists, but only in the live-integration/E2E config, not the default unit run).

---

## 4. Critical coverage holes (code with no catching test)

Code paths a deliberate break leaves entirely green — ranked by blast radius.

1. **Catch-all SECOND-measurement (return) cloud emit** — `scale_events.py:~2599`. The weight reported to the cloud on the return leg is untested (FP-6). A wrong/negative weight ships silently. **No guardian test exists.**
2. **Catch-all REMOVE-suppression** — `scale_events.py:4016`. Removing suppression (single-event-model violation) is invisible (FP-7). **No guardian test exists.**
3. **`list_user_inventory_lots_qty_gt_zero` cloud-tombstone exclusion** — `repo.py:1456`. A cloud-deleted lot can leak into the catch-all tare-write candidate pool (proven green-under-mutation). The certified/uncertified _siblings_ have other-filter tests; the **base** function's `cl.deleted_at` exclusion has none.
4. **`execute_scan_action` purchase cross-tenant scope** — no test crosses one user's id with another user's product (FP-5). GRANT-contained but undefended in-function.
5. **`consume_product` FEFO loop tombstone-with-residual-qty** — no test seeds `deleted_at IS NOT NULL AND qty > 0` (FP-4). Load-bearing alongside H-11.
6. **mcp-worker `registry.ts:52` disabled-tool filter** — `buildUserTools` is imported by **no unit test**; deleting `if (disabledTools.has(name)) continue;` keeps the default `pnpm test` fully green (113 passing). Only the live-wrangler `test:integration` (`mcp-worker.test.ts:718`) catches it. Disabled tools would be exposed in any environment that doesn't run the integration suite.
7. **mcp-worker `authenticateJwt` (`index.ts:151`)** — imported by no unit test; `durable-object.test.ts` only mocks `fetch`. A JWT auth-bypass is visible only under `test:integration`.
8. **Realtime replica-identity contract** — `realtime_invalidation/test_invalidation.test.sql` header claims a `REPLICA IDENTITY FULL` contract but contains **no assertion** for it; current prod state (DEFAULT) passes all 7 assertions. The `SELECT is(relreplident, 'f', ...)` check is missing entirely.
9. **Storage RLS parity-reports** — `storage_rls_parity_reports/test_rls.test.sql` self-skips because the `parity-reports` bucket/migration doesn't exist; the 5 assertions never run. It SKIPs (green) instead of FAILing when the bucket is absent.
10. **Cloud outbox / event-lifecycle state machines (pgTAP side)** — `cloud_outbox_states` and `event_lifecycle` pgTAP files operate on temp mirrors, not the Pi's `outbox.py`/`lifecycle.py`. Real Python transition bugs (e.g. `mark_failed` setting `attempts=0`) leave them green; coverage exists, if at all, only Pi-side.

---

## 5. Worst offenders — fix these first

Ordered by (severity of the masked defect) × (confidence: proven > suspect). Each line: the test to repair and the one-line fix.

1. **`apps/web/src/__tests__/unit/coachbyte/TodayPage.prDetection.test.tsx`** (FP-2, H-2) — stop fabricating `completed_set_id`/`planned_set_id`/`completed` in the mock (lines 58-68); make the mock return the real `RETURNS TABLE(rest_seconds, completed)` shape. The undo-toast + PR self-exclusion tests will then correctly go RED, exposing the dead production paths.
2. **`apps/web/src/__tests__/unit/shared/tz-dst-boundary.test.ts`** (FP-1, H-19) — delete the inline `getLogicalDate` re-impl; **import and test the shipped `todayStr` from `@/shared/dates`** with a non-UTC `TZ` and `dayStartHour > 0`. Also fix `shared-dates.test.ts:10-14` to assert a fixed expected string, not the impl expression.
3. **`supabase/tests/realtime_publication_completeness/test_completeness.test.sql`** (FP-3, H-20) — either remove the false `recipe_ingredients` opt-out row (the table genuinely _is_ subscribed, so it should be **in** the publication and the gate goes RED until the migration adds it), or make the gate **validate** each opt-out reason against a machine-checkable source rather than `reason <> ''`.
4. **`hardware/live-shelf/server/tests/` — add catch-all SECOND-measurement dispatch test** (FP-6) — assert `emit_catch_all_second_measurement` is called with `measured_weight_g == measured_g` (positive, sane) on the return leg, mirroring the existing FIRST-measurement end-to-end test.
5. **`hardware/live-shelf/server/tests/` — add catch-all REMOVE-suppression test** (FP-7) — assert a `catch_all` + `remove` event returns `suppressed:catch_all_remove` and writes **no** `scale_events` row.
6. **`hardware/live-shelf/server/...` — add tombstone-exclusion test for `list_user_inventory_lots_qty_gt_zero`** (hole #3) — seed a `cl.deleted_at IS NOT NULL` lot and assert it is **absent** from the candidate list.
7. **`apps/web/src/__tests__/unit/onerror-rollback/*` (7 files)** — these test in-file _copies_ of production `onError` `setQueryData` rollbacks (TodayPage, MacroPage, MealPlan, Reviews, ApiKeys, Extensions, Tools). Rewrite to drive the **actual** mutation's `onError` (or delete and rely on integration coverage). Until then, deleting any of the 7 production rollbacks ships green.
8. **`*-spec-claims.test.tsx` (hub/chefbyte/coachbyte)** — claims 5-8 in each assert test-local constants / re-implementations and **cannot** turn RED for any production change (proven by tracing: breaking `complete_next_set` ordering leaves coachbyte claim-5 green). Re-point each claim at the real imported symbol or remove the file.
9. **`packages/app-tools/src/__tests__/mcp-iserror-convention.test.ts:139-179`** — `assertIsError` applied to bundled handlers stays green even if a handler's whole body is replaced with `return toolError('boom')` (the mock never reaches the success branch). Add a _positive_ assertion that each handler returns a **success** shape on a valid call.
10. **`supabase/tests/invariants/*` re-implementation tautologies** — `live_shelf_devices_no_paired_regress` (line 103), `watermark_contract_updated_at` (Invariant 5), `event_kind_emit_handle_matrix` (assertion 3) all assert against in-file re-implementations / local row-sets and never invoke the shipped function (`apply_event_override`, heartbeat writer, `VALID_EVENT_KINDS`). Make each call the real function and assert its effect.

---

## Appendix — methodology & integrity notes

- **All mutations reverted.** Every Postgres function/policy/grant/publication was restored from `pg_get_functiondef` snapshots and verified byte-identical; zero edits to `supabase/migrations` or `supabase/tests`. JS/Python mutations reverted in-tree.
- **Live-stack mutation** (not file-only): pgTAP mutations were applied via `CREATE OR REPLACE` / `ALTER POLICY` / `GRANT` / `ALTER PUBLICATION` inside the running `supabase_db_luna-hub-lite` container, with single-test pgTAP runs via the helper. This guarantees the test ran against the _mutated_ object, not a stale file.
- **Edge-fn cache hazard** documented in §2 — only affects edge-fn GREEN verdicts; no §1 false-pass relies on one.
- **Honest negative findings preserved:** FP-4 and FP-5 carry caveats (defense-in-depth / GRANT-containment) rather than being overstated as exploitable. The H-18/C-3 contradiction is reported in full (§2) and resolved in favor of the mutation evidence.
- **Out-of-scope, intentionally untouched** (sibling-mutator territory, to avoid collision): `extensions/**/obsidian-ssrf.test.ts` (H-15), a sibling's in-flight `// MUTATION:` edit in `supabase/functions/shelf-ingest/index.ts`, and `hardware/live-shelf/server/*` changes already in progress. Suspects in those areas are carried forward from inspection only.
