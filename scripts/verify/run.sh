#!/usr/bin/env bash
# scripts/verify/run.sh — driver for `pnpm verify:fast` and `pnpm verify:full`.
#
# Usage: scripts/verify/run.sh fast | full
#
# Runs each step sequentially with timestamped headers. Fails fast on the
# first non-zero exit. Each step's wall-clock duration is reported on the
# success line.
#
# Phase 5 of docs/test-system-fix-plan.md. The pre-push hook
# (.husky/pre-push) routes to one of these modes based on what's about to
# be pushed:
#
#   - docs/markdown/yaml only  → fast
#   - any code file touched    → full
#
# To bypass for emergency fixes only:
#
#   git push --no-verify
#
# This will print a loud warning. The convention for tracking deliberate
# bypasses is to add a footer to the offending commit:
#
#   Verify-skipped: <reason>
#
# That footer is honor-system but visible in `git log`. CI is lint+typecheck
# only — this script is the real test gate.

set -euo pipefail

MODE="${1:-fast}"
if [[ "$MODE" != "fast" && "$MODE" != "full" ]]; then
  echo "usage: scripts/verify/run.sh fast|full" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Steps: declared as an array of "label|command" pairs so we can both print
# the label clearly and run the command. fast = first 4; full = all of them.
FAST_STEPS=(
  "typecheck|pnpm typecheck"
  "lint|pnpm lint"
  "format:check|pnpm format:check"
  "test (vitest, all workspaces)|pnpm test"
)

FULL_STEPS=(
  "${FAST_STEPS[@]}"
  "deno check (supabase edge functions)|bash scripts/verify/deno_check.sh"
  "test:integration (web vs local supabase)|run_integration"
  "test:db (pgTAP)|run_pgtap"
  "Pi unit tests (pytest)|run_pi_pytest"
  "harness (Pi <-> cloud loopback)|pnpm harness"
  "parity_assert (L2 self-test)|run_parity_assert"
  "test:e2e (Phase 2, guarded)|run_e2e_guarded"
)

# ---------------------------------------------------------------------------
# Step helpers — each MUST `exit 1` (or return non-zero) on failure. Using
# functions keeps the step list above declarative.
# ---------------------------------------------------------------------------

run_integration() {
  if ! supabase_running; then
    echo ""
    echo "  ERROR: Supabase local stack is not running."
    echo "  Start it with:  supabase start"
    echo "  Then re-run:    pnpm verify:full"
    return 1
  fi
  pnpm test:integration
}

run_pgtap() {
  if ! supabase_running; then
    echo ""
    echo "  ERROR: Supabase local stack is not running."
    echo "  Start it with:  supabase start"
    echo "  Then re-run:    pnpm verify:full"
    return 1
  fi
  pnpm test:db
}

run_pi_pytest() {
  if [[ ! -d hardware/live-shelf/server ]]; then
    echo "  Skipping (hardware/live-shelf/server not present)."
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "  ERROR: python3 not on PATH; can't run Pi unit tests."
    return 1
  fi
  # Use the Pi venv if present (it has pytest + project deps); fall back to
  # system pytest. Resolve paths to absolute BEFORE the subshell cd so the
  # path stays valid after pwd changes.
  local venv="$REPO_ROOT/hardware/live-shelf/.venv"
  local pytest_bin
  if [[ -x "$venv/bin/pytest" ]]; then
    pytest_bin="$venv/bin/pytest"
  elif command -v pytest >/dev/null 2>&1; then
    pytest_bin="pytest"
  else
    echo "  ERROR: pytest not found (looked in $venv/bin/pytest and PATH)."
    echo "  Bootstrap the Pi venv:  cd hardware/live-shelf && python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt"
    return 1
  fi
  (
    cd "$REPO_ROOT/hardware/live-shelf"
    # test_integration.py used to be excluded here because the integration
    # suite leaked threads + DB handles that segfaulted Python at
    # interpreter exit when combined with the rest of the suite. The
    # 2026-04-27 fix wired AppBundle.shutdown to stop the four background
    # sweepers (lifecycle-retention, system-health-snapshot, disk-retention,
    # scale-events-sweeper) and join classify/reconciler workers; the
    # ignore is no longer needed.
    "$pytest_bin" -x \
      server/tests/ \
      server/cloud/tests/ \
      server/classifier/tests/
  )
}

