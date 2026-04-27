# Testing Workflow

Phase 5 of `docs/test-system-fix-plan.md`. The audit identified a process
gap: agents (and humans) were pushing code that hadn't been verified.
Fixed by moving the test gate from CI to a **mandatory local pre-push
hook**. CI is now lint + typecheck only — fast feedback for the cheap
checks. Everything substantive (unit, integration, db, harness) runs on
the developer's machine before the push reaches origin.

## Two-tier verify

| Script             | Wall-clock | What it runs                                                                 |
| ------------------ | ---------- | ---------------------------------------------------------------------------- |
| `pnpm verify:fast` | ~30 s      | typecheck → lint → format:check → vitest (web + worker + app-tools)          |
| `pnpm verify:full` | 3–5 min    | fast + integration + pgTAP + Pi pytest + harness + e2e (Phase 2 placeholder) |

Both run via `scripts/verify/run.sh`, which:

- runs each step **sequentially** (failures are easier to triage one at a time)
- prints a timestamped header before each step (`==> [HH:MM:SS] verify:fast (3/4) lint`)
- exits non-zero on the first failure
- reports per-step wall-clock and a final green/red banner

### What `verify:fast` catches

The lightweight tier: schema-static checks plus the entire ~1,000-test
Vitest suite (web unit, web integration _units only_, MCP worker, app-tools).
No external services required — runs on a fresh laptop with just `pnpm install`.

Anything you can verify **without a database** is in here. That includes:

- TypeScript type errors (5 packages)
- ESLint and Prettier rule violations
- Pure-function logic (Epley 1RM, macro calc, plate calc, recipe stock status)
- Component render with mocked hooks
- MCP tool handler logic, namespace prefix enforcement, RPC error translation
- OAuth 2.1 endpoint shape, SSE framing, validation

### What `verify:full` adds

The real gate. Layers on:

- **`test:integration`** — Vitest suite that hits the local Supabase HTTP
  surface. Catches edge function CORS / auth / quota / failure-path
  regressions. Requires `supabase start` running.
- **`test:db`** — pgTAP runner against the local Postgres. RLS regressions
  per table, SECURITY DEFINER body correctness, FK cascades, trigger
  invariants. ~30 s.
- **Pi pytest** — `hardware/live-shelf/server/{tests,cloud/tests,classifier/tests}`.
  Pi state machine transitions, in-flight TTL reap, classifier reunite
  guard, catch-all routing, livetrack heartbeat state machine. ~30 s.
- **`harness`** — `scripts/harness/run.py`. 15 Pi↔cloud loopback scenarios
  covering every event kind. ~3 s against a hot stack.
- **`test:e2e`** — Phase 2 territory. Currently a no-op when
  `tests/e2e/` doesn't exist, with a warning. Becomes a hard gate once
  Phase 2 lands its end-to-end Playwright harness.

### Common failures

**Supabase isn't running.** `verify:full` fails fast with:

```
ERROR: Supabase local stack is not running.
Start it with:  supabase start
Then re-run:    pnpm verify:full
```

Fix: run `supabase start` from the repo root and retry.

**Lint complains about `@react-hooks/set-state-in-effect`.** This rule
is part of `eslint-plugin-react-hooks` v7. If it shows as "not found",
your `node_modules/` is stale. Fix: `pnpm install` to refresh.

**Pi pytest can't find `pytest`.** The script looks for
`hardware/live-shelf/.venv/bin/pytest` first, then falls back to the
system `pytest`. Bootstrap the venv:

```bash
cd hardware/live-shelf
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt
```

**`pnpm test:e2e` fails with "no scenarios".** The Phase 2 harness
hasn't shipped yet. The verify driver currently skips this with a
warning instead of failing. Once Phase 2 lands, this becomes a hard
gate.

**Lint times out (~2 min).** This was a regression in the eslint
ignore list — fixed in Phase 5. If you see it come back, check that
`.claude/`, `.stryker-tmp-*/`, `.wrangler/`, and `.venv/` are all in
the `ignores` list in `eslint.config.mjs`.

## Pre-push hook

`.husky/pre-push` is auto-installed by `pnpm install` (via the
`prepare: husky` script in the root `package.json`). It runs on every
`git push` and:

1. Computes the upstream range (`@{u}..HEAD`, or `origin/main..HEAD`
   for new branches)
2. Lists every file in that range
3. Picks **`verify:fast`** if every changed file is a doc/markdown/yaml,
   else **`verify:full`**
4. Runs the chosen script. Non-zero exit aborts the push.

The hook honors `git push --no-verify`, but you should rarely need
that. The verify scripts are designed to be fast enough to run on every
push.

## Bypass convention

```bash
git push --no-verify
```

Bypasses the hook. The convention for tracking deliberate bypasses is
to add a footer to the offending commit:

```
fix(scanner): emergency hot-fix for prod-only crash

Verify-skipped: prod outage at 14:30 UTC; full suite passing on follow-up
```

The `commit-msg` hook (`.husky/commit-msg`) prints a yellow warning at
commit time when it sees this footer:

```
[commit-msg] WARNING: this commit declares Verify-skipped.
  reason: prod outage at 14:30 UTC; full suite passing on follow-up
  The pre-push hook will still run unless you also pass --no-verify.
```

This is honor-system — the hook doesn't block, just informs. The point
is to make a bypass visible in `git log` so a follow-up can re-run the
full suite once the emergency is over.

## Why CI is lean

Two reasons.

1. **GitHub Actions is too slow for the iteration loop.** Boot Supabase
   (~3 min) + cold-start vitest (~10 s) + cold-start pytest (~10 s) +
   Playwright deps install (~30 s) means a 5-minute round-trip on every
   push. Multiply by 20 pushes/day and that's 100 min wasted vs. a 30 s
   local pre-push.

2. **The pre-push hook can't be silently bypassed.** A skipped CI is
   invisible until someone notices the build is red; a skipped pre-push
   leaves a `Verify-skipped:` fingerprint in the commit message, or the
   commit lacks the conventional `Verified: pnpm verify:full` line that
   the reviewer scans for.

The trade-off is that a stale local environment (e.g. a long-running
branch with stale `node_modules`) can pass locally but fail elsewhere.
The fix is `pnpm install && pnpm verify:full` after rebasing, which
takes <1 min on warm caches.

## Phase 1–4 context

Phase 5 is the **process** layer. The other phases are technical:

- **Phase 1** (done) — restore unit + integration tests, gate live-OFF assertions.
- **Phase 2** — end-to-end Playwright harness (`tests/e2e/`).
- **Phase 3** — invariant predicates run after every E2E scenario.
- **Phase 4** — production invariant monitor + admin alerts page.

See `docs/test-system-fix-plan.md` for the full plan.
