#!/usr/bin/env bash
# scripts/verify/cloud-invariants.sh
#
# Shell wrapper for the cloud-outbox payload invariant sweep.
#
# Exits 0 (pass / skip) when:
#   - No DB snapshot path is configured (LIVE_SHELF_DB_PATH is unset or empty)
#   - The configured path does not exist yet (first-run, Pi not synced)
#   - All rows in cloud_outbox pass assert_payload_invariants
#
# Exits 1 (fail) when any payload violates a cross-namespace invariant.
#
# ---------------------------------------------------------------------------
# WIRING GUIDE (for CI or cron):
#
#   1. Set LIVE_SHELF_DB_PATH to the Pi DB snapshot before running.
#      In CI, scp the file first:
#
#        scp pi@192.168.0.181:/home/pi/livetrack/livetrack.db /tmp/livetrack-snapshot.db
#        LIVE_SHELF_DB_PATH=/tmp/livetrack-snapshot.db bash scripts/verify/cloud-invariants.sh
#
#   2. Or export LIVE_SHELF_DB_PATH in your shell profile / CI env:
#
#        export LIVE_SHELF_DB_PATH=/home/jeremy/pi-snapshots/livetrack.db
#
#   3. The sweep is read-only — safe to run against a live DB copy.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

DB_PATH="${LIVE_SHELF_DB_PATH:-}"

if [[ -z "$DB_PATH" ]]; then
  echo "  cloud-invariants: LIVE_SHELF_DB_PATH not set — skipping sweep."
  echo "  (Set LIVE_SHELF_DB_PATH to a Pi DB snapshot path to enable.)"
  exit 0
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "  cloud-invariants: DB not found at '$DB_PATH' — skipping sweep."
  exit 0
fi

# Prefer the Pi venv's Python (has project deps); fall back to system python3.
VENV_PYTHON="$REPO_ROOT/hardware/live-shelf/.venv/bin/python"
if [[ -x "$VENV_PYTHON" ]]; then
  PYTHON="$VENV_PYTHON"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  echo "  ERROR: python3 not found on PATH." >&2
  exit 1
fi

exec "$PYTHON" "$REPO_ROOT/scripts/verify/cloud-invariants.py" "$DB_PATH"
