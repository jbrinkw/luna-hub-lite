# Test System Audit — 2026-04-27

Auditor: subagent dispatched after a string of physical-hardware bugs that
"comprehensive tests" should have caught. Goal: replace the marketing
number with a sober assessment of what is and is not exercised, then plan
the fix.

Scope: every test layer in the repo as of HEAD `8eae0a0`.

---

## TL;DR

- **The "~1,600 tests" claim is technically true but rhetorically misleading.**
  The bulk of those tests exercise individual systems in isolation. The
  classes of bugs that have been hitting Jeremy in physical hardware
  testing happen at sync boundaries between systems — and those
  boundaries are very thinly covered.
- **CI was lint + typecheck only since 2026-04-22 (commit `c932227`)**.
  The unit + integration jobs were removed because the integration
  suite was flaky against the live OpenFoodFacts API. Restoration is
  done in this PR (Phase 1).
- **No test, anywhere, exercises the full Pi → cloud edge fn → DB →
  realtime → React render chain.** Every layer is mocked at its boundary,
  so bugs that live in the contract between layers are invisible to all
  ~1,600 tests.

---

## Layer-by-layer

### 1. pgTAP (`supabase/tests/`)

| Metric        | Value                                                    |
| ------------- | -------------------------------------------------------- |
| Test files    | 50 (`*.test.sql`)                                        |
| Subtests      | 4,842 (sum of `plan()` declarations)                     |
| Skipped       | 0 known                                                  |
| Last green    | Local — runs after every migration push per CLAUDE.md    |
| Run time      | ~30 s under `supabase test db` against fresh local stack |
| Run frequency | Every migration push, locally; never in CI               |

**Catches:** RLS regressions per table, SECURITY DEFINER body
correctness, function signatures, trigger invariants, FK cascades,
4-op (SELECT/INSERT/UPDATE/DELETE) cross-user isolation
(`rls_audit_gap_closer`).

**Cannot catch:** anything that requires a live HTTP boundary (edge
function CORS, Pi → cloud emit, browser → edge fn auth path), realtime
event delivery, RLS under concurrent multi-user writes.

### 2. Web unit tests (`apps/web/src/__tests__/unit/`)

| Metric        | Value                                                 |
| ------------- | ----------------------------------------------------- |
| Test files    | 40                                                    |
| Subtests      | 401 (398 passing + 3 skipped — DST-related, expected) |
| Run time      | 11 s on `pnpm test`                                   |
| External APIs | None                                                  |
| Setup file    | `setup.ts` mocks `AppProvider`, `matchMedia`          |

**Catches:** pure-function logic (epley 1RM, macro calc, recipe stock
status, plate calc, keypad input, expires-on logic), per-component
render with mocked hooks, ErrorBoundary fallback rendering, realtime
health logic.

**Cannot catch:** any bug whose ground truth lives in the database, edge
function, or realtime channel. Mocks the entire `AppProvider`, so
`useAppContext` always returns the canned shape — drift between the
mock and the real provider's contract is invisible.

### 3. Web integration tests (`apps/web/src/__tests__/integration/`, `flows/`)

| Metric        | Value                                                       |
| ------------- | ----------------------------------------------------------- |
| Test files    | 38 + 1 flows                                                |
| Subtests      | 369 + 4 flows                                               |
| Skipped       | 8 of 21 in `analyze-product.test.ts` (live-OFF gated 04-27) |
| Run time      | ~3-5 min against fresh local Supabase stack                 |
| External APIs | OFF (gated behind `RUN_LIVE_OFF=1` post-Phase-1)            |
| Requires      | `supabase start` running locally (or in CI integration job) |

**Subdirs:**

- `chefbyte/` (3 files) — meal-macro, serving-container roundtrip,
  stock-consumption.
- `coachbyte/` (1) — workout-flow.
- `edge-functions/` (6) — analyze-product, walmart, shelf-ingest,
  livetrack-session, encryption, cors-preflight.
- `hub/` (9) — auth lifecycle, profile, app activation, MCP keys, etc.
- `pages/` (16) — per-page query/mutation coverage hitting real DB.
- `realtime/` (1) — subscription tests.

**Catches:** RLS as observed by the JS client (real signed-in users),
edge-function CORS, edge-function auth, edge-function quota enforcement,
DB-side state transitions written by RPCs, full HTTP round-trips, the
`analyze-product` failure paths (via `x-test-force-failure` header
gated by `isLocalDev()`).

