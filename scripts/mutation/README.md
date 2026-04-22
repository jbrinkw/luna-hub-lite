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
# Full run across every registered workspace config — slow (minutes).
# For nightly / pre-release only.
pnpm verify:mutation

# Sampled mode — mutates only the files you specify. run.sh auto-routes
# each file to the matching workspace config (extensions, mcp-worker,
# or web-shared). Measured ~30-90 seconds per small file (~200 lines).
pnpm verify:mutation --related extensions/obsidian/tools/vault-parser.ts
pnpm verify:mutation --related apps/mcp-worker/src/validate.ts
pnpm verify:mutation --related apps/web/src/shared/dates.ts

# Mixing files across workspaces is fine — run.sh invokes each matching
# config once with the corresponding subset:
pnpm verify:mutation --related \
  extensions/obsidian/tools/vault-parser.ts \
  apps/mcp-worker/src/tool-executor.ts \
  apps/web/src/shared/realtimeHealth.ts

# Files outside every known scope are skipped with a warning and the
# run exits 0 with a no-op artifact. PR-scale `--related` runs never
# fail just because someone touched a README.
pnpm verify:mutation --related docs/something.md   # → no-op, exit 0

# Single explicit config (bypass the router):
pnpm verify:mutation --config stryker.mcp-worker.conf.json
```

Under the hood everything calls `bash scripts/mutation/run.sh`, which
iterates the config registry and aggregates per-config reports into one
`.verify/mutation.json` artifact.

## Reading the results

Per-run artifacts:

| Path                                        | Purpose                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `.verify/mutation.json`                     | Aggregated artifact per the VERIFY.md schema. Covers every Stryker config invoked. Reviewer reads. |
| `reports/mutation/mutation.json`            | Raw Stryker JSON from `stryker.conf.json` (extensions).                                            |
| `reports/mutation/mutation-mcp-worker.json` | Raw Stryker JSON from `stryker.mcp-worker.conf.json`.                                              |
| `reports/mutation/mutation-web-shared.json` | Raw Stryker JSON from `stryker.web-shared.conf.json`.                                              |
| `.verify/mutation.log`                      | Concatenated Stryker stdout across every invoked config. Useful when debugging a misconfig.        |

Key fields in `.verify/mutation.json`:

```jsonc
{
  "gate": "mutation",
  "ok": true,
  "mode": "sampled" | "full" | "custom",
  "summary": {
    "overall_score_pct": 73.21, // (killed + timeout) / (detected + undetected)
    "killed": 82,
    "survived": 25,
    "timeout": 3,
    "no_coverage": 7
  },
  "files": [
    {
      "config": "stryker.mcp-worker.conf.json",
      "file": "apps/mcp-worker/src/validate.ts",
      "score_pct": 93.59,
      "killed": 73,
      "survived": 5,
      ...
    }
  ],
  "checks": [
    { "name": "stryker-ran:stryker.conf.json",            "ok": true, "evidence": "..." },
    { "name": "stryker-ran:stryker.mcp-worker.conf.json", "ok": true, "evidence": "..." },
    { "name": "stryker-ran:stryker.web-shared.conf.json", "ok": true, "evidence": "..." },
    { "name": "threshold-break",                          "ok": true, "evidence": "..." }
  ],
  "failures": []
}
```

Each `stryker-ran:<config>` check is an evidence line covering that config.
A failing config leaves a corresponding entry in `failures[]`. `ok: true`
requires every config in the run to pass its break threshold AND every
report to parse cleanly.

## Scope & configuration

Three Stryker configs, one per workspace that has a working unit-test layer:

| Config                         | Workspace          | Contract files mutated                                                                                                                                   |
| ------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stryker.conf.json` (root)     | `extensions/`      | `extensions/**/*.ts` — Obsidian / Todoist / Home Assistant tool handlers. Tested by `packages/app-tools/src/__tests__/extensions.test.ts`.               |
| `stryker.mcp-worker.conf.json` | `apps/mcp-worker/` | `validate.ts`, `sse.ts`, `voice-ack.ts`, `tool-executor.ts`, `tool-logger.ts`, `chat-streaming.ts`. Tested by `apps/mcp-worker/src/__tests__/*.test.ts`. |
| `stryker.web-shared.conf.json` | `apps/web/`        | `shared/dates.ts`, `shared/constants.ts`, `shared/realtimeHealth.ts`. Tested by `apps/web/src/__tests__/unit/{pure,shared}/*.test.ts`.                   |

