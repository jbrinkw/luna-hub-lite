# `tests/e2e` — Phase 2 end-to-end harness

15 user-level scenarios that exercise the full stack: real Supabase
(local), real edge functions, real React app rendered in headless
Chromium, and an in-process Pi simulator that hits the cloud-facing
contract the way the Raspberry Pi would.

Each scenario is a single `*.spec.ts` file under `scenarios/`. Each one
seeds its own throwaway user via the admin API, drives one
end-to-end flow, asserts state convergence at every layer (DB row,
edge-fn response, realtime broadcast, React render), and cleans up the
user on teardown. Scenarios are independent — no shared state — but
`workers=1` so the dev server boot doesn't race.

See `docs/test-system-fix-plan.md` for the architecture rationale + why
this layer exists alongside the ~1,600 lower-level tests.

---

## Running

```bash
# Local (assumes `supabase start` and an .env.test at repo root)
cd tests/e2e
pnpm test:e2e

# UI mode — pick + replay individual scenarios
pnpm test:e2e:ui

# Or directly
pnpm exec playwright test --config tests/e2e/playwright.config.ts
```

The Playwright config auto-boots `pnpm --filter @luna-hub/web dev` on
port 5173 (reused if already running). The local Supabase stack must
be up — `supabase start` from the repo root before invoking.

Trace + video + screenshot are retained on failure under
`../../test-results-e2e/` (gitignored). HTML report under
`../../playwright-report-e2e/`. Both directories are
`.gitignore`d — they are test output, not source.

---

## Scenarios

| #  | Slug                                   | Layers exercised                          | Notes |
| -- | -------------------------------------- | ----------------------------------------- | ----- |
| 01 | `scanner-purchase`                     | UI → analyze-product → stock_lots → UI    | Catches the chocolate-milk class of "scanned but not visible." |
| 02 | `scanner-consume-macros`               | UI → consume_product → food_logs → UI     | Asserts daily macro total reflects the scan. |
| 03 | `scanner-consume-no-macros`            | UI → consume_product (no macros)          | CRITICAL invariant: NO `food_logs` row when the user opts out. |
| 04 | `pi-pickup-shows-inflight-badge`       | Pi → shelf-ingest → realtime → UI         | Amber In-flight badge renders within 5 s of pickup. |
| 05 | `pi-return-clears-inflight`            | Pi → shelf-ingest → realtime → UI         | Badge clears on return; falls back to nav-refresh if realtime drops. |
| 06 | `pi-ttl-reap`                          | Pi (drifted measurement) → whole-lot zero | Asserts the TTL/reap branch zeros the entire lot regardless of `delta_g`. |
| 07 | `place-back-after-ttl`                 | Pi → reap → Pi `added` revives same lot   | No duplicate lot creation. |
| 08 | `shopping-import-to-inventory`         | UI → toggle purchased → import → UI       | Catches the optimistic-update query-key bug class. |
| 09 | `workout-pr-detection`                 | UI → complete_next_set → PRsPage          | Epley 1RM surfaces in the PR view. |
| 10 | `day-rollover` *(clock-frozen)*        | RPC w/ explicit `p_logical_date` → UI     | Drives the day_start_hour boundary without faking the system clock. |
| 11 | `discarded-event-no-macros`            | Pi `discarded` → stock_lots zero          | CRITICAL invariant: NO `food_logs` row when the user manually removes a lot. |
| 12 | `catch-all-scale-routing`              | Pi `live_scale` → stock_lots              | `last_update_source='live_scale'`; payload kind discriminator preserved. |
| 13 | `meal-plan-execution-creates-meal-lot` | UI/RPC `mark_meal_done` → `[MEAL]` lot    | Validates `[MEAL] <name> MM-DD` mint + ingredient decrement. |
| 14 | `below-min-stock-auto-shopping`        | UI Auto-add → shopping_list               | Asserts qty rounding on auto-add. |
| 15 | `livetrack-wizard-suppresses-events`   | livetrack_import_sessions ↔ Pi predicate  | Contract test — Pi-side gate predicate mirrored on the test side. |

---

## Per-scenario caveats