**Cannot catch:** anything that requires the Pi to actually emit an
event, realtime delivery into a real React render tree, optimistic-update
key-shape mismatches that only manifest when both `useQuery` and
`setQueryData` are wired through TanStack Query at runtime.

### 4. App-tools (`packages/app-tools/src/__tests__/`)

| Metric        | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Test files    | 9 (4 unit + 5 integration)                                   |
| Subtests      | 401                                                          |
| Run time      | ~2 s for unit; live tests require keys (auto-skip if absent) |
| External APIs | Mocked in `extensions.test.ts`; live in `*-live.test.ts`     |

**Files:**

- Unit: `coachbyte-timer-handlers`, `extensions` (obsidian + todoist
  - ha mocked via global fetch stub), `obsidian-ssrf`.
- Integration: `chefbyte-tools`, `coachbyte-tools`, `ha-live` (skipIf
  no `HA_TOKEN`), `obsidian-live` (skipIf no `GITEA_TOKEN`),
  `todoist-live` (skipIf no `TODOIST_API_KEY`).

**Catches:** MCP tool handler logic for all 41 tools, SSRF guards on
obsidian, namespace-prefix enforcement, parameter validation,
RPC error translation, real Todoist / HA / Gitea round-trip when
secrets present (nightly).

**Cannot catch:** Cloudflare Worker-specific runtime quirks (DO
storage, fetch resolution, KV), MCP transport layer issues (SSE,
streamable-http), OAuth flow.

### 5. MCP worker (`apps/mcp-worker/src/__tests__/`)

| Metric        | Value                  |
| ------------- | ---------------------- |
| Test files    | 9                      |
| Subtests      | 135                    |
| Run time      | ~3 s                   |
| External APIs | None — Supabase mocked |

**Files:** `chat-streaming`, `mcp-streamable`, `mcp-worker`,
`obsidian-parser`, `session-logging`, `sse`, `tool-executor`,
`tool-logger`, `validate`, `voice-ack`.

**Catches:** OAuth 2.1 endpoints (authorize, token, register, revoke,
PKCE, scope shape), API key + JWT auth fallthrough, session lifecycle,
SSE framing, streamable HTTP framing, request validation,
`mcp_tool_logs` observability wrapper, voice-ack streaming.

**Cannot catch:** real DO durability semantics, Cloudflare cache
behavior, the actual deployed worker's response to malformed requests,
the live SSE keepalive timing under poor network.

### 6. Extensions tests

The "100 tests / 72 mocked + 28 live" claim from the README maps
to the four files inside `packages/app-tools/src/__tests__/integration/`
and `extensions.test.ts`. No tests live under `extensions/*/__tests__/`
itself — they are all colocated with the tool handlers in app-tools.
The README claim is technically defensible but the file layout is a
trap for new readers. (Audit recommendation: rename README claim or
move tests into `extensions/`.)

### 7. Pi unit tests (`hardware/live-shelf/server/tests/`)

| Metric            | Value                                  |
| ----------------- | -------------------------------------- |
| Test files        | 38 (`test_*.py`)                       |
| Subtests          | 249 (sum of `def test_*` declarations) |
| Run time          | ~30 s on Pi venv (`pytest tests/`)     |
| External services | SQLite + mocked HTTP only              |

**Catches:** state machine transitions per scale type, in-flight pickup
TTL reap, lot-snapshot reunite poller, classifier reunite guard,
catch-all routing, close-weight stability gate, livetrack heartbeat
state machine, manual discard, session lot dedup, replacement-branch
emit-add, scale-03 paired no-stock, sweep-orphans, tare capture,
unknown-weight fit promotion, usage-log emission, wizard suppress
events.

**Cannot catch:** real ESP8266 → Pi WiFi packet loss, real load-cell
noise, the actual Anthropic Sonnet classifier returning real outputs,
camera capture failures.

### 8. Harness (`scripts/harness/scenarios/`)

| Metric        | Value                                              |
| ------------- | -------------------------------------------------- |
| Scenarios     | 15 real (+ 3 sentinels: `passing_*`, `broken_*`)   |
| Run time      | ~3 s for all 15 against fresh local stack          |
| External APIs | None — Pi calls go to the local stack via loopback |

**Coverage:**

