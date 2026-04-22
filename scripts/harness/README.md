# Pi↔Cloud Contract Harness

End-to-end scenario runner that drives **real Pi Python code** against a
**real local Supabase stack** to catch Pi↔Cloud boundary bugs that a
mock-based unit test won't.

Contract spec: [`docs/VERIFY.md` §"Gate: Harness"](../../docs/VERIFY.md).

## Quick start

```bash
# 0. Supabase must be running locally (stays up between runs to amortize
#    the 30-60s startup cost). Run once in its own terminal:
supabase start

# 1. Run every scenario
pnpm harness

# 2. Run one scenario by name
pnpm harness livetrack_heartbeat_state_machine

# 3. List registered scenarios
python3 scripts/harness/run.py --list
```

Exit codes:

- `0` — every scenario passed.
- `1` — at least one scenario failed. `.verify/harness.json` has the
  per-check evidence (schema: `docs/VERIFY.md §"JSON artifact schema"`).
- `2` — configuration error (no scenarios, unknown name, supabase
  unreachable, etc.) — stderr message explains.

## Architecture

```
pnpm harness <name>
     │
     ▼
scripts/harness/run.py           entrypoint + CLI + artifact writer
     │
     ▼
scripts/harness/orchestrator.py  HarnessContext factory + healthcheck
     │                           + @scenario decorator + registry
     ▼
scripts/harness/scenarios/*.py   one file per scenario
```

### `orchestrator.py`

- Resolves `hardware/live-shelf/server/` onto `sys.path` so scenarios
  can import `from server.cloud.client import CloudClient` etc.
- `ensure_supabase_running()` — HTTP probe + postgres TCP probe, fails
  fast with an actionable message if `supabase start` isn't up.
- `HarnessContext` — per-scenario handle exposing:
  - `db`: psycopg2 service-role connection (autocommit, RLS-bypassed).
  - `seed_cloud_user / seed_device / seed_product / seed_pairing /
seed_stock_lot / seed_livetrack_session` — inline-SQL seeders.
    Each scenario gets its own user (unique email per run) so multiple
    scenarios can share the stack without contamination.
  - `pi_sqlite`, `pi_cloud_client`, `pi_emitter`, `pi_worker`,
    `pi_livetrack_poller`, `pi_product_sync_poller` — lazy factories
    that build Pi-side objects wired to the local edge function.
  - `build_pi_scale_handler(...)` — `ScaleHandler` wired to the above.
  - `check(name, ok, evidence)` — records assertion; `ok=False` raises
    `ScenarioFailure` which `run.py` converts to a `failures[]` entry
    and marks the scenario failed.
  - `teardown()` — `DELETE FROM auth.users WHERE id = user_id` cascades
    all seeded state; closes SQLite + pg connections. Run from
    `run.py` in a `finally` block so a crash mid-scenario still cleans
    up.

### `run.py`

- Discovers scenarios by importing every non-dunder `.py` under
  `scenarios/`. Modules self-register via `@scenario("name")`.
- Runs scenarios serially (real DB, real local edge runtime — parallel
  runs would require per-scenario postgres schemas, out of scope for
  MVP).
- Writes `.verify/harness.json` via the shared schema. `.verify/` is
  gitignored. Override via `HARNESS_VERIFY_DIR` env var (used by the
  meta-tests so they don't stomp the dev checkout's artifact).
- Auto-re-execs under `hardware/live-shelf/.venv/bin/python3` when the
  system `python3` lacks `psycopg2` — makes `pnpm harness` work out of
  the box on a machine that has the Pi venv set up.

## Determinism — no sleeps, no polling loops

Per `docs/VERIFY.md §"Scenario contract"` #2:

> Drive the Pi via direct Python calls (e.g., `handle_scale_event(...)`)
> not simulated HTTP from outside. Then tick the outbox drainer
> synchronously. No polling loops, no `time.sleep(> 0.5)` — use
> deterministic drainer-tick calls.

How we honor that:

- Scenarios call `handler.handle_scale_event(payload)` or
  `handler.handle_heartbeat(payload)` as a direct Python call. No
  subprocess HTTP round trips from test → Pi.
- The Pi's `CloudClient` inside those calls DOES hit the real cloud
  edge function over `http://127.0.0.1:54321/functions/v1/...` — that's
  the load-bearing round trip the harness exists to test.
- After producing outbox rows, scenarios call `ctx.pi_worker.tick()`
  **once** to drain. `CloudWorker.tick()` is a pre-existing public
  method (see `hardware/live-shelf/server/cloud/worker.py`); the
  background thread never runs in harness mode.
- The `ProductSyncPoller` exposes `tick_once()` for the same reason —
  used by `device_delete_propagates`.
- `LiveTrackPoller` is replaced by a `_MutablePoller` stub in
  `livetrack_heartbeat_state_machine`; the scenario advances its
  snapshot manually to simulate cloud Realtime transitions landing.

## Scenarios

