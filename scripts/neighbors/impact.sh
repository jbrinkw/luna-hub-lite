#!/usr/bin/env bash
# scripts/neighbors/impact.sh
#
# Impact gate — given a git base ref (default origin/main), run tests that
# could plausibly be affected by the diff between <base> and HEAD. Pure
# shell + POSIX tools + jq. Contract: docs/VERIFY.md §"Gate: Impact".
# Artifact: .verify/impact.json.
#
# Exit codes:
#   0 = all related tests passed (or nothing related)
#   1 = at least one related test failed
#   2 = harness failure (git diff broken, vitest produced no junit, etc.)
#   4 = required tool missing
#
# Design:
#   * For TS/TSX changes we invoke `vitest run --changed <base>` per
#     affected workspace. Vitest (v4) owns the dependency-graph walk.
#   * For python changes under hardware/live-shelf/server/ we try
#     pytest-testmon (with --changed-since=<base>); if testmon isn't
#     installed we fall back to the full suite with a WARN.
#   * For SQL changes under supabase/{migrations,tests}/ we run the full
#     pgTAP suite because it's fast (~2s).
#
# No LLM. No Node/Python for the script — shell + jq only.

set -u
set -o pipefail

# Use the *caller's* git toplevel so invoking from a worktree keeps artifacts
# and test runs isolated. Falls back to the script-relative root if the CWD
# isn't inside any git checkout (shouldn't normally happen).
if REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$REPO_ROOT" ]; then
  :
else
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
cd "$REPO_ROOT"

BASE_REF="${1:-origin/main}"
HEAD_REF="${2:-HEAD}"
DRY_RUN="${IMPACT_DRY_RUN:-0}"
VERIFY_DIR="$REPO_ROOT/.verify"
ARTIFACT="$VERIFY_DIR/impact.json"
mkdir -p "$VERIFY_DIR"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_NS="$(date +%s%N)"

log()  { printf '[impact] %s\n'       "$*" >&2; }
warn() { printf '[impact][WARN] %s\n' "$*" >&2; }
err()  { printf '[impact][ERR] %s\n'  "$*" >&2; }

CHECKS_FILE="$(mktemp)"
FAILS_FILE="$(mktemp)"
CHANGED_FILE="$(mktemp)"
RUNLOG="$(mktemp)"
JUNIT_STAGE="$(mktemp -d)"
cleanup() { rm -rf "$CHECKS_FILE" "$FAILS_FILE" "$CHANGED_FILE" "$RUNLOG" "$JUNIT_STAGE"; }
trap cleanup EXIT

emit_check() {
  # $1 name, $2 ok(true|false), $3 evidence, $4 ran, $5 failed
  jq -nc \
    --arg name "$1" --argjson ok "$2" --arg evidence "$3" \
    --argjson ran "$4" --argjson failed "$5" \
    '{name:$name, ok:$ok, evidence:$evidence, ran:$ran, failed:$failed}' \
    >> "$CHECKS_FILE"
}

emit_failure() {
  jq -nc \
    --arg check "$1" --arg message "$2" --arg detail "$3" \
    '{check:$check, message:$message, detail:$detail}' \
    >> "$FAILS_FILE"
}

emit_artifact() {
  local ok_bool="$1"
  local dur_ms=$(( ( $(date +%s%N) - START_NS ) / 1000000 ))
  local checks_arr="[]" fails_arr="[]"
  [ -s "$CHECKS_FILE" ] && checks_arr="$(jq -s '.' "$CHECKS_FILE")"
  [ -s "$FAILS_FILE" ]  && fails_arr="$(jq -s '.' "$FAILS_FILE")"
  jq -n \
    --arg gate impact \
    --argjson ok "$ok_bool" \
    --arg ran_at "$STARTED_AT" \
    --argjson duration_ms "$dur_ms" \
    --arg base "$BASE_REF" \
    --argjson checks "$checks_arr" \
    --argjson failures "$fails_arr" \
    '{gate:$gate, ok:$ok, ran_at:$ran_at, duration_ms:$duration_ms,
      base:$base, checks:$checks, failures:$failures}' \
    > "$ARTIFACT"
}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    err "required tool missing: $1"
    emit_failure "tool_missing" "$1 not found on PATH" ""
    emit_artifact false
    exit 4
  }
}

require jq
require git

# --- Resolve base ref -------------------------------------------------------

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  warn "base ref '$BASE_REF' not found; falling back to HEAD~1"
  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    BASE_REF="HEAD~1"
  else
    warn "HEAD~1 missing; using empty-tree ref — whole tree is 'changed'"
    BASE_REF="$(git hash-object -t tree /dev/null)"
  fi