run_parity_assert() {
  # Runs the parity_assert.py self-test scenario in sandbox (pure in-memory
  # SQLite — no real Pi DB or Supabase connection required). The self-test
  # deliberately seeds the "160.4 g Pi vs 1.6 ctn cloud" unit-mismatch class
  # and asserts the diff engine detects it. Exit non-zero means drift was
  # found or the engine itself errored.
  if ! command -v python3 >/dev/null 2>&1; then
    echo "  ERROR: python3 not on PATH; can't run parity_assert."
    return 1
  fi
  # The self-test scenario always expects DELTAS (it seeds a mismatch on
  # purpose to prove detection works). parity_assert.py exits 1 when deltas
  # are found — which is the DESIRED outcome for self-test. We invert that:
  # if the self-test exits 0 (no deltas detected), the gate was blind and we
  # fail loudly. If it exits 1 (deltas detected = engine works), the gate
  # passes. Any other exit code (2 = usage/import error) also fails.
  local out
  out=$(python3 scripts/harness/parity_assert.py self-test --quiet 2>&1)
  local ec=$?
  if [[ $ec -eq 1 ]]; then
    # Expected: engine caught the mismatch — gate passes.
    echo "  parity_assert self-test: deltas detected as expected (engine OK)"
    return 0
  elif [[ $ec -eq 0 ]]; then
    echo "  ERROR: parity_assert self-test reported NO deltas — the engine"
    echo "  failed to detect the seeded Pi<->cloud unit mismatch. Either the"
    echo "  self-test scenario was modified or the diff engine has regressed."
    echo "  Output: $out"
    return 1
  else
    echo "  ERROR: parity_assert.py exited with code $ec (import/usage error)."
    echo "  Output: $out"
    return 1
  fi
}

run_e2e_guarded() {
  # Phase 2 territory. The e2e harness lives at tests/e2e/ once Phase 2
  # lands. Until then, skip cleanly with a warning instead of erroring —
  # the spec says don't block fast pushes on a not-yet-built suite.
  if [[ -d tests/e2e ]]; then
    pnpm test:e2e
  else
    echo "  WARNING: tests/e2e/ not present — Phase 2 e2e harness has not"
    echo "  landed yet. Skipping. (This will become a hard gate once"
    echo "  Phase 2 ships.)"
    return 0
  fi
}

# ---------------------------------------------------------------------------
# supabase_running — best-effort liveness probe for the local stack.
# ---------------------------------------------------------------------------
supabase_running() {
  # `supabase status` exits 0 when running and prints connection info; exits
  # non-zero (and writes to stderr) when stopped. We only need the boolean.
  if supabase status >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Header / runner.
# ---------------------------------------------------------------------------

print_header() {
  local idx=$1
  local total=$2
  local label=$3
  local ts
  ts="$(date '+%H:%M:%S')"
  printf '\n\033[1;36m==> [%s] verify:%s (%d/%d) %s\033[0m\n' \
    "$ts" "$MODE" "$idx" "$total" "$label"
}

print_success() {
  local label=$1
  local secs=$2
  printf '    \033[0;32mOK\033[0m %s — %ds\n' "$label" "$secs"
}

print_failure() {
  local label=$1
  printf '    \033[0;31mFAIL\033[0m %s\n' "$label"
}

run_step() {
  local idx=$1
  local total=$2
  local pair=$3
  local label="${pair%%|*}"
  local cmd="${pair#*|}"

  print_header "$idx" "$total" "$label"
  local start_ts
  start_ts=$(date +%s)
  if eval "$cmd"; then
    local end_ts
    end_ts=$(date +%s)
    print_success "$label" "$((end_ts - start_ts))"
    return 0
  else
    print_failure "$label"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------

if [[ "$MODE" == "fast" ]]; then
  STEPS=("${FAST_STEPS[@]}")
else
  STEPS=("${FULL_STEPS[@]}")
fi

TOTAL=${#STEPS[@]}
WALL_START=$(date +%s)

printf '\n\033[1;35m+++ verify:%s — %d step(s) +++\033[0m\n' "$MODE" "$TOTAL"

i=1
for step in "${STEPS[@]}"; do
  if ! run_step "$i" "$TOTAL" "$step"; then
    printf '\n\033[0;31m+++ verify:%s FAILED at step %d/%d +++\033[0m\n' \
      "$MODE" "$i" "$TOTAL"
    exit 1
  fi
  i=$((i + 1))
done

WALL_END=$(date +%s)
WALL_SECS=$((WALL_END - WALL_START))
WALL_MIN=$((WALL_SECS / 60))
WALL_REM=$((WALL_SECS % 60))

printf '\n\033[1;32m+++ verify:%s GREEN — %dm %ds wall +++\033[0m\n' \
  "$MODE" "$WALL_MIN" "$WALL_REM"
