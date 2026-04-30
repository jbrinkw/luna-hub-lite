# No-Bypass Verify Policy

**Status:** active 2026-04-30

## Rule

Do not push code that bypassed `pnpm verify:full`. The local pre-push hook
runs it on every push to main; the GH Actions `verify-full` workflow runs
it (subset, see below) on every PR + push to main as a redundant gate.

## Bypass mechanism (`--no-verify`)

`git push --no-verify` skips the local pre-push hook. The hook prints a
loud warning when invoked but cannot prevent the bypass — that's what
`--no-verify` does.

The convention for tracking deliberate bypasses (e.g. emergency hotfix when
the test infra itself is broken):

1. Add a footer to the offending commit:
   ```
   Verify-skipped: <one-line reason>
   ```
2. Resolve as soon as possible with a follow-up commit citing the skipped
   commit:
   ```
   Verify-resolved-by: <short-sha-of-bypass-commit>
   ```
3. The local `pre-commit` hook scans HEAD for unresolved `Verify-skipped:`
   footers on every subsequent commit and warns.

## CI subset (no Supabase)

GH Actions cannot run a full Supabase local stack reliably (Auth
contention + clock-skew flakes that we hit weekly locally). The
`verify-full` workflow runs the subset of `FULL_STEPS` that does NOT
require Supabase:

- typecheck, lint, format:check, vitest unit
- deno check (edge functions)
- parity_assert L2 self-test (in-memory SQLite only)
- cloud-invariants (skips without `LIVE_SHELF_DB_PATH`)
- invariant-monitor (Deno test)
- state-machine (vitest unit)
- splice-uniqueness, schema-parity (skips without `PI_DB_PATH`)
- migration-test-coverage, lint-coverage

The Supabase-dependent steps (`test:integration`, `test:db`, `test:e2e`,
`harness`, `mutation_pair_gate`) only run via the local pre-push hook.

## Why this gap exists

Supabase local is a real Postgres + Auth + Storage + Realtime + Edge stack;
running it inside a GH Actions runner reliably requires solving:

- Container networking + container-to-runner port forwarding
- Auth JWT clock-skew flakes (the `restart_supabase_if_stale` helper in
  `scripts/verify/run.sh` only works locally; CI containers can drift)
- Storage bucket setup
- pgTAP installation

Until that's solved, the local pre-push is the authoritative gate. CI is a
fast-failing redundant safety net for the non-Supabase subset.

## Auditing bypass usage

To list every commit that skipped verify since a date:

```sh
git log --grep '^Verify-skipped:' --since='YYYY-MM-DD'
```

To list unresolved bypasses (still pending a follow-up commit):

```sh
git log --format='%H %s' --grep '^Verify-skipped:' main \
  | while read sha rest; do
      short=$(git rev-parse --short "$sha")
      if ! git log --grep "Verify-resolved-by: ${short}" --format=%H "${sha}..main" | grep -q .; then
        echo "$short $rest"
      fi
    done
```
