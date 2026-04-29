#!/usr/bin/env bash
# scripts/verify/deno_check.sh — Deno typecheck gate for Supabase edge functions.
#
# The 5 edge functions in supabase/functions/ are Deno code:
# jsr:/npm:/https: imports, the global `Deno` namespace, no Node module
# resolution. The project's TypeScript LSP and `tsc --noEmit` cannot
# typecheck them (root tsconfig.json excludes the subtree on purpose).
# This gate runs the actual Deno typechecker so type errors in edge
# functions can't sneak past `pnpm verify:full`.
#
# Wired into scripts/verify/run.sh (full mode only). Skipped automatically
# in fast mode and on machines without Deno installed.
#
# Exit codes:
#   0 — all edge functions clean (or skipped because Deno not on PATH)
#   1 — at least one Deno type error
#
# Manual invocation:
#   bash scripts/verify/deno_check.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FN_DIR="$REPO_ROOT/supabase/functions"

# --- Portability: skip cleanly when Deno isn't installed -----------------
#
# Most contributors don't need Deno locally; the edge runtime is the
# Supabase platform's, not the dev box's. CI / production setups that care
# about edge functions install Deno explicitly (see
# `.github/workflows/`). For everyone else, missing-deno is a WARN, not a
# FAIL — `git push` shouldn't break because someone hasn't installed a
# tool they don't use.
if ! command -v deno >/dev/null 2>&1; then
  printf '\033[1;33m[deno-check] WARNING: deno not on PATH — skipping edge-function typecheck.\033[0m\n'
  printf '[deno-check] Install via https://docs.deno.com/runtime/getting_started/installation/ to enable this gate locally.\n'
  exit 0
fi

if [[ ! -d "$FN_DIR" ]]; then
  # Repo without edge functions — nothing to do.
  exit 0
fi

# --- Discover targets ----------------------------------------------------
#
# Every *.ts file under each per-function directory. We deliberately scope
# to the function dirs (not bare globs) so accidental top-level *.ts files
# in supabase/functions/ aren't typechecked twice. `deno check` is happy
# with a multi-file argv — it deduplicates the import graph internally.
TARGETS=()
while IFS= read -r -d '' f; do
  TARGETS+=("${f#"$FN_DIR"/}")
done < <(find "$FN_DIR" -mindepth 2 -maxdepth 2 -name '*.ts' -type f -print0 | sort -z)

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  printf '\033[1;33m[deno-check] No edge function .ts files found under %s — skipping.\033[0m\n' "$FN_DIR"
  exit 0
fi

DENO_VERSION="$(deno --version 2>/dev/null | head -1 || echo 'unknown')"
printf '[deno-check] %s\n' "$DENO_VERSION"
printf '[deno-check] Checking %d edge-function file(s) under supabase/functions/...\n' "${#TARGETS[@]}"

# `deno check` resolves config (deno.json + import map) from CWD. Run from
# inside supabase/functions/ so the shared config is honored — running
# from the repo root resolves the wrong (or no) config and trips
# "Could not find a matching package for 'npm:...'" errors.
(
  cd "$FN_DIR"
  deno check "${TARGETS[@]}"
)

printf '\033[0;32m[deno-check] OK — all edge functions typecheck cleanly.\033[0m\n'
