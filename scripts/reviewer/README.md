# Reviewer gate — `scripts/reviewer/`

Pure-shell verification gate defined by `docs/VERIFY.md` §"Gate: Review".
Given a git SHA, it mechanically verifies that the commit's test claims hold.
No LLM; shell + POSIX + `jq` only.

Artifact: `.verify/review.json` (schema: `docs/VERIFY.md`).

## Invoke

```bash
pnpm verify:review <sha>              # canonical entry point
bash scripts/reviewer/review.sh <sha> # equivalent
```

Example:

```bash
pnpm verify:review 7667e39   # known-good — exits 0
pnpm verify:review HEAD      # verify the tip
```

## What it checks

Each check is recorded as an entry in `.verify/review.json`'s `checks[]`
array. Order of execution:

1. **`claims_tests_has_test_files`** — if the commit subject is `test(…)` or
   the body claims "added/new tests", the diff must contain at least one
   test file. Otherwise FAIL.
2. **`run:<test-file>`** (per-file) — for every test file added/modified in
   the commit, the reviewer checks out the commit into a throwaway `git
worktree`, runs that exact file via the appropriate runner (vitest for
   TS workspaces, pytest for `hardware/live-shelf/`, pgTAP for
   `supabase/tests/`), and parses the junit output. Non-test files in the
   diff are ignored here and caught by step 4.
3. **`claim_count_match`** — if the commit body contains an explicit "N/N
   pass", "N/N passing", "N tests pass", or "N passing" phrase, the summed
   PASS count across step-2 runs must equal N. If no such claim exists,
   this check is recorded as `ok: true` with "skipped" evidence.
4. **`impact_gate`** — runs `scripts/neighbors/impact.sh <sha>^ <sha>` in
   the worktree. Any failure there fails the reviewer.
5. **`mutation_contract_score`** — if `stryker.conf.json` + `reports/
mutation/mutation.json` both exist, every non-test file the commit
   touched that appears in the stryker `mutate` glob must have mutation
   coverage ≥ `thresholds.high` (default 60). Otherwise skipped.

### Worktree sharing

The reviewer creates a throwaway worktree at `.worktrees/review-<sha12>`
and symlinks `node_modules` + `hardware/live-shelf/.venv` from the main
checkout so vitest and pytest don't need to reinstall dependencies. The
worktree is torn down on exit (including on ctrl-c) via a `trap`.

### Count-claim parsing

The body is scanned for, in order:

1. `\d+/\d+ (pass|passing|tests pass|tests passing)` → take the denominator.
2. `\d+ (tests|tests pass|tests passing)` → take the leading integer.

First match wins. Case-insensitive where it matters. Implemented via
`grep -oE` so the script stays pure-shell.

## Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| 0    | pass                                          |
| 1    | at least one check failed                     |
| 2    | harness failure (bad SHA, worktree failed, …) |
| 4    | required tool missing (`jq`, `git`)           |

## Bypass

Include a `BYPASS-REASON: <why>` line in the commit body. When present,
the reviewer still runs every check but will not fail the commit on
`mutation_contract_score` (other checks — missing tests, count mismatch,
test failures, impact-gate fails — are load-bearing and never bypassed).

Also reachable via the PR-label `verify-bypass-review` per the policy in
`docs/VERIFY.md` §"Local bypass".

## Fixtures

- `tests/fixtures/make_bad_fixture.sh` — builds a synthetic known-bad commit
  at test-run-time. The commit adds a tautological vitest file to
  `packages/app-tools/src/__tests__/_meta_bad_fixture.test.ts` (2
  `expect(true).toBe(true)` tests) and claims "42/42 tests pass" in the
  body. The reviewer MUST flag `claim_count_match=false` and exit non-zero.
  Commit lives in the shared object DB; the worktree that created it is
  torn down immediately, so the fixture leaves no working-tree footprint.

### Add a new fixture

1. Record a real commit SHA (prefer a reproducible one from repo history).
2. Add a new `PASS`/`FAIL` block in `tests/test_review_meta.sh` invoking
   the reviewer against that SHA and asserting the expected verdict.
3. If the fixture must be synthetic (e.g. a specific failure mode that
   doesn't exist in real history), build it the way `make_bad_fixture.sh`
   does: a temporary worktree → commit via plumbing → return SHA on stdout
   → leave the commit object in the shared DB.

Note that synthetic fixtures leave loose objects in `.git/objects/`; `git
gc --prune=now` will reclaim them. If you want long-lived reproducible
fixtures, tag the fixture SHA.

## Meta-test

```bash
bash scripts/reviewer/tests/test_review_meta.sh
```

Replays both fixtures end-to-end:

- Known-good `7667e39` — should exit 0 and produce `ok: true`.
- Synthetic known-bad (built fresh each run) — should exit non-zero and
  produce `ok: false` with `claim_count_match: false`.

If either assertion fails, the meta-test exits non-zero and prints the
relevant slice of `.verify/review.json`.

## Files

- `review.sh` — the gate itself.
- `tests/test_review_meta.sh` — meta-test driver.
- `tests/fixtures/make_bad_fixture.sh` — builds the synthetic bad fixture.