`scripts/mutation/run.sh` routes `--related <file>` to the matching config
by path prefix. Adding a new config: append to `ALL_CONFIGS` + the
`config_for_file` case statement in `run.sh`, then create the
`stryker.<workspace>.conf.json` file with its own `mutate[]` list and
distinct `jsonReporter.fileName`. Follow the existing configs verbatim.

### Deferred scopes (explicit non-goals)

- `packages/app-tools/src/{coachbyte,chefbyte}/*.ts` — only have integration
  tests that require a live Supabase. Out of scope for PR-scale sampled runs.
- `apps/web/src/shared/useRealtimeInvalidation.ts` — tests need jsdom +
  fake timers + a fully-mocked Supabase client; Stryker's per-test coverage
  analysis has flaky timeouts on mutants of this file. Covered indirectly
  by component tests that render pages consuming the hook.
- `apps/web/src/**` outside `shared/` — React component surfaces. Most
  Stryker mutants there are semantically-equivalent (class-name order,
  whitespace) and the signal-to-noise ratio is poor.

### Stryker v9 quirk: vitest `root` vs relative `setupFiles`

Stryker's vitest-runner sets vitest's `root` to the SANDBOX root (the copy
of the whole monorepo it stages under `.stryker-tmp*/sandbox-*`). When a
vitest config uses a relative `setupFiles` path like
`'./src/__tests__/setup.ts'`, that path resolves against `root` — i.e.
the sandbox root, not the workspace directory. apps/web's real vitest
config does exactly this, so Stryker then can't find setup.ts and every
test file fails with "Cannot find module .../src/**tests**/setup.ts".

Workaround (see `stryker.web-shared.conf.json`): point Stryker at a
**stryker-only wrapper** at
`scripts/mutation/stryker-configs/vitest.web.config.ts` that resolves
every path via `path.resolve(__dirname, ...)`. Apps/web's normal test
suite continues to use its own vitest config unchanged; only Stryker uses
the wrapper. The mcp-worker workspace doesn't need this because its
vitest config has no setupFiles. If you add a new config and hit the same
failure, copy the wrapper pattern rather than mutating the workspace
vitest config.

## Thresholds

All configs share the same thresholds (from each `stryker.*.conf.json`):

- `high: 60` — "good" contract coverage; reported green.
- `low: 40` — warning zone.
- `break: 40` — below this, Stryker exits non-zero and the gate fails.

A config breaks the gate independently — if mcp-worker drops below 40%
while extensions sits at 55%, `run.sh` propagates mcp-worker's non-zero
exit and the aggregate `ok` is false.

Timeouts: `timeoutMS: 10000` per mutant (+50% `timeoutFactor`). Infinite
loops from mutations will be killed fast.

## Adjusting thresholds

Edit the relevant `stryker.*.conf.json` → `thresholds`. Lower `break`
only if you're onboarding a legacy workspace with known weak coverage;
raise it once you've burned down the survivor list. Do NOT set `break: 0`
— that makes the gate informational only and silently lets tautologies
land.

## Meta-test

`scripts/mutation/tests/test_mutation_meta.sh` runs in two phases:

**Phase A — rigor discrimination.** Two fixtures in
`scripts/mutation/fixtures/`:

- `good_contract.ts` with a thorough test → expect score **> 80%**.
- `tautology.ts` with `expect(fn).toBeDefined()` → expect score **< 30%**.

Asserts `good_score > taut_score`. If Stryker's output is broken (wrong
runner, no coverage), Phase A catches it before the real gate is trusted.

**Phase B — multi-config aggregation.** Runs
`scripts/mutation/run.sh --related <one file per config> --skip-python`
and asserts:

1. Every registered config produced an `stryker-ran:<config>` check in
   `.verify/mutation.json` with `ok: true`.
2. `files[]` in the artifact contains exactly the files we asked about.
3. An out-of-scope `--related README.md` run is handled gracefully
   (exit 0, artifact records a passing `no-op` check, `files[]` empty).

Phase B guards against the specific failure mode where a new config is
declared but `run.sh` silently drops its report because of a prefix
mismatch or a missing `jsonReporter.fileName`.

Run: `bash scripts/mutation/tests/test_mutation_meta.sh`

## Runtime expectations

| Scope                                            | Runtime  |
| ------------------------------------------------ | -------- |
| Single file, sampled                             | 30–90 s  |
| Extensions full (`stryker.conf.json`)            | 3–8 min  |
| MCP-worker full (`stryker.mcp-worker.conf.json`) | 1–2 min  |
| Web-shared full (`stryker.web-shared.conf.json`) | 1–2 min  |
| All three configs, full                          | 5–12 min |
| Meta-test (2 fixtures + multi-config probe)      | 2–4 min  |

