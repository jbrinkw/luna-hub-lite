# IMPLEMENTATION_AUDIT_A

## Scope / Inputs actually available

- Requested files `/home/jeremy/luna-hub-lite/FINAL_PLAN.md` and `/home/jeremy/luna-hub-lite/SOLUTION_AUDIT.md` are not present in this checkout (`No such file or directory` when read attempts were made).
- Audit executed against the 5 specified commits and current repository sources.

## D1. Carve-out legitimacy (excluded event_kinds)

Reference carve-out insertion: `supabase/migrations/20260429340000_apply_shelf_event_strict.sql:115-119` (excluded set) and comments at `:29-34`.

### 1) `in_flight_pickup`

- What Pi sends: payload contract requires `product_id` (`hardware/live-shelf/server/cloud/payload_contracts.py:69-77`, validator `:264-269`). Producer path drops emit if `product_id` missing (`hardware/live-shelf/server/cloud/integration.py:529-538`) and includes `product_id` in payload (`:552-557`).
- Phantom `product_id` at apply time: function inserts log row first (`supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql:477-493`), then in `in_flight_*` branch returns `applied=false, reason='product not found'` (`:512-523`).
- Cloud outcome: edge treats unexpected `applied=false` as error 422 (`supabase/functions/shelf-ingest/index.ts:846-866`), not success.
- Verdict: **laziness loophole**. `product_id` is required; phantom IDs are not a legitimate “product_id not required” case.

### 2) `in_flight_return`

- What Pi sends: payload contract requires `product_id` (`hardware/live-shelf/server/cloud/payload_contracts.py:80-88`, validator `:277-282`). Dedicated marker emitter returns `None` if missing (`hardware/live-shelf/server/cloud/integration.py:748-779`) and sends `product_id` (`:780-785`).
- Phantom `product_id` at apply time: same `in_flight_*` check as pickup (`supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql:512-523`) => `applied=false 'product not found'`.
- Cloud outcome: 422 for unexpected `applied=false` (`supabase/functions/shelf-ingest/index.ts:853-866`).
- Verdict: **laziness loophole** for phantom-product path. (There _is_ a legitimate no-lot no-op, but that is `product exists + no in_flight lot`, not phantom product; see `:604-612`.)

### 3) `catch_all_first_measurement`

- What Pi sends: payload contract requires `product_id` (`hardware/live-shelf/server/cloud/payload_contracts.py:102-110`, validator `:294-301`). Emitter drops if missing (`hardware/live-shelf/server/cloud/integration.py:822-823`) and includes `product_id` (`:829-833`).
- Phantom `product_id` at apply time: branch reads product net weight and if missing returns `applied=false 'product missing net_weight_g'` (`supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql:652-661`) after log row already inserted (`:477-493`).
- Cloud outcome: unexpected `applied=false` converted to 422 (`supabase/functions/shelf-ingest/index.ts:853-866`).
- Verdict: **laziness loophole**. `product_id` is required and phantom ID does not “genuinely process correctly”.

### 4) `catch_all_second_measurement`

- What Pi sends: payload contract requires `product_id` (`hardware/live-shelf/server/cloud/payload_contracts.py:112-120`, validator `:304-311`). Emitter drops if missing (`hardware/live-shelf/server/cloud/integration.py:868-869`) and includes `product_id` (`:875-879`).
- Phantom `product_id` at apply time: same product lookup/net-weight gate returns `applied=false 'product missing net_weight_g'` (`supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql:763-775`) after insert (`:477-493`).
- Cloud outcome: 422 via unexpected `applied=false` guard (`supabase/functions/shelf-ingest/index.ts:853-866`).
- Verdict: **laziness loophole**.

### 5) `discarded`

- What Pi sends: payload contract requires `product_id` (`hardware/live-shelf/server/cloud/payload_contracts.py:91-99`, validator `:284-289`). Emitter drops if missing (`hardware/live-shelf/server/cloud/integration.py:725-726`) and includes `product_id` (`:727-732`).
- Phantom `product_id` at apply time: branch explicitly returns `applied=false 'product not found'` (`supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql:850-861`) after insert (`:477-493`).
- This is also codified in pgTAP as expected behavior (`supabase/tests/chefbyte/shelf_event_discarded.test.sql:259-280`).
- Verdict: **laziness loophole**. The migration comment claims discarded unknown products are a valid soft no-op (`supabase/migrations/20260429340000_apply_shelf_event_strict.sql:33-34`), but implementation/tests contradict that.

## D2. Edge-function translation defeat

### 1) RPC failure path behavior

- `handleEvent` returns HTTP 500 on RPC `error` (`supabase/functions/shelf-ingest/index.ts:826-837`), not HTTP 200 + `applied=false`.

### 2) When `private.apply_shelf_event` raises `23503`

