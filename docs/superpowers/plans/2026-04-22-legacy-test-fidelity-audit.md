# Legacy Test Fidelity Audit — Pre-Wave-1-2-3 Suite (post-livetrack miss)

**Audit date:** 2026-04-22
**Scope:** every test in the repo EXCEPT those added/modified by the
wave-1-2-3 commits covered in `2026-04-22-test-fidelity-reaudit.md`
(excluded: `97fb0d1`, `6ede1d7`, `321a5fc`, `1efeae1`, `222405f`,
`534c6b8`, `1cb697a`, `4c3f1a7`, `126e44b`, `2699546`, `2701765`,
`448967c`, `cf72eb3`, `fb36e55`, `a9b376f`, `a375b9d`).
**Method:** read each file, invent 2-3 realistic regressions per test,
ask "would this test fail?" — the livetrack lens.

---

## 1. Executive summary

Roughly **~1,200 pre-existing tests** audited across pgTAP (33 files,
~7,900 lines), web integration (~5,700 lines), web E2E (~15,000 lines),
web unit (~4,700 lines), Pi pytest (~28 files, ~300 tests), MCP worker
(6 files), app-tools extensions (~79k line legacy mock file), and
~17 page-query integration files (~8k lines total).

**Verdict: regrade the pre-existing suite from the original B+ down to
C+.** The original audit's HIGH ratings on E2E and pgTAP held up on
spot-check, but the assessment was inflated by not reading past the
first 2-3 tests per file. A systematic sweep reveals:

- **2 CRITICAL** tests that would silently pass under the realistic
  regression they claim to guard: `timer_states.test.sql`
  (self-implementing WHERE guard — literally tests the mock) and
  `api-key-lifecycle.test.ts::enforces max 10 active keys` (asserts
  count == 2 and <= 10, testing nothing).
- **7 HIGH** — mostly structural category-false tests: the entire
  `__tests__/integration/pages/chef-*.test.ts` + `coach-*.test.ts`
  suite (15 files, ~3,800 assertions) is query-replica pattern that
  was already flagged in wave reaudit for `coach-history.test.ts` —
  the rest of the suite has the same blindspot, inherited.
- **11 MEDIUM** — weak assertions that accept non-specific failure
  modes (auth-lifecycle rate-limit-or-error branches, realtime
  postgres_changes deliberately skipped locally, extension mock
  shapes, RLS tests that assert "0 rows" without verifying the
  policy was the gate).
- **The blindspots are largely HERITABLE**, not a novel class. Wave
  1-2-3 inherited ~60% of the patterns called out in §4. The
  livetrack regression class (single-call state-machine tests) is
  pervasive in pgTAP RLS and Pi pytest.

**Worst offender by realistic-regression risk:**
`supabase/tests/coachbyte/timer_states.test.sql` — the ENTIRE file
(572 lines, 31 tests) is 8 application-level guard tests plus 4 anti-
matching "positive" tests that do nothing. The comment on line 143
literally says "application-level state transition guards. The DB has
no trigger or CHECK. The WHERE clauses in these UPDATE statements
simulate the guards." The app code could delete every `WHERE state =
'X'` guard and this test suite would still pass — because the test
suite rewrites the guard inside its own UPDATE SQL.

**Worst offender by magnitude:** the page-query-replica pattern
(§2.3). 15 files × ~250 tests inherit the coach-history.test.ts
blindspot already documented in the wave reaudit.

---

## 2. Flagged tests

### 2.1 CRITICAL — `timer_states.test.sql` is a tautology

- **File:** `supabase/tests/coachbyte/timer_states.test.sql:1-572`
- **Original audit's grade:** HIGH
- **Actual fidelity:** BROKEN — the test exercises a copy-of-the-guard
  embedded in the test SQL, not the production client code.
- **Class of blindspot:** #8 (stub matches current behavior; test
  passes unchanged if production code deletes the guard) + #10
  (test-inline implementation).
- **Concrete realistic regression:** a developer replaces TodayPage's
  pause button handler with `coachbyte.from('timers').update({ state:
'paused', paused_at: now }).eq('user_id', userId)` (drops the
  required `.eq('state', 'running')` guard). A user double-clicks
  pause on an expired timer and transitions expired→paused. Timer DB
  row is corrupted. `timer_states.test.sql` still passes — because
  tests 5-8 run their own UPDATE with the correct guard inline, and
  tests 5b-8b confirm "DB has no guards." Nothing here tests the
  real client code.
- **Recommended fix:** move the tests to either (a) an integration
  spec that calls the actual TodayPage timer handlers and checks DB
  state, or (b) a pgTAP test that calls a real `coachbyte.pause_timer`
  RPC (doesn't exist today — would need to be added; the state
  machine is correctly app-level, but the tests should prove the APP
  code uses the guard, not that the test's own SQL does).

### 2.2 CRITICAL — `api-key-lifecycle.test.ts::enforces max 10 active keys count check`

- **File:** `apps/web/src/__tests__/integration/hub/api-key-lifecycle.test.ts:297-323`
- **Original audit's grade:** HIGH
- **Actual fidelity:** BROKEN. Inserts 2 keys, asserts count == 2 and
  `<= 10`. Nowhere does the test attempt to insert 11+ keys and
  assert the 11th is rejected.
- **Class of blindspot:** #4 (tautological assertion) + #8 (test
  proves the mock — "2 keys when 2 inserted").
- **Concrete realistic regression:** remove the 10-key-cap enforcement
  entirely from the api-keys insert handler (it's currently
  client-side in `McpSettingsPage.tsx`). A compromised user key
  could create 10,000 keys. Test still passes.
- **Recommended fix:** insert 11 keys, assert the 11th throws — or
  assert `count <= 10` AFTER an attempt to insert #11. If the cap is
  purely client-side (no DB constraint), move this to a Playwright
  E2E test that clicks the "Generate" button 11 times and asserts
  the 11th surfaces a UI error.

### 2.3 HIGH — `__tests__/integration/pages/chef-*.test.ts` + `coach-*.test.ts` (15 files) replicate page queries inline

- **File:** 15 files under `apps/web/src/__tests__/integration/pages/`
  totaling ~5,400 lines. Representative example:
  `chef-home.test.ts:26-150` (`// Source: HomePage.tsx line 86-87`).
