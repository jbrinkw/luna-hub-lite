# Implementation Audit E — mutation_pair_gate

Auditor: Claude Sonnet 4.6 (subagent, read-only)
Date: 2026-04-29
Commits audited: `004b69b`, `703d567`, `c7d6e31`, `d9c86c5`, `b66c2e5`, `442a6c2`

---

## E1 — Does the gate work end-to-end?

**Verdict: Mostly yes, with one structural gap and one design-level weakness.**

### What the gate does

For each `(test, prod)` pair discovered in the PR diff, the gate:

1. Identifies changed test files and changed production files via `git diff --name-only "$BASE_REF...HEAD"` (three-dot, line 98).
2. Pairs them via path-mirror (filename heuristic) and import scan (grep for relative imports, line 172–187).
3. Routes the prod file to a Stryker config via `config_for_prod_file`.
4. Writes a temp Stryker config overriding `mutate` and `testFiles` to a single-file pair.
5. Runs Stryker; counts killed mutants from the JSON report.
6. Fails (`exit 1`) if killed == 0. Fails (`exit 3`) if Stryker times out. Passes (`exit 0`) if killed ≥ 1.

### Tautological test scenario

A test that only calls `expect(gradeA).toBeDefined()` and `expect(typeof gradeA).toBe('function')`:

- Stryker mutates the function body (boundary operators, return values, removed returns).
- None of those mutations change `typeof gradeA` or whether it's defined.
- All mutants survive → `killed = 0` → gate exits 1. **CORRECTLY CAUGHT.**

### Real test scenario

A test that calls `gradeA(0)`, `gradeA(59)`, `gradeA(60)`, `gradeA(90)` with `.toBe()` assertions on specific strings:

- Mutants like `< 60` → `<= 60` or `return 'fail'` → `return 'pass'` cause test failures.
- At least one mutant killed → gate exits 0. **CORRECTLY PASSES.**

### "Tests added, no production code changed" scenario

When `CHANGED_PROD` is empty and `CHANGED_TESTS` is non-empty, `NUM_PAIRS` is 0. The gate exits 0 with `mode: 'no-pairs'` and `reason: 'test-only-no-prod-partner'`. A warning is emitted. **This is a WARNING, not a FAILURE.** This is the correct behavior: the gate cannot infer the pairing and cannot run Stryker without a prod file. No suppression of the check occurs.

### Self-test

`scripts/verify/tests/mutation_pair_gate_self_test.sh` (401 lines) has two phases:

**Phase 1 (direct Stryker, no git):** Creates fixture files, writes Stryker configs, runs Stryker directly, asserts killed counts. This runs end-to-end Stryker and verifies the fixture itself is tautological or rigorous. **This is a real experiment, not theater.**

**Phase 2 (full gate path via git diff):** Creates temp branches with git commits, runs the gate with `--base BASE_BRANCH`. Captures gate exit code via `|| GATE_EXIT_A=$?` under `set -uo pipefail`. With pipefail active, the pipeline exit propagates from the gate through grep correctly — `GATE_EXIT_A` receives the gate's non-zero exit when the gate fails. The logic is correct.

**The self-test was NOT run as part of this audit** (read-only constraint; Stryker run takes minutes). The code structure shows it exercises the actual failure path.

### Design-level weakness (not a bug)

The gate threshold is "≥1 mutant killed," not "all mutants killed." A test calling `gradeA(0)` with `.toBe('fail')` kills the "remove return" mutant but survives boundary mutations (`< 60` → `<= 60`). The gate would PASS this weak test. This is a deliberate design choice for "anti-laziness minimum" not "coverage completeness." It will not catch tests that only cover one branch.

**Lazy test patterns the gate misses:**

- Test exercises one function call, asserts the result, kills ≥1 mutant → gate passes even if 8 of 10 mutants survive.
- Test mocks the module under test entirely (jest.mock / vi.mock) — Stryker mutates the real module but the mock intercepts all calls → killed = 0 → CAUGHT.

### Self-test fragility

Phase 2 stashes with `--include-untracked` after Phase 1 fixtures are written. If stash fails (e.g., a stash already on the stack with same content), `git stash pop` at line 384 under `set -uo pipefail` would abort the script without cleaning up temp branches. Not a gate correctness issue, but a self-test reliability issue.

---

