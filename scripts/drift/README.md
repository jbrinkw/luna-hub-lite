# Migration-drift gate (`scripts/drift/`)

Catches local-vs-prod migration drift on every PR. Implements VERIFY.md
"Gate: Drift — PR-level".

## What it does

Runs `supabase db push --dry-run --include-all --linked` against the prod
project and classifies the outcome into four states:

| State       | Exit | Meaning                                                                                                       | PR verdict      |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------- | --------------- |
| `in_sync`   | 0    | No migrations to apply. Local and remote agree.                                                               | pass (silent)   |
| `ahead`     | 0    | Local has N new migrations not yet on remote. Forward-only — will apply cleanly on merge.                     | pass (annotate) |
| `behind`    | 1    | Remote has migrations BEFORE the latest local timestamp. `supabase db push` will refuse. Unrecoverable in CI. | FAIL            |
| `cli_error` | 2    | Dry-run crashed for a non-drift reason (network, auth, etc.).                                                 | FAIL            |

The `behind` case is the one that motivated this gate: commit `20260422040000`
landed a local migration dated before a migration already on remote, and
`supabase db push` refused to apply it, blocking deploys until manual rescue.
This gate catches that same failure in a PR instead of in production.

## How to invoke

```bash
# Real mode — requires `supabase link` to have been run.
pnpm verify:drift

# Meta-test mode — canned outputs, no network:
bash scripts/drift/check.sh --mock-dry-run-output ok
bash scripts/drift/check.sh --mock-dry-run-output ahead
bash scripts/drift/check.sh --mock-dry-run-output behind
bash scripts/drift/check.sh --mock-dry-run-output error
```

Both write `.verify/drift.json` per the shared VERIFY.md artifact schema.

## Artifact shape

```jsonc
{
  "gate": "drift",
  "ok": true,
  "mode": "real" | "ok" | "ahead" | "behind" | "error",
  "state": "in_sync" | "ahead" | "behind" | "cli_error",
  "pending_migrations": [
    "20260421120000_add_voice_ack_table.sql"
  ],
  "checks": [...],
  "failures": [...],
  "raw_output": "full supabase CLI stdout+stderr"
}
```

## PR workflow

`.github/workflows/drift-check.yml` runs on every PR to `main` that touches:

- `supabase/migrations/**`
- `supabase/config.toml`
- `scripts/drift/**`
- `.github/workflows/drift-check.yml`

Flow:

1. `actions/checkout@v4`
2. `supabase/setup-cli@v1` pinned to the same version as root devDependencies
   (`2.76.15`). Newer versions may have stricter or looser dry-run output —
   pin matters.
3. `supabase link --project-ref btlfsxammjzkyluophgr` using the
   `SUPABASE_ACCESS_TOKEN` secret.
4. `bash scripts/drift/check.sh` — exit code becomes the job outcome.
5. Upload `.verify/drift.json` and `.verify/drift.log` as artifacts.
6. If PR + drift state != `in_sync` → `actions/github-script@v7` posts
   a comment:
   - `ahead`: "This PR adds N migrations not yet on prod: ..."
   - `behind`: unrecoverable drift, instructions to rebase timestamps
   - `cli_error`: gate failed, see artifact

The comment is informational. The job exit code is what gates the merge.

## Required secrets

| Name                    | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | PAT with `project:read` + `migration:read` scope.                                         |
| `SUPABASE_DB_PASSWORD`  | Only needed if the dry-run wants to issue a shadow-DB connection. Optional in most paths. |

Configure in repo settings → Secrets and variables → Actions.

## Nightly full-schema AST diff

**Deferred.** VERIFY.md also describes a nightly job that dumps both local
and remote DDL, normalizes to an AST, and diffs. That's a larger build:
requires running a local `supabase db reset` on CI (Docker), generating a
canonical schema dump, applying the same to prod via `supabase db dump`,
and running a normalizer that's robust to column-order and constraint-name
noise.

The PR-level dry-run already closes the recurring failure mode that
motivated this gate (historical-order drift). Nightly AST diff catches
silent DDL edits made outside the migrations folder — valuable but not
blocking-critical for Phase 1.

Follow-up tracked at `scripts/drift/README.md` (this file) → ping Agent
Infrastructure when the full-diff is a priority.

## Supabase CLI version pinning

Pinned to **2.76.15** in three places that must stay aligned:

1. Root `package.json` devDependencies (`supabase: ^2.76.15`).
2. `.github/workflows/drift-check.yml` → `supabase/setup-cli@v1 with version`.
3. The check script `scripts/drift/check.sh` resolves `SUPABASE_BIN`, then
   `node_modules/.bin/supabase`, then PATH — all should be the pinned version.

If the CLI changes its dry-run output wording, the string-matching in
`check.sh` may classify states wrong. The meta-test won't catch that
(it uses canned output). When upgrading the pin:

1. Run `supabase db push --dry-run` against a test project with
   actual drift, capture the output.
2. Verify the new output still matches the regexes in `check.sh`:
   `grep -iE 'before the last migration on remote|older local...'`
3. Update both the pin and `check.sh` regex if phrasing changed.

## Meta-test

`scripts/drift/tests/test_drift_meta.sh` drives `check.sh` through all four
mock states and asserts exit codes + artifact shape. No real network, no
supabase link needed. Purely mechanical.

Run: `bash scripts/drift/tests/test_drift_meta.sh`

## Troubleshooting

- **"supabase CLI not found"** — `pnpm install` installs it per `package.json`
  devDependency, but it lands in the workspace's `.bin` not the root. Set
  `SUPABASE_BIN=$(which supabase)` to override, or install the CLI globally.
- **"Access token required"** — `supabase link` wasn't run or token expired.
  In CI: check `SUPABASE_ACCESS_TOKEN` secret is set and non-empty.
- **State = `cli_error` on a project that's actually in sync** — parser
  didn't recognize CLI output. Update the regex in `check.sh` and bump the
  CLI pin if needed.
- **Repeated `ahead` comments on the same PR** — the workflow posts a new
  comment every run. If noisy, gate the annotation step on `github.event.pull_request.synchronize` only. (Not done yet; follow-up if it becomes a problem.)