- **Original audit's grade:** HIGH (they're "integration tests")
- **Actual fidelity:** every test manually re-types the query from
  the page file and comments "`Source: PageName.tsx line X`". If the
  page changes its query shape (column added, limit changed, join
  removed), the test's stale replica still passes.
- **Class of blindspot:** #10 (test tests a helper that's also inlined
  in production) — already flagged in the wave reaudit for
  `coach-history.test.ts`.
- **Concrete realistic regression:** `InventoryPage.tsx` refactors its
  `stock_lots.select(...)` to a shared hook `useInventoryLots(userId)`
  that adds a `.order('expires_on')` clause. The new hook has a bug
  where it orders DESC (nearest-expiry at bottom). Test still passes
  — it's still running the original `.select(...).eq(...)` against
  the DB.
- **Recommended fix:** either (a) convert to Playwright E2E tests
  that render the page and assert DOM output, or (b) extract the
  query builders into page exports and have the tests import them.
  The pgTAP + E2E layer above would catch shape-drift, but the
  promised "integration test of the page query" is not what's
  shipping.

### 2.4 HIGH — `auth-lifecycle.test.ts` password-reset/refresh tests accept "rate limit" as success

- **File:** `apps/web/src/__tests__/integration/hub/auth-lifecycle.test.ts:194-239`
- **Original audit's grade:** MEDIUM
- **Actual fidelity:** several tests have the shape
  ```ts
  if (error) {
    expect(error.message).toMatch(/rate limit|invalid/i);
  }
  ```
  If password reset completely breaks (the Supabase endpoint returns
  500), the test catches `error.message` and only asserts it's "rate
  limit OR invalid." A `500 Internal Server Error` doesn't match
  either regex → `expect(error.message).toMatch(...)` would fail,
  but the test has no `else` branch for the success case — so if the
  request silently succeeds AND does nothing (e.g., email never
  sent), the test passes silently.
- **Class of blindspot:** #4 (assertion so loose anything non-4xx
  counts as passing) + #5 (timing/flaky obscures real regression).
- **Concrete realistic regression:** the `redirectTo` URL is wrong
  in the password-reset template and Supabase silently ignores the
  request. Test passes because no error is raised.
- **Recommended fix:** poll the local Inbucket mail server after the
  call and assert a reset email was actually sent with the correct
  `redirectTo` link. Or rescope the test to only assert the request
  shape is valid and the specific error code (422) on bogus input.

### 2.5 HIGH — `realtime/subscriptions.test.ts` skips the feature the app actually uses

- **File:** `apps/web/src/__tests__/integration/realtime/subscriptions.test.ts:1-127`
- **Original audit's grade:** HIGH (it's "realtime integration")
- **Actual fidelity:** the docstring (lines 1-11) says "postgres_changes
  CDC tests are skipped in local dev because the Realtime CDC
  extension doesn't reliably deliver events for non-public schemas
  in the local Supabase setup." The actual tests only cover
  `broadcast` and `presence` channels — which the app does NOT use
  for production data.
- **Class of blindspot:** #8 (test ensures the interesting feature
  never runs in CI — broadcast/presence pass trivially).
- **Concrete realistic regression:** publication config drops
  `chefbyte.stock_lots` from the realtime publication (the same bug
  that `9011487 fix(realtime): add live_shelf_devices + scale_pairings
to realtime publication` fixed). No realtime subscriptions test
  catches this — the browser-side e2e realtime.spec.ts does, but
  that's the WAVE addition being protected AGAINST here.