- `live_shelf_pickup_single_event` — REMOVE at PRESENT lot fires one event
- `live_shelf_in_flight_return_clears_marker` — pickup → return clears in_flight
- `live_shelf_in_flight_ttl_reap_clears_marker` — TTL elapses, marker clears
- `live_shelf_in_flight_ttl_reap_removes_whole_lot` — TTL reap removes lot
- `live_shelf_place_back_after_ttl_expired` — late return revives reaped lot
- `live_shelf_reunite` — lot-snapshot poller pulls cloud delta to Pi
- `live_shelf_close_weight_noise_rejected` — stability gate rejects mid-motion
- `live_shelf_manual_discard_no_macros` — manual discard emits without food log
- `live_scale_depleted_event` — single-item depleted event
- `livetrack_heartbeat_state_machine` — heartbeat state transitions
- `livetrack_wizard_suppresses_events` — wizard suppression correctness
- `lot_snapshot_reunite` — three-step reunite loop (insert/update/delete)
- `single_item_first_placement` — first placement creates lot
- `catch_all_frames_captured` — catch-all frame capture
- `device_delete_propagates` — device delete propagates to Pi

**Cannot catch:**

- **No browser-side test** — every scenario asserts on DB state, never
  on what a React component would render given the same DB state.
- **No realtime delivery test** — events flow Pi → DB but the realtime
  channel that should invalidate TanStack Query is not exercised end-
  to-end.
- **No multi-user concurrent test** — scenarios run as a single user.

### 9. Verification gates (`.verify/<gate>.json`, per `docs/VERIFY.md`)

| Gate       | Status                                            |
| ---------- | ------------------------------------------------- |
| `harness`  | Live — last run 2026-04-26 17:01 UTC, ok          |
| `impact`   | Live — `pnpm verify:impact`                       |
| `review`   | Live — `pnpm verify:review`                       |
| `mutation` | Live — `pnpm verify:mutation` (Stryker + mutmut)  |
| `drift`    | Live — `pnpm verify:drift`, GitHub workflow on PR |

**These gates are local + nightly + PR-time. None of them ran in CI on
push to main between 2026-04-22 and 2026-04-27.**

---

## Boundary-coverage matrix

The bugs that have been hitting in physical hardware all live at the
boundary between two systems. Below: which boundaries are exercised at
which layer.

| Boundary                                                             | Pi unit | pgTAP | Web unit | Web int | Harness | E2E |
| -------------------------------------------------------------------- | ------- | ----- | -------- | ------- | ------- | --- |
| Pi state machine ↔ local SQLite                                      | full    | -     | -        | -       | partial | -   |
| Pi cloud emit ↔ shelf-ingest edge fn                                 | mock    | -     | -        | partial | full    | -   |
| shelf-ingest ↔ apply_shelf_event RPC ↔ stock_lots                    | -       | full  | -        | partial | full    | -   |
| stock_lots write ↔ realtime broadcast                                | -       | -     | -        | partial | -       | -   |
| Realtime broadcast ↔ TanStack Query invalidation                     | -       | -     | -        | partial | -       | -   |
| TanStack Query invalidation ↔ Inventory page render                  | -       | -     | partial  | -       | -       | -   |
| Scanner Purchase mode ↔ stock_lots row ↔ Inventory page visible      | -       | -     | -        | -       | -       | -   |
| Classifier reunite guard ↔ cloud emit kind ↔ in_flight_since cleared | partial | -     | -        | -       | partial | -   |
| TanStack Query optimistic key shape ↔ useQuery key shape             | -       | -     | mock     | -       | -       | -   |
| RLS under concurrent multi-user writes                               | -       | none  | -        | partial | -       | -   |
| Date semantics across `day_start_hour` boundaries (cross-layer)      | -       | full  | partial  | partial | -       | -   |

`full` = boundary deliberately exercised end-to-end at this layer;
`partial` = exercised on one side or with mocks on the other;
`mock` = the boundary is faked (does not exercise the real wire);
`-` = not exercised.

---

## What is NOT catchable by the current ~1,600 tests

1. **Pi → cloud → realtime → web render chain.** Each link is tested
   individually with the next link mocked. A bug that lives in the
   contract between any two layers is invisible.

2. **TanStack Query optimistic key-shape drift.** The ShoppingPage bug
   was that `setQueryData(['shopping', userId])` did not match
   `useQuery(['shopping', userId, { logicalDate }])`. The unit tests
   for the ShoppingPage mock TanStack Query, so the real key shape
   that the page consumes never gets compared against the optimistic
   write. Catchable only by a test that uses a real `QueryClient` with
   the real component code and asserts on the DOM after the optimistic
   write.

