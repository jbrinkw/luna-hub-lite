#!/usr/bin/env bash
# scripts/reviewer/review.sh
#
# Reviewer gate — given a git SHA, verify the commit's test claims hold.
# Contract: docs/VERIFY.md §"Gate: Review". Pure shell + POSIX tools + jq.
# No LLM.
#
# Invocation
#   bash scripts/reviewer/review.sh <sha>
#
# What it checks
#   1. Commit contains test changes if the body claims "added/modified tests".
#      Skipped if the body has no such claim.
#   2. For each test file added/modified in the commit, re-run that specific
#      file from the commit's worktree (via `git worktree add`) and parse
#      junit output. If the commit body claims an explicit numeric pass count
#      (e.g. "82/82 pass", "40 tests pass", "N passing"), compare.
#   3. Impact gate (scripts/neighbors/impact.sh) invoked against <sha>^..<sha>.
#      Any failure there fails the reviewer.
#   4. If stryker.conf.json exists at repo root AND reports/mutation/mutation.json
#      exists from a prior run, parse it and fail if any file the commit touched
#      (that's covered by the stryker config's mutate glob) has mutation-score
#      below the stryker `thresholds.high` (default 60).
#
# Artifact: .verify/review.json (schema: docs/VERIFY.md §"JSON artifact").
#
# Exit codes
#   0 = pass
#   1 = test claim mismatch / test failure / impact-gate fail
#   2 = harness failure (bad sha, worktree failed, ...)
#   3 = claim count mismatch specifically (reserved for future, currently merged into 1)
#   4 = required tool missing (git, jq)
#
# Bypass
#   If the commit body includes a line matching `BYPASS-REASON: <why>` the
#   reviewer still runs but reports ok=true when the only remaining failure
#   category is mutation/impact (never for missing-tests or test-count
#   mismatch — those are load-bearing).

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [ $# -lt 1 ]; then
  echo "usage: $0 <sha>" >&2
  exit 2
fi
SHA="$1"

VERIFY_DIR="$REPO_ROOT/.verify"
ARTIFACT="$VERIFY_DIR/review.json"
mkdir -p "$VERIFY_DIR"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_NS="$(date +%s%N)"

log()  { printf '[review] %s\n'       "$*" >&2; }
warn() { printf '[review][WARN] %s\n' "$*" >&2; }
err()  { printf '[review][ERR] %s\n'  "$*" >&2; }

CHECKS_FILE="$(mktemp)"
FAILS_FILE="$(mktemp)"
WORKDIR="$(mktemp -d)"
RUNLOG="$(mktemp)"
JUNIT_STAGE="$(mktemp -d)"
WORKTREE_DIR=""
cleanup() {
  if [ -n "$WORKTREE_DIR" ] && [ -d "$WORKTREE_DIR" ]; then
    git worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  fi
  rm -rf "$CHECKS_FILE" "$FAILS_FILE" "$WORKDIR" "$RUNLOG" "$JUNIT_STAGE"
}
trap cleanup EXIT

require() {
  command -v "$1" >/dev/null 2>&1 || { err "missing tool: $1"; exit 4; }
}
require git
require jq

emit_check() {
  # $1 name, $2 ok(true|false), $3 evidence
  jq -nc --arg name "$1" --argjson ok "$2" --arg evidence "$3" \
    '{name:$name, ok:$ok, evidence:$evidence}' >> "$CHECKS_FILE"
}

emit_failure() {
  jq -nc --arg check "$1" --arg message "$2" --arg detail "$3" \
    '{check:$check, message:$message, detail:$detail}' >> "$FAILS_FILE"
}

emit_artifact() {
  local ok_bool="$1"
  local dur_ms=$(( ( $(date +%s%N) - START_NS ) / 1000000 ))
  local checks_arr="[]" fails_arr="[]"
  [ -s "$CHECKS_FILE" ] && checks_arr="$(jq -s '.' "$CHECKS_FILE")"
  [ -s "$FAILS_FILE" ]  && fails_arr="$(jq -s '.' "$FAILS_FILE")"
  jq -n \
    --arg gate review \
    --argjson ok "$ok_bool" \
    --arg ran_at "$STARTED_AT" \
    --argjson duration_ms "$dur_ms" \
    --arg sha "$SHA_FULL" \
    --argjson checks "$checks_arr" \
    --argjson failures "$fails_arr" \
    '{gate:$gate, ok:$ok, ran_at:$ran_at, duration_ms:$duration_ms,
      sha:$sha, checks:$checks, failures:$failures}' \
    > "$ARTIFACT"
}

