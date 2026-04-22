#!/usr/bin/env bash
# scripts/mutation/tests/test_python_meta.sh
#
# Meta-test for the Python mutation gate (mutmut). Runs mutmut
# independently on two fixture directories under
# scripts/mutation/fixtures/python/:
#   - good_contract/  — rigorous boundary tests; expect HIGH score (>80%)
#   - tautology/      — defined-ness-only tests; expect LOW score (<30%)
#
# Must also assert good > tautology — if they're equal or inverted, our
# wiring isn't discriminating test rigor and the gate is not
# trustworthy. Exit 0 on pass, non-zero on fail.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SHELF_DIR="$REPO_ROOT/hardware/live-shelf"
MUTMUT="$SHELF_DIR/.venv/bin/mutmut"
PY="$SHELF_DIR/.venv/bin/python"

FIX_ROOT="$REPO_ROOT/scripts/mutation/fixtures/python"
REPORT_DIR="$REPO_ROOT/reports/mutation"
mkdir -p "$REPORT_DIR"

if [[ ! -x "$MUTMUT" ]]; then
  echo "FAIL: mutmut not installed at $MUTMUT" >&2
  echo "  Create the Pi venv: python3 -m venv $SHELF_DIR/.venv && $SHELF_DIR/.venv/bin/pip install -r $SHELF_DIR/server/requirements.txt mutmut" >&2
  exit 2
fi

run_mutmut_fixture() {
  local fix_dir="$1"
  local name="$2"
  echo "[meta-py] running mutmut on fixture: $name ($fix_dir)" >&2
  (
    cd "$fix_dir"
    rm -rf mutants .mutmut-cache
    "$MUTMUT" run 2>&1
    "$MUTMUT" export-cicd-stats 2>&1
  )
}

extract_score() {
  # Args: path/to/mutmut-cicd-stats.json
  # Emits a float percent or 'null'.
  local stats="$1"
  if [[ ! -f "$stats" ]]; then
    echo "null"
    return 0
  fi
  "$PY" - "$stats" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
killed = d.get('killed', 0) + d.get('timeout', 0)
undetected = d.get('survived', 0) + d.get('no_tests', 0)
valid = killed + undetected
if valid == 0:
    print('null')
else:
    print(round(killed / valid * 100, 2))
PY
}

FAIL=0

# ---------------------------------------------------------------------------
# Fixture A: good_contract — expect HIGH score (> 80%).
# ---------------------------------------------------------------------------
set +e
run_mutmut_fixture "$FIX_ROOT/good_contract" "good_contract" > "$REPORT_DIR/py-meta-good.log" 2>&1
GOOD_EXIT=$?
set -e 2>/dev/null || true
GOOD_STATS="$FIX_ROOT/good_contract/mutants/mutmut-cicd-stats.json"
GOOD_SCORE="$(extract_score "$GOOD_STATS")"
echo "[meta-py] good_contract score=$GOOD_SCORE (mutmut exit=$GOOD_EXIT)" >&2

if [[ "$GOOD_SCORE" == "null" ]]; then
  echo "FAIL: mutmut produced no stats for good_contract fixture" >&2
  FAIL=1
else
  OK=$("$PY" -c "print('yes' if float('$GOOD_SCORE') > 80 else 'no')")
  if [[ "$OK" != "yes" ]]; then
    echo "FAIL: good_contract score $GOOD_SCORE% not > 80% — rigorous tests should kill most mutants" >&2
    FAIL=1
  else
    echo "PASS: good_contract score $GOOD_SCORE% > 80%" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Fixture B: tautology — expect LOW score (< 30%).
# ---------------------------------------------------------------------------
set +e
run_mutmut_fixture "$FIX_ROOT/tautology" "tautology" > "$REPORT_DIR/py-meta-taut.log" 2>&1
TAUT_EXIT=$?
set -e 2>/dev/null || true
TAUT_STATS="$FIX_ROOT/tautology/mutants/mutmut-cicd-stats.json"
TAUT_SCORE="$(extract_score "$TAUT_STATS")"
echo "[meta-py] tautology score=$TAUT_SCORE (mutmut exit=$TAUT_EXIT)" >&2

if [[ "$TAUT_SCORE" == "null" ]]; then
  echo "FAIL: mutmut produced no stats for tautology fixture" >&2
  FAIL=1
else
  OK=$("$PY" -c "print('yes' if float('$TAUT_SCORE') < 30 else 'no')")
  if [[ "$OK" != "yes" ]]; then
    echo "FAIL: tautology score $TAUT_SCORE% not < 30% — defined-ness tests should leave mutants surviving" >&2
    FAIL=1
  else
    echo "PASS: tautology score $TAUT_SCORE% < 30%" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Cross-check: good must exceed tautology by enough to prove the gate is
# actually discriminating rigor (not just noise).
# ---------------------------------------------------------------------------
if [[ "$GOOD_SCORE" != "null" && "$TAUT_SCORE" != "null" ]]; then
  ORDER=$("$PY" -c "print('yes' if float('$GOOD_SCORE') > float('$TAUT_SCORE') else 'no')")
  if [[ "$ORDER" != "yes" ]]; then
    echo "FAIL: good_contract ($GOOD_SCORE%) did not exceed tautology ($TAUT_SCORE%) — gate is not discriminating" >&2
    FAIL=1
  else
    echo "PASS: good_contract ($GOOD_SCORE%) > tautology ($TAUT_SCORE%)" >&2
  fi
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "[meta-py] Python mutation meta-test FAILED" >&2
  exit 1
fi
echo "[meta-py] Python mutation meta-test PASSED" >&2
exit 0
