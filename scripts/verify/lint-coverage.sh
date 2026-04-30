#!/usr/bin/env bash
# scripts/verify/lint-coverage.sh — lint-coverage gate.
#
# Asserts that no first-party source path is silently excluded by the
# eslint or ruff ignore globs. Delegates to lint-coverage.py, which
# walks the known source trees and verifies each path is reachable by
# its respective linter.
#
# Exit codes:
#   0  — all paths covered (linter reaches them, even if violations found)
#   1  — one or more paths silently excluded (gate fail)
#   2  — usage / setup error

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PYTHON_BIN=""
# Prefer the live-shelf venv (it has all project deps + ruff installed).
VENV="$REPO_ROOT/hardware/live-shelf/.venv/bin/python"
if [[ -x "$VENV" ]]; then
  PYTHON_BIN="$VENV"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  echo "ERROR: python3 not found — cannot run lint-coverage gate." >&2
  exit 2
fi

exec "$PYTHON_BIN" "$REPO_ROOT/scripts/verify/lint-coverage.py" "$@"
