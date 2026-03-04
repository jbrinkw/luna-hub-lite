# Testing System v2 — Catching What v1 Missed

## What v1 Got Wrong

### 1. Unit tests mock Supabase — so they never catch query bugs

Component tests use `vi.mock('@/shared/supabase')` and verify the component calls `.from('table').insert(...)` with the right args. But the args can have wrong column names, wrong keys, inverted booleans — the mock happily accepts anything. The C1 JSONB key mismatch, the D1 seed config key mismatch, and the M24 hardcoded `p_log_macros: false` all pass unit tests because the mock doesn't validate.

### 2. pgTAP tests create their own data — so they never catch seed/UI data bugs

Every pgTAP test inserts `target_reps`, `target_load` (correct keys). The seed.sql and SplitPage.tsx use `reps`, `load` (wrong keys). pgTAP never tests the actual data path from UI → DB.

### 3. E2E tests only cover auth — the rest of the app is untested via browser

41 e2e tests all in Hub. Zero Playwright tests for CoachByte or ChefByte. The entire point of e2e is to catch full-path bugs, but we only test login/logout/signup.

### 4. No parity tests — UI and MCP do different things for the same action

`consumeStock` in UI sets `p_log_macros: false`. MCP sets `true`. Nobody checked if identical actions produce identical results across entry points.

### 5. No negative/boundary testing — forms accept garbage

Every numeric input accepts negatives. No test ever types `-5` into a calories field. No test submits an empty ingredient list. No test types `%` into a search box.

### 6. No error path testing — 30+ queries silently drop errors

Every `loadData` function ignores the `error` field. No test simulates a failed query to verify error handling exists.

### 7. No spec compliance tests — features can be "done" without matching the spec

The spec says "consumed/planned/goal" (3 values). The code shows consumed/goal (2 values). No test checks "does this page match what the spec says?"

---

## v2 Testing Layers

### Layer 1: Seed Smoke Tests (new)

**Purpose:** Verify the demo account works end-to-end after `supabase db reset`.

```
supabase/tests/seed/
  seed_coachbyte.test.sql    -- Verify seed data is readable by actual RPC functions
  seed_chefbyte.test.sql     -- Verify seed data produces correct results
  seed_hub.test.sql          -- Verify seed user_config keys match what functions read
```

**What they catch:**

- D1: `SELECT * FROM private.get_daily_macros(demo_user_id)` → verify goals != server defaults
- C1/D2: `SELECT * FROM private.ensure_daily_plan(demo_user_id, today)` → verify planned_sets have non-NULL target_reps/target_load/rest_seconds
- Any future seed/schema drift

**Rules:**

- Seed tests call the SAME RPC functions that the UI calls
- Seed tests NEVER insert their own data — they only read what seed.sql created
- If a seed test fails, seed.sql is wrong

### Layer 2: Full-Path Integration Tests (new)

**Purpose:** Test the exact Supabase query the UI makes, against a real DB, with real RLS.

```
apps/web/src/__tests__/integration/
  coachbyte/
    split-to-plan.test.ts       -- SplitPage saves → ensure_daily_plan reads → verify non-NULL
    complete-set-timer.test.ts   -- complete_next_set → verify rest_seconds returned
    pr-computation.test.ts       -- Insert sets → verify PR calc matches spec (Epley 1RM)
  chefbyte/
    inventory-stock-ops.test.ts  -- addStock merges lots, consumeStock logs macros
    scanner-flow.test.ts         -- Scan → lookup → create placeholder → verify DB state
    shopping-import.test.ts      -- Import purchased items → verify only purchased=true imported
    recipe-save.test.ts          -- Save recipe with ingredients → verify atomic (no partial state)
    meal-plan-done.test.ts       -- Mark done → verify macros logged + stock consumed
    walmart-query.test.ts        -- Verify "Missing Prices" query returns correct products
  hub/
    extension-credentials.test.ts -- Save credentials → verify handler can read them back
    tool-toggles.test.ts         -- Toggle tool → verify MCP Worker respects the toggle
```

**Key difference from v1:** These tests import the SAME query functions/hooks the pages use (or replicate the exact `.from().select().eq()` chain) and run against a real Supabase instance. No mocks.

**What they catch:**

- C1: SplitPage's JSONB → ensure_daily_plan produces NULLs
- #12: importShopping's `.eq('purchased', false)` returns wrong rows
- #11: addStock creates new lot instead of merging
- M1: Extension credentials saved with wrong keys
- M2: Tool toggle names don't match real tool names
- #43: Walmart "Missing Prices" query is inverted

**Rules:**

- Each test creates its own user, runs the exact query the UI makes, asserts the result
- Tests MUST use the same `.from().select().eq()` chain as the page component — copy-paste from the source
- If a query in the UI changes, the test must be updated to match (enforced by code review)

