# Test System Fix Plan — 2026-04-27

Companion to `docs/test-audit-2026-04-27.md`. The audit identifies what's
broken; this document specifies how to fix it.

Scope: 5 phases. Phase 1 lands in this PR. Phases 2-5 are sequenced for
follow-up sessions.

---

## Phase 1 — Restore CI (this session) ✅

**Goal:** Re-enable unit + integration test jobs in CI. Eliminate the
flake source.

**Root cause of original flake (commit `c932227`):** the integration
suite includes 8 assertions in `analyze-product.test.ts` that hit the
real OpenFoodFacts API for stable barcodes (Nutella, Coca-Cola, Pringles,
etc.). OFF rate-limits aggressively and occasionally 5xx's, which made
the CI run flake at ~1 in 8.

**Fix:** Gate live-OFF assertions behind `RUN_LIVE_OFF=1`. The other
13 tests in the file (auth, validation, quota, CORS, failure-paths via
the `x-test-force-failure` test header that was already implemented)
are deterministic and run unconditionally.

### Deliverables

1. `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts`
   — 8 `it(...)` calls converted to `it.skipIf(skipLiveOff)(...)` where
   `skipLiveOff = process.env.RUN_LIVE_OFF !== '1'`.

2. `.github/workflows/ci.yml` — restore `unit-tests` and
   `integration-tests` jobs. Integration job boots local Supabase via
   `supabase start`, runs `pnpm test:db` + `pnpm test:integration`,
   uploads supabase logs on failure.

3. The e2e-tests job stays commented out (Phase 2 will rebuild that
   into a proper end-to-end harness).

### Verification

- `pnpm typecheck` passes (5 packages, ~6 s).
- `pnpm test` passes locally — 401 web unit + 135 mcp-worker + 401
  app-tools = ~937 subtests, ~12 s wall.
- `pnpm test:integration` requires `supabase start` running; with
  `RUN_LIVE_OFF` unset, the 8 live-OFF assertions skip and the rest
  pass.

### Effort

Done in this session. ~2 hours.

### Bug class caught

The class of "we shipped a regression to a unit-tested feature without
running the suite first" — the unit suite is now mandatory on every
push. The integration suite catches edge-fn CORS / auth / quota /
failure-path regressions before they reach production.

---

## Phase 2 — End-to-end harness (1-2 days) ✅

**Status (2026-04-27):** Shipped. 15 scenarios live under `tests/e2e/`,
all green locally in ~45 s wall. Pi simulator chose option (b) (in-process
TypeScript that POSTs to shelf-ingest with x-api-key) — see
`tests/e2e/README.md` "Why an in-process Pi simulator" for the rationale.
Run: `pnpm test:e2e` (must have `supabase start` running).

**Goal:** A single suite that boots Supabase + a Pi simulator + the React
SPA in a headless browser, runs realistic user flows, and asserts state
convergence at each step.

**Why:** The ~1,600 existing tests each mock the next layer down. A
sync-boundary bug (Pi → cloud → realtime → render) is invisible to all
of them. An end-to-end harness running real code at every layer is the
only way to catch this class.

### Architecture

- **Stack boot:** `supabase start` (DB + auth + storage + edge runtime)
  - `vercel dev` or `vite preview` for the SPA + Pi simulator (Python,
    no real ESP8266; calls `handle_scale_event` directly).
- **Driver:** Playwright. One browser context per scenario, headless,
  no-video-on-pass / video-on-fail.
- **DB seed:** per-scenario inline `psql` calls against the local
  Supabase. Reset between scenarios via `supabase db reset` (heavy) or
  per-test cleanup queries (light, default).
- **Auth:** create the test user via `adminClient.auth.admin.createUser`
  - sign in via Playwright UI to get a real session cookie.
- **Pi simulator:** call into `hardware/live-shelf/server/app.py`
  helpers directly (already used by the existing harness scenarios).
  Reuses `scripts/harness/orchestrator.py`.

### Scenarios shipped (15, not the original 10)

The user expanded the scope to 15 to cover the actively-biting bug
classes (chocolate milk, scanner mode-switch, in-flight badge race,
TTL reap, place-back revival, meal-prep [MEAL] mint,
LiveTrack-wizard suppression contract). The full list lives in
`tests/e2e/README.md` "Coverage matrix" — every scenario references
the boundary it exercises and the bug class it catches. The original
10 below is preserved as historical context.

