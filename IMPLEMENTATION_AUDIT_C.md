# IMPLEMENTATION AUDIT C (Hostile)

Date: 2026-04-29 (America/New_York)
Repo: `/home/jeremy/luna-hub-lite`
Commit audited: `c293b8c` (`test(chefbyte): tighten partial-place qty invariant + structural arithmetic check`)

## Precondition check

Requested file `/home/jeremy/luna-hub-lite/FINAL_PLAN.md` is not present in this checkout.

- `find /home/jeremy -maxdepth 4 -type f -name 'FINAL_PLAN.md'` -> no matches.

## Executive verdict

- C1 Production-data sweep is real: **PASS**
- C2 Negative-twin proof verification: **INDETERMINATE (runtime blocked in this sandbox)**
- C3 Structural arithmetic check quality: **PASS with caveat**
- C4 Test scope drift to seeded fixtures only: **PASS**
- C5 `--no-verify` / hook skip confirmation: **INDETERMINATE**

---

## C1. Production-data sweep is real

### Verdict

**PASS**

### Evidence

`live_shelf_lot_qty_clamp.test.sql` adds the exact unscoped production sweep query:

- `SELECT count(*)::int FROM chefbyte.stock_lots WHERE qty_containers > 1.05 AND last_update_source = 'live_shelf' AND qty_containers > 0` at [supabase/tests/chefbyte/live_shelf_lot_qty_clamp.test.sql](/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/live_shelf_lot_qty_clamp.test.sql:121) through [supabase/tests/chefbyte/live_shelf_lot_qty_clamp.test.sql](/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/live_shelf_lot_qty_clamp.test.sql:125).

This query is not restricted to seeded IDs, so it reads the whole `chefbyte.stock_lots` relation in the local test DB schema.

---

## C2. Negative-twin proof verification

### Verdict

**INDETERMINATE (runtime blocked in this sandbox)**

### 1) Commit-message proof block present?

**Yes.** Commit `c293b8c` includes a `NEGATIVE-TWIN-PROOF` section claiming failures:

- `live_shelf_lot_qty_clamp (tests 2,3,4)`
- `partial_place_arithmetic_invariant (tests 2,3)`

Source: `git show --format=fuller c293b8c`.

### 2) Experimental verification run

I attempted the requested workflow directly, then with a writable clone due `.git` mount constraints:

1. In-place stash at `/home/jeremy/luna-hub-lite` failed:
   - `git stash push -u ...` -> `error: could not write index`
   - `.git` is read-only in this environment (`touch .git/test-write` -> `Read-only file system`).

2. Created writable clone:
   - `git clone --no-hardlinks /home/jeremy/luna-hub-lite /tmp/luna-hub-lite-audit-20260429`

3. Tried `git revert --no-commit 787d19b`:
   - Hit modify/delete conflict on `live_shelf_lot_qty_clamp.test.sql` (expected because `c293b8c` later modified a file added by `787d19b`).

4. Applied equivalent migration-revert state by removing migration file only:
   - `git rm supabase/migrations/20260429210000_partial_place_no_qty_bump.sql`

5. Ran `supabase test db`:
   - Fails before tests execute:
   - `failed to connect to postgres ... dial tcp 127.0.0.1:54322: socket: operation not permitted`

Because test execution is blocked at DB connect time, I cannot empirically capture failing pgTAP names in this sandbox.

### 3) Static plausibility check (not runtime proof)

If migration `20260429210000` is removed, prior function migration still contains additive bug arithmetic at multiple sites, e.g.:

- step 1: `qty_containers = GREATEST(qty_containers + (p_placed_weight_g / v_net_g), 0)` at [supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql](/home/jeremy/luna-hub-lite/supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql:163)
- step 2: `qty_containers = qty_containers + (p_placed_weight_g / v_net_g)` at [supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql](/home/jeremy/luna-hub-lite/supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql:183)

So claimed failures are technically plausible, but not reproduced here due runtime constraints.

---

## C3. Structural arithmetic check

### Verdict

**PASS with caveat**

### Evidence

1. File exists:

- [supabase/tests/chefbyte/partial_place_arithmetic_invariant.test.sql](/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/partial_place_arithmetic_invariant.test.sql:1)

2. It uses regex against `pg_get_functiondef(...)`, not a full literal function snapshot:

- assertion A: `~* 'qty_containers\+\('` after `REPLACE(..., ' ', '')` at [supabase/tests/chefbyte/partial_place_arithmetic_invariant.test.sql](/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/partial_place_arithmetic_invariant.test.sql:67)
- assertion B: `~* 'placed_weight_g/v_net'` after same normalization at [supabase/tests/chefbyte/partial_place_arithmetic_invariant.test.sql](/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/partial_place_arithmetic_invariant.test.sql:99)

3. For the specific reintroduction `qty_containers + (placed / net)` with spacing changes, assertion A still fires (it keys on `qty_containers+(` after stripping spaces).

Caveat: normalization strips plain spaces only. A deliberately evasive reformat using tabs/newlines between `qty_containers`, `+`, and `(` could avoid that exact token match.

---

## C4. Test scope drift (fixtures-only?)

### Verdict

**PASS**

### Evidence

There are `SELECT ... FROM chefbyte.stock_lots` reads not scoped to inserted fixture rows:

- Global invariant read before fixture insert at [supabase/tests/chefbyte/live_shelf_lot_qty_clamp.test.sql](/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/live_shelf_lot_qty_clamp.test.sql:28)
- Production sweep read at [supabase/tests/chefbyte/live_shelf_lot_qty_clamp.test.sql](/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/live_shelf_lot_qty_clamp.test.sql:120)

So scope is not narrowed to only transaction-seeded `INSERT` rows.

---

## C5. `--no-verify` / hook skip usage

### Verdict

**INDETERMINATE**

### Evidence

- Commit object and reflog contain normal commit metadata, but Git does not record whether `--no-verify` was used.
- Commit message has no `Verify-skipped:` footer.
- Hooks are configured via `core.hooksPath = .husky/_` and hook files exist, but this is not forensic proof they ran for this commit.

Conclusion: no direct evidence of `--no-verify`, but no definitive proof of non-usage either.

---

## Requested failing test names

Runtime capture could not be produced here because `supabase test db` never reached test execution (DB socket blocked by sandbox policy).

Claimed in commit `c293b8c` message:

- `live_shelf_lot_qty_clamp` tests `2,3,4`
- `partial_place_arithmetic_invariant` tests `2,3`

These names are quoted from commit metadata, not empirically re-run in this environment.

## Confidence

- **High** on C1/C3/C4 file-level findings (direct SQL/diff evidence).
- **Low-to-medium** on C2 runtime behavior because local Postgres test execution is blocked (`socket: operation not permitted`).
- **Low** on C5 finality: Git metadata cannot conclusively prove/disprove `--no-verify` usage.