- **Recommended fix:** the probe pattern used in
  `apps/web/e2e/chefbyte/realtime.spec.ts::installProbe` works against
  local Supabase fine (it's in CI, passing). Port that harness into
  this integration test. Or delete this file — the postgres_changes
  coverage lives in realtime.spec.ts now.

### 2.6 HIGH — `Pi pytest: no livetrack-heartbeat multi-call test` (inherits wave gap 2.4)

- **File:** `hardware/live-shelf/server/tests/` — 28 pytest files, none
  exercise `handle_heartbeat` with a sequence of 2+ consecutive
  heartbeats on a LiveTrack-enrolled product.
- **Original audit's grade:** HIGH ("real SQLite + real handler chain")
- **Actual fidelity:** every individual Pi test is single-call at the
  handler level. The wave-1-2-3 reaudit §2.4 already flagged
  `test_cloud_contract.py` for structural-only testing; the gap is
  present here too. `test_heartbeat_regression.py` (line 69) is a
  genuine two-call test but it's for a _different_ property (stale
  heartbeats not regressing weight) — it doesn't exercise the
  livetrack state machine.
- **Class of blindspot:** #1 (single-call where multi-call sequence
  is needed).
- **Concrete realistic regression:** the EXACT `a375b9d` bug
  (heartbeat delta-gate too aggressive; 2nd heartbeat skipped).
  Currently invisible to pre-existing pytest, and still invisible
  after the wave-3 additions (as the wave reaudit flagged).
- **Recommended fix:** same as wave reaudit 2.4 — add
  `test_livetrack_heartbeat.py` that drives the full
  `handle_heartbeat → livetrack_poller.snapshot → cloud update` chain
  across 2-3 consecutive calls, each with state transitions.

### 2.7 HIGH — `extensions.test.ts` mocks the fetch shape rather than contract

- **File:** `packages/app-tools/src/__tests__/extensions.test.ts`
  (~79 kB, hundreds of tests). The live-API contract tests added in
  wave-1 (`321a5fc`) are the correct pattern; the pre-existing
  mocked portion (~500 tests) is the blindspot.
- **Original audit's grade:** MEDIUM
- **Actual fidelity:** each test calls `mockFetch.mockReturnValueOnce`
  with a hand-crafted response and asserts the handler returns a
  specific shape. If the real Todoist/Obsidian/HA API renames a
  field, the mock continues returning the old shape and the test
  passes — but production breaks. This is the class the live tests
  fix, but the mocked tests are still the majority.
- **Class of blindspot:** #3 (mock-shape assertion) + #8 (test tests
  the mock).
- **Concrete realistic regression:** GitHub's Git Trees API adds a
  new required `commit_sha` field to trees responses, and the
  extension's parser starts failing on the missing field. Mock tests
  return the OLD shape and keep passing. Users see Obsidian import
  errors in prod.
- **Recommended fix:** gradually deprecate the mocked tests in favor
  of the live-contract tests (`*-live.test.ts`). The live tests
  already exist for all three extensions — they run in CI when the
  API keys are available. Reduce the mocked tests to ONLY cover the
  edge-case/error branches that live tests can't reliably trigger
  (e.g. network timeouts).

### 2.8 HIGH — `chef-scanner.test.ts` inline queries bypass the scanner

- **File:** `apps/web/src/__tests__/integration/pages/chef-scanner.test.ts`
  (793 lines)
- **Original audit's grade:** HIGH
- **Actual fidelity:** same pattern as 2.3 — test manually runs
  `supabase.from('products').insert(...).select(...)` and asserts the
  shape works. The ScannerPage's actual code path
  (handleBarcodeSubmit → analyze-product → upsert) is never
  exercised. Duplicates the coverage of scanner.spec.ts' SCN2
  (which DOES exercise the real UI).
- **Class of blindspot:** #2 (emulated via direct DB call) + #10.
- **Concrete realistic regression:** scanner stops calling
  `.eq('user_id', user.id)` on the barcode lookup (accidental
  removal in a refactor) — it now matches across users, potentially
  finding another user's product by barcode. Test still passes —
  the test itself always filters by user_id.
- **Recommended fix:** delete this file; the scanner.spec.ts E2E
  covers everything it claims to. Failing that, convert to a
  Playwright E2E (page.evaluate) that actually drives the scanner
  handler.

### 2.9 MEDIUM — `today.spec.ts::summary textarea` uses `waitForTimeout(3000)` + `reload()`

- **File:** `apps/web/e2e/coachbyte/today.spec.ts:99-110`
- **Original audit's grade:** HIGH
- **Actual fidelity:** the test clicks away, waits 3s unconditionally,
  reloads the page, then asserts the value is there. Ignores whether
  the blur save actually fired — the reload forces a fresh fetch,
  so even if the save failed silently but the DB had the value from
  a seed, test would pass. The contrast in lines 322-343 (notes
  textarea) shows the RIGHT way: `waitForResponse` + DB assertion
  BEFORE reload.
- **Class of blindspot:** #9 (masks real timing bugs via
  unconditional reload).
- **Concrete realistic regression:** the summary blur-save handler's
  user ID filter breaks (uses wrong `user.id`), so the save is RLS-
  rejected. Test passes because after reload, it re-reads whatever
  is in the DB — which still shows the pre-test value if the save
  was rejected and the DB was never updated (but the test doesn't
  assert the value was FIRST UPDATED, only that it's there after
  reload). Actually this one is a bit contrived — the seed value is
  blank, so the assertion `'Good session'` would fail. But the 3s
  timeout is still flaky-smelling. Move to Medium.
