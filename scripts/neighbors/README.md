# Impact gate — `scripts/neighbors/`

Pure-shell verification gate defined by `docs/VERIFY.md` §"Gate: Impact".
Given a git-diff range, it runs only the tests that could plausibly be
affected so agents can't sneak cross-cutting changes through without
exercising their neighbors.

Artifact: `.verify/impact.json` (schema: `docs/VERIFY.md`).

## Invoke

```bash
pnpm verify:impact                 # default base = origin/main, head = HEAD
bash scripts/neighbors/impact.sh   # equivalent
bash scripts/neighbors/impact.sh <base>            # compare <base>..HEAD
bash scripts/neighbors/impact.sh <base> <head>     # compare <base>..<head>
IMPACT_DRY_RUN=1 bash scripts/neighbors/impact.sh  # plan, don't execute
```

`IMPACT_DRY_RUN=1` is used by the meta-test — it emits the planned work but
doesn't invoke vitest/pytest/pgTAP. Do not use in CI; it's not a real run.

## What it runs

| Change type                               | Runner                                                           |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `apps/web/**/*.{ts,tsx,js,jsx}`           | `pnpm --filter @luna-hub/web exec vitest related <files>`        |
| `apps/mcp-worker/**/*.{ts,tsx,js,jsx}`    | `pnpm --filter @luna-hub/mcp-worker exec vitest related <files>` |
| `packages/app-tools/**/*.{ts,tsx,js,jsx}` | `pnpm --filter @luna-hub/app-tools exec vitest related <files>`  |
| `packages/ui-kit/**/*.{ts,tsx,js,jsx}`    | bubbles into web workspace (only consumer)                       |
| `hardware/live-shelf/server/**/*.py`      | `pytest` file-level: changed test files + adjacent `tests/` dirs |
| `supabase/{migrations,tests}/**/*.sql`    | `npx supabase test db` (full pgTAP — it's ~2s)                   |

### Why file-level Python selection?

The original VERIFY.md contract asks for `pytest-testmon --changed-since`.
That flag doesn't exist on pytest-testmon today — it uses a `.testmondata`
cache, not git. We fall back to deterministic file-level selection
(changed test files + adjacent `tests/` dirs), which matches the TS side's
`vitest related <files>` semantics. If `pytest-testmon` is installed, a
WARN is logged but the script still uses file-level selection for
reproducibility across worktrees.

Install testmon anyway for watch-mode local dev:

```bash
hardware/live-shelf/.venv/bin/pip install pytest-testmon
```

## Exit codes

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| 0    | pass — all related tests passed, or nothing related    |
| 1    | at least one related test failed                       |
| 2    | harness failure (bad ref, vitest produced no junit, …) |
| 4    | required tool missing (`jq`, `git`, pytest venv)       |

## Meta-test

```bash
bash scripts/neighbors/tests/test_impact_meta.sh
```

Exercises three shapes in a throwaway git worktree:

1. **Case A** — append a comment to `apps/web/src/shared/supabase.ts`, commit,
   assert the gate plans ≥1 vitest file to run for `@luna-hub/web`.
2. **Case B** — add a new markdown file under `docs/`, commit, assert zero
   runner checks fire (doc-only change has no test impact).
3. **Case C** — empty diff (`HEAD..HEAD`), assert 0 changed files and exit 0.

Uses `IMPACT_DRY_RUN=1` so meta-tests don't take minutes. The real gate's
PASS/FAIL behaviour is exercised end-to-end via the reviewer meta-test
(`scripts/reviewer/tests/test_review_meta.sh`).

## Bypass

`.verify/impact.json` is never bypassed directly. Use a PR-level
`verify-bypass-impact` label + a `BYPASS-REASON: <why>` line in the commit
body — the reviewer will skip mutation/impact if the bypass line is present,
but test-count / missing-test-file failures are never bypassed.

## Files

- `impact.sh` — the gate itself.
- `tests/test_impact_meta.sh` — meta-test driver.
