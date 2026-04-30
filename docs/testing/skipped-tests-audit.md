# Skipped Tests Audit

Audit date: 2026-04-30  
Auditor: Agent A3 (coverage-audit branch)

Methodology: `git grep -nE '(it|test|describe)\.(skip|todo)\b|it\.skipIf|pytest\.skip|pytest\.mark\.skip'` across
`apps/web/src/__tests__`, `supabase/tests`, `tests/e2e`, `hardware/live-shelf/server/tests`,
`hardware/live-shelf/server/cloud/tests`.

**Total skipped found: 11** (all `it.skipIf` — no hard `.skip` or `.todo`; no pgTAP or e2e skips).  
**DO NOT unskip in this PR — this document is the only deliverable.**

---

## Skipped Tests Table

| File:Line                                                                       | Test Name                                                                 | Reason for Skip                                                                                                                                                              | Verdict           | Action                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts:223` | `returns 404 for barcode not found in OpenFoodFacts`                      | `RUN_LIVE_OFF=1` gate — test hits the real OpenFoodFacts API; flakes under OFF rate limiting and intermittent 5xx. Disabled in commit c932227.                               | `legitimate-gate` | Keep gate; run manually with `RUN_LIVE_OFF=1 pnpm test:integration` before releasing barcode features. |
| `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts:246` | `looks up a real barcode from OpenFoodFacts`                              | Same `RUN_LIVE_OFF=1` gate — live OpenFoodFacts call.                                                                                                                        | `legitimate-gate` | Same as above.                                                                                         |
| `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts:270` | `Coca-Cola Zero (049000042566) returns correct OFF data`                  | Same `RUN_LIVE_OFF=1` gate.                                                                                                                                                  | `legitimate-gate` | Same as above.                                                                                         |
| `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts:297` | `Nutella (3017620422003) returns correct OFF data with nutriments`        | Same `RUN_LIVE_OFF=1` gate.                                                                                                                                                  | `legitimate-gate` | Same as above.                                                                                         |
| `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts:324` | `Coca-Cola Original EU (5449000000996) returns correct OFF data`          | Same `RUN_LIVE_OFF=1` gate.                                                                                                                                                  | `legitimate-gate` | Same as above.                                                                                         |
| `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts:351` | `real barcode returns suggestion=null and valid OFF data when no API key` | Same `RUN_LIVE_OFF=1` gate.                                                                                                                                                  | `legitimate-gate` | Same as above.                                                                                         |
| `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts:384` | `OFF response includes serving_size and nutriments fields`                | Same `RUN_LIVE_OFF=1` gate.                                                                                                                                                  | `legitimate-gate` | Same as above.                                                                                         |
| `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts:458` | `OFF API returns correct nutriment data for Nutella (3017620422003)`      | Same `RUN_LIVE_OFF=1` gate.                                                                                                                                                  | `legitimate-gate` | Same as above.                                                                                         |
| `hardware/live-shelf/server/tests/test_cloud_contract.py:604`                   | `test_cloud_contract` (edge-function source path contract check)          | `pytest.skip` — triggered when the file `supabase/functions/shelf-ingest/index.ts` is not found relative to the test runner's cwd. Defensive path-existence guard.           | `legitimate-gate` | Run from repo root (`hardware/live-shelf/`) to satisfy the path. No code change needed.                |
| `hardware/live-shelf/server/tests/test_capture_frames_same_file.py:153`         | Unnamed platform guard                                                    | `pytest.skip("symlinks unsupported")` — platform capability check; fires when the OS doesn't support symlinks (Windows). Pi runs Linux so this never fires in production CI. | `legitimate-gate` | No action — correct defensive guard.                                                                   |
| `hardware/live-shelf/server/tests/test_capture_frames_same_file.py:165`         | Unnamed platform guard                                                    | `pytest.skip("symlink creation not permitted on this platform")` — companion guard for restricted-permission environments (e.g., Docker without `--cap-add SYS_ADMIN`).      | `legitimate-gate` | No action — correct defensive guard.                                                                   |

---

## Summary

| Verdict           | Count |
| ----------------- | ----- |
| `legitimate-gate` | 11    |
| `abandoned`       | 0     |
| `flake`           | 0     |
| `tech-debt`       | 0     |

All 11 skipped tests are guarded by legitimate environment/capability conditions:

- **8× analyze-product `it.skipIf(skipLiveOff)`** — these hit the real OpenFoodFacts API and
  are intentionally excluded from CI to prevent rate-limit flakes. The guard was deliberately
  introduced in commit c932227 with a restoration plan documented in the file header. These tests
  have real assertions and will pass when OFF is accessible; they should be run in a nightly
  job or before each barcode feature release.

- **1× cloud_contract pytest.skip** — path-existence guard that prevents a false-positive
  failure when the test is not run from the repo root. Informational test; correct behaviour.

- **2× capture_frames_same_file pytest.skip** — OS-capability guards (symlinks). Correct
  defensive pattern; not applicable on Linux/Pi.

**No tests were unskipped in this PR.** Follow-up actions:

1. Add `RUN_LIVE_OFF=1 pnpm test:integration` to the nightly CI schedule or a manual gate job.
2. Document the nightly run in `docs/testing/` so future developers know to run it before barcode feature releases.