Full runs are for nightly CI. Sampled mode is what PR checks invoke.

## Python gate (mutmut)

Python mutation testing for the Pi server (`hardware/live-shelf/server/`).
Wired via [mutmut 3.x](https://mutmut.readthedocs.io/) running inside
the Pi venv at `hardware/live-shelf/.venv/`. Same break threshold (40%)
and high watermark (60%) as the TS Stryker gate.

### How to invoke

```bash
# Sampled — mutate one or more Python files. Paths may be absolute,
# repo-relative (hardware/live-shelf/server/...) or already relative to
# hardware/live-shelf. The driver normalizes and routes them.
bash scripts/mutation/python.sh --related \
  hardware/live-shelf/server/shelves.py

# Full mode — mutates every file listed in hardware/live-shelf/setup.cfg
# under [mutmut] paths_to_mutate. Slow — minutes. Nightly scope.
bash scripts/mutation/python.sh

# Soft-skip when the Pi venv isn't installed (CI contributors who
# don't touch Pi code). Writes an artifact with skipped:true, exit 0.
bash scripts/mutation/python.sh --skip-on-missing-venv
```

Or use the combined orchestrator (runs TS + Python):

```bash
# Both runtimes. Python files in --related are auto-routed to python.sh
# via the hardware/live-shelf/server/*.py path prefix.
bash scripts/mutation/run.sh --related \
  hardware/live-shelf/server/shelves.py \
  apps/mcp-worker/src/foo.ts

# Stryker only (e.g., Pi venv not present on this machine).
bash scripts/mutation/run.sh --skip-python
```

### What it covers

Contract surface only — see
`hardware/live-shelf/setup.cfg` → `[mutmut] paths_to_mutate`. Initially:

- `server/shelves.py`, `server/config.py` — top-level service modules
- `server/handlers/{scale_events, brightness, weight}.py` — shelf
  session state machines
- `server/cloud/{outbox, integration, client}.py` — Pi→cloud sync

Not covered yet:

- `server/camera/`, `server/classifier/` — too much real-hardware /
  real-LLM path; their test mocks don't constrain enough logic to
  produce high-signal mutation scores.
- `server/scripts/` — one-shot operator tools, not contract code.
- `server/intake/`, `server/reconciler/` — tests fake too much of the
  world as currently written.

Expand `paths_to_mutate` as coverage burn-down reveals additional
contract-layer surface worth gating.

### Artifacts

| Path                                    | Purpose                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `.verify/mutation-python.json`          | Normalized VERIFY.md artifact (per-file scores + summary). Reviewer reads.                      |
| `.verify/mutation.json`                 | Combined run.sh artifact; contains TS + Python in `runtimes.python.*`.                          |
| `.verify/mutation-python.log`           | mutmut stdout — useful when debugging a misconfigured mutant.                                   |
| `reports/mutation/mutation-python.json` | Per-file mutmut breakdown + raw cicd-stats summary.                                             |
| `hardware/live-shelf/mutants/`          | Ephemeral mutmut working directory (meta, mutant sources). Rebuilt each run — safe to `rm -rf`. |

Key fields mirror the TS artifact:

```jsonc
{
  "gate": "mutation",
  "runtime": "python",
  "ok": true,
  "mode": "sampled" | "full",
  "thresholds": { "break": 40, "high": 60 },
  "summary": {
    "overall_score_pct": 67.74,
    "killed": 42, "survived": 20, "timeout": 0, "no_tests": 0, ...
  },
  "files": [
    { "file": "hardware/live-shelf/server/shelves.py", "score_pct": 67.74, ... }
  ],
  "checks": [...], "failures": [...]
}
```

### Thresholds

- `break = 40` — below this, python.sh exits non-zero and the gate
  fails (threshold enforced by the driver; mutmut 3.x doesn't have a
  built-in score floor).
- `high  = 60` — informational. Reported in `checks[]` but not gating.

To change: edit the `BREAK_THRESHOLD` / `HIGH_THRESHOLD` variables at
the top of `scripts/mutation/python.sh`.

### Configuration

`hardware/live-shelf/setup.cfg` → `[mutmut]` section:

- `paths_to_mutate` — full-mode source list. Overridden in place by
  python.sh during `--related` mode (backup + restore via an EXIT
  trap).
- `tests_dir` — pytest selection. Defaults to `server/tests/`.
- `also_copy` — `server/` and `firmware/` are carried into the mutant
  sandbox so test-time `from server.x import y` + firmware-contract
  assertions still resolve.
- `pytest_add_cli_args` — `-q -x --no-header -p no:cacheprovider
--ignore=server/tests/test_integration.py`. The ignore is load-bearing:
  `test_integration.py` leaks subprocess/db handles that segfault the
  Python interpreter at exit when combined with other test files in
  the same process. The tests still run in the regular pytest suite;
  they're excluded only from the mutation gate.

### Meta-test

`scripts/mutation/tests/test_python_meta.sh` runs mutmut against two
fixtures in `scripts/mutation/fixtures/python/`:

- `good_contract/` — rigorous boundary tests → expect score **> 80%**
  (verified at 100%).
- `tautology/` — defined-ness-only tests → expect score **< 30%**
  (verified at 0%).

And asserts `good_score > tautology_score`. If the gate stops
discriminating rigor (broken config, wrong runner, coverage collapse),
this meta-test catches it before the real gate is trusted.

Run: `bash scripts/mutation/tests/test_python_meta.sh`

### Runtime expectations

| Scope                                                | Runtime   |
| ---------------------------------------------------- | --------- |
| Single small file (shelves.py, ~62 mutants), sampled | 10-20 s   |
| Single medium file (outbox.py, ~300 lines)           | 1-3 min   |
| Full contract surface (8 files, hundreds of mutants) | ~5-15 min |
| Meta-test (2 tiny fixtures)                          | ~2-4 s    |

### Known limitations

- The `src/` package name is forbidden by mutmut's trampoline (mutation
  of module `src.foo` collides with its own sandbox). Fixtures use
  `fixture_src/` instead. If you add new Python sources, avoid a
  top-level `src/` directory.
