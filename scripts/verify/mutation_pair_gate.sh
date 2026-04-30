#!/usr/bin/env bash
# scripts/verify/mutation_pair_gate.sh — PR-scoped mutation-pair gate.
#
# For each test file added or modified in the PR (vs origin/main), locate the
# production file it most likely covers and assert that at least one mutant
# is killed by those tests when Stryker runs scoped to that production file.
#
# Anti-laziness guarantees:
#   - pass-on-timeout is FORBIDDEN → timeout exits with code 3 (TIMEOUT_FAIL)
#   - modified tests count the same as new tests
#   - mutation scope is STRICT: only prod files also modified in the same PR
#
# Usage:
#   bash scripts/verify/mutation_pair_gate.sh [--base <ref>]
#
#   --base <ref>   Compare against this ref instead of origin/main.
#                  Useful for self-tests where "main" is a temp branch.
#
# Exit codes:
#   0  all pairs killed ≥1 mutant  (or no pairs to check)
#   1  at least one pair killed 0 mutants (gate fail)
#   2  usage/preflight error
#   3  stryker timed out on a pair  (MUST NOT be treated as pass)
#
# Artifact: .verify/mutation-pair-gate.json (VERIFY.md shared schema)

set -uo pipefail

# REPO_ROOT can be overridden via env for self-test scenarios where the script
# is invoked from a non-repo location (e.g. /tmp copy during git stash tests).
if [[ -z "${REPO_ROOT:-}" ]]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
cd "$REPO_ROOT"

BASE_REF="origin/main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_REF="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
STRYKER_BIN="$REPO_ROOT/node_modules/.bin/stryker"
if [[ ! -x "$STRYKER_BIN" ]]; then
  echo "[mutation-pair] ERROR: Stryker not installed. Run: pnpm install" >&2
  exit 2
fi

mkdir -p "$REPO_ROOT/.verify"
mkdir -p "$REPO_ROOT/reports/mutation"

ARTIFACT="$REPO_ROOT/.verify/mutation-pair-gate.json"
LOG_FILE="$REPO_ROOT/.verify/mutation-pair-gate.log"
: > "$LOG_FILE"

START_MS=$(date +%s%3N)
RAN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

log() { echo "[mutation-pair] $*" | tee -a "$LOG_FILE" >&2; }

# ---------------------------------------------------------------------------
# Detect git diff vs base ref
# ---------------------------------------------------------------------------
# If diff fails (no remote, shallow clone, etc.) emit a no-op artifact and
# exit 0 — the gate only applies when a real PR diff exists.
if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  log "WARNING: $BASE_REF not found — no PR context, gate skipped."
  END_MS=$(date +%s%3N)
  node --input-type=module - <<NODE "$ARTIFACT" "$RAN_AT" "$((END_MS - START_MS))"
import fs from 'node:fs';
const [out, ranAt, dur] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({
  gate: 'mutation-pair-gate', ok: true,
  ran_at: ranAt, duration_ms: Number(dur),
  mode: 'skipped',
  reason: 'base-ref-not-found',
  pairs: [], checks: [], failures: [],
}, null, 2));
NODE
  exit 0
fi

CHANGED_ALL=$(git diff --name-only "$BASE_REF...HEAD" 2>/dev/null || true)

if [[ -z "$CHANGED_ALL" ]]; then
  log "No diff vs $BASE_REF — gate skipped (fresh clone / no PR)."
  END_MS=$(date +%s%3N)
  node --input-type=module - <<NODE "$ARTIFACT" "$RAN_AT" "$((END_MS - START_MS))"
import fs from 'node:fs';
const [out, ranAt, dur] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({
  gate: 'mutation-pair-gate', ok: true,
  ran_at: ranAt, duration_ms: Number(dur),
  mode: 'skipped',
  reason: 'empty-diff',
  pairs: [], checks: [], failures: [],
}, null, 2));
NODE
  exit 0
fi