## E2 — testFile scoping in `b66c2e5`

**Verdict: Correctly implemented. Variable expansion is sound.**

### Tracing the variable expansion

In `run_pair` (line 310):

```bash
local test_f="$2"
```

The heredoc invocation at line 341:

```bash
node --input-type=module - <<NODE "$cfg" "$prod_f" "$pair_report_path" "$temp_cfg" "$temp_dir" "$test_f"
```

In bash, arguments listed after the heredoc marker (`<<NODE`) are command arguments to `node`, not part of the heredoc body. The shell expands `"$test_f"` **before** passing it to node. This was verified experimentally: `node --input-type=module - <<MARKER "hello" "world"` correctly delivers `['hello', 'world']` in `process.argv.slice(2)`.

The Node.js code inside the heredoc reads:

```js
const [cfgPath, prodFile, reportPath, outPath, tmpDir, testFile] = process.argv.slice(2);
```

`testFile` at `process.argv[7]` receives the shell-expanded value of `test_f`. The resulting merged config contains:

```json
"testFiles": ["apps/web/src/__tests__/unit/hub/Foo.test.tsx"]
```

### Does `testFiles` actually limit Vitest to one test?

`testFiles` is a documented Stryker-level option (confirmed in schema at `node_modules/@stryker-mutator/core/schema/stryker-schema.json`): _"limit which test files are executed during mutation testing."_ It applies independently of the test runner configuration. The web-components config has `vitest.related: false` which could conflict, but `b66c2e5` line 361 deletes it from the merged config:

```js
if (merged.vitest) delete merged.vitest.related;
```

This defensive deletion is correct. Without it, `vitest.related: false` would override `testFiles`. With the deletion, Stryker uses `testFiles` to scope to exactly one test file per pair. **This is correct.**

### Path resolution

`test_f` is a repo-relative path from `git diff` (e.g., `apps/web/src/__tests__/unit/hub/Foo.test.tsx`). The temp Stryker config is written to `$REPO_ROOT/.verify/`. Stryker resolves `testFiles` globs relative to its working directory, which is `$REPO_ROOT` (set at line 34: `cd "$REPO_ROOT"`). Resolution is correct.

---

## E3 — OOM fix in `442a6c2`

**Verdict: Partially correct diagnosis. Correct fix directionally, but the root cause was already mitigated by `b66c2e5` (testFiles scoping). The 8GB heap bump is secondary defense with a latent accumulation risk.**

### Root cause analysis

The OOM claim in the commit: "components config uses coverageAnalysis:off which runs every test for every mutant; React Testing Library + jsdom + 76+ mutants exhausts the default 2GB heap."

The diagnosis is accurate **for the state before `b66c2e5`**. Before testFiles scoping, Stryker with `coverageAnalysis: off` would run the entire web vitest suite (131+ tests, jsdom, RTL) for every mutant. At 76 mutants, that is 76 × full-suite executions in one Stryker process, which plausibly exhausts 2GB.

After `b66c2e5` (committed before `442a6c2`), `testFiles` restricts each pair run to one test file. This fundamentally reduces the load: 76 mutants × 1 test file rather than 76 × 131 tests. The OOM risk is dramatically reduced.

**Confirmed:** `stryker.web-components.conf.json` line 25:

```json
"coverageAnalysis": "off",
```

The diagnosis is correct. `coverageAnalysis: off` does cause full-suite execution per mutant. But by the time `442a6c2` was committed, `b66c2e5` had already scoped testFiles to one file, which is the correct mitigation.

### Is 8GB enough?

With testFiles scoped to one test file, the question is: does a single jsdom+RTL test file leak enough memory across 76 mutants to exhaust 8GB? The answer depends heavily on the test file. For a typical 5-15 test file with RTL renders, each mutant run consumes ~50-200MB at peak (jsdom heap, component tree, mocks). At `concurrency: 1` (set in web-components config, line 29), only one mutant runs at a time with sequential test file execution. 76 sequential runs × 200MB peak = ~15GB **if memory isn't released between runs**. Whether Node's GC cleans up between Stryker mutant runs is implementation-specific.

The 8GB fix may not be sufficient for large component test files. The correct fix is narrow and already applied: testFiles scoping reduces the number of tests loaded per mutant. The heap bump is a fallback.

### Better fix would be

