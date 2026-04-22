#!/usr/bin/env bash
# scripts/drift/tests/test_nightly_ast_meta.sh
#
# Meta-test for the nightly AST-diff drift gate (VERIFY.md "Gate: Drift →
# Nightly" → "Meta-test"). Drives scripts/drift/nightly-ast-diff.sh via its
# --mock-local/--mock-prod flags with known fixture pairs and asserts:
#
#   1. Same fixture on both sides → empty diff → exit 0, ok=true.
#   2. Fixture pair that differs ONLY in ignored stanzas (roles, grants,
#      owners, comments, SET preamble, statement-reorder) → empty diff
#      after normalization → exit 0, ok=true.
#   3. Fixture pair that differs in a MATERIAL DDL way (missing column)
#      → non-empty diff → exit 1, ok=false, diff.patch non-empty,
#      diff_bytes > 0.
#
# Non-goals: does NOT exercise the GitHub workflow (actionlint covers
# yaml syntax; the `gh issue` flow is tested manually via workflow_dispatch).
#
# Exit 0 on pass, 1 on any failure.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

SCRIPT="$REPO_ROOT/scripts/drift/nightly-ast-diff.sh"
FIXTURES="$REPO_ROOT/scripts/drift/tests/fixtures"
ARTIFACT="$REPO_ROOT/.verify/drift-nightly.json"
DIFF_PATCH="$REPO_ROOT/.verify/diff.patch"

if [[ ! -x "$SCRIPT" ]]; then
  echo "FAIL: $SCRIPT not executable" >&2
  exit 2
fi

for f in local-schema.sql prod-schema.sql ignored-only-a.sql ignored-only-b.sql; do
  if [[ ! -f "$FIXTURES/$f" ]]; then
    echo "FAIL: missing fixture $FIXTURES/$f" >&2
    exit 2
  fi
done

FAIL=0

json_field() {
  # Read a top-level JSON field via python3 (no jq dep). Coerce bool to
  # lowercase "true"/"false" to match JSON convention; everything else
  # goes through str().
  local key="$1" path="$2"
  python3 -c "
import json, sys
with open('$path') as f:
    d = json.load(f)
v = d.get('$key')
if isinstance(v, bool):
    sys.stdout.write('true' if v else 'false')
else:
    sys.stdout.write(str(v))
"
}

run_case() {
  local name="$1" local_fx="$2" prod_fx="$3" want_exit="$4" want_ok="$5" want_diff_nonzero="$6"

  echo "[meta-nightly] case=$name local=$(basename "$local_fx") prod=$(basename "$prod_fx")" >&2

  # Clear prior artifacts so stale data can't satisfy an assertion.
  rm -f "$ARTIFACT" "$DIFF_PATCH"

  set +e
  bash "$SCRIPT" --mock-local "$local_fx" --mock-prod "$prod_fx" >/dev/null 2>&1
  local got_exit=$?
  set -e 2>/dev/null || true

  if [[ "$got_exit" != "$want_exit" ]]; then
    echo "FAIL: $name expected exit=$want_exit got exit=$got_exit" >&2
    FAIL=1
    return
  fi

  if [[ ! -f "$ARTIFACT" ]]; then
    echo "FAIL: $name no artifact at $ARTIFACT" >&2
    FAIL=1
    return
  fi

  local got_ok got_bytes
  got_ok="$(json_field ok "$ARTIFACT")"
  got_bytes="$(json_field diff_bytes "$ARTIFACT")"

  if [[ "$got_ok" != "$want_ok" ]]; then
    echo "FAIL: $name expected ok=$want_ok got ok=$got_ok" >&2
    FAIL=1
    return
  fi

  if [[ "$want_diff_nonzero" == "1" ]]; then
    if [[ "$got_bytes" == "0" ]]; then
      echo "FAIL: $name expected diff_bytes > 0, got 0" >&2
      FAIL=1
      return
    fi
    if [[ ! -s "$DIFF_PATCH" ]]; then
      echo "FAIL: $name expected diff.patch non-empty" >&2
      FAIL=1
      return
    fi
  else
    if [[ "$got_bytes" != "0" ]]; then
      echo "FAIL: $name expected diff_bytes == 0, got $got_bytes" >&2
      FAIL=1
      return
    fi
  fi

  echo "PASS: $name exit=$got_exit ok=$got_ok diff_bytes=$got_bytes" >&2
}

# -----------------------------------------------------------------------------
# Cases
# -----------------------------------------------------------------------------

# 1. Same fixture on both sides — trivial identity case.
run_case "same-file" \
  "$FIXTURES/local-schema.sql" \
  "$FIXTURES/local-schema.sql" \
  0 "true" 0

# 2. Pair that differs ONLY in ignored stanzas — normalizer must erase the
#    diff. THIS is the contract load-bearing test: if someone adds a rule
#    to the normalizer that mis-ignores a real DDL change, or drops a
#    legitimate ignore, this case catches it.
run_case "ignored-only" \
  "$FIXTURES/ignored-only-a.sql" \
  "$FIXTURES/ignored-only-b.sql" \
  0 "true" 0

# 3. Pair with a MATERIAL column-missing divergence — normalizer must
#    surface it.
run_case "material-drift" \
  "$FIXTURES/local-schema.sql" \
  "$FIXTURES/prod-schema.sql" \
  1 "false" 1

# -----------------------------------------------------------------------------
# Artifact schema spot-check (VERIFY.md shared shape).
# -----------------------------------------------------------------------------
python3 - <<'PY' "$ARTIFACT" || FAIL=1
import json, sys
path = sys.argv[1]
with open(path) as f:
    d = json.load(f)
for k in ("gate", "ok", "ran_at", "duration_ms", "checks", "failures"):
    if k not in d:
        print(f"FAIL: artifact missing key {k!r}", file=sys.stderr)
        sys.exit(1)
if d.get("gate") != "drift":
    print(f"FAIL: gate!=drift ({d.get('gate')})", file=sys.stderr)
    sys.exit(1)
if d.get("subgate") != "nightly-ast-diff":
    print(f"FAIL: subgate!=nightly-ast-diff ({d.get('subgate')})", file=sys.stderr)
    sys.exit(1)
if not isinstance(d.get("checks"), list):
    print("FAIL: checks not a list", file=sys.stderr)
    sys.exit(1)
if not isinstance(d.get("failures"), list):
    print("FAIL: failures not a list", file=sys.stderr)
    sys.exit(1)
print("PASS: artifact schema conforms", file=sys.stderr)
PY

# -----------------------------------------------------------------------------
# Normalizer self-test (belt & braces).
# -----------------------------------------------------------------------------
if ! python3 "$REPO_ROOT/scripts/drift/lib/normalize_schema.py" --self-test; then
  echo "FAIL: normalizer self-test failed" >&2
  FAIL=1
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "[meta-nightly] FAILED" >&2
  exit 1
fi
echo "[meta-nightly] PASSED" >&2
exit 0