- **Scenarios 01–03**: include a one-keypad-tap re-render before the
  barcode submit. The ScannerPage's `handleBarcodeSubmit` is wrapped in
  `useCallback` whose deps don't include `defaultLocationId`. On a
  fresh page load, the first scan can race against the `locations`
  query and capture a stale `executeAction`. The keypad tap forces a
  state-driven re-render so the next scan sees a populated
  `defaultLocationId`. Real users hit the keypad before the barcode in
  practice; the harness mirrors that.
- **Scenarios 06–07**: don't wait six real hours for the in-flight TTL.
  They seed a row with `in_flight_since` 7 hours in the past plus a
  matching `pickup_event_id`, then drive a `consumed` event whose
  `pi_event_id` matches. The cloud's whole-lot branch
  (`20260427010000_in_flight_pickup_resolve_whole_lot.sql`) recognizes
  the match and zeroes the lot regardless of the (drifted) measured
  weight. This is a clock-frozen scenario — the harness simulates "TTL
  has elapsed" via a backdated `in_flight_since`.
- **Scenario 09**: uses the deployed function param names
  (`p_actual_reps`, `p_actual_load`). Note: `apps/web/.../TodayPage.tsx`
  calls with `p_reps`/`p_load` which the deployed function does NOT
  accept — flagged in `decisions.md`. The scenario uses the deployed
  contract.
- **Scenario 10**: drives `consume_product` with an explicit
  `p_logical_date` rather than freezing the Postgres clock. The
  `private.get_logical_date()` fallback is well-covered by pgTAP; this
  scenario asserts the cross-layer "macro page rendered with
  day_start_hour=6 honors the logical_date stamp correctly when
  navigating between days."
- **Scenario 13**: `[MEAL]` product/lot is created by the
  `mark_meal_done` RPC; the scenario does NOT exercise an Undo
  reversal. The undo path is covered by pgTAP + integration tests on
  the meal-plan page; this scenario asserts the forward path.
  Reversal-on-undo is a candidate for a future companion scenario.
- **Scenario 14**: tests the explicit "Auto-add" button click on the
  Shopping page (the user-driven entry point for below-min items).
  The consumption-driven path that triggers auto-add inside
  `consume_product` is covered by the scanner scenarios + pgTAP.
- **Scenario 15**: the LiveTrack-wizard suppression gate is Pi-side
  ONLY (see `hardware/live-shelf/server/handlers/scale_events.py::
  _is_wizard_active`, commit d8e0aec). Cloud-side has no matching
  predicate — shelf-ingest accepts whatever the Pi sends. Since our
  TS Pi simulator bypasses Pi entirely, the scenario models the Pi's
  predicate on the test side: it consults
  `chefbyte.livetrack_import_sessions.state`, applies the same
  active-state set as the Pi, skips `postPiEvent` while the
  predicate is true, and asserts the cloud-observable consequence
  (zero `shelf_event_log` rows during the active window). After
  flipping the session to `closed`, it does post and asserts the
  event lands. The Pi's own gate logic is covered by 14 unit tests
  in `hardware/live-shelf/server/tests/test_wizard_suppress_events.py`
  plus the Python harness scenario `livetrack_wizard_suppresses_events.py`.

---

## Runtime Invariants (Phase 3)

After every passing scenario, a shared `afterEach` hook in
`fixtures/test-base.ts` runs `assertSystemInvariants` from
`invariants.ts` against each user the scenario seeded. Violation =
the scenario fails with `InvariantViolationError` listing every
offending predicate. The hook only runs on PASS — invariant
assertions on top of an already-failing scenario just confuse the
report.

The 11 invariants (post-2026-04-27 reconcile with Phase 4 monitor):

