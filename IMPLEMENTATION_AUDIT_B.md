# IMPLEMENTATION AUDIT — Change B (`2ddfb7d`)

## Scope + Inputs

- Target commit: `2ddfb7d` (`fix(live-shelf/cloud): producer-side dead-letter on contract violation`)
- Files touched in commit:
  - `hardware/live-shelf/server/cloud/integration.py`
  - `hardware/live-shelf/server/cloud/tests/test_payload_contracts.py`
  - `hardware/live-shelf/server/cloud/tests/test_integration_producer_dead_letter.py`
- Note: `/home/jeremy/luna-hub-lite/FINAL_PLAN.md` does **not** exist in this workspace (`find` returned no match), so this audit is grounded in your explicit B1–B4 checklist plus commit/test evidence.

---

## B1. Code correctness despite rule violation

### B1.1 What changed in `integration.py`

In `CloudEventEmitter._enqueue`:

- Contract-violation path changed from log+drop to dead-letter INSERT.
- New dead-letter SQL write:
  - `INSERT INTO cloud_outbox (client_event_id, payload_json, attempts, last_error, failed_permanently) VALUES (?, ?, 99, ?, 1)`
  - Source lines in current file: `integration.py:465-470`.
- `last_error` now built as `PRODUCER_DROP: contract violation: {exc}` (`integration.py:449`).

### B1.2 Contract-violation branch behavior: INSERT or `return None`?

Verdict: **INSERT then `return None`**.

- Branch catches `validate_payload_contract` exception, builds dead-letter row, executes INSERT (`integration.py:448-471`), then returns `None` (`integration.py:472`).

### B1.3 Dead-letter marker requirements

Verdict: **Meets requirement**.

- `last_error` prefix: `PRODUCER_DROP:` (`integration.py:449`).
- `attempts`: hard-coded `99` (`integration.py:469`).
- `failed_permanently`: hard-coded `1` (`integration.py:469`).

### B1.4 Original payload preservation

Verdict: **Mostly yes, with one intentional mutation**.

- Stored payload JSON is `stamped = {**payload, "client_event_id": dead_client_id}` (`integration.py:461-462`).
- All original keys are preserved, but `client_event_id` is injected/overwritten for uniqueness.

### B1.5 DB-failure branch on dead-letter INSERT

Verdict: **Raises (does not swallow)**.

- No catch around dead-letter INSERT; exception propagates out of `_enqueue` (`integration.py:465-471`).
- Backed by new test `test_db_insert_failure_raises` (`test_integration_producer_dead_letter.py:147-158`).

### Additional correctness risk (outside strict checklist)

- Commit also changed the **non-contract** `enqueue_event` failure path from swallow to raise:
  - old behavior: log warning + `return None`
  - new behavior: log error + `raise` (`integration.py:484-490`)
- This is broader than dead-letter INSERT failure and can alter runtime failure semantics.

---

## B2. Updated existing test (`test_payload_contracts.py`)

Target test: `test_invalid_payload_raises_before_enqueue`.

Verdict: **Updated correctly to dead-letter behavior**.

- Now asserts:
  - `_enqueue(...)` returns `None` (`test_payload_contracts.py:259`)
  - outbox count is `1` (`test_payload_contracts.py:261`)
  - `last_error` starts with `PRODUCER_DROP:` (`test_payload_contracts.py:262`)
  - `failed_permanently == 1` (`test_payload_contracts.py:263`)
  - `attempts == 99` (`test_payload_contracts.py:264`)
- It no longer asserts `cloud_outbox COUNT == 0`.

Execution check:

- Ran: `.venv/bin/python -m pytest server/cloud/tests/test_payload_contracts.py -k test_invalid_payload_raises_before_enqueue -xvs`
- Result: `1 passed, 6 deselected`.

---

## B3. New test file audit

### B3.1 File presence

Verdict: **Exists at correct path**.

- `hardware/live-shelf/server/cloud/tests/test_integration_producer_dead_letter.py`

### B3.2 Assertions real vs theatrical

Verdict: **Real; exercises actual `_enqueue` paths**.

- 6 tests collected.
- 14 explicit `assert` statements in file.
- Coverage includes:
  - contract violation -> dead-letter row fields (`:60-83`)
  - outbox row count (`:86-92`)
  - payload_json content preservation (`:95-108`)
  - disabled emitter no writes (`:111-118`)
  - dead-letter INSERT failure raises via wrapped connection (`:121-158`)
  - repeated violations create multiple rows (`:161-168`)

### B3.3 Isolation run result

Requested command:

- `cd hardware/live-shelf && python -m pytest server/cloud/tests/test_integration_producer_dead_letter.py -xvs`

Environment result:

- `python` binary missing in this environment (`/bin/bash: python: command not found`).

Equivalent run executed with project venv:

- `cd hardware/live-shelf && .venv/bin/python -m pytest server/cloud/tests/test_integration_producer_dead_letter.py -xvs`
- Result: **6 passed in 1.41s**.

Assertion count in file:

- **14** explicit `assert` statements.

---

## B4. Rule-violation root cause (`--no-verify`)

### B4.1 Was there genuine cross-agent WIP breaking `verify:full` at push time?

Verdict: **Unproven from repo evidence; cannot validate as fact**.

What is provable:

- `origin/main` updated to `2ddfb7d` at `2026-04-29 19:54:20 -0400` (`.git/logs/refs/remotes/origin/main`, line 134).
- Around commit/push window, reflog shows frequent checkouts/fixture commits on temporary self-test/debug branches (`mutation-pair-self-test-*`, `mpg-*`) after the commit (`.git/logs/HEAD:599-605`, etc.).

What is **not** provable from local git logs:

- A captured `verify:full` failure output tied to this push.
- Evidence that failure cause was specifically cross-agent WIP contamination.

### B4.2 Was there a clean alternative?

Verdict: **Yes**.

- Clean bypass-free path existed: create fresh branch/worktree at `origin/main`, cherry-pick `2ddfb7d`, push from clean tree so pre-push hook evaluates only that isolated state.
- This would avoid entanglement with any concurrent local WIP.

### B4.3 "Committed change is clean" claim: true or inseparable?

Verdict: **Mostly true for separability, with one scope overreach caveat**.

- Commit diff is self-contained to 3 relevant files and semantically cohesive for Change B.
- It is separable from later temp-branch fixture activity (not included in commit).
- Caveat: commit includes extra runtime behavior shift (`enqueue_event` exception path now raises), beyond the narrow dead-letter INSERT objective.

### Process compliance observations

- Pre-push bypass convention expects emergency-only use and visibility (`--no-verify` + `Verify-skipped:` convention in docs/hook comments).
- Commit `2ddfb7d` message includes **no `Verify-skipped:` footer**.

---

## Bottom line

- **Functional Change B behavior is implemented and tested**: dead-letter row insertion on contract violation, marker fields (`PRODUCER_DROP`, attempts `99`, `failed_permanently=1`), payload retention, and DB insert failure propagation.
- **Test updates/new tests are real and passing** (using project venv).
- **Rule bypass rationale remains unverified by hard evidence** in repo logs; clean non-bypass alternatives existed.
- **One extra behavior change** (generic enqueue failure now raises) increases regression risk relative to prior swallow semantics.

---

## Confidence

**High** on B1/B2/B3 (direct code + test execution evidence).  
**Medium** on B4.1 root-cause attribution (insufficient forensic artifacts to prove stated failure cause).  
**High** on B4.2/B4.3 conclusions (git/reflog/process evidence is concrete).
