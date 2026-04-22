# Mutation-testing gate (`scripts/mutation/`)

TypeScript mutation testing via off-the-shelf
[Stryker](https://stryker-mutator.io/). Implements VERIFY.md "Gate: Mutation".

## What it does

Mutates a production source file in small, mechanical ways (flip operators,
delete statements, negate conditions, etc.) then re-runs the tests. Every
mutant that tests FAIL to catch is a "survivor" — proof that the tests don't
actually constrain that line of code. High survivor rate means tests are
tautological, coverage-for-coverage's-sake, or have weak assertions.

## How to invoke

```bash
# Full run — slow (minutes). For nightly / pre-release only.
pnpm verify:mutation

# Sampled mode — mutates only the files you specify. Use on PRs to
# scope down to the touched surface. Measured ~30-90 seconds per
# small file (~200 lines).
pnpm verify:mutation --related packages/app-tools/src/chefbyte/add-meal.ts

# Multiple files:
pnpm verify:mutation --related \
  packages/app-tools/src/chefbyte/add-meal.ts \
  packages/app-tools/src/chefbyte/consume.ts
```

Under the hood both call `bash scripts/mutation/run.sh`, which invokes
Stryker against `stryker.conf.json` at the repo root.

## Reading the results

Two artifacts are produced on every run:

| Path                             | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `.verify/mutation.json`          | Normalized artifact per the VERIFY.md schema. Reviewer reads this. |
| `reports/mutation/mutation.json` | Raw Stryker JSON report (detailed per-mutant records).             |
| `.verify/mutation.log`           | Stryker stdout — useful when debugging a misconfigured mutant.     |

Key fields in `.verify/mutation.json`:

```jsonc
{
  "gate": "mutation",
  "ok": true,
  "mode": "sampled" | "full",
  "summary": {
    "overall_score_pct": 73.21, // (killed + timeout) / (detected + undetected)
    "killed": 82,
    "survived": 25,
    "timeout": 3,
    "no_coverage": 7
  },
  "files": [
    { "file": "packages/app-tools/src/chefbyte/add-meal.ts", "score_pct": 78.5, "killed": 41, "survived": 10, ... }
  ],
  "checks": [...],
  "failures": [...]
}
```

## Scope & configuration

The root `stryker.conf.json` currently targets **only the `@luna-hub/app-tools`
workspace**, which hosts the MCP tool handlers (our primary contract layer).
Other contract surfaces — `apps/mcp-worker/src/` and `apps/web/src/shared/` —
are deferred: Stryker's per-workspace runner config doesn't cleanly handle
three vitest configs in one top-level run, and the CLI layer is where
tautological tests are most consequential. Follow-up: add a second Stryker
config targeting `apps/mcp-worker/` once vitest runner scoping is solved.

Thresholds (from `stryker.conf.json`):

- `high: 60` — "good" contract coverage; reported green.
- `low: 40` — warning zone.
- `break: 40` — below this, Stryker exits non-zero and the gate fails.

Timeouts:

- `timeoutMS: 10000` per mutant (+50% `timeoutFactor`). Infinite loops
  from mutations will be killed fast.

## Adjusting thresholds

Edit `stryker.conf.json` → `thresholds`. Lower `break` if you're onboarding
a legacy workspace with known weak coverage; raise it once you've burned
down the survivor list. Do NOT set `break: 0` — that makes the gate
informational only and silently lets tautologies land.

## Meta-test

`scripts/mutation/tests/test_mutation_meta.sh` runs Stryker against two
fixture files in `scripts/mutation/fixtures/`:

- `good_contract.ts` with a thorough test → expect score **> 80%**.
- `tautology.ts` with `expect(fn).toBeDefined()` → expect score **< 30%**.

And asserts `good_score > taut_score`. If Stryker config is broken (e.g.,
wrong test runner, no coverage), the meta-test catches it before the real
gate is trusted.

Run: `bash scripts/mutation/tests/test_mutation_meta.sh`

## Runtime expectations

| Scope                        | Runtime  |
| ---------------------------- | -------- |
| Single file, sampled         | 30-90 s  |
| `packages/app-tools` full    | 5-15 min |
| Meta-test (2 small fixtures) | 20-40 s  |

Full runs are for nightly CI. Sampled mode is what PR checks invoke.

## Python (mutmut)

Deferred. `scripts/mutation/python.sh` is a stub that exits 0 with a
message. Python code lives under `hardware/live-shelf/server/` and has
its own pytest setup — wiring mutmut is a follow-up once the TS side is
stabilized.

## Troubleshooting

- **"Stryker not installed"** — run `pnpm install` at the repo root.
  `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` are in the
  root devDependencies.
- **"No tests covered this mutant"** — the mutated line has no test
  exercise. Count shows under `no_coverage` in the artifact. Not a
  tautology failure per se, but worth investigating.
- **"All mutants CompileError"** — likely a TS path alias that Stryker's
  sandbox doesn't know about. Check the workspace's tsconfig paths match
  Stryker's `vitest.dir`.
- **Runs forever / times out** — reduce `concurrency` or narrow `mutate`.
  10-second per-mutant timeout should prevent true hangs, but a very
  large file with many mutants can still take 10+ minutes.
- **Score = null in artifact** — Stryker didn't produce a JSON report.
  Check `.verify/mutation.log` for the failure.

## Contract layer rationale

Why mutate MCP tool handlers first?

1. They're the external contract: an AI agent calls `CHEFBYTE_add_meal` and
   expects specific behavior. A tautological test here means the contract
   is unchecked.
2. They aggregate many internal calls (DB, permissions, formatters). Any
   weak assertion lets wide regressions land.
3. React components (UI) generate many semantically-equivalent mutations
   (swap `className` order, etc.), most of which the tests rightly don't
   assert. Mutating them is noisy and low-signal.

When contract-layer coverage is strong, expand to edge-function handlers
and shared utilities.