Reduce `concurrency` from 1 to 1 (already done), ensure `cleanTempDir: true` (already done), and consider `maxTestRunnerReuse: 1` to restart the test runner worker between mutants to free memory. This is not present in the current config.

---

## E4 — PR-scope correctness

**Verdict: Correct for the intended use cases. One minor asymmetry with pre-push hook worth noting.**

### Gate scope

The gate uses `git diff --name-only "$BASE_REF...HEAD"` (three-dot, line 98). Three-dot diff gives files that differ between `HEAD` and the merge base of `BASE_REF` and `HEAD`. This is the standard "what changed on my branch" diff, correct for PR-scoped mutation checking.

### Pre-push hook vs gate scope

The pre-push hook computes its own `CHANGED` with `git diff --name-only "$RANGE"` (two-dot) where `RANGE` is `@{u}..HEAD` or `origin/main..HEAD`. Two-dot is "what's on HEAD that's not on base" — for a linear history this is the same as three-dot. For histories with intervening base commits (rebase scenarios), they differ. The hook's two-dot scope controls whether `verify:fast` or `verify:full` is triggered — not the gate's internal scope. **The gate uses three-dot independently; the mismatch doesn't affect gate correctness.**

### Running verify:full before pushing (manual run)

When a user runs `pnpm verify:full` manually before pushing, `origin/main` points to the last pushed commit. `git diff --name-only origin/main...HEAD` gives all local-only commits. This is exactly the intended PR scope. **Correct.**

### Limitation

If `origin/main` doesn't exist (no remote configured), the gate detects this at line 81 (`git rev-parse --verify "$BASE_REF"`), emits a skip artifact, and exits 0. This is documented behavior: "gate only applies when a real PR diff exists." This is a design choice, not a bug, but it means the gate silently skips when there is no remote — which happens when running from a detached fork or a repo with no push target.

### Whole-repo scan risk: does not exist

The gate does NOT scan the whole repo. It is strictly scoped to `git diff --name-only` output. Files not in the diff are never processed.

---

## E5 — `4bc119f testfiles-b` commit

**Verdict: Agent experiment artifact from the stalled debugging session. Should not be on main and is not on main. Orphaned on a dead branch. Not garbage requiring revert — but the branch should be deleted.**

### What it contains

```
extensions/_mpg_b_3569456/index.ts     (new file — grade_b function, 5 lines)
packages/app-tools/src/__tests__/_mpg_b_3569456.test.ts  (new file — 19 lines, rigorous tests)
```

It's a rigorous test fixture for the `grade_b` function with boundary-covering tests. The naming pattern `_mpg_b_3569456` matches the agent's self-test fixture naming convention (`_self_test_gate_{a,b}`), except with a random suffix instead of the standard name.

### Provenance

The reflog shows:

```
d9c86c5 HEAD@{8}: checkout: moving from main to mpg-tf-base-testfiles-3569456
4bc119f HEAD@{6}: commit: testfiles-b            ← committed on branch mpg-tf-b-testfiles-3569456
d9c86c5 HEAD@{7}: checkout: moving from mpg-tf-base-testfiles-3569456 to mpg-tf-b-testfiles-3569456
d9c86c5 HEAD@{4}: checkout: moving from mpg-tf-b-testfiles-3569456 to main
```

The agent created `mpg-tf-base-testfiles-3569456` off main (at `d9c86c5`), then `mpg-tf-b-testfiles-3569456`, committed the testfiles-b fixture, then checked back out to main **without merging**. This is consistent with the agent debugging the `testFiles` parameter and creating test fixtures to validate behavior.

**`4bc119f` is NOT on `main`.** Confirmed:

- `git branch --contains 4bc119f` → `mpg-tf-b-testfiles-3569456` only
- `git log --oneline main | grep 4bc119f` → empty

The branch `mpg-tf-b-testfiles-3569456` is an orphaned dead branch. The files in the commit (`extensions/_mpg_b_3569456/` and `packages/app-tools/src/__tests__/_mpg_b_3569456.test.ts`) are not present on main.

**No production code is in this commit; no revert needed.** The branch should be deleted to keep the repo clean, but it causes no harm as-is.

---

## E6 — e2e fix in `703d567`

**Verdict: Legitimate fix for a pre-existing conflict. The replacement assertion is extremely weak and loses meaningful UI coverage.**

