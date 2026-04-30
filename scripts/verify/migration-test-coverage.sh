#!/usr/bin/env bash
# scripts/verify/migration-test-coverage.sh
#
# Gate: every migration in supabase/migrations/*.sql must either have a
# corresponding pgTAP test that exercises the objects it introduces, or
# carry a "-- no-test: <reason>" header comment.
#
# Exit codes:
#   0 — all migrations covered or explicitly exempted
#   1 — one or more uncovered migrations without -- no-test: annotation

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/verify/migration-test-coverage.py"

if [[ ! -f "$SCRIPT" ]]; then
  echo "ERROR: migration-test-coverage.py not found at $SCRIPT" >&2
  exit 1
fi

exec python3 "$SCRIPT" "$@"