3. **RLS under realistic multi-user concurrency.** `rls_audit_gap_closer`
   asserts user A cannot read user B's rows. It does NOT assert that two
   concurrent inserts from A and B do not collide on a shared sequence,
   that A's RLS policy is not weakened by a SECURITY DEFINER call from B,
   or that a triggered cascade respects A's RLS when the trigger fires
   from B's row.

4. **Date semantics under timezone + day_start_hour.** Tests assert the
   `private.get_logical_date()` function returns the right value. They
   do NOT assert that, when the user's `day_start_hour` is 4 and the
   system clock is at 03:55 local, the MacroPage shows yesterday's
   total — the cross-layer assertion that links a DB function to a
   rendered component output is missing.

5. **Scanner Purchase mode → Inventory page visibility.** No test
   asserts that scanning a barcode in Purchase mode results in the new
   lot being visible in the Inventory page within X seconds.

6. **Classifier reunite → in_flight clearance after event.** The Pi unit
   tests assert the classifier picks the right candidate. The harness
   asserts cloud receives the right event kind. Neither asserts the
   round trip: classifier picks lot L, emits event, cloud receives,
   stock_lots.in_flight_since is null, web sees lot L without the
   amber "(picked up)" badge.

7. **Live-OFF rate limiting drift.** Eight integration tests still
   require the real OFF API. Gated behind `RUN_LIVE_OFF=1` post-04-27.
   When OFF changes its response shape, only the nightly audit job
   notices.

---

## "Comprehensive" claim audit

`README.md` line 167: `**~1,600+ tests across 5 layers:**`

Defensible? Numerically, yes. The breakdown sums to:

- pgTAP: 4,842 subtests (the README rounds to 774 — ambiguous, see
  next item)
- Web unit: 401
- Web integration: 369 + 4 flows
- MCP worker: 135
- App tools: 401 (4 + 5 files in nested dirs)
- Pi unit: 249
- Total: ~6,400 subtests (≠ the README's 1,600)

The README undercounts. The honest framing is closer to "~6,000 unit-
level subtests + 15 harness scenarios + 5 verification gates,
exercising individual systems thoroughly but with weak coverage at the
boundaries between systems."

**Corrections to make:**

- README "Testing & Verification" section: drop the marketing tone,
  state the boundary-coverage gap explicitly. Either link to this audit
  or fold the gist of the matrix above into the README.
- README per-layer counts: pgTAP 4,842 subtests across 50 files (not
  774); add a note that "subtests" are individual `is/ok/throws_ok`
  assertions and roughly 10x the file count.
- README harness count: 15 scenarios (not 14). Three sentinels
  (`passing_sentinel`, `broken_sentinel`, plus another) make the file
  count higher.

---

## Five worst gaps (smallest fix → biggest coverage)

Ranked by effort-to-coverage ratio.

1. **Pi → cloud → web render scenario in the harness.** Existing
   harness already boots Pi + DB. Add 1 scenario that, after the cloud
   emit lands, asserts the web Inventory page query returns the new
   lot. Effort: ~4 hours. Closes 3 of the 7 gap classes above.

2. **Optimistic-update key-shape contract test.** A small Vitest suite
   that renders each TanStack-Query-using page with a real
   `QueryClient`, dispatches `setQueryData` for every key the page
   writes, and asserts the page re-renders with the new data. Effort:
   ~6 hours. Closes the ShoppingPage class of bug.

3. **Multi-user concurrency RLS test.** One pgTAP file that creates
   two users, runs concurrent inserts to the shared tables (recipes,
   stock_lots, food_logs), and asserts row visibility per user
   independent of timing. Effort: ~4 hours. Closes the concurrency
   blind spot.

4. **`day_start_hour` cross-layer test.** One integration test that
   sets a user's `day_start_hour` to 4, fakes the system clock to
   03:55, hits the MacroPage data fetcher, asserts the result includes
   yesterday's logs. Effort: ~3 hours. Closes the date-rollover bug
   class.

5. **Scanner → inventory full-chain integration.** One integration
   test that drives the ScannerPage in Purchase mode (mocked camera,
   real DB), asserts the lot appears in the InventoryPage query within
   2 s of the realtime event. Coordinate with the scanner-fix-agent
   on file ownership. Effort: ~4 hours. Closes the chocolate-milk
   bug class.

Total: ~21 hours. Compare with the 100+ hours invested in the existing
1,600 tests — the marginal coverage from these five is far higher per
hour than what's there now.
