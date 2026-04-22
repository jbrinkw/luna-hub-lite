#!/usr/bin/env bash
# scripts/mutation/tests/test_mutation_meta.sh
#
# Meta-test for the mutation gate (VERIFY.md "Gate: Mutation" → Meta-test).
#
# Phase A — rigor discrimination (fixtures):
#   Runs Stryker independently on two fixture files:
#     - good_contract.ts  (expects HIGH score, >80%)
#     - tautology.ts      (expects LOW score,  <30%)
#   If the gate produces inverted or uncorrelated scores, Stryker plus our
#   wiring is NOT actually discriminating rigor — bail.
#
# Phase B — multi-config aggregation (real repo):
#   Runs `scripts/mutation/run.sh --related` with one file per registered
#   workspace config (extensions, mcp-worker, web-shared) and asserts the
#   aggregated .verify/mutation.json artifact contains a `checks[]` entry
#   for each config. Guards against regressions where a new config lands
#   but the aggregator silently drops its report.
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
# Phase A.1: good_contract — expect HIGH score
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
# Phase A.2: tautology — expect LOW score
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
# Phase A.3: cross-check — good must strictly exceed tautology
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

# ---------------------------------------------------------------------------
# Phase B: multi-config aggregation. Verify run.sh fans out across every
# registered config and the aggregate artifact reflects each one. We use
# --related to keep runtime bounded; the Stryker-ran check in the artifact
# proves each config actually produced a report.
# ---------------------------------------------------------------------------
ONE_PER_CONFIG=(
  "extensions/obsidian/tools/vault-parser.ts"
  "apps/mcp-worker/src/validate.ts"
  "apps/web/src/shared/constants.ts"
)
EXPECTED_CHECKS=(
  "stryker-ran:stryker.conf.json"
  "stryker-ran:stryker.mcp-worker.conf.json"
  "stryker-ran:stryker.web-shared.conf.json"
)

echo "[meta] Phase B: running run.sh --related across all configs…" >&2
set +e
bash "$REPO_ROOT/scripts/mutation/run.sh" --related "${ONE_PER_CONFIG[@]}" --skip-python \
  > "$REPORT_DIR/meta-multiconfig.log" 2>&1
RUN_EXIT=$?
set -e 2>/dev/null || true

AGG_ARTIFACT="$REPO_ROOT/.verify/mutation.json"
if [[ ! -f "$AGG_ARTIFACT" ]]; then
  echo "FAIL: multi-config run did not write $AGG_ARTIFACT (exit=$RUN_EXIT)" >&2
  FAIL=1
else
  if [[ "$RUN_EXIT" -ne 0 ]]; then
    echo "FAIL: multi-config run exited $RUN_EXIT — see $REPORT_DIR/meta-multiconfig.log" >&2
    FAIL=1
  fi
  # Extract check names and file scopes from the artifact and assert each
  # expected check is present with ok=true.
  MISSING=$(node --input-type=module - "$AGG_ARTIFACT" "${EXPECTED_CHECKS[@]}" <<'NODE'
import fs from 'node:fs';
const [artifactPath, ...expected] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
const missing = [];
for (const name of expected) {
  const c = (a.checks ?? []).find(x => x.name === name);
  if (!c || !c.ok) missing.push(name);
}
process.stdout.write(missing.join(','));
NODE
  )
  if [[ -n "$MISSING" ]]; then
    echo "FAIL: aggregated artifact missing/failing checks: $MISSING" >&2
    FAIL=1
  else
    echo "PASS: aggregated artifact contains an ok check for every registered config" >&2
  fi
  FILE_COUNT=$(node --input-type=module - "$AGG_ARTIFACT" <<'NODE'
import fs from 'node:fs';
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(String((a.files ?? []).length));
NODE
  )
  if [[ "$FILE_COUNT" -ne "${#ONE_PER_CONFIG[@]}" ]]; then
    echo "FAIL: expected ${#ONE_PER_CONFIG[@]} files in artifact, got $FILE_COUNT" >&2
    FAIL=1
  else
    echo "PASS: aggregated artifact lists all $FILE_COUNT mutated files" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Phase B.2: out-of-scope --related file must no-op gracefully (exit 0,
# artifact ok:true, no configs invoked). Guards the router's skip branch.
# ---------------------------------------------------------------------------
echo "[meta] Phase B.2: out-of-scope --related should no-op…" >&2
set +e
bash "$REPO_ROOT/scripts/mutation/run.sh" --related README.md --skip-python \
  > "$REPORT_DIR/meta-noop.log" 2>&1
NOOP_EXIT=$?
set -e 2>/dev/null || true

if [[ "$NOOP_EXIT" -ne 0 ]]; then
  echo "FAIL: out-of-scope --related exited $NOOP_EXIT — should be 0" >&2
  FAIL=1
else
  NOOP_OK=$(node --input-type=module - "$AGG_ARTIFACT" <<'NODE'
import fs from 'node:fs';
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hasNoop = (a.checks ?? []).some(c => c.name === 'no-op' && c.ok);
process.stdout.write(hasNoop && a.ok === true && (a.files ?? []).length === 0 ? 'yes' : 'no');
NODE
  )
  if [[ "$NOOP_OK" != "yes" ]]; then
    echo "FAIL: out-of-scope artifact did not record a passing no-op check" >&2
    FAIL=1
  else
    echo "PASS: out-of-scope --related produced a valid no-op artifact" >&2
  fi
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "[meta] mutation meta-test FAILED" >&2
  exit 1
fi
echo "[meta] mutation meta-test PASSED" >&2
exit 0