# --- Resolve SHA -----------------------------------------------------------

if ! SHA_FULL="$(git rev-parse --verify "$SHA^{commit}" 2>/dev/null)"; then
  err "not a commit: $SHA"
  SHA_FULL="$SHA"
  emit_failure "bad_sha" "git rev-parse $SHA failed" ""
  emit_artifact false
  exit 2
fi
log "sha=$SHA_FULL"

COMMIT_BODY="$(git log --format='%B' -n1 "$SHA_FULL")"
BYPASS_REASON=""
if printf '%s' "$COMMIT_BODY" | grep -qE '^[[:space:]]*BYPASS-REASON:'; then
  BYPASS_REASON="$(printf '%s' "$COMMIT_BODY" | grep -E '^[[:space:]]*BYPASS-REASON:' | head -n1 | sed -E 's/^[[:space:]]*BYPASS-REASON:[[:space:]]*//')"
  warn "commit declares BYPASS-REASON: $BYPASS_REASON"
fi

# --- 1. Identify changed test files ----------------------------------------

CHANGED_ALL="$WORKDIR/changed-all.txt"
CHANGED_TESTS="$WORKDIR/changed-tests.txt"
CHANGED_PROD="$WORKDIR/changed-prod.txt"

git diff --name-only --diff-filter=AM "$SHA_FULL^" "$SHA_FULL" > "$CHANGED_ALL" 2>/dev/null || {
  err "git diff ${SHA_FULL}^..$SHA_FULL failed"
  emit_failure "git_diff" "diff parent..commit failed" ""
  emit_artifact false
  exit 2
}

# Test heuristics: anything in a __tests__/ folder, or *.test.ts/.tsx/.js, or
# test_*.py in hardware/live-shelf/, or *.spec.ts.
grep -E '(^|/)(__tests__|tests)/|(^|/)test_[^/]+\.py$|\.test\.(ts|tsx|js|jsx|mjs)$|\.spec\.(ts|tsx|js|jsx|mjs)$' \
  "$CHANGED_ALL" > "$CHANGED_TESTS" || true
grep -vxF -f "$CHANGED_TESTS" "$CHANGED_ALL" > "$CHANGED_PROD" 2>/dev/null || cp "$CHANGED_ALL" "$CHANGED_PROD"

NUM_TESTS=$(wc -l < "$CHANGED_TESTS" | tr -d ' ')
NUM_PROD=$(wc -l < "$CHANGED_PROD" | tr -d ' ')
log "commit touches: $NUM_TESTS test file(s), $NUM_PROD non-test file(s)"

# Check 1: test files present if body claims tests added
CLAIMS_TESTS=0
if printf '%s' "$COMMIT_BODY" | grep -qiE 'added test|add test|tests added|new test|regression test|\btest\(|^test\(.*\):'; then
  CLAIMS_TESTS=1
fi
if printf '%s' "$(git log --format='%s' -n1 "$SHA_FULL")" | grep -qiE '^test[\(:]'; then
  CLAIMS_TESTS=1
fi

REVIEW_OK=1

if [ "$CLAIMS_TESTS" = "1" ] && [ "$NUM_TESTS" = "0" ]; then
  emit_check "claims_tests_has_test_files" "false" \
    "commit subject/body claims tests added but no test files changed"
  emit_failure "claims_tests_has_test_files" \
    "commit claims tests added but diff has no test files" ""
  REVIEW_OK=0