### Layer 3: E2E Playwright Tests — Full Module Coverage (expand existing)

**Purpose:** Browser-level tests that click buttons, fill forms, and verify visible results.

```
apps/web/e2e/
  hub/           # existing 11 tests
  coachbyte/
    today.spec.ts          -- Complete set → verify timer starts, set moves to completed
    today-edit.spec.ts     -- Edit planned set reps/load (once implemented)
    split.spec.ts          -- Edit split → save → verify changes persist on reload
    split-keys.spec.ts     -- Edit split → navigate to Today → verify planned sets have values
    history.spec.ts        -- Verify history shows formatted dates, expandable detail
    prs.spec.ts            -- Verify PR display with rep chips
    settings.spec.ts       -- Change rest duration, plate config → verify persistence
  chefbyte/
    scanner.spec.ts        -- Scan barcode → verify queue item appears, stock changes
    inventory.spec.ts      -- +1 Ctn → verify stock increases, -1 → verify decrease
    inventory-merge.spec.ts -- +1 Ctn twice → verify single lot with qty=2 (not two lots)
    recipes.spec.ts        -- Create recipe with ingredients → verify macros display
    recipe-edit.spec.ts    -- Edit recipe → verify ingredients persist (atomic save)
    meal-plan.spec.ts      -- Add meal → mark done → verify macro page reflects it
    macros.spec.ts         -- Log temp item → verify appears in consumed table → delete it
    shopping.spec.ts       -- Add item → mark purchased → import → verify in inventory
    walmart.spec.ts        -- Verify correct products in Missing Links/Missing Prices
    settings.spec.ts       -- Add product → edit → delete → verify CRUD
  cross-module/
    demo-smoke.spec.ts     -- Login as demo → visit every page → verify no empty/error states
    negative-input.spec.ts -- Type -5 into calories → verify rejected or clamped
    search-wildcards.spec.ts -- Type % into search → verify doesn't match everything
```

**What they catch:**

- C1: `split-keys.spec.ts` edits a split via UI, goes to Today, verifies planned sets have real values
- Timer auto-start: `today.spec.ts` completes a set, verifies timer countdown appears
- #12: `shopping.spec.ts` imports only purchased items
- X10: `negative-input.spec.ts` types negative numbers, verifies rejection
- F1: `search-wildcards.spec.ts` types `%`, verifies filtered results

**Rules:**

- Every page MUST have at least one e2e test
- Every e2e test MUST verify visible UI state, not just URL navigation
- Demo smoke test runs on every PR — catches seed data regressions

### Layer 4: MCP-UI Parity Tests (new)

**Purpose:** Same action via MCP tool and via UI query, verify identical DB outcome.

```
apps/web/src/__tests__/parity/
  consume-stock.parity.test.ts   -- UI consume vs MCP CHEFBYTE_consume → same macros logged?
  add-stock.parity.test.ts       -- UI addStock vs MCP CHEFBYTE_add_stock → same lot behavior?
  complete-set.parity.test.ts    -- UI complete vs MCP COACHBYTE_complete_next_set → same result?
  shopping-add.parity.test.ts    -- UI addItem vs MCP CHEFBYTE_add_to_shopping → same upsert?
  below-min.parity.test.ts       -- UI autoAdd vs MCP CHEFBYTE_below_min_stock → same dedup?
  split-save.parity.test.ts      -- UI saveSplit vs MCP COACHBYTE_update_split → same JSONB keys?
```

**What they catch:**

- M24: UI `p_log_macros: false` vs MCP `true`
- M4: UI saves `reps`/`load` vs MCP saves `target_reps`/`target_load`
- M8: MCP overwrites shopping qty vs UI skips existing
- M9: UI INSERT vs MCP UPSERT on shopping add

**Rules:**

- Each test creates a user, performs the action via UI query chain, performs same action via MCP handler, compares DB state
- If they differ, the test fails and the error message explains which path is wrong

### Layer 5: Error Path Tests (new)

**Purpose:** Verify the app handles failures gracefully, not silently.

```
apps/web/src/__tests__/error-paths/
  query-failure.test.ts       -- Mock Supabase to return error → verify error shown to user
  network-offline.test.ts     -- Set online=false → verify buttons disabled
  token-expired.test.ts       -- Simulate expired token → verify redirect to login
  validation-boundary.test.ts -- Submit forms with edge cases (0, -1, NaN, empty, max+1)
```

**What they catch:**

- X4: Silent error swallowing on all read queries
- X10/X13: Negative numbers accepted
- X11: Zero-ingredient recipe submission
- X1: Token refresh failure handling
- #15/41: Offline state doesn't disable buttons

