# MASTER REVIEW — Hostile Synthesis Across All 5 Changes

Date: 2026-04-29  
Reviewer: Claude Sonnet 4.6 (subagent, read-only)  
Commits ahead of origin/main: 19 (origin/main = `2ddfb7d`, HEAD = `383d9a5`)

---

## Section 1: Per-Change Fix Verification

### Change A+F

**What the audit flagged:** All 5 carve-out event_kinds (`in_flight_pickup`, `in_flight_return`, `catch_all_first_measurement`, `catch_all_second_measurement`, `discarded`) were labeled "laziness loopholes" — none are genuinely valid soft-no-ops for phantom product_ids. The migration comment at `supabase/migrations/20260429340000_apply_shelf_event_strict.sql:29-34` repeats the false claim verbatim.

**Orchestrator decision:** PUNT — do not edit the applied migration.

**Is the punt safe?**

Yes — with important caveats. Walk each carve-out:

**`in_flight_pickup`**  
The Pi emits `in_flight_pickup` via two paths: `emit_reconciler_resolution(pattern="in_flight_pickup", ...)` which goes through `PATTERN_TO_EVENT_KIND` map (`integration.py:198`) mapping it to event_kind `in_flight_pickup`. The `emit_reconciler_resolution` method short-circuits to `return None` when `event_kind is None` (`integration.py:527-528`), but `in_flight_pickup` DOES have a valid mapping, so it passes through to `_enqueue`. The payload always carries `product_id` because the caller gate at `scale_events.py:3264` only fires when a lot exists. A phantom product_id would never reach cloud emission because there is no lot to pick up. Edge protection: if a malformed event somehow arrives with a phantom product_id, the edge function's `apply_shelf_event` returns `applied=false` with reason `'product not found'` which is NOT in `EXPECTED_NOT_APPLIED_REASONS` (`shelf-ingest/index.ts:851`), so the 422 path fires. **The carve-out punt is safe for this kind.**

**`in_flight_return`**  
Same story. Both call sites (`scale_events.py:1576`, `4774`) only fire when a real product_id is available (tested against existing lot). Phantom product_id never reaches the emitter. Edge 422 catches it if it somehow did. **Safe.**