fi
if ! git rev-parse --verify "$HEAD_REF" >/dev/null 2>&1; then
  err "head ref '$HEAD_REF' not found"
  emit_failure "bad_head_ref" "head ref $HEAD_REF does not resolve" ""
  emit_artifact false
  exit 2
fi
log "base=$BASE_REF head=$HEAD_REF"

# --- Enumerate changed files ------------------------------------------------

if ! git diff --name-only "$BASE_REF" "$HEAD_REF" > "$CHANGED_FILE" 2>/dev/null; then
  err "git diff --name-only $BASE_REF $HEAD_REF failed"
  emit_failure "git_diff" "git diff $BASE_REF..$HEAD_REF failed" ""
  emit_artifact false
  exit 2
fi

CHANGED_COUNT=$(wc -l < "$CHANGED_FILE" | tr -d ' ')
log "$CHANGED_COUNT changed files between $BASE_REF..$HEAD_REF"

any_match() { # $1 = regex
  grep -qE "$1" "$CHANGED_FILE" 2>/dev/null
}

WEB_HIT=0; WORKER_HIT=0; APPTOOLS_HIT=0; UIKIT_HIT=0; PY_HIT=0; SQL_HIT=0
any_match '^apps/web/.*\.(ts|tsx|js|jsx)$'                 && WEB_HIT=1
any_match '^apps/mcp-worker/.*\.(ts|tsx|js|jsx)$'          && WORKER_HIT=1
any_match '^packages/app-tools/.*\.(ts|tsx|js|jsx)$'       && APPTOOLS_HIT=1
any_match '^packages/ui-kit/.*\.(ts|tsx|js|jsx)$'          && UIKIT_HIT=1
any_match '^hardware/live-shelf/server/.*\.py$'            && PY_HIT=1
any_match '^supabase/(migrations|tests)/.*\.sql$'          && SQL_HIT=1

# ui-kit changes bubble into the web workspace (its only consumer).
if [ "$UIKIT_HIT" = "1" ]; then WEB_HIT=1; fi

log "hits: web=$WEB_HIT worker=$WORKER_HIT app-tools=$APPTOOLS_HIT py=$PY_HIT sql=$SQL_HIT ui-kit=$UIKIT_HIT"

# --- Helpers ---------------------------------------------------------------

