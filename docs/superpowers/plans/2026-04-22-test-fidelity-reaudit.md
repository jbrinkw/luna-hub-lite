# Test Fidelity Re-Audit — Wave 1/2/3 Additions (post-livetrack miss)

**Audit date:** 2026-04-22
**Scope:** only tests added/modified in commits `97fb0d1`, `321a5fc`,
`1efeae1`, `222405f`, `534c6b8`, `1cb697a`, `126e44b`, `2699546`,
`2701765`, `448967c`.
**Method:** read each file in full, invent 2-3 realistic regressions per
test, ask "would this test fail?"

---

## 1. Executive summary

~160 new tests across 10 commits. Overall grade: **B-**. The livetrack
miss is not a one-off — 7 tests have the same class of blindspot
("single-call where a multi-call sequence is needed" or "test bypasses
the component it claims to cover"), and 3 more have assertions weak
enough to pass silently under realistic regressions.

**Worst offender by risk:** the offline test
`apps/web/e2e/chefbyte/offline.spec.ts::offline disables ChefByte
actions` — uses `click({ trial: true })` which does NOT actually click.
If someone removes the `pointerEvents: none` guard in ChefLayout, this
test still passes because no click ever fires and the DB stays at 3
containers. A prod regression that re-enables writes offline ships
without a test failure.

**Second-worst:** `apps/web/e2e/hub/agent-voice.spec.ts::mid-stream
disconnect` — the user has NO Anthropic key, so the request fails at
422 before a stream ever starts. The test's name says "disconnect
mid-stream" but no stream exists. Any real abort-handling regression
(zombie DOs, connection leaks) is invisible to this test.

Same-class-as-livetrack hits (single-call where sequencing is needed):
5 files, 7 tests total. See §2.

**Green tests:** 11 tests are genuinely solid — see §3. The key-rotation
E2E and the optimistic-rollback unit test are exemplars of how the
livetrack test should have been written.

---

## 2. Flagged tests

### 2.1 CRITICAL — `offline.spec.ts::offline disables ChefByte actions via pointer-events guard + DB unchanged`

- **File:** `apps/web/e2e/chefbyte/offline.spec.ts:57-110`
- **Commit claim:** "Actions disabled while offline via `pointerEvents:
none`; DB unchanged."
- **Actual fidelity:** the test uses `click({ trial: true, timeout:
3000 })` with `.catch(() => {})`. `trial: true` does NOT actually
  click — it only probes clickability. The subsequent DB check (3
  containers unchanged) passes regardless of whether pointer-events is
  disabled, because no click ever fires.
- **Blindspot class:** #3 (asserts the mock/call-shape, not real state)
  - variant of #1 (test structurally cannot exercise the protected
    code path).
- **Realistic regression:** remove `pointerEvents: none` and `opacity:
0.6` from `ChefLayout.tsx`. The "No connection" banner still
  renders, `trial: true` still returns success, DB still at 3 ⇒ test
  passes. Users can now click buttons that will silently fail at the
  transport layer while showing "offline" banner. **Exactly the class
  of "visual banner up but guard removed" regression the test claims
  to pin.**
- **Recommended fix:** replace `trial: true` with a real `click({
force: true })` and assert the DB still matches the pre-click state;
  alternatively, assert `page.getByTestId('sub-ctn-...').evaluate(el
=> getComputedStyle(el).pointerEvents)` equals `'none'`.

### 2.2 CRITICAL — `agent-voice.spec.ts::mid-stream disconnect`

- **File:** `apps/web/e2e/hub/agent-voice.spec.ts:163-209`
- **Commit claim:** "Proves the worker handles client aborts cleanly —
  a regression here would accumulate zombie DO sessions or corrupted
  tool-logger state."
- **Actual fidelity:** the user has no Anthropic key ⇒ request fails at
  422 before any streaming happens. The `setTimeout(abort, 50)` fires,
  but the fetch already returned. The follow-up request also gets
  401/422 because the user still has no key. The test is a tautology:
  "two back-to-back requests against an unconfigured user both fail
  with 4xx" — proves nothing about abort handling.
- **Blindspot class:** #8 (stub matches current behavior; test would
  pass unchanged if the code under test was ripped out).
- **Realistic regression:** introduce a real zombie-DO leak in
  mid-stream abort handling (e.g., the worker holds a DO session open
  after client disconnect). Test still passes — no stream was ever
  opened.
- **Recommended fix:** add a real Anthropic key to CI secrets for one
  test, or stand up a mock Anthropic streaming endpoint in the worker
  test env so a real SSE stream can be aborted and re-queried.
  Alternative: drop the test and replace with a chat-streaming.test.ts
  unit-level abort case (already exists per the docstring).

### 2.3 HIGH — `livetrack-session.test.ts::valid matching key → 200, only ALLOWED fields written`

- **File:** `apps/web/src/__tests__/integration/edge-functions/livetrack-session.test.ts:355-380`
- **Commit claim:** "Full auth+validation matrix across /create,
  /pi-update, /active routes including cross-user scoping."
- **Actual fidelity:** single `pi-update` call. Asserts the ALLOWED
  fields wrote. But **never** does `pi-update (state=waiting_scale) →
pi-update (state now scale_reading_received) → assert second update
landed`. This is the **exact canonical livetrack blindspot**: the
  bug fixed in `a375b9d` required the state-flip-blocks-next-update
  sequence to surface.
- **Blindspot class:** #1 (single-call where multi-call sequence is
  needed) — canonical example.
- **Realistic regression:** add an ALLOWED_STATES guard on the edge fn
  that only accepts `state=waiting_scale`. First heartbeat lands (as
  asserted); subsequent heartbeats silently 400'd. Test passes because
  it only makes one call.
- **Recommended fix:** add a follow-up test "two consecutive pi-update
  calls update scale_reading_g both times, even when the first
  transitioned state to `scale_reading_received`." Mirrors the
  key-rotation E2E's pattern. The Pi-side test also needs the same
  pattern — see §2.4.

### 2.4 HIGH — `test_cloud_contract.py` has NO heartbeat-sequence test

- **File:** `hardware/live-shelf/server/tests/test_cloud_contract.py`
  (full file)
- **Commit claim:** "Pi↔cloud schema contract + 4 regression guards —
  prevents the whole class of drift from recurring."
- **Actual fidelity:** every test in this file is **structural** —
  field-name sets, literal enums, JSON shape, translation map. No test
  exercises the `handle_heartbeat` multi-call sequence. The test file
  explicitly scopes itself to "structural guard, see
  test_catch_all_scale_routing.py for the behavioral ingress test"
  but no equivalent behavioral test exists for LiveTrack heartbeats.
- **Blindspot class:** coverage gap (no test at all for the buggy
  code path). The livetrack bug was in
  `hardware/live-shelf/server/handlers/scale_events.py` line ~3458; no
  pytest in scope touches that code.
- **Realistic regression:** the exact `a375b9d` bug: guard that flips
  state too early so second heartbeat's check fails. Was missed;
  would be missed again.
- **Recommended fix:** a `pytest` in `hardware/live-shelf/server/tests/
test_livetrack_heartbeat.py`: instantiate `ScaleHandler`, seed
  `livetrack_poller.snapshot()` to return `state=waiting_scale`, post
  `handle_heartbeat(weight=100)`, flip snapshot to
  `scale_reading_received`, post `handle_heartbeat(weight=150)`, assert
  both calls emitted a `post_livetrack_session_update` to the stub
  cloud client with the correct weight.

### 2.5 HIGH — `parity.spec.ts` expansion batch is mislabeled

- **File:** `apps/web/e2e/mcp/parity.spec.ts:713-1511` (the 18
  "expansion batch" tests after the first 6)
- **Commit claim:** "MCP-UI parity — expands from 6 to 24 MCP tool
  flows. Ensures MCP and UI write/read shape parity for every mutable
  tool."
- **Actual fidelity:** of the 24 tests, 18 use a **direct supabase-js
  call** labeled `"UI path"` and never open the browser for the UI
  arm. The inline comment acknowledges this ("This deliberately skips
  rendering each page") but the commit message and the test suite
  name say "MCP-UI parity." These tests are DB-level tool-vs-RPC
  parity, not UI-vs-MCP parity.
- **Blindspot class:** #2 (test bypasses the component it claims to
  cover) + #4 (mislabeled / shape-only).
- **Realistic regression:** the UI for `CHEFBYTE_update_product`
  starts sending `price` as a string (`"9.99"` instead of `9.99`) and
  the UI's local Zod validator rejects it. DB-level parity still
  passes because the test calls supabase-js directly with a number.
  Users report "can't save price" in prod.
- **Recommended fix:** either rename to "MCP tool ↔ direct RPC
  parity" in comments/test names, or convert 3-5 high-value tests
  (add_stock, create_recipe, update_product, mark_done, complete_set)
  to real UI click paths. Accept the others as DB-level.

### 2.6 HIGH — `oauth.spec.ts` full OAuth flow always skips in CI

- **File:** `apps/web/e2e/mcp/oauth.spec.ts:144-258`
- **Commit claim:** "MCP OAuth 2.1 + offline behavior + Voice Assist —
  closes audit item #13."
- **Actual fidelity:** the entire `'MCP OAuth 2.1 — Supabase AS
endpoints'` describe block is gated by `asMetadataAvailable`, which
  requires Supabase local to have `auth.oauth_server.enabled = true`.
  That flag is OFF by default in `config.toml` (the docstring
  acknowledges this). In normal CI runs, the authorize/token/PKCE
  tests all skip cleanly. The only OAuth surfaces actually tested are
  the Worker's `/.well-known/` endpoints and a "Bearer-token parity"
  test that uses an **API key** (not an OAuth token).
- **Blindspot class:** #8 (test infrastructure ensures the interesting
  assertions never run).
