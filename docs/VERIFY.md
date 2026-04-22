# Verification contracts

Shared reference for the Phase-1 infrastructure agents. Each infrastructure
piece implements one of these contracts and must pass its own meta-tests.

The goal: no agent's "done" claim is trusted unless a mechanical gate
verifies it. Agents are lazy by default; this doc is how we prevent it.

## Exit codes (all gates)

- `0` = pass
- non-zero = fail with a human-readable message on stderr AND a structured
  JSON artifact at `./.verify/<gate>.json` describing what failed

## JSON artifact schema (shared)

```json
{
  "gate": "harness" | "review" | "impact" | "mutation" | "drift",
  "ok": boolean,
  "ran_at": "ISO-8601 timestamp",
  "duration_ms": number,
  "checks": [
    {
      "name": "check identifier",
      "ok": boolean,
      "evidence": "string — what was asserted, how it was verified"
    }
  ],
  "failures": [
    { "check": "string", "message": "human-readable", "detail": "optional" }
  ]
}
```

All gates write this artifact to `.verify/<gate>.json`. `.verify/` is
gitignored. Reviewer (`scripts/reviewer/`) reads these artifacts to make a
pass/fail decision.

## Gate: Harness (`scripts/harness/`)

Runs end-to-end scenarios that exercise **real Pi code + real cloud code +
real DB** over a loopback. Catches Pi↔Cloud boundary bugs.

### Invocation

- `pnpm harness` → runs all scenarios
- `pnpm harness <scenario-name>` → runs one

### Scenario contract

Each scenario lives in `scripts/harness/scenarios/<name>.py` and must:

1. **Setup** — use a clean local supabase (`supabase db reset`), spin up
   the Pi Flask app as a subprocess pointed at localhost edge-runtime,
   seed DB state inline (products, pairings, lots as needed).
2. **Act** — drive the Pi via direct Python calls (e.g.,
   `handle_scale_event(...)`) not simulated HTTP from outside. Then tick
   the outbox drainer synchronously. No polling loops, no `time.sleep(>
   0.5)` — use deterministic drainer-tick calls.
3. **Assert** — verify end state in cloud DB (rows, columns) AND on Pi
   disk (JPEG file existence, SQLite rows).
4. **Teardown** — stop Pi process; supabase stays running between
   scenarios to amortize startup cost.

### Required v1 scenarios

- `livetrack_heartbeat_state_machine` — three heartbeats across states;
  assert cloud `livetrack_import_sessions.scale_reading_g` updates every
  heartbeat, NOT just the first one. Pins the 2026-04-21 regression.
- `single_item_first_placement` — scale-03 paired to product with
  `net_weight_g > 0`, no existing stock; simulate refill add; assert
  cloud `stock_lots.qty_containers > 0` after drain. Pins the
  2026-04-22 regression.
- `catch_all_frames_captured` — catch-all event fires; assert
  `data/events/<id>/before.jpg` + `after.jpg` exist on Pi disk; cloud
  `shelf_event_log.pi_event_id` populated.
- `live_shelf_reunite` — in-flight lot + refill event with delta < pickup
  → lot exits in_flight, no new lot minted.
- `device_delete_propagates` — cloud soft-delete of a product; Pi
  poller tick; assert product gone from Pi local SQLite within one
  poll cycle.

### Meta-test

A `scripts/harness/tests/test_harness_meta.py` must include a
deliberately-failing scenario (`broken_sentinel`) and assert the harness
correctly reports FAIL on it (exit non-zero + artifact shows `ok: false`).
Otherwise the harness could silently report pass when scenarios don't
actually run.

### Non-goals

- Does NOT exercise firmware (`.ino`) — that's a separate gate.
- Does NOT validate prod behavior — local loopback only.
- Does NOT assert UX (banners, layout).

## Gate: Impact (`scripts/neighbors/impact.sh`)

Given a git diff, identify tests that could plausibly be affected and run
them. Prevents agents committing cross-cutting changes without touching
neighbor tests.

### Invocation

- `pnpm verify:impact [<base-ref>]` → runs related tests since base (defaults to `origin/main`)

### Behavior

1. For TS changes: `vitest run --related <files>` in each workspace.
2. For Python changes in `hardware/live-shelf/server/`: `pytest-testmon`.
3. For SQL changes under `supabase/migrations/` or `supabase/tests/`:
   run the full `supabase test db` (pgTAP is fast).