- **Recommended fix:** mirror lines 322-343: use `waitForResponse`
  on the PATCH `rest/v1/daily_plans`, assert DB has the new value
  BEFORE reload, then reload + assert DOM value.

### 2.10 MEDIUM — `pgTAP RLS tests` use "count = 0" without SELECT-sanity probe

- **File:** multiple — representative: `chefbyte/rls_core.test.sql`
  lines 102-109, 192-200 (but the pattern is in nearly every RLS
  file).
- **Original audit's grade:** HIGH
- **Actual fidelity:** the SELECT-as-UserB pattern is
  `(SELECT count(*) FROM table WHERE user_id = user_a_uid)` expects 0. A broken RLS policy that silently returns empty for all queries
  (including user A's own) would ALSO make this test pass. The test
  doesn't confirm user B could SELECT their own row first to prove
  the query machinery works.
- **Class of blindspot:** #7 (RLS test that only asserts SELECT
  returns nothing — broken "return empty" policies pass).
- **Concrete realistic regression:** someone writes an RLS policy
  `USING (false)` for product_rls by accident in a migration. Every
  SELECT returns 0 rows. Every "user B cannot see user A" test
  passes. Every "user A can see own" test ALSO fails — but the
  failing test output is the same as "RLS is too strict" which
  might read as noise during migration churn.
- **Recommended fix:** add a sanity probe at the top of each RLS
  describe block: User B inserts a row in their own scope and
  SELECTs it; assert count == 1. THEN run the cross-user isolation
  assertions.

### 2.11 MEDIUM — `chef-walmart.test.ts` serpapi_url env var test is shallow

- **File:** `apps/web/src/__tests__/integration/pages/chef-walmart.test.ts`
  (188 lines)
- **Original audit's grade:** LOW
- **Actual fidelity:** the page-query-replica pattern holds — same
  blindspot as 2.3.
- **Class of blindspot:** #10.
- **Recommended fix:** same as 2.3. Or delete — the Walmart flow is
  already covered by walmart.spec.ts E2E.

### 2.12 MEDIUM — `shelf-ingest.test.ts` idempotency test doesn't verify across process boundaries

- **File:** `apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts:457-509`
- **Original audit's grade:** HIGH
- **Actual fidelity:** two calls in-proc with the same
  `client_event_id` land → second correctly returns the cached
  outcome. BUT — the test doesn't verify the dedup survives a
  restart (the event log is in chefbyte.shelf_event_log which is
  durable, but the test doesn't explicitly assert the row exists
  with the right fingerprint for replay by a second edge-fn
  instance).
- **Class of blindspot:** #6 (idempotency happy-path only — no
  conflicting-state second call).
- **Concrete realistic regression:** the edge fn switches from a
  Deno-process-local LRU dedup cache to a DB-backed dedup (or vice
  versa). Test passes under both behaviors. A bug where the cache
  evicts too aggressively only surfaces in prod during load.
- **Recommended fix:** add a third call with a different `delta_g`
  but the same `client_event_id` — assert the original outcome is
  returned unchanged (not a new `applied:true` with the modified
  delta).

### 2.13 MEDIUM — `test_integration.py::test_full_flow_remove_then_reconcile` time.sleep(0.02) scheduler race

- **File:** `hardware/live-shelf/server/tests/test_integration.py:330-345`
- **Original audit's grade:** HIGH
- **Actual fidelity:** line 333 uses `time.sleep(0.02)` to "be
  defensive against async schedulers on Python 3.13" and line 407
  `fake_camera._subs.reverse()` flips subscriber order to avoid a
  race that exists in production. This is the inverse of #9 — the
  test manually works around a real race, but doesn't assert the
  production code also tolerates the race.
- **Class of blindspot:** #9 (masks real timing bug) — specifically,
  the comment at line 402-407 acknowledges "In the real
  orchestrator the subscribers are both scheduled off the camera
  daemon thread" — meaning the production race WAS NOT FIXED, only
  papered over in test. If a user's Pi has an unusual scheduler
  behavior, this bug reoccurs.
- **Concrete realistic regression:** the production subscriber order
  dependency bites under load. Test keeps passing because it
  forcibly reverses the order.
- **Recommended fix:** either (a) fix the production race (add
  explicit ordering via a small queue) and remove the test's
  `_subs.reverse()`, or (b) explicitly document that ordering is
  load-bearing in the production code, and add a comment asserting
  CI is the only environment that needs the workaround.

### 2.14 LOW — `keypad-logic.test.ts` inlined re-implementation

- **File:** `apps/web/src/__tests__/unit/pure/keypad-logic.test.ts:10-34`
- **Original audit's grade:** LOW (pure-function test)
- **Actual fidelity:** defines `handleKeypadClick` INLINE in the test
  file (lines 10-34), not importing from production. Any bug in the
  ScannerPage real handler is invisible to this test.
- **Class of blindspot:** #10 (test exercises replica, not extracted
  helper) — canonical case.