### Was the test failing before Change E?

**Yes, and due to an unrelated commit.**

Timeline (confirmed via git ancestry and timestamps):

| Date             | Commit    | Event                                                                                                      |
| ---------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| 2026-04-27 13:29 | `085198a` | e2e Scenario 13 created with assertion: `inv-product-<id>` visible on `/chef/inventory` for [MEAL] product |
| 2026-04-29 19:34 | `c110f0a` | MEAL exclusion added to `useChefbyteProducts` (`.not('name', 'ilike', '[MEAL]%')`)                         |
| 2026-04-29 20:16 | `703d567` | e2e assertion updated to match new behavior                                                                |

`085198a` is an ancestor of `c110f0a` (confirmed: `merge-base --is-ancestor 085198a c110f0a` → true). The MEAL exclusion (`c110f0a`) broke the existing e2e test. The fix at `703d567` responds to this correctly.

**The test was failing BEFORE Change E**, not because of Change E. The fix is causally legitimate.

### Is the fix correct?

The replacement assertion (lines 104-106):

```typescript
await loginViaUi(page, seeded.email, seeded.password);
await page.goto('/chef');
await expect(page.getByText('ChefByte')).toBeVisible({ timeout: 10_000 });
```

The DB assertions (lines 74-97) still verify:

- `mark_meal_done` RPC succeeds
- `[MEAL] <recipe> MM-DD` product was created with correct name format
- A `stock_lot` exists for that product with `qty_containers > 0`

The DB-side assertions are correct and sufficient for the scenario's contract ("meal execution creates a [MEAL] lot"). The web-side assertion is not: `getByText('ChefByte')` is a navigation smoke test, not a verification of meal execution outcome. This is a meaningful regression in test quality — the original assertion verified the DB state propagated to the UI. That propagation path is now untested by this scenario.

**The fix is legitimate (correct direction) but the replacement assertion should be stronger.** An acceptable alternative that respects the MEAL exclusion: navigate to `/chef/meal-plan`, verify the meal plan entry is marked as done, or check that `/chef` loads the correct user's ChefByte without errors from the console. The current "ChefByte text visible" check adds no verification of the meal execution outcome.

---

## E7 — NEGATIVE-TWIN-PROOF presence per commit

| Commit    | Subject                                            | NEGATIVE-TWIN-PROOF present?                        |
| --------- | -------------------------------------------------- | --------------------------------------------------- |
| `004b69b` | feat(verify): mutation_pair_gate.sh                | **YES** — full block with both simulators described |
| `703d567` | fix(e2e): update meal-plan-execution               | **NO**                                              |
| `c7d6e31` | fix(mutation-gate): extend config_for_prod_file    | **NO**                                              |
| `d9c86c5` | chore(verify): gitignore + fix Stryker temp-config | **NO**                                              |

`004b69b` (the initial gate implementation) includes a NEGATIVE-TWIN-PROOF block describing both the tautological simulator (gate FAILS) and the real simulator (gate PASSES), with "Verified: bash scripts/verify/tests/mutation_pair_gate_self_test.sh."

The three follow-up commits — `703d567`, `c7d6e31`, `d9c86c5` — have no NEGATIVE-TWIN-PROOF blocks.

**Assessment of `004b69b`'s proof:**

The self-test script exists at `scripts/verify/tests/mutation_pair_gate_self_test.sh` (401 lines). It has two phases that run Stryker directly and via full gate invocation. The proof block is plausible — the script structure would produce the described outcomes. **However, the self-test was not executed during this audit (read-only constraint).** The existence of the self-test is necessary but not sufficient to confirm the proof block reflects actual execution results vs. aspirational description.

**The three commits without proofs are the ones that changed behavior after the initial implementation.** `c7d6e31` changed `config_for_prod_file` routing; `d9c86c5` changed how the Stryker temp config is built; both are structural changes that should have had proofs demonstrating the gate still fails on tautological tests with the new routing/config approach.

---

## E8 — `--no-verify` usage

**Verdict: No evidence of `--no-verify` usage in any Change E commit. One pre-existing `Verify-skipped` footer in an unrelated commit 184 commits before HEAD. The self-test script uses `--no-gpg-sign` for ephemeral fixture commits on throwaway branches — acceptable.**

### Evidence examined