### Original 10 scenarios (planning doc — superseded by 15 shipped)

Each scenario asserts state convergence at every layer (DB row, edge fn
response, realtime broadcast received, React component rendered).

1. **scanner-purchase-to-inventory** — ScannerPage + Purchase mode +
   barcode `5000159484695` → analyze-product (canned OFF) → product
   created → stock_lot inserted → InventoryPage shows lot. Catches
   Phase 1 of the chocolate milk bug class. Effort: 1 hour.

2. **pi-pickup-to-inventory-badge** — Pi simulator emits
   `in_flight_pickup` → cloud handler sets `in_flight_since` →
   realtime broadcast → InventoryPage renders amber "(picked up)"
   badge. Effort: 1.5 hours.

3. **pi-return-clears-badge** — sequel to #2: Pi emits
   `in_flight_return` → in_flight_since cleared → realtime broadcast →
   InventoryPage badge gone. Effort: 1 hour.

4. **pi-pickup-ttl-reap-removes-lot** — Pi emits pickup → 6h
   simulated time skip → reaper runs → lot deleted → realtime
   broadcast → InventoryPage no longer shows lot. Effort: 1.5 hours.

5. **scanner-consume-with-macros** — ScannerPage + Consume mode →
   stock_lot decremented → food_log inserted → MacroPage daily total
   updated. Effort: 1 hour.

6. **shopping-meal-plan-import** — Add meal to plan → Shopping list
   auto-fills → Toggle purchased → Import to inventory → Inventory
   page shows `[MEAL]` lot. Tests the meal-prep workflow + optimistic
   updates. Effort: 1.5 hours.

7. **workout-set-completion-with-pr** — CoachByte Today page → mark
   set complete → DB rest timer started → Realtime broadcasts
   timer state every second → UI countdown matches → set 2 of 3
   complete → PR toast on new Epley 1RM. Effort: 2 hours.

8. **day_start_hour-rollover** — Set day_start_hour=4, fake clock to
   03:55 local, log a food → MacroPage shows the log under
   yesterday's logical date, NOT today's. Effort: 1.5 hours.

9. **multi-user-isolation** — Two browser contexts (user A + user B)
   running simultaneously. Each writes to recipes, stock_lots,
   food_logs in parallel. Assert no cross-user leaks at every layer.
   Effort: 2 hours.

10. **livetrack-wizard-completion** — Browser starts wizard → Pi
    receives session → Pi scans tare → Pi calls `livetrack-session/
pi-update` → Browser sees state transition via Realtime → wizard
    completes → product catalog updated. Effort: 2 hours.

Total scenario effort: ~15 hours.

### Deliverables

- `apps/web/playwright.config.ts` — already exists for the old e2e
  job, reuse with a fresh test directory `e2e/scenarios/`.
- `apps/web/e2e/scenarios/01-scanner-purchase-to-inventory.spec.ts`
  through `10-livetrack-wizard-completion.spec.ts` — one file per
  scenario.
- `scripts/harness/web-driver.ts` — shared helper that boots the
  full stack (delegates to existing `scripts/harness/run.py` for the
  Pi simulator and DB seed).
- `.github/workflows/ci.yml` — uncomment the `e2e-tests` job, point at
  the new scenarios.

### Effort

15 hours scenarios + 5 hours infra + 4 hours debugging on first run = ~24 hours.

### Bug class caught

Sync-boundary bugs across Pi ↔ cloud ↔ realtime ↔ web render. All 7
classes from the audit's "What is NOT catchable" list.

---

## Phase 3 — Invariant predicates (1 day)

**Goal:** A set of standalone Python or TypeScript functions that assert
system invariants are true. Run after every E2E scenario and as part of
a production monitor (Phase 4).

**Why:** Even the most thorough E2E scenario only checks the assertions
the test author thought to write. Invariants are global statements
about the system that must be true regardless of which path got us
there.

### Deliverables

10 invariants, each a standalone callable that takes a Supabase client
and returns `(ok: boolean, message: string)`.

1. **`every_food_log_has_logical_date`** — `select count(*) from
chefbyte.food_logs where logical_date is null` must equal 0.