| name                                | pins                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `livetrack_heartbeat_state_machine` | 2026-04-21 heartbeat guard bug (commit `a375b9d`) — Pi must keep posting `scale_reading_g` across the `waiting_scale → scale_reading_received` transition, not freeze after the first post. Verified pre-fix: fails on the first heartbeat's cloud-side weight check (baseline gate + state guard combined). Verified post-fix: every heartbeat updates the cloud row. |
| `single_item_first_placement`       | 2026-04-22 refill-to-empty-product bug (commit `0d23dbc`) — cloud must mint a new `stock_lots` row (or revive an empty one) when a paired `live_scale` refills from zero.                                                                                                                                                                                              |
| `catch_all_frames_captured`         | Catch-all events must write `before.jpg` + `after.jpg` to `events/<event_id>/` on the Pi's disk inline, since catch-all has no session-capture pipeline to fill them otherwise. Asserts both files exist + the Pi's local `scale_events` row records the event.                                                                                                        |
| `live_shelf_reunite`                | `in_flight_return` must clear `stock_lots.in_flight_since` on the matching lot, NOT mint a new lot, NOT decrement `qty_containers`. Migration `20260425080000_shelf_event_in_flight_pickup.sql`.                                                                                                                                                                       |
| `device_delete_propagates`          | Cloud soft-delete of a product (`UPDATE products SET deleted_at = now()`) must tombstone the row on the Pi within one `ProductSyncPoller.tick_once()`. Relies on the `products_set_updated_at` trigger to include the tombstone in the delta query.                                                                                                                    |

Sentinel scenarios (NOT run by default — only via explicit
`--scenario <name>`):

| name               | purpose                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broken_sentinel`  | Deliberately fails. Meta-test uses it to prove the harness detects + reports failure correctly (exit non-zero + artifact ok=false).                               |
| `passing_sentinel` | Trivially passes. Meta-test uses it to prove the happy path: exit 0 + artifact ok=true. Without both legs, a broken harness could satisfy one and fake the other. |

## Adding a scenario

1. Create `scripts/harness/scenarios/<your_scenario>.py`.
2. Import the registrar + orchestrator:

   ```python
   from scripts.harness.orchestrator import HarnessContext, scenario

   @scenario("your_scenario")
   def _your_scenario(ctx: HarnessContext) -> None:
       ctx.seed_cloud_user()
       ctx.seed_device()
       product_id = ctx.seed_product(name="...", net_weight_g=...)

       # Drive the Pi
       handler = ctx.build_pi_scale_handler(catch_all_enabled=True)
       resp, status = handler.handle_scale_event({...})
       ctx.check("pi_accepted", status == 200, evidence=f"status={status}")

       # Drain outbox
       ctx.pi_worker.tick()

       # Assert cloud state
       row = ctx.q_one("SELECT ... FROM chefbyte.stock_lots WHERE ...", (...,))
       ctx.check("cloud_row_present", row is not None, evidence=f"got {row!r}")
   ```

3. Name it deterministically — `run.py --list` shows every registered
   scenario; if the name is in the list it's runnable.
4. Fresh user per scenario: always start with `ctx.seed_cloud_user()`.
   The unique-email generator in `HarnessContext` stops scenarios from
   stepping on each other.
5. `ctx.teardown()` runs automatically (in `run.py`'s `finally`); the
   seeded user's `auth.users` row cascade-deletes everything this
   scenario wrote.
6. Use `ctx.check(name, ok, evidence)` for every assertion. The
   evidence string lands in `.verify/harness.json` so a failing CI run
   is self-describing.

## Running the meta-tests

The meta-tests prove the harness itself detects both failure and
success. They run as regular pytest:

```bash
pytest scripts/harness/tests/ -v
```

They subprocess `run.py --scenario broken_sentinel` and assert
exit-nonzero + `ok: false` in the artifact. Then the passing-sentinel
leg for exit-zero + `ok: true`. Neither leg alone is sufficient — see
`broken_sentinel.py` + `passing_sentinel.py` comments for why.

Meta-tests pass `--skip-supabase-check` + point
`HARNESS_VERIFY_DIR` at a tmp path so they don't require a live
Supabase stack and don't collide with the dev checkout's
`.verify/` folder.

## Troubleshooting

**"cannot connect to local postgres at postgresql://..."**  
Run `supabase start` from the repo root. The harness doesn't start
Supabase itself — the 30-60s startup cost is amortized across runs.

**"edge function at http://127.0.0.1:54321/... returned 500"**  
Likely a migration drift: the local DB schema doesn't match what the
edge function expects. Run `supabase db reset` to reapply all
migrations.

**Scenario fails on `cloud_after_heartbeat_N_weight_X` with row=None**  
The Pi's `CloudClient.post_livetrack_session_update` hit the edge
function but the patched fields were not in the allow-list (see
`supabase/functions/livetrack-session/index.ts::ALLOWED_PI_FIELDS`)
or the session is in `closed`/`expired` state. Inspect the session
row:

```sql
SELECT * FROM chefbyte.livetrack_import_sessions WHERE session_id = '...';
```

**"duplicate scenario name"**  
Two files under `scenarios/` used the same `@scenario("name")` string.
Rename one — the registry uses the string as its primary key.

**Meta-test subprocess timeout**  
`run.py` has no wall-clock timeout itself. A hung scenario (e.g.
blocking on the cloud) pinned pytest's 60s fallback. Check for a
`requests` call without `timeout=`. `CloudClient` enforces 10s by
default.

## What this gate does NOT do

From `docs/VERIFY.md §"Non-goals"`:

- Does NOT exercise firmware (`.ino`) — separate gate.
- Does NOT validate prod behavior — local loopback only.
- Does NOT assert UX (banners, layout).

Also not covered:

- Concurrent scenario execution. Single postgres DB, single SQLite;
  two scenarios running in parallel would race on `auth.users` seed
  emails if name-generation collided.
- Chaos testing (network partition, edge function 5xx bursts) — the
  Pi's backoff behavior is covered by the Pi-side unit tests in
  `hardware/live-shelf/server/cloud/tests/`.