4. Aggregate results into the shared JSON artifact.

### Meta-test

Modify a known TS file in the test fixture; assert the impact gate
reports at least one related test. Modify a file with no tests; assert
the gate reports zero related AND exits 0 (no neighbors = no problem).

## Gate: Review (`scripts/reviewer/review.sh`)

Given a git SHA, verify that the commit's claims are substantiated. This
is a **shell script**, not an LLM agent — the LLM role is advisory
summary only.

### Invocation

- `pnpm verify:review <sha>` → verifies the commit's tests actually
  assert what they claim; runs them; parses output; compares to a
  structured manifest.

### Required checks

1. **Commit contains test changes.** If a commit claims "added tests"
   but no test files changed → FAIL.
2. **Tests actually run.** Execute every test file added/modified in the
   diff. Parse junit-format output. Compare pass count to manifest.
3. **Mutation coverage** (optional; runs if `scripts/mutation/` is
   configured). For each production file changed, run Stryker on it;
   assert at least N% of mutants killed. N defaults to 60.
4. **No neighbor-test regressions.** Invoke impact gate; if it reports
   any failures → FAIL.

### Output

Structured JSON at `.verify/review.json` with the shape above. Non-zero
exit on any FAIL check.

### Meta-test

`scripts/reviewer/tests/fixtures/` contains a known-good commit (should
pass) and a known-bad commit (tests claim to test X but actually only
assert `true === true` → mutation gate catches). Assert reviewer
returns correct verdict on both.

## Gate: Mutation (`scripts/mutation/`)

Off-the-shelf Stryker (TS) + mutmut (Python). Catches tautologies.

### Invocation

- `pnpm verify:mutation` → full run (slow, nightly)
- `pnpm verify:mutation --related <files>` → sampled mutations on
  specific files (PR-scale, fast)

### Configuration

- `stryker.conf.json` at repo root
- Target: contract files first (RPC handlers, MCP tool handlers, edge
  function handlers). Leaf utilities deprioritized.
- Thresholds: fail if `high < 60%` on contract files; warn otherwise.
- Sampling: 20 random mutants per file on PR; full run nightly.

### Meta-test

Two fixture files in `scripts/mutation/fixtures/`: one with a genuine
test of a real function (mutation should kill most mutants), one with a
tautological test (mutation should flag high survival). Assert mutation
gate produces correct scores.

## Gate: Drift (`scripts/drift/` + workflow)

Catches local-vs-prod migration drift.

### PR-level

A GitHub Action runs on every PR:

```
supabase db push --dry-run --include-all --linked
```

If the dry-run indicates migrations would apply to prod, the PR is
annotated (not blocked — sometimes migrations are intentional). If the
dry-run FAILS with "older local migration than remote" → FAIL the PR.

### Nightly

A scheduled workflow does a deeper check: compares normalized schema
AST between local (from `supabase db reset`) and prod (from
`supabase db dump --schema-only --linked`). Opens a GitHub issue on
any material DDL divergence.

### Meta-test

A fixture migration in a sandbox supabase project: apply locally,
skip remotely, assert the PR gate flags the drift.

## Reviewer escalation

If `scripts/reviewer/review.sh` returns FAIL three times on the same
commit (agent retries didn't converge), open a GitHub issue tagged
`needs-human-triage`. Do not retry automation forever.

## Local bypass

For genuine hotfixes where a gate is blocking legitimate work, PR label
`verify-bypass-<gate-name>` skips that gate with an audit log entry
(commit message must include `BYPASS-REASON: <why>`). Do not make
bypass casual.

## Test-first principle

When an agent fixes a bug, tests MUST be written that:

1. **Fail against pre-fix code** (prove the bug existed).
2. **Pass against post-fix code** (prove it's fixed).

Evidence in the commit body: "Verified tests fail on <pre-sha>, pass on
<post-sha>." Reviewer checks this evidence exists.

## Non-goals of verification infrastructure

- UX/aesthetic review — stays physical.
- Hardware-level firmware behavior (load cells, noise, thermal) — stays
  physical.
- Exploratory/one-off manual testing by user — stays physical.

Automation targets functional correctness of the code path, not
product judgment.