# Separate test files from production files in the diff
CHANGED_TESTS=$(echo "$CHANGED_ALL" | grep -E '\.(test|spec)\.(ts|tsx|py|sql)$' || true)
CHANGED_PROD=$(echo "$CHANGED_ALL" | grep -Ev '\.(test|spec)\.(ts|tsx|py|sql)$' \
  | grep -Ev '(^__tests__|/__tests__/|/tests?/|\.config\.(ts|js|mjs)$|^scripts/|^docs/|\.md$|\.json$|\.lock$|\.sh$|^supabase/migrations/)' \
  || true)

log "Changed tests: $(echo "$CHANGED_TESTS" | grep -c . || echo 0)"
log "Changed prod:  $(echo "$CHANGED_PROD"  | grep -c . || echo 0)"

# ---------------------------------------------------------------------------
# Pair-finding heuristic
# ---------------------------------------------------------------------------
# Given a test file, find which production files it likely covers:
#   1. Path-mirror: strip __tests__/, tests/, /test/ prefix/suffix and the
#      .test.ts suffix → try that as a production path.
#   2. Import scan: grep for relative imports in the test file and resolve
#      them against the test file's directory.
# Returns newline-separated paths (relative to repo root), only those that
# exist AND appear in $CHANGED_PROD.

find_paired_prod_files() {
  local test_file="$1"
  local candidates=()

  # --- Strategy 1: path mirror ---
  # e.g. apps/web/src/__tests__/unit/hub/Foo.test.tsx → apps/web/src/components/hub/Foo.tsx
  #      apps/web/src/shared/Foo.test.ts              → apps/web/src/shared/Foo.ts
  local stripped
  # Remove test suffix (.test.ts, .test.tsx, .spec.ts, etc.)
  stripped="${test_file%.test.ts}"
  stripped="${stripped%.test.tsx}"
  stripped="${stripped%.spec.ts}"
  stripped="${stripped%.spec.tsx}"

  # Pattern: …/__tests__/unit/<subpath>/Basename → try several prod locations
  if [[ "$stripped" =~ /__tests__/unit/(.+) ]]; then
    local sub="${BASH_REMATCH[1]}"
    local src_root
    src_root="$(echo "$stripped" | sed 's|/__tests__/.*||')"

    # Try common production directories relative to src root
    for prod_dir in components pages hooks shared; do
      candidates+=("$src_root/$prod_dir/$sub.ts" "$src_root/$prod_dir/$sub.tsx")
    done
    # Direct: src_root/sub (for shared/ tests that mirror src/shared/)
    candidates+=("$src_root/$sub.ts" "$src_root/$sub.tsx")
  else
    # Sibling: test file and prod file in same directory
    candidates+=("$stripped.ts" "$stripped.tsx" "$stripped.py")
  fi

  # --- Strategy 2: import scan ---
  # Grep the test file for relative imports; resolve each against the file's dir
  local test_dir
  test_dir="$(dirname "$test_file")"
  while IFS= read -r line; do
    # Match: import ... from './foo' or '../bar/baz'
    if [[ "$line" =~ from\ [\'\"](\.\./[^\'\"]+|\.\/[^\'\"]+)[\'\"] ]]; then
      local rel="${BASH_REMATCH[1]}"
      # Resolve relative path from test_dir
      local resolved
      resolved="$(realpath -m "$REPO_ROOT/$test_dir/$rel" 2>/dev/null || true)"
      if [[ -n "$resolved" ]]; then
        local repo_rel="${resolved#$REPO_ROOT/}"
        # Try with common extensions
        for ext in "" ".ts" ".tsx" ".js"; do
          candidates+=("${repo_rel}${ext}")
        done
      fi
    fi
  done < <(grep -E "^import .* from ['\"]" "$REPO_ROOT/$test_file" 2>/dev/null || true)

  # Filter: file must exist AND be in CHANGED_PROD
  local seen=()
  for c in "${candidates[@]}"; do
    # Normalise: strip leading ./
    c="${c#./}"
    # Skip duplicates
    local already=0
    for s in "${seen[@]:-}"; do [[ "$s" == "$c" ]] && already=1 && break; done
    [[ "$already" -eq 1 ]] && continue
    if [[ -f "$REPO_ROOT/$c" ]] && echo "$CHANGED_PROD" | grep -qF "$c"; then
      seen+=("$c")
      echo "$c"
    fi
  done
}

# ---------------------------------------------------------------------------
# Map prod file → stryker config
# ---------------------------------------------------------------------------
config_for_prod_file() {
  local f="$1"
  case "$f" in
    extensions/*) echo "stryker.conf.json" ;;
    apps/mcp-worker/src/*) echo "stryker.mcp-worker.conf.json" ;;
    # shared/ primitives: perTest coverage — fast, small surface.
    apps/web/src/shared/*) echo "stryker.web-shared.conf.json" ;;
    # components/ and pages/: coverageAnalysis:off to avoid OOM on React
    # components with many mutants. Runs full web vitest suite per mutant.
    # bash case uses prefix glob — sub-directories are covered by /*
    apps/web/src/components/*) echo "stryker.web-components.conf.json" ;;
    apps/web/src/pages/*) echo "stryker.web-components.conf.json" ;;
    # Other apps/web/* (hooks/, etc.) — shared config as fallback.
    apps/web/src/*) echo "stryker.web-shared.conf.json" ;;
    *) echo "" ;;
  esac
}

# ---------------------------------------------------------------------------
# Build pairs
# ---------------------------------------------------------------------------
declare -A PAIR_SEEN=()
ALL_TEST_FILES=()
if [[ -n "$CHANGED_TESTS" ]]; then
  while IFS= read -r tf; do
    [[ -z "$tf" ]] && continue
    [[ -f "$REPO_ROOT/$tf" ]] || continue
    ALL_TEST_FILES+=("$tf")
  done <<< "$CHANGED_TESTS"
fi

declare -a PAIR_TESTS=()
declare -a PAIR_PRODS=()

for tf in "${ALL_TEST_FILES[@]:-}"; do
  [[ -z "$tf" ]] && continue
  paired_prods=$(find_paired_prod_files "$tf")
  if [[ -z "$paired_prods" ]]; then
    log "no paired prod file found for: $tf"
  else
    while IFS= read -r pf; do
      [[ -z "$pf" ]] && continue
      key="${tf}::${pf}"
      if [[ -z "${PAIR_SEEN[$key]:-}" ]]; then
        PAIR_SEEN[$key]=1
        log "pair: $tf → $pf"
        PAIR_TESTS+=("$tf")
        PAIR_PRODS+=("$pf")
      fi
    done <<< "$paired_prods"
  fi
done

NUM_PAIRS=${#PAIR_TESTS[@]}
log "total pairs to check: $NUM_PAIRS"

# ---------------------------------------------------------------------------
# Warning: tests added but no prod code changed
# ---------------------------------------------------------------------------
HAS_TESTS_NO_PROD_PARTNER=0
if [[ "${#ALL_TEST_FILES[@]:-0}" -gt 0 && -z "$CHANGED_PROD" ]]; then
  log "WARNING: test files changed but no production code changed in this PR."
  log "         The gate cannot pair tests — emitting 'test-only' warning (not failure)."
  HAS_TESTS_NO_PROD_PARTNER=1
fi

# ---------------------------------------------------------------------------
# If no pairs: emit artifact + exit 0
# ---------------------------------------------------------------------------
if [[ "$NUM_PAIRS" -eq 0 ]]; then
  END_MS=$(date +%s%3N)
  REASON="no-pairs"
  if [[ "$HAS_TESTS_NO_PROD_PARTNER" -eq 1 ]]; then
    REASON="test-only-no-prod-partner"
  elif [[ -z "$CHANGED_TESTS" ]]; then
    REASON="no-test-files-changed"
  fi
  node --input-type=module - <<NODE "$ARTIFACT" "$RAN_AT" "$((END_MS - START_MS))" "$REASON"
import fs from 'node:fs';
const [out, ranAt, dur, reason] = process.argv.slice(2);
const isWarn = reason === 'test-only-no-prod-partner';
fs.writeFileSync(out, JSON.stringify({
  gate: 'mutation-pair-gate', ok: true,
  ran_at: ranAt, duration_ms: Number(dur),
  mode: 'no-pairs',
  reason,
  warning: isWarn ? 'Tests added/modified but no production files changed — cannot verify mutation kill.' : undefined,
  pairs: [], checks: [], failures: [],
}, null, 2));
NODE
  if [[ "$HAS_TESTS_NO_PROD_PARTNER" -eq 1 ]]; then
    log "WARNING emitted (test-only PR — not a gate failure)."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Run Stryker per (test, prod) pair — strict per-file scope
# ---------------------------------------------------------------------------
OVERALL_EXIT=0
PAIR_RESULTS=()

run_pair() {
  local idx="$1"
  local test_f="$2"
  local prod_f="$3"

  local cfg
  cfg=$(config_for_prod_file "$prod_f")

  local pair_report_path="$REPO_ROOT/reports/mutation/mutation-pair-${idx}.json"

  log "[$idx/$NUM_PAIRS] test=$test_f  prod=$prod_f  config=${cfg:-UNROUTABLE}"

  if [[ -z "$cfg" ]]; then
    local ext="${prod_f##*.}"
    if [[ "$ext" == "sql" || "$ext" == "py" ]]; then
      log "  SKIP: $ext production file — TS Stryker N/A. Manual review required."
      PAIR_RESULTS+=("{\"index\":$idx,\"test\":\"$test_f\",\"prod\":\"$prod_f\",\"status\":\"skip\",\"reason\":\"non-ts-file\",\"killed\":0}")
      return 0
    fi
    log "  FAIL: production file $prod_f not in any Stryker scope"
    PAIR_RESULTS+=("{\"index\":$idx,\"test\":\"$test_f\",\"prod\":\"$prod_f\",\"status\":\"fail\",\"reason\":\"unroutable\",\"killed\":0}")
    OVERALL_EXIT=1
    return 0
  fi

  # Build a temp config that overrides mutate[] and jsonReporter.fileName.
  # We can't pass --jsonReporter.fileName via CLI (not a valid Stryker CLI flag);
  # it must be set in the config file. We read the base config, override the
  # relevant fields, and write a temporary config for this pair.
  local temp_cfg="$REPO_ROOT/.verify/mutation-pair-${idx}.stryker.conf.json"
  local temp_dir="$REPO_ROOT/.stryker-tmp-pair-${idx}"
  node --input-type=module - <<NODE "$cfg" "$prod_f" "$pair_report_path" "$temp_cfg" "$temp_dir" "$test_f"
import fs from 'node:fs';
const [cfgPath, prodFile, reportPath, outPath, tmpDir, testFile] = process.argv.slice(2);
let base = {};
try { base = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
const merged = {
  ...base,
  mutate: [prodFile],
  // Scope testFiles to the single test that covers this prod file.
  // This avoids loading the entire 131+ test suite for a single-file pair check,
  // which would OOM on large monorepos.
  testFiles: [testFile],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: reportPath },
  tempDirName: tmpDir,
  cleanTempDir: true,
  // Suppress threshold break so Stryker exits 0 on low-score (we check killed count ourselves)
  thresholds: { high: 80, low: 0, break: 0 },
};
// Remove vitest.related if present — it can conflict with single-file testFiles scope
if (merged.vitest) delete merged.vitest.related;
fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
NODE

  # Run Stryker scoped to exactly prod_f using the temp config.
  # Bump Node heap to 8GB — components config uses coverageAnalysis:off
  # which runs every test for every mutant; React Testing Library +
  # jsdom + 76+ mutants exhausts the default 2GB heap.
  local stryker_exit=0
  {
    NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192" \
      "$STRYKER_BIN" run "$temp_cfg" 2>&1
  } | tee -a "$LOG_FILE" ; stryker_exit=${PIPESTATUS[0]}
  rm -f "$temp_cfg" 2>/dev/null || true

  # Timeout detection: stryker_exit != 0 AND no report written
  if [[ "$stryker_exit" -ne 0 && ! -f "$pair_report_path" ]]; then
    log "  TIMEOUT or hard error (exit=$stryker_exit, no report produced)"
    PAIR_RESULTS+=("{\"index\":$idx,\"test\":\"$test_f\",\"prod\":\"$prod_f\",\"status\":\"timeout\",\"reason\":\"stryker-no-report\",\"killed\":0}")
    OVERALL_EXIT=3
    return 0
  fi

  # Parse killed count
  local killed
  killed=$(node --input-type=module - "$pair_report_path" <<'NODE' 2>/dev/null || echo "0"
import fs from 'node:fs';
const p = process.argv[2];
try {
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  let k = 0;
  for (const fd of Object.values(r.files ?? {})) {
    for (const m of fd.mutants ?? []) {
      if (m.status === 'Killed') k++;
    }
  }
  process.stdout.write(String(k));
} catch {
  process.stdout.write('0');
}
NODE
  )

  log "  killed=$killed"

  if [[ "$killed" -gt 0 ]]; then
    PAIR_RESULTS+=("{\"index\":$idx,\"test\":\"$test_f\",\"prod\":\"$prod_f\",\"status\":\"pass\",\"killed\":$killed}")
  else
    log "  FAIL: zero mutants killed — test may be tautological"
    PAIR_RESULTS+=("{\"index\":$idx,\"test\":\"$test_f\",\"prod\":\"$prod_f\",\"status\":\"fail\",\"reason\":\"zero-killed\",\"killed\":0}")
    OVERALL_EXIT=1
  fi
}

for i in "${!PAIR_TESTS[@]}"; do
  run_pair "$((i + 1))" "${PAIR_TESTS[$i]}" "${PAIR_PRODS[$i]}"
done

# ---------------------------------------------------------------------------
# Write artifact
# ---------------------------------------------------------------------------
END_MS=$(date +%s%3N)
DURATION_MS=$((END_MS - START_MS))

PAIRS_RAW=""
for r in "${PAIR_RESULTS[@]}"; do
  PAIRS_RAW+="$r"$'\n'
done

echo "$PAIRS_RAW" | node --input-type=module - "$ARTIFACT" "$RAN_AT" "$DURATION_MS" "$OVERALL_EXIT" <<'NODE'
import fs from 'node:fs';
const [artifactPath, ranAt, durMs, exitRaw] = process.argv.slice(2);
const exitCode = Number(exitRaw);

let stdinData = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdinData += chunk;

const pairs = stdinData.trim().split('\n').filter(Boolean).map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const checks = pairs.map(p => ({
  name: `pair:${p.test}→${p.prod}`,
  ok: p.status === 'pass' || p.status === 'skip',
  evidence: p.status === 'pass'
    ? `killed ${p.killed} mutant(s) in ${p.prod}`
    : p.status === 'skip'
      ? `skipped: ${p.reason}`
      : p.status === 'timeout'
        ? 'TIMEOUT — stryker produced no report'
        : 'zero mutants killed — test may be tautological',
}));

const failures = pairs
  .filter(p => p.status === 'fail' || p.status === 'timeout')
  .map(p => ({
    check: `pair:${p.test}→${p.prod}`,
    message: p.status === 'timeout'
      ? 'Stryker timed out — treated as gate failure (no pass-on-timeout)'
      : `Zero mutants killed in ${p.prod} by ${p.test}`,
    detail: p.reason ?? null,
  }));

const artifact = {
  gate: 'mutation-pair-gate',
  ok: exitCode === 0,
  ran_at: ranAt,
  duration_ms: Number(durMs),
  mode: 'pr-scoped',
  pairs,
  checks,
  failures,
};
fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
process.stderr.write(`[mutation-pair] wrote ${artifactPath}\n`);
NODE

if [[ "$OVERALL_EXIT" -eq 3 ]]; then
  log "GATE FAIL: Stryker timeout on at least one pair (exit 3 — not a pass)"
  exit 3
elif [[ "$OVERALL_EXIT" -ne 0 ]]; then
  log "GATE FAIL: at least one (test, prod) pair killed 0 mutants"
  exit 1
else
  log "GATE PASS: all pairs killed ≥1 mutant"
  exit 0
fi
