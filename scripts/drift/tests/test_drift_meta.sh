#!/usr/bin/env bash
# scripts/drift/tests/test_drift_meta.sh
#
# Meta-test for the drift gate (VERIFY.md "Gate: Drift → Meta-test").
# Drives scripts/drift/check.sh through each mock state and asserts the
# expected exit code + artifact shape. Purely mechanical — no network.
#
#   ok     → exit 0, artifact.ok == true, state == "in_sync"
#   ahead  → exit 0, artifact.ok == true, state == "ahead"
#   behind → exit 1, artifact.ok == false, state == "behind"
#   error  → exit 2, artifact.ok == false, state == "cli_error"
#
# Exit 0 on pass, non-zero on fail.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

CHECK="$REPO_ROOT/scripts/drift/check.sh"
ARTIFACT="$REPO_ROOT/.verify/drift.json"

if [[ ! -x "$CHECK" ]]; then
  echo "FAIL: $CHECK not found or not executable" >&2
  exit 2
fi

FAIL=0

assert_state() {
  # Args: mock_token expected_exit expected_state expected_ok
  local mock="$1" want_exit="$2" want_state="$3" want_ok="$4"
  echo "[meta] drift: mock=$mock" >&2

  set +e
  bash "$CHECK" --mock-dry-run-output "$mock" >/dev/null 2>&1
  local got_exit=$?
  set -e 2>/dev/null || true

  if [[ "$got_exit" != "$want_exit" ]]; then
    echo "FAIL: mock=$mock expected exit=$want_exit got exit=$got_exit" >&2
    FAIL=1
    return
  fi

  if [[ ! -f "$ARTIFACT" ]]; then
    echo "FAIL: mock=$mock no artifact at $ARTIFACT" >&2
    FAIL=1
    return
  fi

  # Extract state + ok via node (portable vs. jq dependency).
  local parsed
  parsed="$(node -e "
    const a = require('$ARTIFACT');
    process.stdout.write(JSON.stringify({state: a.state, ok: a.ok}));
  ")"
  local got_state got_ok
  got_state="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).state)" "$parsed")"
  got_ok="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).ok))" "$parsed")"

  if [[ "$got_state" != "$want_state" ]]; then
    echo "FAIL: mock=$mock expected state=$want_state got state=$got_state" >&2
    FAIL=1
    return
  fi
  if [[ "$got_ok" != "$want_ok" ]]; then
    echo "FAIL: mock=$mock expected ok=$want_ok got ok=$got_ok" >&2
    FAIL=1
    return
  fi

  echo "PASS: mock=$mock exit=$got_exit state=$got_state ok=$got_ok" >&2
}

assert_state "ok"     0 "in_sync"   "true"
assert_state "ahead"  0 "ahead"     "true"
assert_state "behind" 1 "behind"    "false"
assert_state "error"  2 "cli_error" "false"

# Extra check: artifact schema conforms to the shared VERIFY.md shape.
node -e "
const a = require('$ARTIFACT');
const required = ['gate', 'ok', 'ran_at', 'duration_ms', 'checks', 'failures'];
for (const k of required) {
  if (!(k in a)) { console.error('FAIL: artifact missing key:', k); process.exit(1); }
}
if (a.gate !== 'drift') { console.error('FAIL: artifact gate != drift'); process.exit(1); }
if (!Array.isArray(a.checks)) { console.error('FAIL: checks not an array'); process.exit(1); }
if (!Array.isArray(a.failures)) { console.error('FAIL: failures not an array'); process.exit(1); }
console.error('PASS: artifact schema conforms');
" || FAIL=1

if [[ "$FAIL" -ne 0 ]]; then
  echo "[meta] drift meta-test FAILED" >&2
  exit 1
fi
echo "[meta] drift meta-test PASSED" >&2
exit 0