else
  emit_check "claims_tests_has_test_files" "true" \
    "claims_tests=$CLAIMS_TESTS, test_files_changed=$NUM_TESTS"
fi

# --- 2. Set up a worktree at the commit to run tests from that snapshot ----

WORKTREE_DIR="$REPO_ROOT/.worktrees/review-${SHA_FULL:0:12}"
rm -rf "$WORKTREE_DIR" 2>/dev/null || true
mkdir -p "$(dirname "$WORKTREE_DIR")"
if ! git worktree add --detach "$WORKTREE_DIR" "$SHA_FULL" >/dev/null 2>&1; then
  err "git worktree add at $SHA_FULL failed"
  emit_failure "worktree" "git worktree add failed" ""
  emit_artifact false
  exit 2
fi
log "worktree: $WORKTREE_DIR"

# Worktrees share the objectDB but not node_modules. Symlink so pnpm + vitest
# can resolve dependencies from the main checkout. Safe to link blindly: if
# the source doesn't exist we skip; if the dest exists we keep it.
_link_nm() {
  local src="$1" dst="$2"
  [ -e "$src" ] || return 0
  [ -e "$dst" ] && return 0
  ln -s "$src" "$dst" 2>/dev/null || true
}
_link_nm "$REPO_ROOT/node_modules"                    "$WORKTREE_DIR/node_modules"
_link_nm "$REPO_ROOT/apps/web/node_modules"           "$WORKTREE_DIR/apps/web/node_modules"
_link_nm "$REPO_ROOT/apps/mcp-worker/node_modules"    "$WORKTREE_DIR/apps/mcp-worker/node_modules"
_link_nm "$REPO_ROOT/packages/app-tools/node_modules" "$WORKTREE_DIR/packages/app-tools/node_modules"
_link_nm "$REPO_ROOT/packages/ui-kit/node_modules"    "$WORKTREE_DIR/packages/ui-kit/node_modules"
_link_nm "$REPO_ROOT/packages/db-types/node_modules"  "$WORKTREE_DIR/packages/db-types/node_modules"
# Share the python venv; pytest and its plugins live here, and the reviewer
# needs to run live-shelf tests from the worktree's checkout of the code.
_link_nm "$REPO_ROOT/hardware/live-shelf/.venv"       "$WORKTREE_DIR/hardware/live-shelf/.venv"

# --- 3. Parse claimed pass counts ------------------------------------------
# Patterns captured:
#   "82/82 pass", "82/82 passing"
#   "N tests pass", "N tests passing", "N passing"
#   "all N tests pass"

CLAIMED_TOTAL=-1
CLAIMED_RAW=""
# Highest-specificity pattern first: "X/Y"
CLAIMED_RAW="$(printf '%s' "$COMMIT_BODY" | grep -oE '[0-9]+/[0-9]+[[:space:]]*(pass|passing|tests pass|tests passing)' | head -n1 || true)"
if [ -n "$CLAIMED_RAW" ]; then
  # Take the denominator (Y).
  CLAIMED_TOTAL="$(printf '%s' "$CLAIMED_RAW" | grep -oE '[0-9]+/[0-9]+' | head -n1 | awk -F/ '{print $2}')"
fi
if [ "$CLAIMED_TOTAL" = "-1" ]; then
  CLAIMED_RAW="$(printf '%s' "$COMMIT_BODY" | grep -oE '[0-9]+[[:space:]]+(tests|tests? (pass|passing))' | head -n1 || true)"
  if [ -n "$CLAIMED_RAW" ]; then
    CLAIMED_TOTAL="$(printf '%s' "$CLAIMED_RAW" | grep -oE '^[0-9]+' || true)"
  fi
fi
[ -z "$CLAIMED_TOTAL" ] && CLAIMED_TOTAL=-1

# --- 4. Run the test files added/modified in the commit --------------------
# We bucket each test file by what runner to use.