**Rules:**

- Every page's `loadData` function must be tested with a simulated error
- Every form must be tested with at least: empty required fields, negative numbers, zero values
- These tests CAN mock Supabase (they're testing UI error handling, not DB queries)

### Layer 6: Spec Compliance Checklist (new — not code, but process)

**Purpose:** Human/AI review gate that maps spec requirements to test coverage.

```
docs/testing/spec-coverage-matrix.md
```

A table with every spec bullet point and which test covers it:

| Spec requirement                         | Source          | Test file               | Status  |
| ---------------------------------------- | --------------- | ----------------------- | ------- |
| "consumed/planned/goal (3 values)"       | chefbyte.md:112 | macros.spec.ts          | MISSING |
| "Epley 1RM through 10RM pills"           | coachbyte.md:51 | prs.spec.ts             | MISSING |
| "Offline: disabled buttons + banner"     | coachbyte.md:86 | network-offline.test.ts | MISSING |
| "Import only purchased, non-placeholder" | chefbyte.md:81  | shopping-import.test.ts | COVERED |

**Rules:**

- Updated every time a spec or test changes
- Reviewed during test-quality-review skill — reviewer checks the matrix for gaps
- Any spec line without a test is flagged

---

## Updated Test-Quality-Review Checklist

Add these checks to the existing test-quality-review skill:

### New checks (what v1 missed):

1. **Data path fidelity:** "Does this test use the same query/JSONB keys/column names as the actual UI code?" If the test inserts `target_reps` but the UI saves `reps`, the test is testing the wrong thing.

2. **Seed data coverage:** "Is the seed data tested by running the actual RPC functions against it?" Not just "does the seed INSERT succeed" but "does get_daily_macros return the seeded goals?"

3. **Parity check:** "If this action can be done via both UI and MCP, is there a parity test?" Flag any action that exists in both entry points without a parity test.

4. **Error path coverage:** "Does this page have at least one test for query failure?" If loadData ignores errors, flag it.

5. **Boundary testing:** "Does this form have tests for negative numbers, empty required fields, and SQL special characters?" If not, flag it.

6. **Boolean correctness:** "Are all .eq('column', true/false) queries verified with a test that checks the actual rows returned?" The inverted boolean on importShopping would be caught by a test that asserts "only purchased=true rows are returned."

7. **Full-path tracing:** "Can I trace this feature from UI click → Supabase query → DB function → response → UI update in the test suite?" If any segment is mocked, flag the gap.

---

## Execution Order

1. **Seed smoke tests first** — fastest to write, catches C1/C4/D1/D2 immediately
2. **Full-path integration tests** — catches query bugs (inverted booleans, wrong keys, wrong columns)
3. **E2E expansion** — catches UI-level issues (forms, validation, visible state)
4. **Parity tests** — catches UI/MCP divergence
5. **Error path tests** — catches silent failures
6. **Spec coverage matrix** — catches missing features systematically

## CI Integration

```
# PR checks (must all pass):
1. supabase test db          # pgTAP + seed smoke tests
2. pnpm test                 # unit + integration + parity + error path
3. pnpm e2e                  # Playwright (including demo-smoke)
4. pnpm typecheck            # TypeScript (catches column name typos if types are current)

# Weekly:
5. Regenerate DB types       # Prevents D3 (stale types)
6. Spec coverage audit       # Review matrix for gaps
```

## What This Catches That v1 Didn't

| Bug Category                     | v1   | v2    | How                                |
| -------------------------------- | ---- | ----- | ---------------------------------- |
| Wrong JSONB keys (C1)            | MISS | CATCH | Seed smoke + full-path integration |
| Wrong seed config keys (C4/D1)   | MISS | CATCH | Seed smoke tests                   |
| Inverted booleans (#12)          | MISS | CATCH | Full-path integration + e2e        |
| Silent error swallowing (X4)     | MISS | CATCH | Error path tests                   |
| Negative input acceptance (X10)  | MISS | CATCH | Boundary tests + e2e               |
| UI/MCP behavior divergence (M24) | MISS | CATCH | Parity tests                       |
| Missing spec features            | MISS | CATCH | Spec coverage matrix               |
| Wrong query filters (#43)        | MISS | CATCH | Full-path integration              |
| Extension credential keys (M1)   | MISS | CATCH | Full-path integration              |
| Tool toggle names (M2)           | MISS | CATCH | Full-path integration              |
| Lot merge vs proliferation (#11) | MISS | CATCH | E2E + integration                  |
| Timer auto-start from split      | MISS | CATCH | E2E split-keys + today             |
| Stale DB types (D3)              | MISS | CATCH | Weekly regen + typecheck           |