- **Realistic regression:** a change to PKCE validation or the
  authorize redirect handling ships. CI passes (skipped), prod breaks.
- **Recommended fix:** flip `auth.oauth_server.enabled = true` in the
  local `config.toml` used for CI (the user-facing dev env can keep
  it off). Or split the skip into separate `describe` blocks that
  fail loudly if misconfigured rather than silently skipping.

### 2.7 MEDIUM — `analyze-product.test.ts::placeholder resurrection`

- **File:** `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts:573-673`
- **Commit claim:** "A placeholder row from an earlier FAILED analyze
  call must be UPDATED (not duplicated) when the retry succeeds."
- **Actual fidelity:** the test seeds a placeholder, calls the edge
  fn (asserts `source: 'existing'`), then **uses `adminClient` to
  UPDATE the row directly**, bypassing the scanner entirely. The
  scanner's actual code path (which is what the test name claims to
  cover) is never exercised.
- **Blindspot class:** #2 (emulates the scanner via direct DB write)
  and #3 (asserts the mock's write shape).
- **Realistic regression:** the scanner's code changes from `update(
...).eq('product_id', placeholderId)` to `upsert(..., {onConflict:
'barcode'})` with a bug where the placeholder's `product_id`
  changes. The test still passes because the admin call it makes is
  still an update-by-id. Users see a duplicated placeholder in
  `Unknown Product` lists.
- **Recommended fix:** drive the UPDATE via the real scanner UI
  (Playwright click → fill → blur → assert) or via the public
  supabase-js authenticated client (not admin). The existing
  `scanner.spec.ts::SCN2` seems to cover this via UI — if so, the
  edge-fn layer test's claim should be downgraded to "edge fn's
  existing-row short-circuit returns the placeholder product_id" and
  the UPDATE-doesn't-duplicate claim moved to scanner.spec.ts.

### 2.8 MEDIUM — `walmart.test.ts::cross-user isolation`

- **File:** `apps/web/src/__tests__/integration/edge-functions/walmart.test.ts:195-225`
- **Commit claim:** "Cross-user isolation — User A failure does not
  affect User B."
- **Actual fidelity:** B's assertion is `not.toBe(401) &&
not.toBe(400)`. Any 5xx passes (including internal 500 from missing
  SERPAPI_KEY, which the test comment ACKNOWLEDGES). Since the edge
  fn is stateless there's nothing to isolate — any stateless fn would
  pass this test.
- **Blindspot class:** #4 (assertion so loose that any response
  passes) + #8 (test proves the mock, not the real isolation
  property).
- **Realistic regression:** someone adds per-user state to
  walmart-scrape (e.g., a cache keyed on `user_id`) with a bug where
  A's failure poisons B's cache. Test still passes — no response-code
  change.
- **Recommended fix:** drop the test or rescope. If per-user quota is
  ever implemented, re-enable with a tight assertion (B's quota
  counter == 0 after A hits limit).

### 2.9 MEDIUM — `day_start_hour_logical_date.test.sql::Part A write-time correctness`

- **File:** `supabase/tests/coachbyte/day_start_hour_logical_date.test.sql:72-84`
- **Commit claim:** "When a user changes day_start_hour and a NEW
  daily_plan is created, its logical_date reflects the NEW
  day_start_hour (via ensure_daily_plan → get_logical_date)."
- **Actual fidelity:** with `plan_date='2026-04-21'` and
  `day_start_hour=6`, `get_logical_date` computes from `plan_date