parse_junit_counts() {
  # Emits "TOTAL FAILED" from vitest-style junit. "-1 -1" if unparseable.
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

run_vitest_changed() {
  # $1 = workspace filter (e.g. @luna-hub/web)
  # $2 = prefix regex for files relevant to this workspace
  local workspace="$1"
  local prefix_re="$2"
  local safe="${workspace//[^A-Za-z0-9._-]/_}"
  local name="vitest:$workspace"
  local junit_out="$JUNIT_STAGE/${safe}.xml"

  # Collect files relevant to this workspace.
  local files_list="$JUNIT_STAGE/${safe}.files"
  grep -E "$prefix_re" "$CHANGED_FILE" 2>/dev/null > "$files_list" || true
  # Drop deleted files (vitest can't resolve them).
  if [ -s "$files_list" ]; then
    local keep="$JUNIT_STAGE/${safe}.files.keep"
    : > "$keep"
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      [ -e "$REPO_ROOT/$f" ] && printf '%s\n' "$f" >> "$keep"
    done < "$files_list"
    mv -f "$keep" "$files_list"
  fi

  if [ ! -s "$files_list" ]; then
    emit_check "$name" "true" \
      "no (existing) ${workspace} files changed — nothing to run" 0 0
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    local cnt
    cnt=$(wc -l < "$files_list" | tr -d ' ')
    emit_check "$name" "true" \
      "DRY_RUN: would run vitest related on $cnt file(s) in $workspace" "$cnt" 0
    return 0
  fi

  # Build vitest argv: `vitest related <files...>` keeps it file-driven and
  # independent of the working-tree ref, so the reviewer can invoke us with
  # an explicit HEAD_REF that isn't the tip of the current branch.
  local args=( run --reporter=junit "--outputFile=$junit_out" --reporter=default )
  log "running $name related <$(wc -l < "$files_list" | tr -d ' ') file(s)>"
  : > "$RUNLOG"
  local exit_code=0
  # shellcheck disable=SC2046
  pnpm --silent --filter "$workspace" exec vitest related \
      $(tr '\n' ' ' < "$files_list") \
      "${args[@]}" \
      > "$RUNLOG" 2>&1 || exit_code=$?

  read -r total failed <<< "$(parse_junit_counts "$junit_out")"

  if [ "$total" = "-1" ]; then
    # Heuristics: vitest prints "No test files found" when zero matches.
    if grep -qiE 'no test files found|include pattern' "$RUNLOG"; then
      emit_check "$name" "true" \
        "vitest related: no tests reference the changed files" 0 0
      # Copy empty artifact into .verify for traceability.
      cp -f "$RUNLOG" "$VERIFY_DIR/${safe}.runlog" 2>/dev/null || true
      return 0
    fi
    emit_check "$name" "false" \
      "vitest ran but produced no junit (exit $exit_code)" 0 0
    emit_failure "$name" "vitest produced no junit output" \
      "$(tail -n 30 "$RUNLOG" | tr '\n' ' ')"
    cp -f "$RUNLOG" "$VERIFY_DIR/${safe}.runlog" 2>/dev/null || true
    return 2
  fi

  # Preserve junit in .verify/ for caller inspection.
  cp -f "$junit_out" "$VERIFY_DIR/${safe}.junit.xml" 2>/dev/null || true

  if [ "$exit_code" -eq 0 ] && [ "$failed" = "0" ]; then
    emit_check "$name" "true" \
      "vitest related: $total tests, 0 failures" "$total" "$failed"
    return 0
  fi
  emit_check "$name" "false" \
    "vitest related: $total tests, $failed failures (exit=$exit_code)" \
    "$total" "$failed"
  emit_failure "$name" "$failed of $total tests failed" \
    "$(tail -n 40 "$RUNLOG" | tr '\n' ' ')"
  return 1
}

run_pytest_impact() {
  local name="pytest:live-shelf"
  local pybin="$REPO_ROOT/hardware/live-shelf/.venv/bin/python"
  local pytestbin="$REPO_ROOT/hardware/live-shelf/.venv/bin/pytest"
  if [ "$DRY_RUN" = "1" ]; then
    local cnt
    cnt=$(grep -cE '^hardware/live-shelf/server/.*\.py$' "$CHANGED_FILE" || true)
    emit_check "$name" "true" \
      "DRY_RUN: would run pytest for $cnt python file(s)" "$cnt" 0
    return 0
  fi
  if [ ! -x "$pytestbin" ]; then
    emit_check "$name" "false" \
      "pytest venv missing at hardware/live-shelf/.venv" 0 0
    emit_failure "$name" "pytest binary missing" \
      "expected $pytestbin to exist — see scripts/neighbors/README.md"
    return 4
  fi

  # File-level selection (deterministic, no global testmon state needed):
  # collect changed *.py files under hardware/live-shelf/server/, then run
  # those plus any co-located tests/ directory next to changed production
  # files. This matches the TS side's `vitest related` semantics and is
  # robust across worktrees (testmon's .testmondata isn't worktree-scoped).
  local files_list="$JUNIT_STAGE/livesh.files"
  grep -E '^hardware/live-shelf/server/.*\.py$' "$CHANGED_FILE" 2>/dev/null \
    > "$files_list" || true

  local targets="$JUNIT_STAGE/livesh.targets"
  : > "$targets"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    local rel="${f#hardware/live-shelf/}"
    case "$rel" in
      server/tests/*)   printf '%s\n' "$rel" >> "$targets" ;;
      server/*/tests/*) printf '%s\n' "$rel" >> "$targets" ;;
      server/*)
        local dir
        dir="$(dirname "$rel")"
        while [ "$dir" != "server" ] && [ "$dir" != "." ]; do
          if [ -d "$REPO_ROOT/hardware/live-shelf/$dir/tests" ]; then
            printf '%s\n' "$dir/tests" >> "$targets"
            break
          fi
          dir="$(dirname "$dir")"
        done
        # Safety net: include top-level tests dir when production code
        # changes — it's fast and catches cross-module effects.
        printf '%s\n' "server/tests" >> "$targets"
        ;;
    esac
  done < "$files_list"
  sort -u "$targets" -o "$targets"

  if [ ! -s "$targets" ]; then
    emit_check "$name" "true" "pytest: no python tests in scope" 0 0
    return 0
  fi

  local has_testmon=0
  if "$pybin" -c 'import pytest_testmon' >/dev/null 2>&1; then
    has_testmon=1
  fi
  [ "$has_testmon" = "0" ] && \
    warn "pytest-testmon not installed — file-level selection in effect (see scripts/neighbors/README.md)"

  local junit_out="$JUNIT_STAGE/live-shelf.xml"
  : > "$RUNLOG"
  log "running pytest on $(wc -l < "$targets" | tr -d ' ') target(s) (file-level)"
  local exit_code=0
  # shellcheck disable=SC2046
  ( cd "$REPO_ROOT/hardware/live-shelf" \
    && "$pytestbin" --junitxml="$junit_out" \
         $(tr '\n' ' ' < "$targets") \
         > "$RUNLOG" 2>&1 ) || exit_code=$?

  # pytest exit 5 = "no tests collected" — success for impact.
  if [ "$exit_code" -eq 5 ]; then
    emit_check "$name" "true" "pytest: 0 affected tests collected" 0 0
    cp -f "$RUNLOG" "$VERIFY_DIR/live-shelf.runlog" 2>/dev/null || true
    return 0
  fi

  read -r total failed <<< "$(parse_junit_counts "$junit_out")"
  cp -f "$RUNLOG" "$VERIFY_DIR/live-shelf.runlog" 2>/dev/null || true
  [ -f "$junit_out" ] && cp -f "$junit_out" "$VERIFY_DIR/live-shelf.junit.xml" 2>/dev/null || true

  if [ "$total" = "-1" ]; then
    emit_check "$name" "false" \
      "pytest produced no junit (exit $exit_code)" 0 0
    emit_failure "$name" "pytest produced no junit" \
      "$(tail -n 30 "$RUNLOG" | tr '\n' ' ')"
    return 2
  fi

  local mode="file-level"
  if [ "$exit_code" -eq 0 ] && [ "$failed" = "0" ]; then
    emit_check "$name" "true" \
      "pytest ($mode): $total tests, 0 failures" "$total" "$failed"
    return 0
  fi
  emit_check "$name" "false" \
    "pytest ($mode): $total tests, $failed failures (exit=$exit_code)" \
    "$total" "$failed"
  emit_failure "$name" "$failed of $total pytest tests failed" \
    "$(tail -n 40 "$RUNLOG" | tr '\n' ' ')"
  return 1
}

run_supabase_pgtap() {
  local name="supabase:pgtap"
  if [ "$DRY_RUN" = "1" ]; then
    emit_check "$name" "true" \
      "DRY_RUN: would run supabase test db (full pgTAP)" 0 0
    return 0
  fi
  if ! command -v npx >/dev/null 2>&1; then
    emit_check "$name" "false" "npx not found — cannot run supabase test db" 0 0
    emit_failure "$name" "npx missing" ""
    return 4
  fi
  log "running supabase test db (full pgTAP suite)"
  : > "$RUNLOG"
  local exit_code=0
  ( cd "$REPO_ROOT" && npx --yes supabase test db > "$RUNLOG" 2>&1 ) || exit_code=$?

  local total passed failed
  total=$(grep -E '^# tests ' "$RUNLOG"  | tail -n1 | awk '{print $3}')
  passed=$(grep -E '^# pass ' "$RUNLOG"  | tail -n1 | awk '{print $3}')
  failed=$(grep -E '^# fail ' "$RUNLOG"  | tail -n1 | awk '{print $3}')
  total=${total:-0}; passed=${passed:-0}; failed=${failed:-0}
  cp -f "$RUNLOG" "$VERIFY_DIR/pgtap.runlog" 2>/dev/null || true

  if [ "$exit_code" -eq 0 ]; then
    emit_check "$name" "true" "pgTAP: $passed/$total passing" "$total" "$failed"
    return 0
  fi
  emit_check "$name" "false" \
    "pgTAP: $passed/$total passing, $failed failing (exit=$exit_code)" \
    "$total" "$failed"
  emit_failure "$name" "pgTAP failures" \
    "$(tail -n 40 "$RUNLOG" | tr '\n' ' ')"
  return 1
}

# --- Run everything ---------------------------------------------------------

OVERALL_OK=1
# web also picks up ui-kit changes (its only consumer).
WEB_PREFIX_RE='^(apps/web/|packages/ui-kit/).*\.(ts|tsx|js|jsx)$'
WORKER_PREFIX_RE='^apps/mcp-worker/.*\.(ts|tsx|js|jsx)$'
APPTOOLS_PREFIX_RE='^packages/app-tools/.*\.(ts|tsx|js|jsx)$'

[ "$WEB_HIT"      = "1" ] && { run_vitest_changed "@luna-hub/web"        "$WEB_PREFIX_RE"      || OVERALL_OK=0; }
[ "$WORKER_HIT"   = "1" ] && { run_vitest_changed "@luna-hub/mcp-worker" "$WORKER_PREFIX_RE"   || OVERALL_OK=0; }
[ "$APPTOOLS_HIT" = "1" ] && { run_vitest_changed "@luna-hub/app-tools"  "$APPTOOLS_PREFIX_RE" || OVERALL_OK=0; }
[ "$PY_HIT"       = "1" ] && { run_pytest_impact                                               || OVERALL_OK=0; }
[ "$SQL_HIT"      = "1" ] && { run_supabase_pgtap                                              || OVERALL_OK=0; }

if [ "$CHANGED_COUNT" -eq 0 ]; then
  emit_check "nothing-to-check" "true" \
    "no files changed since $BASE_REF — nothing to run" 0 0
fi

if [ "$OVERALL_OK" = "1" ]; then
  emit_artifact true
  log "PASS (artifact: $ARTIFACT)"
  exit 0
fi
emit_artifact false
log "FAIL (artifact: $ARTIFACT)"
exit 1
