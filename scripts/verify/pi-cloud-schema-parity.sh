#!/usr/bin/env bash
# scripts/verify/pi-cloud-schema-parity.sh
#
# Wrapper around pi-cloud-schema-parity.py that:
#   1. Checks for python3 on PATH (error if absent).
#   2. Passes PI_DB_PATH + PG_DSN from environment.
#   3. Propagates the exit code from the Python script.
#
# CI (no PI_DB_PATH set) → exits 0 with a note (Python script handles this).
# Local with Pi DB → full parity check.
#
# Set PG_DSN to override the default local Supabase DSN:
#   postgresql://postgres:postgres@localhost:54322/postgres

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/verify/pi-cloud-schema-parity.py"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not on PATH — cannot run pi-cloud-schema-parity." >&2
  exit 1
fi

exec python3 "$SCRIPT" "$@"