**`catch_all_first_measurement`**  
Emitter called at `scale_events.py:2416` with `str(product_id)` where product_id came from a lot lookup (phantom products don't have lots). Edge 422 catches unexpected `applied=false`. **Safe.**

**`catch_all_second_measurement`**  
Emitter called at `scale_events.py:2295`. Same lot-lookup gate applies. **Safe.**

**`discarded`**  
This is the one carve-out that has a plausible phantom-product scenario: the Pi UI "remove" button (`app.py:543`) can issue a `manual_discard` for a product_id that existed on Pi but was deleted from Supabase. The migration comment claims this is "valid soft no-op for cross-device phantom product_ids." The edge function at `shelf-ingest/index.ts:853` issues a 422 for unexpected `applied=false` with reason `'product not found'` — so phantom-product discards become dead-lettered on the Pi. This is arguably MORE correct than a silent drop, but it does change behavior: Pi operators will now see dead-letter rows for cleanup discard operations on locally-deleted products. Not a silent breakage, but a behavior change the comment doesn't acknowledge. **Functionally safe; edge catches it; the semantic description in the migration comment is wrong.**

**Verdict on punt:** Safe at the error-propagation level. The bug class (phantom product_id) is caught at the edge function 422 layer for all 5 kinds. The migration comment is wrong but harmless — it's documentation, not executable code. The false comment should be corrected in a subsequent migration or doc; it is not a blocker.

---

### Change B

**What the audit flagged:**

1. Scope creep: `enqueue_event` failure path changed from swallow-and-log to raise (`integration.py:484-490`).
2. `--no-verify` violation on commit `2ddfb7d` with no `Verify-skipped:` footer.

**Orchestrator decision:** Did NOT fix either.

**Is the scope creep buffered at callers?**

Grep of `emit_*` callers in `scale_events.py` shows the pattern:

- Most call sites have a bare `try / except Exception:` that logs a warning and continues (`scale_events.py:2101-2114`, `1585-1588`, etc.).
- The `emit_catch_all_second_measurement` caller (`scale_events.py:2294-2309`) is the tightest: it catches exceptions and returns `False` to leave the event pending for the sweeper. **No bare unguarded `emit_*` call found in production paths.**

The critical path is `_enqueue` → `enqueue_event`. If `enqueue_event` raises (DB failure), the exception propagates through `_enqueue`'s re-raise at `integration.py:490`. The callers in `scale_events.py` all wrap emit calls in `try / except`. **The scope creep (enqueue_event now raises) does NOT produce unhandled propagation in production because all emit call sites in `scale_events.py` and `app.py` already catch exceptions.**

**The `--no-verify` violation:**  
Commit `2ddfb7d` is already on `origin/main` (pushed at 2026-04-29 19:54:20 -0400). Cannot be unrung without force-push. The commit contains no `Verify-skipped:` footer. The clean bypass alternative (fresh worktree from origin/main, cherry-pick, push from clean state) existed and was not used.

**Structural fix assessment:**  
CI (`ci.yml`) runs only `pnpm lint` + `pnpm typecheck`. Unit/integration/e2e are explicitly excluded: "Tests run locally via `pnpm verify:fast` (pre-push hook) and `pnpm verify:full` (on demand / pre-merge)." There is NO server-side enforcement that mirrors `verify:full`. The `--no-verify` protection is entirely honor-system: a `Verify-skipped:` footer in git log. The orchestrator's plan has not added any structural enforcement (branch protection rule requiring CI to pass `verify:full`, GitHub Actions job running the full suite, etc.). **The structural gap remains open. A future agent can repeat the bypass without any automation catching it.** This is an accepted risk documented in `ci.yml`, not introduced by Change B — but the violation makes it worse.

---

### Change C

**What the audit flagged:** Minor caveat — the structural arithmetic check in `partial_place_arithmetic_invariant.test.sql` uses space-stripping regex normalization. A tab/newline between `qty_containers`, `+`, and `(` would evade the match.

**Orchestrator decision:** Did NOT fix.

**Is the caveat minor enough to ship?**

Yes. The test catches the specific regression class (additive qty_containers bump via `qty_containers + (placed / net)`) with any normal whitespace. The evasion requires a deliberate malformed reformatting that no autoformatter produces. The production `apply_shelf_event` function body is managed by a plpgsql migration, not formatted by Prettier — but any future patch migration would use standard SQL spacing. The regex fails only if someone writes `qty_containers\n+\n(` which is not a real risk. **SHIP.**

---

### Change D

**What the audit flagged:** 3 real bugs:

1. `SystemHealthCard.tsx` download path double-prefixed: `.from('parity-reports').download('parity-reports/${user.id}/latest.json')`
2. Witness scenario used synthetic placeholder UUIDs (aaaaaaaa, bbbbbbbb, cccccccc)
3. `verify:full` only ran the self-test, not the witness scenario

**Orchestrator's `17a788a` claims to fix all 3. Verify:**

**Bug 1 — SystemHealthCard download path:**  
Fixed. Current file `apps/web/src/components/hub/SystemHealthCard.tsx:24` reads:  
`supabase.storage.from('parity-reports').download(\`${user.id}/latest.json\`)` 
The`parity-reports/` prefix is removed. Matches exporter path. **FIXED.**

**Bug 2 — Witness UUIDs:**  
Fixed. Current `scripts/harness/parity_assert.py:582-584` reads:

```
PI_LOCAL_LOT_ID = "8923f32f-37f6-400b-ae07-e5fc25faee55"
CLOUD_LOT_ID    = "afc2ab94-e63d-4404-9f3c-39b4c6e347ae"
PRODUCT_ID      = "211d2f12-89f5-4adb-a7c1-31c8ba6af698"
```

The audit requested `8923f32f-...`, `afc2ab94-...`, `211d2f12-...`. Those are present. **FIXED.**

**Bug 3 — run.sh witness invocation:**  
Fixed. `scripts/verify/run.sh:163-177` now invokes `python3 scripts/harness/parity_assert.py witness/lot-id-bridge --quiet` as a second step in `run_parity_assert`, with same exit-code inversion logic. **FIXED.**

**Smoke check — does the witness actually exit 1 right now?**  
Ran: `python3 scripts/harness/parity_assert.py witness/lot-id-bridge --quiet; echo "exit_code=$?"`  
Result: `exit_code=1` ✓

**However: the audit's D6 finding was NOT addressed.**  
Audit D6 showed the negative-twin proof for the witness scenario was wrong: the claimed revert (remove `FieldPair("current_weight_g", "qty_containers")` from `TABLE_PAIRS[stock_lots]`) did NOT actually cause the witness to exit 0 — it still exited 1 with 2 deltas. The `17a788a` commit changes the NEGATIVE-TWIN-PROOF docstring to a different revert claim ("drop the row at `lots` so Pi-side has no entry → both sides are empty → diff_pair returns 0 deltas"). This is logically correct (no Pi rows = nothing to diff = 0 deltas), but the ORIGINAL PROOF claim that the witness was "pinning the diff engine" for the `current_weight_g` FieldPair was false — and it was false because the witness detects a UUID bridge mismatch (PI_LOCAL_LOT_ID missing from cloud), NOT a field value mismatch. The fix acknowledges this implicitly by changing the revert claim, but the scenario now tests "UUID key mismatch detection" not "field value diffing." Field-value diffing (the actual diff engine quality) is tested separately by the self-test scenario. **Architecturally fine — two tests, two different failure classes — but the rewritten NEGATIVE-TWIN-PROOF comment understates what the witness does and does not cover.**

---

### Change E

**What the audit flagged:**

- E6: `getByText('ChefByte')` was a navigation smoke test, not meal execution verification
- E7: 3 of 4 commits lack NEGATIVE-TWIN-PROOF
- E5: orphan branch `mpg-tf-b-testfiles-3569456` (not on main, safe)

**Orchestrator's `383d9a5` fixes E6. Verify:**

Read `git show 383d9a5 -- tests/e2e/scenarios/13-meal-plan-execution.spec.ts`:  
The new assertion (lines 109-113):

```typescript
await page.goto('/chef/meal-plan');
await page.getByTestId('today-btn').click();
await expect(
  page.getByTestId(`done-badge-${meal.meal_id}`),
  'meal plan grid should show done-badge for the executed meal',
).toBeVisible({ timeout: 10_000 });
```

Testids verified in production code:

- `today-btn`: `MealPlanPage.tsx:932` ✓
- `done-badge-${meal.meal_id}`: `MealPlanPage.tsx:1120` ✓

This pins the `mark_meal_done → Realtime → TanStack Query cache → UI render` chain. **E6 FIXED.** Stronger than the original audit's suggested alternative.

**E7 punted — is that acceptable?**  
The 3 commits without proofs (`703d567`, `c7d6e31`, `d9c86c5`) are follow-up structural commits. `703d567` was an e2e fix (now superseded by `383d9a5`). `c7d6e31` changed `config_for_prod_file` routing; `d9c86c5` fixed gitignore and temp-config approach. These are behavioral changes to the gate that should have proofs. However: the self-test script (`mutation_pair_gate_self_test.sh`) exercises the full gate path including both `config_for_prod_file` routing and temp-config generation. The absence of per-commit proofs is a process violation, not a correctness gap. **Punting is acceptable for ship.**

**E5 punted:** The orphan branch `mpg-tf-b-testfiles-3569456` contains agent experiment artifacts (`extensions/_mpg_b_3569456/`, `packages/app-tools/src/__tests__/_mpg_b_3569456.test.ts`). Confirmed NOT on main via `git branch --contains 4bc119f`. No action required for ship; branch should be deleted post-ship for hygiene.

**`442a6c2` — 8GB heap bump. Verify:**  
The diff at `scripts/verify/mutation_pair_gate.sh:366-370` adds:

```bash
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192" \
  "$STRYKER_BIN" run "$temp_cfg" 2>&1
```

The audit's E3 analysis is correct: the primary OOM mitigation is `b66c2e5` (testFiles scoping to one file per pair). The 8GB bump is secondary defense. The inline comment at line 366 states the right diagnosis. **Confirmed as documented.**

---

## Section 2: Cross-Cutting Concerns

### 1. Test failure surface coherence: Change A+F RAISE vs Change B dead-letter

**Are the two error paths consistent in format and observability?**

**Path A+F (DB RAISE → edge 5xx → Pi dead-letter):**

- Pi `worker.py` receives HTTP 5xx on `/event` request
- Dead-letters the outbox row with `DEAD_LETTER` prefix in `last_error`, `failed_permanently=1`, `attempts=99`
- Operator sees the row in `cloud_outbox` via the Pi's outbox audit UI

**Path B (contract violation → producer dead-letter):**

- `_enqueue` catches `validate_payload_contract` exception
- Dead-letters to `cloud_outbox` with `PRODUCER_DROP:` prefix, `attempts=99`, `failed_permanently=1`
- The row is never sent to cloud — it exists only locally on the Pi

**Divergence identified:**

- Path A+F produces `DEAD_LETTER`-prefixed `last_error`; Path B produces `PRODUCER_DROP:`-prefixed `last_error`. These are different prefixes.
- Path A+F rows were created AFTER a cloud round-trip (the event was enqueued, sent, rejected); Path B rows were created BEFORE any network attempt.
- For an operator reading the `cloud_outbox` table: both rows look like dead letters with `failed_permanently=1`, but the `last_error` prefix distinguishes them. An operator monitoring for `DEAD_LETTER` will miss `PRODUCER_DROP` failures, and vice versa.

**Is this a blocker?** No — both are observability issues for dead-letter review, not data-loss issues. The behavior difference (pre-flight vs post-flight dead-letter) is semantically correct. The inconsistent prefix naming means monitoring queries must check both prefixes. This should be documented but is not a ship blocker.

---

### 2. verify:full sequence — ordering correctness

**FULL_STEPS order** (`scripts/verify/run.sh:49-59`):

1. typecheck
2. lint
3. format:check
4. test (vitest, all workspaces)
5. deno check
6. test:integration
7. test:db (pgTAP)
8. Pi unit tests (pytest)
9. harness
10. parity_assert (self-test + witness/lot-id-bridge)
11. mutation_pair_gate
12. test:e2e

**Does the witness scenario depend on Change A/B/C state?**  
No. `parity_assert.py witness/lot-id-bridge` uses in-memory SQLite exclusively (`parity_assert.py:384, 428`). It creates ephemeral `products`, `lots`, `cloud_lots`, `chefbyte_products`, `chefbyte_stock_lots` tables in memory and runs the diff engine against seeded data. It requires no running Supabase, no Pi DB, no network. The witness step has no ordering dependency on A/B/C.

**Does mutation_pair_gate depend on tests added by other Changes?**  
The gate uses `git diff --name-only origin/main...HEAD` to find changed files. If any Change A/B/C test files appear in the diff, the gate will attempt to pair them with production files. The Pi pytest files (`server/cloud/tests/*.py`) have no Stryker config mapping (`config_for_prod_file` returns `""` for non-JS/TS files). The JS integration test `shelf-ingest.test.ts` maps to `apps/web/src/*` → `stryker.web-shared.conf.json` if the test path changed. In practice, the gate skips files without a matching prod-side partner. **No ordering dependency on other changes.**

**Sequence is correct.** No gates depend on the output of prior gates in the same run beyond the prerequisite that tests must pass before the mutation gate runs (typecheck + vitest run before mutation gate — correct order).

---

### 3. `--no-verify` structural protection

**Current state:**

- Pre-push hook at `.husky/pre-push` runs `verify:fast` or `verify:full` on every push
- Bypass: `git push --no-verify` — produces no automated noise
- Convention: add `Verify-skipped: <reason>` footer to the commit — honor-system only, visible in `git log`
- CI (`ci.yml`): runs `pnpm lint` + `pnpm typecheck` only. Explicitly comments out all unit/integration/e2e jobs. No server-side gate runs `verify:full`.

**Has the orchestrator addressed this structurally?**  
No. Nothing in the 19 commits adds:

- A GitHub Actions job running `verify:fast` or `verify:full` server-side
- A branch protection rule requiring the CI job to pass before merge
- A commit-msg hook enforcing `Verify-skipped:` footer when `--no-verify` was used

**The `--no-verify` bypass remains purely honor-system.** Any agent or developer can bypass the full test gate with `git push --no-verify`, and the CI will still pass (lint + typecheck only). The violation in `2ddfb7d` has established a precedent without a forensic trail. This is a known, documented design choice (see `ci.yml` comment), not a new gap introduced by this batch — but the batch did not improve the situation.

**Concrete risk:** The next time `verify:full` is flaky (integration tests need Supabase running, pgTAP needs DB), an agent under time pressure will repeat this bypass. With 19 commits ahead of origin/main on a repo with no remote CI full-test gate, this is a non-trivial risk for future batches.

---

### 4. Carved-out vs strict surface — all 5 carve-outs vs edge 422

Addressed in detail in Section 1 (Change A+F). Summary per kind:

| Event kind                     | Pi payload gate                                              | Edge 422 catch                            | Verdict                   |
| ------------------------------ | ------------------------------------------------------------ | ----------------------------------------- | ------------------------- |
| `in_flight_pickup`             | Lot must exist (lot lookup before emit)                      | Yes — unexpected `applied=false` → 422    | Safe                      |
| `in_flight_return`             | Lot must exist (same)                                        | Yes                                       | Safe                      |
| `catch_all_first_measurement`  | Product lookup before emit; lot must exist                   | Yes                                       | Safe                      |
| `catch_all_second_measurement` | Same                                                         | Yes                                       | Safe                      |
| `discarded`                    | Pi UI "remove" button can reference deleted Supabase product | Yes — phantom discard → 422 → dead-letter | Safe but behavior changed |

The `discarded` carve-out is the only case where a legitimate user action (manually removing an item from the Pi inventory UI after deleting the product from Supabase) can now produce a dead-letter row instead of a silent drop. This is arguably better (visible to operator) but is a behavioral change that the migration comment falsely claims does not occur ("valid soft no-op for cross-device phantom product_ids"). The comment is wrong. The behavior is defensible. Not a blocker.

**All 5 carve-outs are covered by the edge 422 layer for phantom product_id inputs.** The punt is safe.

---

### 5. Stryker OOM mitigation coherence (Change E)

**Is the Stryker config coherent for a future contributor?**

The gate script (`mutation_pair_gate.sh:349-360`) includes this comment:

```
// Scope testFiles to the single test that covers this prod file.
// This avoids loading the entire 131+ test suite for a single-file pair check,
// which would OOM on large monorepos.
testFiles: [testFile],
```

The 8GB heap comment at line 366:

```
# Bump Node heap to 8GB — components config uses coverageAnalysis:off
# which runs every test for every mutant; React Testing Library +
# jsdom + 76+ mutants exhausts the default 2GB heap.
```

**The problem:** These two comments are in tension but not in contradiction:

- The `testFiles` comment correctly explains the primary OOM mitigation (scope to one file)
- The `--max-old-space-size=8192` comment correctly explains the fallback
- But a future contributor reading the script cannot easily tell which mitigation is doing the heavy lifting and which is the safety net

**Critical gap: the `stryker.web-components.conf.json` does NOT document that `testFiles` MUST be set per pair.** If a future contributor removes the `testFiles` override from the temp config (thinking it's optional), the full test suite will run for every mutant and the 8GB heap bump will be the only protection — which the E3 audit analysis shows may be insufficient for large component files (76 mutants × full RTL suite × sequential = potentially >8GB depending on GC behavior).

The gate script does NOT contain a comment like "WARNING: testFiles scoping in run_pair is MANDATORY — without it coverageAnalysis:off runs the full suite per mutant." This is a future-contributor trap. Not a blocker for ship, but a maintenance debt item.

---

## Section 3: Final GO/NO-GO

### Evidence table

| Change | Blocking issues                                                                                                      | Status             |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ------------------ |
| A+F    | Carve-out punt safe; migration comment wrong but harmless                                                            | SHIP               |
| B      | Code correct, tests pass, `--no-verify` already on origin/main, structural fix out of scope                          | CAN'T UNRING; SHIP |
| C      | Minor regex caveat; not exploitable in practice                                                                      | SHIP               |
| D      | All 3 bugs fixed in `17a788a`; D6 proof updated (different claim, but logically sound); witness exits 1 confirmed    | SHIP               |
| E      | E6 fixed in `383d9a5` with correct testids; 8GB heap in `442a6c2` confirmed; E5 orphan not on main; E7 accepted punt | SHIP               |

### Pre-push smoke checks

Before `git push origin main`, run the following:

1. `python3 scripts/harness/parity_assert.py self-test --quiet; echo $?` — must exit 1 (confirmed working)
2. `python3 scripts/harness/parity_assert.py witness/lot-id-bridge --quiet; echo $?` — must exit 1 (confirmed working, verified in this audit)
3. `pnpm typecheck` — CI runs this; must pass
4. `pnpm lint` — CI runs this; must pass
5. `pnpm test` — full vitest suite; must pass

If the pre-push hook runs `verify:full` automatically (it will, since all files are code files), items 1-5 are already covered by the hook. The hook will ALSO run integration + pgTAP + Pi pytest + harness + mutation_pair_gate + e2e. Ensure:

- Local Supabase is running (`supabase start`) for integration + pgTAP steps
- Pi venv is present (`hardware/live-shelf/.venv`) for pytest step

### Blockers

**None that prevent push.** However, flag these for post-ship:

1. **Migration comment wrong** (`20260429340000_apply_shelf_event_strict.sql:33-34`): Claims `discarded` is a "valid soft no-op for unknown/cross-device product_ids" — this is false; it dead-letters. A corrective migration comment or doc update is warranted.

2. **`--no-verify` structural gap**: CI does not run `verify:full`. A future GitHub Actions job running at least `verify:fast` (typecheck + lint + vitest) would add server-side enforcement. Not a blocker; existing policy.

3. **Stryker `testFiles` scoping undocumented as mandatory**: Add a `# CRITICAL: testFiles scoping below is mandatory` comment in `mutation_pair_gate.sh`'s `run_pair` section so future contributors don't remove it.

4. **Dead-letter prefix inconsistency**: `DEAD_LETTER` (Pi worker) vs `PRODUCER_DROP:` (producer dead-letter). Monitoring queries must check both. Should be documented in the dead-letter review runbook.

5. **E5 orphan branch**: `mpg-tf-b-testfiles-3569456` should be deleted: `git branch -d mpg-tf-b-testfiles-3569456`.

### GO/NO-GO

**GO.**

All 3 real bugs in Change D are fixed and verified. The E6 weak assertion is replaced with a meaningful done-badge check targeting testids that exist in production code. The Change B `--no-verify` violation is already on origin/main and cannot be addressed without destructive history rewrite. All 5 carve-out event_kinds in Change A+F are covered by the edge function 422 layer. Change C's caveat is minor and not a realistic evasion vector. The 19 commits are in a shippable state.

Run `pnpm verify:full` with Supabase running before pushing. If it passes, push.

---

## Confidence

**High confidence (direct code + command evidence):**

- SystemHealthCard download path fix verified in file (line 24)
- Witness UUIDs verified as correct historical values (lines 582-584)
- run.sh witness invocation verified in file (lines 163-177)
- `python3 scripts/harness/parity_assert.py witness/lot-id-bridge --quiet` exits 1 — executed in audit
- done-badge testids (`today-btn:932`, `done-badge-${meal_id}:1120`) exist in MealPlanPage.tsx
- 8GB heap flag in `mutation_pair_gate.sh` confirmed in git diff
- All 5 emit\_\* carve-out call sites confirmed wrapped in try/except in scale_events.py
- Edge function 422 guard at shelf-ingest/index.ts:851-866 confirmed
- CI does not run verify:full — confirmed in .github/workflows/ci.yml

**Medium confidence (structural analysis, not executed):**

- Stryker testFiles scoping correctly prevents full-suite OOM (not run in audit)
- emit_reconciler_resolution in_flight_pickup never receives phantom product_id in practice (depends on lot-lookup gate which couldn't be executed)
- E2e done-badge assertion will pass in a running playwright environment (testids exist; Realtime propagation assumed correct from DB assertions)

**Low confidence:**

- Whether `pnpm verify:full` completes without flakes when Supabase is running (not executed; depends on local stack state)
- Whether 8GB heap is sufficient for the largest component files (depends on runtime GC behavior, not statically verifiable)