12:00 local`, which at noon is always past the 6am cutover ⇒
  `logical_date = plan_date`. A regression where `ensure_daily_plan`
  stored `plan_date` directly instead of calling `get_logical_date`
  would produce an identical result (`logical_date = plan_date`).
- **Blindspot class:** #4 (shape-only — test would pass if the call
  to `get_logical_date` were removed entirely).
- **Realistic regression:** refactor `ensure_daily_plan` to store
  `plan_date` as `logical_date` for "simplicity" and remove the
  `get_logical_date` call. Part A passes. Part D (flip dsh after
  insert) still passes because the literal stored value doesn't
  change. The ACTUAL bug — that logical_date is no longer DST-aware —
  is invisible.
- **Recommended fix:** add a test case where `plan_date=2026-04-21`
  and the test passes `day_start_hour=12` (noon cutover). With that
  config, a noon-local `get_logical_date` call would round DOWN to
  `2026-04-20`, whereas direct-store would give `2026-04-21`. The
  divergence surfaces the regression.

### 2.10 MEDIUM — `temp_items_logical_date.test.sql` doesn't exercise UI stamping

- **File:** `supabase/tests/chefbyte/temp_items_logical_date.test.sql`
- **Commit claim:** "Pin two properties: (1) at INSERT time, the
  caller's stamped logical_date is the one `private.get_logical_date`
  produces ... (2) after an insert, changing day_start_hour must NOT
  retroactively rewrite the row."
- **Actual fidelity:** property (1) is tested via Part A's
  `get_logical_date` direct calls, but the INSERTs in Part B pass
  HARDCODED `logical_date='2026-04-20'` — the test never calls
  `get_logical_date` as the UI/MCP would. Property (2) is well-
  tested.
- **Blindspot class:** #8 (test proves the invariant in isolation,
  but the UI caller's use of it is never exercised).
- **Realistic regression:** UI's temp-item logging path drops the
  `day_start_hour` arg and always passes 0 to `get_logical_date`.
  DB tests pass (because they hardcode the value). Users with custom
  rollover hours see temp items misdated.
- **Recommended fix:** an integration test at
  `apps/web/src/__tests__/integration/` that drives the real temp
  item save path (supabase-js insert through the UI's code) and
  asserts logical_date matches the expected value under a non-default
  day_start_hour.

### 2.11 LOW — `coach-history.test.ts` replicates the page's queries instead of calling the page

- **File:** `apps/web/src/__tests__/integration/pages/coach-history.test.ts:48-345`
- **Commit claim:** "HistoryPage queries — daily_plans with
  pagination, planned_sets count, exercises filter, expand/collapse."
- **Actual fidelity:** each test manually replicates the `HistoryPage`
  query by inlining the `.from(...).select(...).eq(...).order(...)`
  call and commenting "Source: HistoryPage.tsx line 40-46." If
  HistoryPage changes its query shape (e.g., adds `.limit()` or a
  new column), these tests stay on the stale shape and pass.
- **Blindspot class:** #10 (test exercises the replica, not the
  extracted helper or the page).
- **Realistic regression:** HistoryPage refactor that replaces the
  inline query with a call to a shared hook that uses a different
  column set. Tests pass (stale queries still work against DB). The
  page breaks in prod.
- **Recommended fix:** either (a) convert to E2E Playwright tests
  that click pagination buttons and assert on DOM, OR (b) extract
  the query builders into `HistoryPage` exports (e.g.
  `fetchHistoryPage(client, userId, cursor)`) and import them in the
  test, so the test fails if the page's query changes.

  The pagination boundary test (lines 356-480) IS solid — it tests a
  self-contained algorithm, not a page. Keep that one as-is.

### 2.12 LOW — `rest timer lifecycle` falls back to direct DB write to "force" expired state

- **File:** `apps/web/e2e/coachbyte/today.spec.ts:781-791`
- **Commit claim:** "Rest timer full lifecycle: start → pause →
  resume → expired (DB state tracked by UI)."
- **Actual fidelity:** for the expired step, the test first waits 10s
  for natural expiry detection (the page's 1s interval should fire
  `handleTimerExpired`). If that times out, it silently falls back to
  `coach.from('timers').update({ state: 'expired' })` — a direct DB
  write — and asserts the UI banner renders. The `sawExpired` flag is
  collected as telemetry but never asserted.
- **Blindspot class:** #9 (masks real timing bugs via a DB-level
  workaround).
- **Realistic regression:** the client-side `handleTimerExpired`
  callback stops firing (e.g., someone changes the interval from
  `1000` to `1_000_000` by typo). Test passes because the fallback
  flips state directly.
- **Recommended fix:** fail the test when `sawExpired === false` —
  or shorten the rest_seconds to 2s and actually wait for the real
  expiry to fire.

### 2.13 LOW — `mcp-worker.test.ts::reconnect with same sessionId` doesn't test tool state

- **File:** `apps/mcp-worker/src/__tests__/mcp-worker.test.ts:499-558`
- **Commit claim:** "SessionId reconnect — tool set shared across
  connections."
- **Actual fidelity:** the test explicitly pins STATELESS behavior
  (docstring: "the worker currently runs STATELESS"). It asserts
  the tool count is equal across reconnections, but this is
  trivially true in a stateless server — the same user ID produces
  the same tool registry. The test would pass against any stateless
  HTTP server that echoes back the sessionId header.
- **Blindspot class:** #8 (test proves the trivial invariant of a
  stateless server; named to imply stateful session continuity).
- **Realistic regression:** return to stateful DO-backed sessions is
  introduced WITHOUT breaking the public HTTP contract. Test passes.
  This is actually the INTENDED pin (the test is named "pin current
  stateless behavior") — the blindspot is purely cosmetic (naming).
  Note as a LOW / rename recommendation rather than a bug.
- **Recommended fix:** rename the test to "stateless POST /mcp
  handles reconnect without state dependency" and remove the
  "resumption" framing.

---

## 3. Green tests (hold up under scrutiny)

These tests would catch realistic regressions in the feature they
claim to cover. Listed with one-sentence fidelity justification.

1. **`mcp-tools.spec.ts::Key Rotation — revoke mid-flight`** — real
   init → tools/list → DB revoke → tools/list (same session) →
   assert 401 within 5s. Exactly the multi-call pattern the livetrack
   test needed. Gold standard.
2. **`OptimisticRollback.test.tsx`** — observes intermediate cache
   state via TanStack QueryCache subscription, plus a success-path
   control test to prove the rollback assertion has teeth. Would
   fail if `onMutate` OR `onError` regresses.
3. **`concurrent-tabs.spec.ts`** — two real browser contexts,
   passive Realtime delivery (no reload), cross-table check. Catches
   subscription scoping regressions.
4. **`realtime.spec.ts::scale_pairings publication`** (three tests)
   — real probe, real postgres_changes events, cross-user RLS gate
   check. Strong.
5. **`demo-contamination.spec.ts`** — real user A + user B +
   canonical demo user, bit-for-bit fingerprint comparison,
   idempotency run. Catches WHERE-clause regressions in
   `reset_demo_dates()`.
6. **`apply_event_override.test.sql` (batch 6-10)** — tests
   consumed→added→consumed flip reversibility with stock + food_logs
   assertions at each transition. Multi-state sequencing done right.
7. **`event-viewer.spec.ts`** — real UI edit → save → DB verify for
   the override flow. Independent stock + macros fields exercised.
8. **`scanner.spec.ts::SCN7 click-away confirm`** — scan A, scan B,
   click A, scan C — asserts row A's red/green state at each step.
   Catches auto-confirm regressions.
9. **`scanner.spec.ts::SCN4b real analyze-product 503`** — uses the
   `x-test-force-failure` header to drive real edge fn into
   genuinely-degraded state. Real failure path.
10. **`serving-container-roundtrip.test.ts`** — seed → write
    containers → read both units → consume servings → assert floor,
    macro snapshot (logged > available). Realistic integration.
11. **`ha-live.test.ts` + `obsidian-live.test.ts` + `todoist-live.test.ts`**
    — real upstream API, real sequential state changes
    (turn_on → verify on, append note → re-read, create task →
    update task → complete), plus response-shape contract tests.
    The contract tests specifically guard upstream drift.
12. **`cors-preflight.test.ts`** — parametrized over real filesystem
    enumeration; meta-assertion that at least one fn was discovered.
    Catches new fns without preflight.

---

## 4. Systemic patterns

### 4.1 "UI emulated via direct DB call"

Appears in: `parity.spec.ts` expansion (18 cases), `coach-history.test.ts`
(9 cases), `analyze-product.test.ts::placeholder resurrection`,
`temp_items_logical_date.test.sql`.

The pattern is usually well-intentioned — avoid flaky UI renders,
test a contract in isolation. But the commit messages and test names
frequently imply UI coverage. The reviewer reading the test names
reasonably assumes the UI path is exercised.

**Systemic fix:** adopt a naming convention. Tests that bypass the UI
should NOT claim "UI vs X" in their name. Prefer "MCP tool ↔ direct
RPC shape parity" or "database-level contract." Reserve "UI vs MCP"
for tests that actually render.

### 4.2 Single-call where multi-call sequencing is the contract

Appears in: `livetrack-session.test.ts::valid matching key` (and the
absent Pi-side heartbeat sequence test), most RLS tests (though those
happen to be correctly scoped).

The livetrack miss is the canonical case. The `apply_event_override`
test AND the `mcp-tools::key rotation` test both show how to do
multi-call sequencing correctly — the others don't follow that lead.

**Systemic fix:** before writing a "X works" test, ask "is there a
STATE that X modifies that changes whether X works a second time?"
If yes, write a two-call test.

### 4.3 Weak assertion patterns (`not.toBe(X)`, `trial: true`, `toBeTruthy()` for schema)

Appears in: `offline.spec.ts::disables actions` (trial click),
`walmart.test.ts::cross-user` (not.toBe bouncing off 5xx),
`todoist-live.test.ts::update due_string` (self-annotated as
weak-matcher).

**Systemic fix:** prefer positive assertions (`.toBe(expectedValue)`)
over negative (`.not.toBe(badValue)`). When you need a negative,
make it specific (`.toBe(200)` instead of `not.toBe(500)`).

### 4.4 Test-quality-review skill did not catch these

Per CLAUDE.md, the `test-quality-review` skill was supposed to run
after each test layer batch. The livetrack miss proves it did not run
or was rubber-stamped. The 7 findings above would have been caught by
the prompt ("if I broke the feature's state machine, would this
test fail?"). Recommend: add explicit dispatch of `test-quality-
review` to the plan's post-implementation checklist, with a named
reviewer artifact committed to `docs/superpowers/reviews/`.

---

## 5. Priority fix list

### Immediate (S — today)

1. **[S]** Rewrite `offline.spec.ts::disables ChefByte actions` with a
   real `click({ force: true })` and DB assertion (2.1). Highest
   severity, trivial fix.
2. **[S]** Remove or rescope `agent-voice.spec.ts::mid-stream
disconnect` (2.2). One-line delete + add TODO comment.
3. **[S]** Rename `mcp-worker.test.ts::reconnect with same sessionId`
   to drop the "resumption" framing (2.13).

### Short-term (M — this week)

4. **[M]** Add the Pi-side heartbeat-sequence pytest described in
   2.4. This is the direct fix for the next
   livetrack-like regression. Same multi-call pattern as the
   key-rotation test.
5. **[M]** Extend `livetrack-session.test.ts::pi-update` with a
   two-call test where the first call transitions state and the
   second call must still land (2.3).
6. **[M]** Fix `analyze-product::placeholder resurrection` to drive
   the UPDATE through the authenticated scanner client, not the
   admin client (2.7).
7. **[M]** Flip `auth.oauth_server.enabled = true` in the CI
   `config.toml` so the full OAuth flow tests actually run (2.6).
8. **[M]** Add the `day_start_hour=12` noon-cutover case to
   `day_start_hour_logical_date.test.sql` (2.9).

### Medium-term (L — next iteration)

9. **[L]** Convert 3-5 high-value `parity.spec.ts` expansion tests
   to real UI click paths (2.5). Or rename the remaining to drop
   the "UI vs MCP" label.
10. **[L]** Replace `coach-history.test.ts` query-replica pattern
    with an E2E or extracted-helper pattern (2.11).
11. **[L]** Drop the `walmart.test.ts::cross-user` test until quota
    is implemented (2.8).
12. **[L]** Tighten `rest timer lifecycle` test to fail when
    natural expiry detection doesn't fire (2.12).
13. **[L]** Add UI-level integration tests for `temp_items` and
    `food_logs` that exercise the real `get_logical_date` call path
    (2.10).

### Systemic

14. **[M]** Adopt the naming convention in §4.1. Document in
    `CLAUDE.md` or a testing conventions doc.
15. **[M]** Add explicit `test-quality-review` dispatch to the
    post-implementation checklist (§4.4), with reviewer artifacts
    committed.