# Helper: parse junit (vitest / pytest emit compatible format).
parse_junit_counts() {
  local junit="$1"
  [ ! -s "$junit" ] && { printf '%s\n' "-1 -1"; return; }
  local total failed
  if grep -qE '<testsuites[ >]' "$junit"; then
    total=$(grep -oE 'tests="[0-9]+"' "$junit" | head -n1 | sed 's/[^0-9]//g')
    failed=$(grep -oE 'failures="[0-9]+"' "$junit" | head -n1 | sed 's/[^0-9]//g')
  else
    total=$(grep -oE 'tests="[0-9]+"' "$junit" | sed 's/[^0-9]//g' | awk '{s+=$1} END {print s+0}')
    failed=$(grep -oE 'failures="[0-9]+"' "$junit" | sed 's/[^0-9]//g' | awk '{s+=$1} END {print s+0}')
  fi
  printf '%s %s\n' "${total:--1}" "${failed:--1}"
}

WORKSPACE_OF() {
  # given a file path, print workspace name or "" if not a ts workspace.
  case "$1" in
    apps/web/*|packages/ui-kit/*) echo "@luna-hub/web" ;;
    apps/mcp-worker/*)            echo "@luna-hub/mcp-worker" ;;
    packages/app-tools/*)         echo "@luna-hub/app-tools" ;;
    *) echo "" ;;
  esac
}

TOTAL_RAN=0
TOTAL_FAILED=0
ANY_TEST_EXECUTED=0

run_one_vitest() {
  local file="$1" workspace="$2"
  local junit_out="$JUNIT_STAGE/$(echo "$file" | tr / _).xml"
  : > "$RUNLOG"
  local exit_code=0
  # Vitest resolves paths relative to the workspace root. The commit's file
  # lives at `$WORKTREE_DIR/$file`; the workspace config lives under the
  # worktree too. We invoke pnpm in the worktree dir so `--filter` resolves
  # inside that checked-out tree, not the main working tree.
  ( cd "$WORKTREE_DIR" \
    && pnpm --silent --filter "$workspace" exec vitest run \
         "$WORKTREE_DIR/$file" \
         --reporter=junit --outputFile="$junit_out" --reporter=default \
       > "$RUNLOG" 2>&1 ) || exit_code=$?
  read -r t f <<< "$(parse_junit_counts "$junit_out")"
  ANY_TEST_EXECUTED=1
  if [ "$t" = "-1" ]; then
    emit_check "run:$file" "false" "vitest produced no junit (exit $exit_code)"
    emit_failure "run:$file" "vitest no junit" "$(tail -n 30 "$RUNLOG" | tr '\n' ' ')"
    return 1
  fi
  [ "$t" -gt 0 ] && TOTAL_RAN=$(( TOTAL_RAN + t ))
  [ "$f" -gt 0 ] && TOTAL_FAILED=$(( TOTAL_FAILED + f ))
  if [ "$exit_code" -eq 0 ] && [ "$f" = "0" ]; then
    emit_check "run:$file" "true" "$t passed, 0 failed"
    return 0
  fi
  emit_check "run:$file" "false" "$t total, $f failed (exit=$exit_code)"
  emit_failure "run:$file" "$f of $t failed" "$(tail -n 30 "$RUNLOG" | tr '\n' ' ')"
  return 1
}

run_one_pytest() {
  local file="$1"
  local pytestbin="$WORKTREE_DIR/hardware/live-shelf/.venv/bin/pytest"
  if [ ! -x "$pytestbin" ]; then
    # Worktree shares the venv from the main repo (venv is in .gitignore and
    # doesn't get checked out). Fall back to the main repo's venv.
    pytestbin="$REPO_ROOT/hardware/live-shelf/.venv/bin/pytest"
  fi
  if [ ! -x "$pytestbin" ]; then
    emit_check "run:$file" "false" "pytest venv not found"
    emit_failure "run:$file" "no pytest binary" "expected hardware/live-shelf/.venv/bin/pytest"
    return 1
  fi
  local junit_out="$JUNIT_STAGE/$(echo "$file" | tr / _).xml"
  local rel="${file#hardware/live-shelf/}"
  : > "$RUNLOG"
  local exit_code=0
  ( cd "$WORKTREE_DIR/hardware/live-shelf" \
    && "$pytestbin" --junitxml="$junit_out" "$rel" \
       > "$RUNLOG" 2>&1 ) || exit_code=$?
  read -r t f <<< "$(parse_junit_counts "$junit_out")"
  ANY_TEST_EXECUTED=1
  if [ "$t" = "-1" ]; then
    emit_check "run:$file" "false" "pytest produced no junit (exit $exit_code)"
    emit_failure "run:$file" "pytest no junit" "$(tail -n 30 "$RUNLOG" | tr '\n' ' ')"
    return 1
  fi
  [ "$t" -gt 0 ] && TOTAL_RAN=$(( TOTAL_RAN + t ))
  [ "$f" -gt 0 ] && TOTAL_FAILED=$(( TOTAL_FAILED + f ))
  if [ "$exit_code" -eq 0 ] && [ "$f" = "0" ]; then
    emit_check "run:$file" "true" "$t passed, 0 failed"
    return 0
  fi
  emit_check "run:$file" "false" "$t total, $f failed (exit=$exit_code)"
  emit_failure "run:$file" "$f of $t pytest failed" "$(tail -n 30 "$RUNLOG" | tr '\n' ' ')"
  return 1
}

RAN_ANY_CHECKS=0
while IFS= read -r tfile; do
  [ -z "$tfile" ] && continue
  RAN_ANY_CHECKS=1
  case "$tfile" in
    supabase/tests/*.sql)
      # pgTAP files: the impact gate runs the full suite which includes this
      # file — skip per-file execution, rely on step 5.
      emit_check "run:$tfile" "true" "pgTAP file; will run via impact-gate supabase test db"
      ;;
    hardware/live-shelf/server/tests/*.py|hardware/live-shelf/tests/*.py)
      run_one_pytest "$tfile" || REVIEW_OK=0
      ;;
    *.ts|*.tsx|*.js|*.jsx|*.mjs)
      ws="$(WORKSPACE_OF "$tfile")"
      if [ -z "$ws" ]; then
        emit_check "run:$tfile" "false" "no workspace mapping for test file"
        emit_failure "run:$tfile" "unmapped test file" ""
        REVIEW_OK=0
      else
        run_one_vitest "$tfile" "$ws" || REVIEW_OK=0
      fi
      ;;
    *)
      # Skip unknown file types silently — they'll show up under impact gate.
      ;;
  esac
done < "$CHANGED_TESTS"

# Check 2a: numeric claim vs actual
if [ "$CLAIMED_TOTAL" != "-1" ] && [ "$ANY_TEST_EXECUTED" = "1" ]; then
  PASSED=$(( TOTAL_RAN - TOTAL_FAILED ))
  if [ "$PASSED" = "$CLAIMED_TOTAL" ]; then
    emit_check "claim_count_match" "true" \
      "commit claims ${CLAIMED_TOTAL}; observed ${PASSED} passing across changed test files"
  else
    emit_check "claim_count_match" "false" \
      "commit claims ${CLAIMED_TOTAL}; observed ${PASSED}/${TOTAL_RAN} passing"
    emit_failure "claim_count_match" \
      "claimed ${CLAIMED_TOTAL}, observed ${PASSED}" \
      "raw-claim: $CLAIMED_RAW"
    REVIEW_OK=0
  fi
else
  emit_check "claim_count_match" "true" \
    "no explicit N/N claim in commit body (skipped)"
fi

# --- 5. Impact gate --------------------------------------------------------

log "delegating to impact gate for $SHA_FULL^..$SHA_FULL"
IMPACT_OK=1
# Run impact.sh in the worktree so the diff range matches what was committed.
( cd "$WORKTREE_DIR" \
  && bash "$REPO_ROOT/scripts/neighbors/impact.sh" "$SHA_FULL^" "$SHA_FULL" \
     > "$WORKDIR/impact.log" 2>&1 ) || IMPACT_OK=0
# Copy the artifact back for the reviewer to reference.
if [ -f "$WORKTREE_DIR/.verify/impact.json" ]; then
  cp -f "$WORKTREE_DIR/.verify/impact.json" "$VERIFY_DIR/review-impact.json" 2>/dev/null || true
fi
if [ "$IMPACT_OK" = "1" ]; then
  emit_check "impact_gate" "true" "impact.sh $SHA_FULL^..$SHA_FULL passed"
else
  emit_check "impact_gate" "false" "impact.sh reported failures"
  emit_failure "impact_gate" "impact gate failed on commit neighbours" \
    "$(tail -n 30 "$WORKDIR/impact.log" | tr '\n' ' ')"
  REVIEW_OK=0
fi

# --- 6. Mutation report (optional) -----------------------------------------

MUTATION_REPORT="$REPO_ROOT/reports/mutation/mutation.json"
STRYKER_CONF="$REPO_ROOT/stryker.conf.json"

if [ -f "$STRYKER_CONF" ] && [ -f "$MUTATION_REPORT" ]; then
  THRESHOLD="$(jq -r '.thresholds.high // 60' "$STRYKER_CONF" 2>/dev/null || echo 60)"
  # For each non-test file the commit touched, look it up in the report and
  # fail if its mutation score is below threshold.
  MUTATION_FAIL=0
  MUTATION_DETAILS=""
  while IFS= read -r pfile; do
    [ -z "$pfile" ] && continue
    # mutation.json paths are relative to repo root.
    score="$(jq -r --arg f "$pfile" '
      .files[$f] // empty
      | (.mutants // []) as $m
      | ($m | map(select(.status=="Killed")) | length) as $killed
      | ($m | map(select(.status=="Survived")) | length) as $survived
      | ($m | map(select(.status=="Timeout")) | length) as $timeout
      | ($m | map(select(.status=="NoCoverage")) | length) as $nocov
      | ($killed + $timeout) as $covered
      | ($covered + $survived + $nocov) as $total
      | if $total == 0 then empty else (100 * $covered / $total) end
    ' "$MUTATION_REPORT" 2>/dev/null)"
    if [ -z "$score" ] || [ "$score" = "null" ]; then
      # File not in mutation report — not in mutate glob, skip silently.
      continue
    fi
    # Truncate to integer-ish for comparison.
    score_int="$(printf '%.0f' "$score" 2>/dev/null || echo 0)"
    if [ "$score_int" -lt "$THRESHOLD" ]; then
      MUTATION_FAIL=1
      MUTATION_DETAILS="$MUTATION_DETAILS $pfile:${score_int}%"
    fi
  done < "$CHANGED_PROD"

  if [ "$MUTATION_FAIL" = "1" ]; then
    emit_check "mutation_contract_score" "false" \
      "files below threshold (${THRESHOLD}%):${MUTATION_DETAILS}"
    emit_failure "mutation_contract_score" \
      "mutation score below ${THRESHOLD}% on commit's contract files" \
      "${MUTATION_DETAILS# }"
    if [ -n "$BYPASS_REASON" ]; then
      warn "mutation-score fail bypassed: $BYPASS_REASON"
    else
      REVIEW_OK=0
    fi
  else
    emit_check "mutation_contract_score" "true" \
      "all in-scope files ≥ ${THRESHOLD}% mutation coverage (or not in mutate glob)"
  fi
else
  emit_check "mutation_contract_score" "true" \
    "skipped (stryker.conf.json or reports/mutation/mutation.json not present)"
fi

# --- Emit artifact ---------------------------------------------------------

if [ "$REVIEW_OK" = "1" ]; then
  emit_artifact true
  log "PASS (artifact: $ARTIFACT)"
  exit 0
fi
emit_artifact false
log "FAIL (artifact: $ARTIFACT)"
exit 1