1. **Change E commit messages** (`004b69b`, `703d567`, `c7d6e31`, `d9c86c5`, `b66c2e5`, `442a6c2`): No "Verify-skipped," "no-verify," or "bypass" text in any. All are clean.

2. **Reflog search**: No `no-verify` appears in any reflog entry for these commits.

3. **`Verify-skipped` in broader history**: Found in `0ed7acc` ("feat(classifier): opt-in fallback pass") — 184 commits before HEAD, unrelated to Change E, and it was for a pre-existing `livetrack-session` integration flake.

4. **Self-test script**: Uses `git commit --no-gpg-sign` at lines 328 and 366 for temp fixture commits (`mpg-self-test-a:` and `mpg-self-test-b:`). These are throwaway commits on throwaway branches that are deleted after the test. `--no-gpg-sign` is not `--no-verify`; it skips GPG signature (not hooks). This is acceptable for self-test scaffolding.

5. **`run.sh` comment**: Lines 17-22 describe `git push --no-verify` as the documented emergency bypass mechanism. This is documentation, not usage.

### Gate scripts are exempt from their own gate

Note: all Change E commits modify files that are excluded from CHANGED_PROD (`^scripts/` pattern at line 121 of the gate). So none of these commits would have triggered the mutation-pair gate even if it was fully operational. The pre-push hook would have run `verify:full` (typecheck, lint, format, tests, integration, etc.) but NOT mutation testing for these specific changes. This is a legitimate exemption — shell scripts are not JavaScript and Stryker doesn't mutate them.

---

## Summary Matrix

| Item                                              | Verdict                                                       | Severity      |
| ------------------------------------------------- | ------------------------------------------------------------- | ------------- |
| E1: Gate end-to-end correctness                   | Correct for tautological case, weak threshold (≥1 killed)     | Low           |
| E1: Self-test trustworthiness                     | Code structure is real, execution not verified in audit       | Unverified    |
| E2: `test_f` variable expansion                   | Correct — bash argument passing, not heredoc interpolation    | None          |
| E2: `testFiles` interaction with `vitest.related` | Correct — defensive deletion at line 361                      | None          |
| E3: OOM root cause                                | Correct diagnosis; `b66c2e5` (testFiles) already mitigated it | Low           |
| E3: 8GB heap sufficiency                          | May be insufficient for large component files at scale        | Low           |
| E3: Missing `maxTestRunnerReuse`                  | Not present; large component files may still OOM              | Low           |
| E4: PR-scope correctness                          | Correct — three-dot diff, handles no-remote gracefully        | None          |
| E5: `4bc119f testfiles-b`                         | Orphaned agent experiment, NOT on main, safe                  | Low (cleanup) |
| E6: e2e fix legitimacy                            | Fix is legitimate; replacement assertion is too weak          | Medium        |
| E7: NEGATIVE-TWIN-PROOF presence                  | 1/4 commits have proof; 3 follow-up commits are bare          | Medium        |
| E8: `--no-verify` usage                           | No evidence of bypass in Change E commits                     | None          |

---

## Confidence

**High confidence (verified via code + git history):**

- `4bc119f` is not on main (confirmed via `git branch --contains` and `git log --oneline main`)
- Variable expansion at line 341 is correct (tested experimentally with bash heredoc)
- `testFiles` is a valid Stryker config option (confirmed via schema)
- The MEAL exclusion (`c110f0a`) predates `703d567` and postdates `085198a` (confirmed via merge-base)
- No `Verify-skipped` footer in any Change E commit (exhaustive log scan)
- `stryker.web-components.conf.json` uses `coverageAnalysis: off` (line 25, confirmed)

**Medium confidence (structural analysis, not run):**

- Self-test Phase 1 tautological fixture genuinely kills 0 mutants (gradeA body mutations don't affect `typeof gradeA`)
- Self-test Phase 2 gate path correctly captures exit code under `set -uo pipefail`

**Could not verify:**

- Whether the self-test actually passes when executed (Stryker run, read-only constraint)
- Whether 8GB heap is sufficient for all web component files in practice (depends on runtime GC behavior)
- Whether `testFiles` scoping correctly restricts Vitest in Stryker's vitest-runner v9.6.1 (documented but not experimentally confirmed)
- Whether b66c2e5 `testFiles` scoping actually eliminates the OOM in the full web component run that originally failed