- **Mitigating factor:** the wave commit `7eaa3e3` added
  `ScannerKeypad.test.tsx` which DOES render the real component and
  DOES exercise the handler. So the prod regression is caught by
  the wave test, not this one. Keep as LOW.
- **Recommended fix:** delete `keypad-logic.test.ts` as dead weight;
  `ScannerKeypad.test.tsx` covers the contract.

### 2.15 LOW — `auth.spec.ts::signup duplicate email` tolerates either outcome

- **File:** `apps/web/e2e/hub/auth.spec.ts:86-103`
- **Original audit's grade:** MEDIUM
- **Actual fidelity:** the test `waitForURL(/\/(hub|signup)/, ...)` —
  accepts EITHER redirect-to-hub OR stay-on-signup. Then asserts
  only 1 user exists in admin.listUsers. This is correct (the
  invariant is "no duplicate"), but the accepting-both paths means
  a regression where signup SILENTLY SUCCEEDS (redirect to hub with
  no error) for an existing email — when it should have been
  rejected — still passes if no duplicate was created.
- **Class of blindspot:** #4 (loose `/\/(hub|signup)/` match).
- **Mitigating factor:** GoTrue's anti-enumeration behavior means
  the API genuinely returns an opaque success for some duplicate
  cases — a strict assertion would flake. The test author's note
  ("Supabase local dev with email confirmation disabled may silently
  succeed") is correct. Keep as LOW.
- **Recommended fix:** tighten to assert the FIRST-created user's
  row is UNTOUCHED (email_confirm status, created_at, etc.) — proves
  no silent upsert happened.

### 2.16 LOW — `daily_macros.test.sql` uses `@` approx comparisons on known constants

- **File:** `supabase/tests/chefbyte/daily_macros.test.sql`
- **Observation:** heavy use of approximate comparisons on known-
  deterministic values. Not a regression risk, just slightly weaker
  than needed.
- **Recommended fix:** use exact equality where the inputs are
  integer grams.

---

## 3. Green tests (hold up under scrutiny)

1. **`supabase/tests/chefbyte/mark_meal_done.test.sql`** — 60
   assertions, tests multi-step idempotency (first call succeeds,
   second returns `success=false`, meal_prep branch creates [MEAL]
   product + stock lot, scale_factor applied correctly). Gold
   standard for pgTAP RPC testing.
2. **`supabase/tests/coachbyte/complete_next_set.test.sql`** —
   multi-call sequential: complete set 1 returns rest for set 2,
   complete set 2 returns rest for set 3, etc. Real state machine
   through the RPC.
3. **`apps/web/src/__tests__/integration/chefbyte/meal-macro-flow.test.ts`**
   — seeds full scenario, calls `mark_meal_done` RPC, verifies
   stock decremented correctly, food_logs created with exact macros,
   meal_prep branch creates [MEAL] product. Real end-to-end through
   real RPC, not via DB-write emulation.
4. **`apps/web/src/__tests__/integration/chefbyte/stock-consumption.test.ts`**
   — FIFO (nearest-expiry-first) depletion, floor-at-zero logging-
   for-full-amount, multi-lot cascade. All via real consume_product
   RPC with exact assertions.
5. **`apps/web/src/__tests__/integration/coachbyte/workout-flow.test.ts`**
   — ensure_daily_plan idempotency, complete_next_set order
   processing, logical_date matching. Real multi-step state machine.
6. **`apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts`**
   — real HTTP against local edge function, auth matrix (missing /
   invalid / disabled device), CRUD across /catalog /event
   /heartbeat /intake, cross-user isolation with stock-untouched
   assertion, zero-qty-lot bug regression guard, idempotency with
   real replay.
7. **`apps/web/e2e/chefbyte/scanner.spec.ts::SCN1-SCN7`** (pre-wave
   scenarios) — real UI flows with DB assertions, per-scenario
   regression claims aligned with actual test behavior.
8. **`apps/web/e2e/chefbyte/realtime.spec.ts`** (pre-wave part) —
   real browser-side postgres_changes probe, asserts the exact event
   arrives with the expected payload. The PROBE pattern is
   exemplary.
9. **`apps/web/e2e/mcp/mcp-to-ui.spec.ts`** — real MCP-over-SSE +
   real UI render. Catches cross-stack data-shape drift. Short,
   high-signal.
10. **`apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts::failure-path`**
    section — exercises all 5 failure branches (OFF 503, OFF
    malformed, Anthropic timeout, Anthropic malformed JSON, bad_key)
    with the `x-test-force-failure` header. Real fn, real shape
    assertions, real quota side-effect checks.
11. **`apps/mcp-worker/src/__tests__/mcp-worker.test.ts`** (pre-wave
    part, tests 1-14) — real SSE session establishment, initialize
    handshake, tool/list with real DB, invalid-key 401.
12. **`hardware/live-shelf/server/tests/test_heartbeat_regression.py`**
    — explicit two-call sequence: stale heartbeat must NOT regress
    weight, then fresh heartbeat MUST update. Exactly the
    multi-call pattern the livetrack tests needed.
13. **`hardware/live-shelf/server/tests/test_integration.py::test_full_flow_remove_then_reconcile`**
    — minus the scheduler-race hack (2.13), the rest is a real
    multi-step flow with DB state checks at each transition.
14. **`supabase/tests/chefbyte/apply_event_override.test.sql`**
    (batches 6-10, pre-wave) — multi-state flip-reversibility with
    stock + food_logs assertions. Correctly tests the idempotency
    AND the reversibility.
15. **`apps/web/src/__tests__/unit/coachbyte/RestTimer.test.tsx`** —
    imports real component, fake timers correctly, asserts state
    transitions (idle → running → paused → expired) through the
    real component's rendered DOM. 15 tests.
16. **`apps/web/src/__tests__/unit/pure/auto-scale.test.ts`** —
    imports real `autoScaleNutrition` from production ScannerPage.
    Tests edge cases (zero divisor fallback, NaN input, 4-4-9 rule).

---

## 4. Systemic patterns

### 4.1 "Query-replica" integration tests (inherited from pre-wave)

Affects 15 files under `__tests__/integration/pages/`, ~5,400 lines.
The comment `// Source: PageName.tsx line X` appears hundreds of
times. These are NOT integration tests in the "tests the page as a
user would" sense — they're "tests the query shape the page USED to
have at some point." When the page refactors to a hook, the tests
stay pinned to the old query.

**The wave reaudit §4.1 explicitly called this out for
`coach-history.test.ts` — but the same pattern is the default for
ALL 15 page integration files.** If the wave grade the rest should
match.

**Systemic fix:** per §2.3 — either delete or convert. Don't let the
test title "PageName queries" falsely imply UI coverage.

### 4.2 Single-call where multi-call is the contract

Affects `timer_states.test.sql` (canonical case), pgTAP RLS tests
(no round-trip through a real policy evaluation), Pi
`test_app_startup.py` (single init). Wave reaudit flagged the
livetrack case; this audit finds the pattern is pervasive.

**Systemic fix:** per wave reaudit §4.2. Add explicit multi-call
variants to the 5 highest-traffic state machines: timer transitions,
livetrack session, apply_event_override, complete_next_set,
livetrack heartbeat.

### 4.3 "Count == 0" RLS assertions without positive probe

RLS tests assert (as user B) `count == 0` for user A's rows. This
passes whether RLS is correctly filtering OR whether RLS is totally
broken (returning empty to everyone). No test verifies user B can
SELECT their OWN rows first to prove the query works.

**Systemic fix:** add a 2-line positive-probe preamble to every RLS
describe block.

### 4.4 Test-tests-the-mock patterns

Three distinct variants:

- Inline helper (keypad-logic.test.ts — mitigated by real-component
  ScannerKeypad.test.tsx)
- Test SQL implements the guard (timer_states.test.sql — CRITICAL)
- Test count matches setup count, not the bound it claims to test
  (api-key-lifecycle "max 10" — CRITICAL)

The pattern is seductive because the tests "pass" and feel thorough
(60+ assertions). Code reviewers don't catch it without the
livetrack-style regression-simulation prompt.

### 4.5 "Rate limit or success" assertions

Affects 5+ tests in `auth-lifecycle.test.ts`. The workaround for
Supabase's prod rate limits swallowed genuine signal. The password
reset and email-confirmation paths are functionally untested.

**Systemic fix:** use the local Inbucket mail server in CI for
deterministic email delivery assertions. `setup.integration.ts`
already has access.

### 4.6 Comparison to wave 1-2-3 inherited blindspots

Wave 1-2-3 (per reaudit doc) added 7 tests with the same-class-as-
livetrack blindspot. This legacy audit finds:

- §4.1 "UI emulated via direct DB" — wave introduced 18 new cases
  (parity.spec.ts expansion). Legacy had ~30 from the page-query-
  replica files. **Wave did not introduce a novel class — it
  expanded a pre-existing one.**
- §4.2 "Single-call where multi-call needed" — wave had 2 cases
  (livetrack-session, Pi contract). Legacy has 1 critical case
  (timer_states). **This was a pre-existing pattern, not a wave
  regression.**
- §4.3 "Weak assertion" — wave had 2 (walmart cross-user, offline
  trial-click). Legacy has 5+ (auth-lifecycle rate-limit, loose
  waitForURL). **Pre-existing was worse.**
- §4.4 "Test-tests-the-mock" — wave had 1 (mcp-worker reconnect).
  Legacy has 2 CRITICAL (timer_states, api-key max 10). **Pre-
  existing was worse, not better.**

**Conclusion:** the pre-existing suite is NOT cleaner than the
wave additions. The wave additions, in fact, introduced FEWER new
blindspots proportionally — they mostly inherited and amplified
existing patterns. The B+ original grade on the legacy suite was
generous.

---

## 5. Priority backlog (top 30, severity-first)

### Immediate (S — today)

1. **[S]** Rewrite `timer_states.test.sql` to test the real client
   code, not inline guards (§2.1). CRITICAL — tests are a tautology.
2. **[S]** Fix `api-key-lifecycle::enforces max 10` — insert 11 keys
   and assert the 11th is rejected (§2.2). CRITICAL.
3. **[S]** Delete `keypad-logic.test.ts` (§2.14) — ScannerKeypad.test.tsx
   covers it properly.
4. **[S]** Delete or rename the 15 `__tests__/integration/pages/chef-*`
   - `coach-*` files to drop the "PageName queries" framing and
     acknowledge they're DB-contract tests (§2.3, §4.1).

### Short-term (M — this week)

5. **[M]** Add Inbucket-probe to password reset / email confirmation
   tests in `auth-lifecycle.test.ts` (§2.4).
6. **[M]** Replace `realtime/subscriptions.test.ts` broadcast/
   presence scope with the postgres_changes probe pattern from
   `apps/web/e2e/chefbyte/realtime.spec.ts::installProbe` (§2.5).
7. **[M]** Add Pi-side livetrack heartbeat multi-call pytest
   (§2.6 — same as wave reaudit §2.4).
8. **[M]** Add the 2-line positive-probe preamble to every pgTAP
   RLS test block (§2.10, §4.3).
9. **[M]** Fix `today.spec.ts::summary textarea` — use waitForResponse
   - DB assertion BEFORE reload (§2.9).
10. **[M]** Delete `chef-scanner.test.ts` integration-pages file —
    scanner.spec.ts E2E already covers it (§2.8).
11. **[M]** Tighten `shelf-ingest` idempotency test to include a
    conflicting-state third call (§2.12).
12. **[M]** Fix production race in `test_integration.py` or remove
    the `_subs.reverse()` workaround (§2.13).

### Medium-term (L — next iteration)

13. **[L]** Migrate `extensions.test.ts` mocked-portion tests to
    live-contract tests where the live API is available (§2.7).
14. **[L]** Rebuild `timer_states` as an integration test with a
    real `coachbyte.pause_timer` RPC (doesn't exist yet; could be
    added; per §2.1).
15. **[L]** Convert `chef-home.test.ts` and 13 other page-query
    files to real E2E tests or extracted-helper tests (§2.3).
16. **[L]** Audit all `auth-lifecycle` tests — verify each
    assertion has a clear failure case separate from rate-limit
    (§4.5).
17. **[L]** Audit all `page.waitForTimeout(X)` + `page.reload()` in
    E2E — replace with waitForResponse + DB-state assertion.
18. **[L]** Audit all `.not.toBe(X)` assertions across integration
    tests — replace with positive `.toBe(Y)` where X is a specific
    error code.

### Systemic

19. **[M]** Adopt the naming convention from wave reaudit §4.1 —
    "integration test" MUST mean the production code path runs.
    "Query contract" is a valid but distinct test category.
20. **[M]** Add pre-commit lint rule: any integration test file
    whose comment includes `// Source: X.tsx` without importing from
    `X.tsx` is a warning.
21. **[M]** Dispatch `test-quality-review` skill on the LEGACY suite
    the same way the wave reaudit did — specifically focus on the
    30 files flagged here (§4.4 test-tests-the-mock pattern).
22. **[M]** Document the "positive-probe + cross-user check"
    pattern for RLS pgTAP tests in `CLAUDE.md` or a testing
    conventions doc.
23. **[L]** CI check: every pgTAP test must have at least one
    `results_eq` or `is(...)` per unique invariant, not just
    `ok(exists(...))`.

### Test deletions (reduce noise)

24. **[L]** Delete `keypad-logic.test.ts` (§2.14).
25. **[L]** Delete `chef-scanner.test.ts` integration-pages file
    (§2.8).
26. **[L]** Delete `chef-walmart.test.ts` integration-pages file
    (§2.11) — walmart.spec.ts E2E is sufficient.
27. **[L]** Delete `realtime/subscriptions.test.ts` after §5.6
    replacement (§2.5).

### Coverage additions

28. **[M]** Add a pgTAP file `private_helpers.test.sql` covering
    `private.get_logical_date` edge cases under various
    `day_start_hour` values — the helper is load-bearing and tested
    only indirectly today.
29. **[L]** Add a Pi pytest for the `handle_heartbeat` multi-call
    LiveTrack path (duplicates §2.6, explicit because it's the
    direct livetrack regression gate).
30. **[L]** Add an E2E test for the "API key generation rate
    limit" once the cap is enforced server-side (§2.2).

---

## 6. Regression retrospective

Walked `git log --before=2026-04-18 --grep="^fix" --oneline -50`.
For each of the 14 most impactful fixes, would the current legacy
suite (excluding wave 1-2-3 additions) catch a regression?

| Commit    | Description                                                     | Caught? | Why                                                                                                                                |
| --------- | --------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `3de4ee5` | mcp: round 4 — empty tool blocks, null content                  | PARTIAL | `mcp-worker.test.ts` covers the JSON-RPC happy paths; empty-tool-block edge case not pinned by any test                            |
| `d9752e9` | hub: prevent encrypted key leak + AgentPage UX + HA SSRF        | NO      | The HA SSRF fix is covered by wave SSRF guard; pre-wave encryption-leak risk has no direct test.                                   |
| `0d67f66` | mcp: remove legacy DO routes + error handling                   | NO      | Legacy-route removal isn't pinned; tests check current routes only.                                                                |
| `7ede713` | obsidian: UTF-8 encoding, path separators, blob cap             | PARTIAL | `extensions.test.ts` Obsidian mocks cover basic shape; blob-size cap regression invisible.                                         |
| `c265c4e` | mcp: disable GET /sse                                           | NO      | No test asserts `GET /sse → 405`.                                                                                                  |
| `b98fb3f` | mcp: POST /sse stateless                                        | NO      | `mcp-worker.test.ts` happy-path; stateful regression invisible per wave reaudit §2.13.                                             |
| `0b2f2b5` | ActivationGuard spinner + auth timeout                          | NO      | No test exercises the auth timeout branch.                                                                                         |
| `2e2e5d7` | chef: duplicate-key error in auto-add below min stock           | YES     | `chef-shopping.test.ts` + shopping.spec.ts cover below-min + duplicate scenarios.                                                  |
| `dc28f37` | stale closure in TodayPage notes/summary blur                   | PARTIAL | today.spec.ts summary test exists but has the waitForTimeout hack (§2.9); stale-closure would surface if timing aligned unluckily. |
| `0891127` | deep audit — stock lot merges + stale realtime + fetch timeouts | PARTIAL | Stock lot merge is covered by realtime.spec.ts + scanner.spec.ts SCN7-like logic; fetch timeouts aren't tested explicitly.         |
| `4cfb434` | remove hardcoded JWTs                                           | n/a     | Static analysis concern — not a behavioral regression.                                                                             |
| `6ea5243` | prod deployment: ES256 + edge fn hardening                      | PARTIAL | OAuth tests (wave) cover some; edge-fn hardening is partially covered by wave failure-path tests.                                  |
| `edc5981` | Walmart deep link + seed date spread + demo reset               | YES     | `demo-contamination.spec.ts` + shopping.spec.ts + walmart.spec.ts.                                                                 |
| `f369bb3` | scanner: confirm (red→green) only on click-away                 | YES     | scanner.spec.ts::SCN7 pins this exactly.                                                                                           |

**Pre-wave catch rate: ~40% (5 partial + 2 yes out of 14).** The
wave-1-2-3 reaudit measured a similar rate (~50%). The legacy suite
is NOT materially better than what the wave tests achieved, despite
having 4x the assertion count — the pattern of "many tests, low
fidelity" is consistent.

**Most concerning miss:** `timer_states.test.sql` was the FIRST
line of defense for every timer state-machine bug. `dc28f37` (stale
closure in TodayPage notes blur) should have been caught by a timer-
state test. It wasn't, because the test doesn't exercise the client
code. Direct consequence of §2.1.

---

## 7. Comparison to wave-1-2-3 reaudit

| Metric                              | Wave additions (reaudit) | Pre-existing (this doc) |
| ----------------------------------- | ------------------------ | ----------------------- |
| Total tests                         | ~160 new                 | ~1,200                  |
| Flagged CRITICAL                    | 2                        | 2                       |
| Flagged HIGH                        | 5                        | 7                       |
| Flagged MEDIUM                      | 5                        | 11                      |
| Flagged LOW (rename/cosmetic)       | 2                        | 3                       |
| Green count                         | 11                       | 16                      |
| Regression-retrospective catch rate | ~50%                     | ~40%                    |
| Blindspot classes introduced        | 0 new                    | 4 pre-existing          |
| Regrade                             | B-                       | C+                      |

**Interpretation:** the wave additions introduced almost no novel
blindspots — they inherited and expanded existing ones. The
pre-existing suite has the same CLASS of fidelity problems, applied
at much larger scale, with 4 canonical "test tests the mock"
patterns the wave didn't introduce but also didn't repair.

**The B+ original grade on pre-existing tests was ~1 letter too
high.** A C+ is more honest. The livetrack miss was a symptom of a
pattern that saturates the test suite; fixing it requires the
systemic changes in §5, not one-off test additions.

---

## 8. Closing note

The livetrack miss was not a rogue incident. It was the RULE for
state-machine coverage in this codebase. Every test that claims to
"pin a state machine" via single-call execution is subject to the
same class of regression. The wave-1-2-3 reaudit caught 7 such
tests in the new additions; this audit finds the pre-existing suite
has at least 20-30 more of the same, across pgTAP, pytest, and
integration layers.

The S-effort fixes in §5 (rewrite timer_states, fix api-key max-10,
delete the query-replica files) close the highest-severity gaps in
about 2-3 hours of work. The M-effort fixes close the systemic gaps
over a week. The L-effort fixes are the long-term migration off
query-replica patterns.

None of this requires adding new E2E tests from scratch — the E2E
layer (scanner.spec.ts, realtime.spec.ts, mcp-to-ui.spec.ts,
demo-contamination.spec.ts) is the suite's actual source of signal.
The integration and unit layers are mostly noise with the specific
critical-path tests called out in §3.

Grade: C+. Actionable backlog: 30 items, 8 S-effort, 13 M-effort,
9 L-effort.