- Strict migration raises `23503` for unknown product in covered kinds (`supabase/migrations/20260429340000_apply_shelf_event_strict.sql:120-127`).
- Edge function handles RPC errors in the `if (error)` branch and returns 500 with machine-readable `code` (`supabase/functions/shelf-ingest/index.ts:826-837`).
- Verdict: **verified non-200 error propagation** for raises.

### 3) Allowlist exactness

- `EXPECTED_NOT_APPLIED_REASONS` in edge function is exactly `new Set(['duplicate', 'stale: manual edit is newer'])` (`supabase/functions/shelf-ingest/index.ts:851`). No extra reasons in that set.
- Unexpected `applied=false` returns 422 + `APPLIED_FALSE_UNEXPECTED` (`:853-866`).

Status: **verified (not compromised)**.

## D3. HTTP contract test reality

### 1) Test added in `3a17ddb`

- Added explicit contract test at `apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts:1755-1800`.
- Also updated earlier cross-user case from 200/applied=false to 5xx + non-success body at `:433-439`.

### 2) Does it post to real edge URL?

- Yes. `BASE_URL` is `SUPABASE_URL/functions/v1/shelf-ingest` (`apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts:14`), and test calls `fetch(`${BASE_URL}/event`, ...)` (`:1774-1786`).

### 3) Assertion shape

- Asserts status `>=400` and `<600` (`:1788-1790`), then asserts `body.error` exists (`:1797-1799`).
- It is **not** asserting `body.applied === false`.

### 4) Isolation run result

- Command run:
  - `cd apps/web && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/edge-functions/shelf-ingest.test.ts -t "phantom product_id"`
- Result: suite setup failed before test execution because local Supabase endpoint is unreachable in this sandbox (`connect EPERM 127.0.0.1:54321` from test setup user creation), so tests were skipped after `beforeAll` failure.
- Therefore: test is **real HTTP**, but **not executable here against live local stack** due environment network restriction.

## D4. Per-commit NEGATIVE-TWIN-PROOF verification

### `bcaa3d5`

- Block present in commit message (`git log -1 bcaa3d5` lines 20-25).
- Attempted experiment:
  - In disposable clone `/tmp/luna-audit-af`, removed strict migration + strict pgTAP files, ran `pnpm test:db`.
- Outcome:
  - Could not verify claimed test failures because `supabase test db` cannot reach local Postgres in this sandbox (`dial tcp 127.0.0.1:54322: operation not permitted`).

### `d49f14e`

- No `NEGATIVE-TWIN-PROOF` block in commit message (`git log -1 d49f14e` lines 1-6 only).
- Flag: **absent**.

### `3a17ddb`

- No `NEGATIVE-TWIN-PROOF` block in commit message (`git log -1 3a17ddb` lines 1-11 only).
- Flag: **absent**.

### `c8856c6`

- Block present in commit message (`git log -1 c8856c6` lines 17-21).
- Attempted experiment:
  - In disposable clone, restored `apply_event_override.test.sql` from pre-commit state and ran `pnpm test:db`.
- Outcome:
  - Same environment blocker: local Postgres connection denied (`127.0.0.1:54322 operation not permitted`), so named proof test could not be executed.

### `df9be48`

- Block present in commit message (`git log -1 df9be48` lines 24-31).
- Named command in message (`.venv/bin/pytest ...`) is not runnable here because `.venv/bin/pytest` is missing.
- Executed equivalent direct harness (without pytest dependency) in disposable clone:
  - **HEAD behavior** (df9 code): unexpected `applied=false` response dead-letters row (`sent_at_is_none=True`, `failed_permanently=1`, `last_error` prefixed `DEAD_LETTER`).
  - **Reverted behavior** (`git checkout df9be48^ -- worker.py`): same input gets silently acked (`sent_at_is_none=False`, `failed_permanently=0`, `last_error=None`).
- Verdict: **negative-twin claim substantiated functionally**, though not via the exact named pytest command.

## D5. `--no-verify` usage report

- Ran `git log -1 <commit> --pretty=format:'%B'` for all five A+F commits (`bcaa3d5`, `d49f14e`, `3a17ddb`, `c8856c6`, `df9be48`) and grepped for `--no-verify`.
- Result: **no `--no-verify` reference in any of those commit messages**.
- Also checked `2ddfb7d` message similarly; no literal `--no-verify` string there either.
- Note: commit messages are not authoritative proof of CLI flags used at commit time; this check only confirms absence of message-level references.

## Confidence

- **D1/D2/D3 code-path reality:** High (line-level evidence in migration/function/tests).
- **D3 runtime pass/fail on live local stack:** Low-to-medium due sandbox blocking localhost Supabase connectivity.
- **D4 proof execution:**
  - `df9be48`: Medium-high (direct behavioral harness reproduced twin effect).
  - `bcaa3d5` and `c8856c6`: Low for runtime proof due blocked DB test environment.
- **D5 message scan:** High for “no message references”.