| #  | Name                                       | Severity | Catches                                                                                            |
| -- | ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| 1  | `qty_non_negative`                         | critical | a scenario somehow leaving a `stock_lots.qty_containers < 0` for the test user                     |
| 2  | `food_logs_4_4_9_within_tolerance`         | warning  | per-row macro drift — `cal != 4c+4p+9f ± 10 kcal` on any food_logs row created during the scenario |
| 3  | `stock_lots_in_flight_consistent`          | error    | a lot with `in_flight_since` set but no `pickup_event_id` (orphan in-flight state)                 |
| 4  | `pi_cloud_lot_id_match`                    | error    | (skipped unless simulator tracks lots) Pi knows about a lot the cloud doesn't have                 |
| 5  | `mcp_tool_log_user_id_present`             | error    | `hub.mcp_tool_logs` row with NULL user_id (column is NOT NULL — catches drop)                      |
| 6  | `shelf_event_log_no_orphan_lots`           | error    | event references a lot_id that doesn't exist (soft-delete-races-event-write)                       |
| 7  | `livetrack_session_no_zombie_active`       | warning  | LiveTrack session still in non-terminal state > 5 min after creation                               |
| 8  | `coachbyte_timer_running_has_end_time`     | error    | timer.state='running' AND end_time IS NULL (partial-write canary)                                  |
| 9  | `coachbyte_timer_running_not_stale`        | warning  | timer.state='running' AND end_time > 4h in the past (forgotten timer)                              |
| 10 | `product_macro_drift_4_4_9`                | warning  | products updated during the scenario have `cal != 4c+4p+9f ± 5%`                                   |
| 11 | `cloud_outbox_no_permanent_failed`         | critical | (skipped unless simulator exposes outbox) Pi outbox has permanent-failed rows                      |

All predicates are scoped to the test user (and where applicable a
scenario-start timestamp) so cross-scenario data doesn't trip them.

The unit suite at `__tests__/invariants.test.ts` covers each
predicate's logic in isolation (mocked Supabase). Runs as part of
`pnpm verify:fast` automatically. The 15 e2e scenarios cover the
end-to-end "real Supabase, real data, real afterEach hook" path.

Manual sanity verification: see Phase 3 of
`docs/test-system-fix-plan.md`. Drop the `stock_lots_qty_nonneg`
CHECK, plant a `qty_containers = -1` row, run any scenario — the
afterEach must throw `InvariantViolationError` naming
`qty_non_negative`.

Phase 4's production monitor (`supabase/functions/invariant-monitor`)
runs the same class of invariants against live cloud data every 30
min. The two share intent but not code; the e2e module also reads
local-only state (e.g. simulator-side fields) where Phase 4 cannot.

---

## Layout

```
tests/e2e/
├── README.md                # this file
├── playwright.config.ts     # config, web-server boot, output dirs
├── vitest.config.ts         # vitest config for invariant unit tests
├── package.json             # @luna-hub/e2e workspace
├── tsconfig.json            # extends repo base
├── invariants.ts            # 10 system invariant predicates (Phase 3)
├── __tests__/
│   └── invariants.test.ts   # 25 unit tests for the predicates (vitest)
├── fixtures/
│   ├── env.ts               # SUPABASE_* env loader, admin/anon clients, sha256
│   ├── pi-simulator.ts      # in-process Pi → shelf-ingest emitter
│   ├── test-base.ts         # extended `test` with afterEach invariant hook
│   └── test-db.ts           # per-scenario seeding + UI-driven login + cleanup
├── helpers/                 # shared cross-scenario helpers (currently empty)
└── scenarios/
    ├── 01-scanner-purchase.spec.ts
    ├── 02-scanner-consume-macros.spec.ts
    ├── 03-scanner-consume-no-macros.spec.ts
    ├── 04-pi-pickup-shows-inflight-badge.spec.ts
    ├── 05-pi-return-clears-inflight.spec.ts
    ├── 06-pi-ttl-reap.spec.ts
    ├── 07-place-back-after-ttl.spec.ts
    ├── 08-shopping-import-to-inventory.spec.ts
    ├── 09-workout-pr-detection.spec.ts
    ├── 10-day-rollover.spec.ts
    ├── 11-discarded-no-macros.spec.ts
    ├── 12-catch-all-routing.spec.ts
    ├── 13-meal-plan-execution.spec.ts
    ├── 14-below-min-stock-auto-shopping.spec.ts
    └── 15-livetrack-wizard-suppresses-events.spec.ts
```

---

## Why an in-process Pi simulator (not a Python subprocess)

Each scenario boots in ~50 ms instead of the ~3–5 s a Python+venv+
supabase-py subprocess would take. The cost is we don't exercise the
Pi's classifier / reconciler / state machine — but those are covered
exhaustively by the existing 38-file Pi pytest suite and the 15-scenario
Python harness under `hardware/live-shelf/scripts/harness/`. This
harness's job is to hit the *cloud-facing contract* with the right
payloads — every link downstream of the Pi outbox (shelf-ingest →
`apply_shelf_event` RPC → DB writes → realtime → React render) is the
real production path. See `fixtures/pi-simulator.ts` header comment for
the full rationale.