2. **`every_stock_lot_has_user_id_matching_product_user_id`** — RLS
   foreign key consistency check. No lot's `user_id` should differ
   from its product's `user_id`.

3. **`no_in_flight_lots_older_than_ttl`** — `select count(*) from
chefbyte.stock_lots where in_flight_since < now() - interval '6h'`
   must equal 0. (TTL reaper runs every minute; >0 means the reaper
   is broken.)

4. **`every_completed_set_has_logical_date`** — same logical-date
   invariant for `coachbyte.completed_sets`.

5. **`every_recipe_ingredient_has_unit_in_canonical_form`** — units
   must be one of the 6 canonical values (oz, g, ml, container,
   serving, count). No free-text units.

6. **`mcp_tool_logs_observability_invariant`** — every successful
   MCP tool call must have a `mcp_tool_logs` row. Asserts the
   observability wrapper isn't silently dropping calls.

7. **`every_active_app_has_user_profile`** — RLS / FK invariant: no
   row in `hub.user_apps` should reference a non-existent user_id.

8. **`every_stock_lot_qty_is_non_negative`** — quantities cannot be
   negative. The CHECK constraint exists in DB; this invariant
   catches a bug where the constraint is dropped or a SECURITY
   DEFINER bypasses it.

9. **`livetrack_sessions_have_terminal_state_after_24h`** — sessions
   older than 24h must be in `completed`, `failed`, or `cancelled`.
   Catches stuck wizards.

10. **`stock_lots_have_consistent_in_flight_marker_pair`** —
    `in_flight_since IS NULL` ⟺ `pickup_event_id IS NULL`. Catches
    half-cleared in-flight states.

### Architecture

- File: `scripts/invariants/predicates.py` (Python — same venv as the
  harness).
- Each predicate is a function taking `(conn: psycopg2.connection)` and
  returning `Result(ok, name, message, evidence)`.
- Runner: `scripts/invariants/run.py` — runs all 10, writes
  `.verify/invariants.json` per the VERIFY.md schema.
- Hook into harness: `scripts/harness/run.py` calls the invariant
  runner after each scenario.

### Effort

10 invariants × ~30 min each + 2 hours for runner + 1 hour wiring = ~8 hours.

### Bug class caught

Slow-burn corruption that no individual test detects but that
accumulates and breaks the system over time.

---

## Phase 4 — Production invariant monitor (1 day)

**Goal:** Run the invariants from Phase 3 against live production data
every 30 min via a scheduled Supabase function. Write violations to a
new `hub.alerts` table and surface in the Hub UI.

### Deliverables

#### 1. Schema migration

`supabase/migrations/20260427_hub_alerts.sql`:

```sql
create table if not exists hub.alerts (
  alert_id     uuid primary key default gen_random_uuid(),
  detected_at  timestamptz not null default now(),
  severity     text not null check (severity in ('info', 'warn', 'critical')),
  invariant    text not null,        -- predicate name (e.g. 'no_in_flight_lots_older_than_ttl')
  message      text not null,
  evidence     jsonb not null default '{}'::jsonb,
  resolved_at  timestamptz,
  resolved_by  uuid references auth.users(id) on delete set null
);

create index alerts_unresolved_idx on hub.alerts (severity, detected_at desc) where resolved_at is null;

-- RLS: only platform admin role reads. No user-scoped access.
alter table hub.alerts enable row level security;

create policy "alerts admin read" on hub.alerts
  for select to authenticated
  using (
    exists (
      select 1 from hub.user_profile
      where user_id = (select auth.uid())
        and is_admin = true
    )
  );
```

#### 2. Edge function

`supabase/functions/run-invariants/index.ts` — TypeScript port of the
Phase 3 predicates. Schedule via Supabase pg_cron at `*/30 * * * *`.

#### 3. UI surface

- `apps/web/src/pages/hub/AlertsPage.tsx` — admin-only page listing
  unresolved alerts with severity badges.
- `apps/web/src/shared/AppProvider.tsx` — fetch unresolved-alert count,
  show red dot on hub nav for admins.

### Effort

8 hours (migration + edge fn + UI + RLS test).

### Bug class caught

Production data corruption that local testing missed.

---

## Phase 5 — Process changes ✅

