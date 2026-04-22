#!/usr/bin/env bash
# scripts/mutation/python.sh — Stub for Python mutation testing (mutmut).
#
# Status: DEFERRED. Python code (hardware/live-shelf/server/) has its own
# test infrastructure; wiring mutmut against it is a separate follow-up.
#
# For now, TS mutation testing via Stryker covers the cloud-side contract
# surface (MCP tool handlers, RPC boundaries, shared utilities), which is
# where tautological tests are most consequential.
set -euo pipefail
cat >&2 <<'EOF'
[mutation/python] Python mutation testing is NOT yet wired.
Run the TypeScript mutation gate via:  bash scripts/mutation/run.sh
Tracking: scripts/mutation/README.md ("Python mutmut" section).
EOF
exit 0