- `test_integration.py` is excluded from the mutation pytest invocation
  due to a Python-level segfault on interpreter teardown when combined
  with other test files. Running it alone is fine and unaffected.
- `hardware/live-shelf/mutants/` and `.mutmut-cache/` appear as
  untracked after each run. They're ephemeral — python.sh wipes them
  at the start of every invocation.
- Like Stryker, mutmut reports `no_tests` for mutants on lines not
  covered by the test suite. These are counted as undetected in the
  score calculation (same policy as the TS side).

## Troubleshooting

- **"Stryker not installed"** — run `pnpm install` at the repo root.
  `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` are in the
  root devDependencies.
- **"Vitest failed to find test files related to mutated files"** — the
  web-shared config sets `vitest.related: false` to work around this in
  alias-heavy codebases. If you hit it on a new config, try disabling
  `related` first. If tests still aren't discovered, the tests probably
  import the mutated file via a path alias that vitest can't trace
  without executing.
- **"Cannot find module .../src/**tests**/setup.ts"** — vitest resolved
  a relative `setupFiles` against the Stryker sandbox root. Use absolute
  paths in a stryker-only wrapper under
  `scripts/mutation/stryker-configs/`. See the "Stryker v9 quirk"
  section above.
- **"No tests covered this mutant"** — the mutated line has no test
  exercise. Counted under `no_coverage` in the artifact. Not a tautology
  failure per se, but worth investigating.
- **"All mutants CompileError"** — likely a TS path alias Stryker's
  sandbox doesn't know about. Check the workspace's tsconfig paths and
  the Stryker config's `vitest.configFile` alias resolution.
- **Runs forever / times out** — reduce `concurrency` or narrow `mutate`.
  10-second per-mutant timeout should prevent true hangs, but a very
  large file with many mutants can still take 10+ minutes.
- **Score = null in artifact** — Stryker didn't produce a JSON report
  for the relevant config. Check `.verify/mutation.log` for that
  config's section.

## Contract layer rationale

Why mutate these files first?

1. **MCP tool dispatch + SSE framing (mcp-worker)** — external API
   contract. Agents call these handlers expecting specific behavior;
   weak assertions here let protocol regressions land.
2. **Extension tool handlers (extensions/)** — Obsidian / Todoist / HA
   tool adapters. Same argument: they're the contract a user-facing
   agent call depends on.
3. **Shared auth / date / realtime primitives (web/shared)** — single-
   definition utilities imported by dozens of pages. A silent regression
   in `dates.todayStr()` or `realtimeHealth.setStatus()` breaks many
   features at once.

React component mutants generate lots of semantically-equivalent changes
(class ordering, whitespace) that tests rightly don't constrain. Mutating
them is noisy and low-signal, so those surfaces stay out of scope.