**Goal:** No more autonomous agent commit+push without verifying test
pass. Every push runs the suite locally first.

**Status:** Done 2026-04-27. Two-tier `verify:fast` / `verify:full` driver
(`scripts/verify/run.sh`) wired through `package.json`. Husky 9 pre-push
hook (`.husky/pre-push`) auto-routes docs-only changes to `verify:fast`
and code changes to `verify:full`. Honor-system bypass via
`git push --no-verify` + `Verify-skipped:` footer; `commit-msg` hook
prints a warning when the footer is present. Lint and prettier ignore
lists were fixed during Phase 5 dogfooding (lint dropped from 81k errors
on artifact dirs to 0; format from 232 dirty files to 0). Full picture
in `docs/testing-workflow.md`. CI workflow already lint+typecheck only
(commit `7b45ee3`); Phase 5 is the local enforcement that makes the lean
CI safe.

### Deliverables

#### 1. Pre-push hook

`.husky/pre-push` — runs `pnpm verify:fast` (typecheck + unit only,
~15 s) before allowing push. Can be bypassed with `--no-verify` for
emergency fixes; bypasses logged to `decisions.md`.

#### 2. Updated `pnpm verify`

Replace the existing `verify` script with a fast/full split:

```jsonc
"verify:fast": "pnpm typecheck && pnpm test",
"verify:full": "pnpm typecheck && pnpm test && pnpm test:integration && pnpm harness",
"verify": "pnpm verify:fast"
```

Local devs run `verify:full` before declaring a phase complete; the
pre-push hook runs only `verify:fast` to keep the push loop tight.

#### 3. Commit message verification (CLAUDE.md update)

Add to `CLAUDE.md` "Test Quality Gate" section:

> **Mandatory verification before any push.** Run `pnpm verify:full`
> before declaring a phase complete. If `verify:full` fails, fix or
> roll back — never push partially-verified work. This is enforced by
> the pre-push hook for `verify:fast`; the full integration suite is
> on the agent's honor system but **the agent's commit message MUST
> name the verification command they ran and the wall-clock time of
> the green output**. Example commit message footer:
>
>     Verified: pnpm verify:full → 6m 42s green at 2026-04-27 14:35 UTC

This makes verification claims auditable; a commit lacking the footer
is a process failure that the next agent must surface.

#### 4. Reviewer gate enhancement

`scripts/reviewer/review.sh` — parse the commit footer, verify it
matches a `.verify/<gate>.json` artifact written within the last 30
min. If missing or stale, fail the gate.

### Effort

4 hours (hook + script + CLAUDE.md edit + reviewer enhancement).

### Bug class caught

The "agents claim green and push without running" failure that just
hit. Procedural gate, not a code-coverage gate.

---

## Total effort

| Phase | Effort | Bug class caught                                           |
| ----- | ------ | ---------------------------------------------------------- |
| 1     | 2 h ✅ | Regressions in unit-tested code; CORS / auth / quota drift |
| 2     | 24 h   | Sync-boundary bugs Pi ↔ cloud ↔ realtime ↔ render          |
| 3     | 8 h    | Slow-burn corruption invisible to per-test assertions      |
| 4     | 8 h    | Production data corruption                                 |
| 5     | 4 h ✅ | Procedural gate (agents pushing unverified work)           |
| Total | ~46 h  |                                                            |

Phases 2-5 can run in parallel after Phase 1 lands. Suggested order if
sequential: 1 → 2 → 3 → 4 → 5.

---

## Open decisions for the user

1. **`hub.alerts` admin gating.** The schema above gates reads behind a
   `hub.user_profile.is_admin` flag. That flag does not exist yet. Options:
   (a) add the flag now and seed Jeremy's user as admin, or (b) inline
   the admin check via a hardcoded user_id whitelist for now. Recommend
   (a). Flagged in `decisions.md` if executed without confirmation.

2. **Pre-push hook timeout.** `verify:fast` is ~15 s today. Once Phase 2
   E2E lands, `verify:fast` should still skip E2E (otherwise pushes
   take 5+ min). Confirm split is acceptable before Phase 2.

3. **Phase 2 scenario count.** 10 is a starter set. Adding 5 more
   covers the corner cases (offline mode, timer race conditions,
   wizard cancellation). Expand or stop at 10?
