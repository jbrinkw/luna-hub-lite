#!/usr/bin/env bash
# scripts/mutation/tests/test_mutation_meta.sh
#
# Meta-test for the mutation gate (VERIFY.md "Gate: Mutation" → Meta-test).
# Runs Stryker independently on two fixture files:
#   - good_contract.ts  (expects HIGH score, >80%)
#   - tautology.ts      (expects LOW score,  <30%)
# If the gate produces inverted or uncorrelated scores, Stryker plus our
# wiring is NOT actually discriminating rigor — bail.
#
# Exit 0 on pass, non-zero on fail.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

STRYKER="$REPO_ROOT/node_modules/.bin/stryker"
if [[ ! -x "$STRYKER" ]]; then
  echo "FAIL: stryker not installed" >&2
  exit 2
fi

FIX_DIR="$REPO_ROOT/scripts/mutation/fixtures"
REPORT_DIR="$REPO_ROOT/reports/mutation"
mkdir -p "$REPORT_DIR"

run_stryker_fixture() {
  local conf="$1"
  local name="$2"
  echo "[meta] running Stryker on fixture: $name ($conf)" >&2
  (
    cd "$FIX_DIR"
    "$STRYKER" run "$conf" 2>&1
  )
}

extract_score() {
  # Args: report_path
  # Prints a percentage score (0-100, float) or 'null'.
  node --input-type=module - "$1" <<'NODE'
import fs from 'node:fs';
const path = process.argv[2];
let r;
try { r = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { console.log('null'); process.exit(0); }
let killed = 0, survived = 0, timeout = 0, noCov = 0;
for (const fdata of Object.values(r.files ?? {})) {
  for (const m of fdata.mutants ?? []) {
    switch (m.status) {
      case 'Killed': killed++; break;
      case 'Survived': survived++; break;
      case 'Timeout': timeout++; break;
      case 'NoCoverage': noCov++; break;
    }
  }
}
const detected = killed + timeout;
const undetected = survived + noCov;
const valid = detected + undetected;
if (valid === 0) { console.log('null'); process.exit(0); }
console.log(((detected / valid) * 100).toFixed(2));
NODE
}

FAIL=0

# ---------------------------------------------------------------------------
# Fixture A: good_contract — expect HIGH score
# ---------------------------------------------------------------------------
set +e
run_stryker_fixture "stryker.good.conf.json" "good_contract" > "$REPORT_DIR/meta-good.log"
GOOD_EXIT=$?
set -e 2>/dev/null || true
GOOD_REPORT="$REPORT_DIR/fixture-good.json"
GOOD_SCORE="$(extract_score "$GOOD_REPORT")"
echo "[meta] good_contract score=$GOOD_SCORE (exit=$GOOD_EXIT)" >&2

if [[ "$GOOD_SCORE" == "null" ]]; then
  echo "FAIL: no Stryker report for good_contract fixture" >&2
  FAIL=1
else
  # Compare as floats via node
  OK=$(node -e "process.stdout.write(Number('$GOOD_SCORE') > 80 ? 'yes' : 'no')")
  if [[ "$OK" != "yes" ]]; then
    echo "FAIL: good_contract score $GOOD_SCORE% is not > 80% — rigorous test should kill most mutants" >&2
    FAIL=1
  else
    echo "PASS: good_contract score $GOOD_SCORE% > 80%" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Fixture B: tautology — expect LOW score
# ---------------------------------------------------------------------------
set +e
run_stryker_fixture "stryker.tautology.conf.json" "tautology" > "$REPORT_DIR/meta-taut.log"
TAUT_EXIT=$?
set -e 2>/dev/null || true
TAUT_REPORT="$REPORT_DIR/fixture-tautology.json"
TAUT_SCORE="$(extract_score "$TAUT_REPORT")"
echo "[meta] tautology score=$TAUT_SCORE (exit=$TAUT_EXIT)" >&2

if [[ "$TAUT_SCORE" == "null" ]]; then
  echo "FAIL: no Stryker report for tautology fixture" >&2
  FAIL=1
else
  OK=$(node -e "process.stdout.write(Number('$TAUT_SCORE') < 30 ? 'yes' : 'no')")
  if [[ "$OK" != "yes" ]]; then
    echo "FAIL: tautology score $TAUT_SCORE% is not < 30% — weak test should leave mutants surviving" >&2
    FAIL=1
  else
    echo "PASS: tautology score $TAUT_SCORE% < 30%" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Cross-check: the good fixture must score strictly higher than the tautology.
# If they're equal or inverted, Stryker's output isn't meaningful for us.
# ---------------------------------------------------------------------------
if [[ "$GOOD_SCORE" != "null" && "$TAUT_SCORE" != "null" ]]; then
  ORDER=$(node -e "process.stdout.write(Number('$GOOD_SCORE') > Number('$TAUT_SCORE') ? 'yes' : 'no')")
  if [[ "$ORDER" != "yes" ]]; then
    echo "FAIL: good_contract ($GOOD_SCORE%) did not exceed tautology ($TAUT_SCORE%) — gate is not discriminating" >&2
    FAIL=1
  else
    echo "PASS: good_contract ($GOOD_SCORE%) > tautology ($TAUT_SCORE%)" >&2
  fi
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "[meta] mutation meta-test FAILED" >&2
  exit 1
fi
echo "[meta] mutation meta-test PASSED" >&2
exit 0
