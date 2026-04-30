#!/usr/bin/env bash
# scripts/verify/tests/mutation_pair_gate_self_test.sh
#
# Self-test (negative-twin proof) for mutation_pair_gate.sh.
#
# Simulator A — tautological test:
#   Creates a temp branch with a production file + a tautological test.
#   Runs the gate with --base pointing at the common base. Asserts FAIL.
#
# Simulator B — rigorous test:
#   Creates a temp branch with the same production file + a rigorous test.
#   Runs the gate. Asserts PASS.
#
# The production files live under extensions/ (extensions/**/*.ts) so
# stryker.conf.json covers them via packages/app-tools/vitest.config.ts.
#
# NEGATIVE-TWIN-PROOF:
#   Tautological-test simulator: creates a test that does nothing, runs the
#   gate, asserts gate FAILS.
#   Real-test simulator: creates a test that catches a known mutation, runs
#   the gate, asserts gate PASSES.
#   Verified: bash scripts/verify/tests/mutation_pair_gate_self_test.sh
#
# Exit 0 = both simulators behaved correctly.
# Exit 1 = at least one simulator produced the wrong outcome.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

GATE="$REPO_ROOT/scripts/verify/mutation_pair_gate.sh"
STRYKER="$REPO_ROOT/node_modules/.bin/stryker"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
RST='\033[0m'

ok()   { printf "${GRN}  PASS${RST} %s\n" "$*"; }
fail() { printf "${RED}  FAIL${RST} %s\n" "$*" >&2; CLEANUP_FAIL=1; }
info() { printf "${YLW}  INFO${RST} %s\n" "$*"; }

CLEANUP_FAIL=0

if [[ ! -x "$STRYKER" ]]; then
  echo "[self-test] ERROR: Stryker not installed. Run: pnpm install" >&2
  exit 2
fi

if [[ ! -x "$GATE" ]]; then
  echo "[self-test] ERROR: gate not found or not executable: $GATE" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Strategy: instead of git branch gymnastics, we use the gate's direct
# Stryker invocation path.
#
# The gate's core assertion is: killed ≥ 1 for each (test, prod) pair.
# We test this assertion directly by:
#   1. Creating fixture files (prod + test) in a temp worktree directory
#   2. Running Stryker directly with a temp config scoped to the fixture
#   3. Asserting killed count
#
# Then we test the FULL gate path with actual git diff by:
#   - Stashing ALL changes (--include-untracked) for a clean slate
#   - Making commits on temp branches
#   - Running the gate
#   - Popping stash after
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Phase 1: Direct Stryker fixture test (fast, no git ceremony)
# ---------------------------------------------------------------------------
info "=== Phase 1: Direct Stryker fixture validation ==="

PROD_A="extensions/_self_test_gate_a/index.ts"
TEST_A="packages/app-tools/src/__tests__/_self_test_gate_a.test.ts"
PROD_B="extensions/_self_test_gate_b/index.ts"
TEST_B="packages/app-tools/src/__tests__/_self_test_gate_b.test.ts"
REPORT_A="$REPO_ROOT/reports/mutation/pair-self-test-a.json"
REPORT_B="$REPO_ROOT/reports/mutation/pair-self-test-b.json"
CONF_A="$REPO_ROOT/.verify/pair-self-test-a.stryker.conf.json"
CONF_B="$REPO_ROOT/.verify/pair-self-test-b.stryker.conf.json"

cleanup_fixtures() {
  rm -rf "$REPO_ROOT/extensions/_self_test_gate_a" \
         "$REPO_ROOT/extensions/_self_test_gate_b" 2>/dev/null || true
  rm -f "$REPO_ROOT/$TEST_A" "$REPO_ROOT/$TEST_B" "$CONF_A" "$CONF_B" 2>/dev/null || true
  rm -f "$REPORT_A" "$REPORT_B" 2>/dev/null || true
}

trap cleanup_fixtures EXIT

mkdir -p "$REPO_ROOT/extensions/_self_test_gate_a"
mkdir -p "$REPO_ROOT/extensions/_self_test_gate_b"
mkdir -p "$REPO_ROOT/.verify"
mkdir -p "$REPO_ROOT/reports/mutation"

# Write production files
cat > "$REPO_ROOT/$PROD_A" <<'EOF'
// _self_test_gate_a — PR mutation pair gate self-test fixture (Simulator A).
export function gradeA(score: number): 'fail' | 'pass' | 'ace' {
  if (score < 60) return 'fail';
  if (score < 90) return 'pass';
  return 'ace';
}
EOF

cat > "$REPO_ROOT/$PROD_B" <<'EOF'
// _self_test_gate_b — PR mutation pair gate self-test fixture (Simulator B).
export function gradeB(score: number): 'fail' | 'pass' | 'ace' {
  if (score < 60) return 'fail';
  if (score < 90) return 'pass';
  return 'ace';
}
EOF

# Write TAUTOLOGICAL test for A
# The test ONLY checks that the function is callable and returns a truthy value.
# It does NOT check which specific string is returned — so Stryker can swap
# 'fail' → '' (empty, falsy) and kill it, OR swap return branches and the test
# still passes. To make it genuinely tautological, we must not call the function
# at all — just check it was imported successfully.
cat > "$REPO_ROOT/$TEST_A" <<'EOF'
// _self_test_gate_a.test.ts — TAUTOLOGICAL (Simulator A negative fixture).
// Does NOT call gradeA with any input that would exercise its branches.
// Stryker can mutate any branch operator or return value without this test failing.
import { describe, expect, it } from 'vitest';
import { gradeA } from '../../../../extensions/_self_test_gate_a/index';
describe('gradeA (tautological)', () => {
  it('module imported without error', () => {
    // Only checks the import succeeded — not the logic.
    expect(gradeA).toBeDefined();
    expect(typeof gradeA).toBe('function');
  });
});
EOF

# Write RIGOROUS test for B
cat > "$REPO_ROOT/$TEST_B" <<'EOF'
// _self_test_gate_b.test.ts — RIGOROUS (Simulator B positive fixture).
import { describe, expect, it } from 'vitest';
import { gradeB } from '../../../../extensions/_self_test_gate_b/index';
describe('gradeB (rigorous)', () => {
  it('returns fail below 60', () => {
    expect(gradeB(0)).toBe('fail');
    expect(gradeB(59)).toBe('fail');
  });
  it('returns pass at boundary 60 — kills < 60 → <= 60 mutation', () => {
    expect(gradeB(60)).toBe('pass');
    expect(gradeB(60)).not.toBe('fail');
  });
  it('returns pass mid range', () => {
    expect(gradeB(75)).toBe('pass');
    expect(gradeB(89)).toBe('pass');
  });
  it('returns ace at boundary 90 — kills < 90 → <= 90 mutation', () => {
    expect(gradeB(90)).toBe('ace');
    expect(gradeB(90)).not.toBe('pass');
  });
  it('returns ace above 90', () => {
    expect(gradeB(95)).toBe('ace');
    expect(gradeB(100)).toBe('ace');
  });
});
EOF

# Write Stryker configs
cat > "$CONF_A" <<EOF
{
  "\$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "plugins": ["@stryker-mutator/vitest-runner"],
  "vitest": { "configFile": "packages/app-tools/vitest.config.ts", "dir": "packages/app-tools" },
  "coverageAnalysis": "perTest",
  "timeoutMS": 20000,
  "timeoutFactor": 2,
  "concurrency": 2,
  "mutate": ["$PROD_A"],
  "ignorePatterns": ["dist","coverage","legacy","hardware",".verify",".turbo",".wrangler",".vercel",".stryker-tmp"],
  "reporters": ["clear-text", "json"],
  "jsonReporter": { "fileName": "$REPORT_A" },
  "thresholds": { "high": 80, "low": 40, "break": 0 },
  "tempDirName": ".stryker-tmp-pair-self-test-a",
  "cleanTempDir": true
}
EOF

cat > "$CONF_B" <<EOF
{
  "\$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "plugins": ["@stryker-mutator/vitest-runner"],
  "vitest": { "configFile": "packages/app-tools/vitest.config.ts", "dir": "packages/app-tools" },
  "coverageAnalysis": "perTest",
  "timeoutMS": 20000,
  "timeoutFactor": 2,
  "concurrency": 2,
  "mutate": ["$PROD_B"],
  "ignorePatterns": ["dist","coverage","legacy","hardware",".verify",".turbo",".wrangler",".vercel",".stryker-tmp"],
  "reporters": ["clear-text", "json"],
  "jsonReporter": { "fileName": "$REPORT_B" },
  "thresholds": { "high": 80, "low": 40, "break": 0 },
  "tempDirName": ".stryker-tmp-pair-self-test-b",
  "cleanTempDir": true
}
EOF

# ---------------------------------------------------------------------------
# Simulator A: tautological — expect killed=0
# ---------------------------------------------------------------------------
info "=== Simulator A: tautological test (Stryker should kill 0) ==="
"$STRYKER" run "$CONF_A" 2>&1 | grep -E '(Mutation score|killed|survived)' | tail -5 || true

KILLED_A=0
if [[ -f "$REPORT_A" ]]; then
  KILLED_A=$(node --input-type=module - "$REPORT_A" <<'NODE' 2>/dev/null || echo "0"
import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let k = 0;
for (const fd of Object.values(r.files ?? {})) {
  for (const m of fd.mutants ?? []) { if (m.status === 'Killed') k++; }
}
process.stdout.write(String(k));
NODE
  )
fi

info "  Simulator A: killed=$KILLED_A (want 0)"
if [[ "$KILLED_A" -gt 0 ]]; then
  fail "Simulator A: tautological test killed $KILLED_A mutants — fixture is not tautological!"
else
  ok "Simulator A: tautological test killed 0 mutants as expected"
fi

# ---------------------------------------------------------------------------
# Simulator B: rigorous — expect killed >= 1
# ---------------------------------------------------------------------------
info "=== Simulator B: rigorous test (Stryker should kill ≥1) ==="
"$STRYKER" run "$CONF_B" 2>&1 | grep -E '(Mutation score|killed|survived)' | tail -5 || true

KILLED_B=0
if [[ -f "$REPORT_B" ]]; then
  KILLED_B=$(node --input-type=module - "$REPORT_B" <<'NODE' 2>/dev/null || echo "0"
import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let k = 0;
for (const fd of Object.values(r.files ?? {})) {
  for (const m of fd.mutants ?? []) { if (m.status === 'Killed') k++; }
}
process.stdout.write(String(k));
NODE
  )
fi

info "  Simulator B: killed=$KILLED_B (want ≥1)"
if [[ "$KILLED_B" -lt 1 ]]; then
  fail "Simulator B: rigorous test killed 0 mutants — fixture is not rigorous!"
else
  ok "Simulator B: rigorous test killed $KILLED_B mutant(s) as expected"
fi

# ---------------------------------------------------------------------------
# Phase 2: Full gate path via git diff simulation
# Stash ALL working tree changes (including untracked) so commits are clean.
# ---------------------------------------------------------------------------
info ""
info "=== Phase 2: Full gate invocation via git diff ==="

ORIG_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
ORIG_HEAD=$(git rev-parse HEAD)
SUFFIX="$$"
BASE_BRANCH="mpg-self-test-base-$SUFFIX"
BRANCH_A="mpg-self-test-a-$SUFFIX"
BRANCH_B="mpg-self-test-b-$SUFFIX"

cleanup_git() {
  git checkout -q "$ORIG_BRANCH" 2>/dev/null || git checkout -q "$ORIG_HEAD" 2>/dev/null || true
  git branch -D "$BASE_BRANCH" 2>/dev/null || true
  git branch -D "$BRANCH_A"    2>/dev/null || true
  git branch -D "$BRANCH_B"    2>/dev/null || true
}

# The gate script may be untracked (before first commit). Copy it to /tmp
# so it survives the stash --include-untracked.
GATE_TMP="/tmp/mutation_pair_gate_selftest_$SUFFIX.sh"
cp "$GATE" "$GATE_TMP"
chmod +x "$GATE_TMP"

# Stash everything including untracked (clean working tree for temp commits)
STASH_MSG="mpg-self-test-stash-$SUFFIX"
info "  Stashing all working tree changes (including untracked)..."
git stash push --include-untracked -m "$STASH_MSG" 2>&1 | tail -2 || true
# Check if stash was actually created
STASH_LIST=$(git stash list --format="%s" 2>/dev/null | head -3)
info "  Stash state: $STASH_LIST"

git checkout -q -b "$BASE_BRANCH" 2>/dev/null

# --- Simulator A gate path ---
git checkout -q -b "$BRANCH_A" 2>/dev/null
# Write clean files (prod + tautological test)
mkdir -p "$REPO_ROOT/extensions/_self_test_gate_a"
cat > "$REPO_ROOT/$PROD_A" <<'EOF'
export function gradeA(score: number): 'fail' | 'pass' | 'ace' {
  if (score < 60) return 'fail';
  if (score < 90) return 'pass';
  return 'ace';
}
EOF
mkdir -p "$(dirname "$REPO_ROOT/$TEST_A")"
# Truly tautological: only checks the import — does not exercise any branch
cat > "$REPO_ROOT/$TEST_A" <<'EOF'
import { describe, expect, it } from 'vitest';
import { gradeA } from '../../../../extensions/_self_test_gate_a/index';
describe('gradeA (tautological)', () => {
  it('module imported without error', () => {
    expect(gradeA).toBeDefined();
    expect(typeof gradeA).toBe('function');
  });
});
EOF
git add "$PROD_A" "$TEST_A"
git commit --no-gpg-sign -m "self-test-a: tautological fixture" 2>&1 | tail -2

info "  Running gate with --base $BASE_BRANCH (Simulator A, tautological)..."
GATE_EXIT_A=0
REPO_ROOT="$REPO_ROOT" bash "$GATE_TMP" --base "$BASE_BRANCH" 2>&1 | grep -E '(\[mutation-pair\]|GATE|pair:)' | tail -8 || GATE_EXIT_A=$?

info "  Gate exit Simulator A: $GATE_EXIT_A (want non-zero)"
if [[ "$GATE_EXIT_A" -eq 0 ]]; then
  fail "Gate-path Simulator A: gate exited 0 — tautological test NOT caught!"
else
  ok "Gate-path Simulator A: gate correctly FAILED (exit $GATE_EXIT_A)"
fi

# --- Simulator B gate path ---
git checkout -q "$BASE_BRANCH" 2>/dev/null
git checkout -q -b "$BRANCH_B" 2>/dev/null

mkdir -p "$REPO_ROOT/extensions/_self_test_gate_b"
cat > "$REPO_ROOT/$PROD_B" <<'EOF'
export function gradeB(score: number): 'fail' | 'pass' | 'ace' {
  if (score < 60) return 'fail';
  if (score < 90) return 'pass';
  return 'ace';
}
EOF
mkdir -p "$(dirname "$REPO_ROOT/$TEST_B")"
cat > "$REPO_ROOT/$TEST_B" <<'EOF'
import { describe, expect, it } from 'vitest';
import { gradeB } from '../../../../extensions/_self_test_gate_b/index';
describe('gradeB (rigorous)', () => {
  it('fail below 60', () => { expect(gradeB(0)).toBe('fail'); expect(gradeB(59)).toBe('fail'); });
  it('pass at 60', () => { expect(gradeB(60)).toBe('pass'); expect(gradeB(60)).not.toBe('fail'); });
  it('pass mid', () => { expect(gradeB(75)).toBe('pass'); expect(gradeB(89)).toBe('pass'); });
  it('ace at 90', () => { expect(gradeB(90)).toBe('ace'); expect(gradeB(90)).not.toBe('pass'); });
  it('ace above 90', () => { expect(gradeB(95)).toBe('ace'); expect(gradeB(100)).toBe('ace'); });
});
EOF
git add "$PROD_B" "$TEST_B"
git commit --no-gpg-sign -m "self-test-b: rigorous fixture" 2>&1 | tail -2

info "  Running gate with --base $BASE_BRANCH (Simulator B, rigorous)..."
GATE_EXIT_B=0
REPO_ROOT="$REPO_ROOT" bash "$GATE_TMP" --base "$BASE_BRANCH" 2>&1 | grep -E '(\[mutation-pair\]|GATE|pair:)' | tail -8 || GATE_EXIT_B=$?

info "  Gate exit Simulator B: $GATE_EXIT_B (want 0)"
if [[ "$GATE_EXIT_B" -ne 0 ]]; then
  fail "Gate-path Simulator B: gate exited $GATE_EXIT_B — rigorous test NOT accepted!"
else
  ok "Gate-path Simulator B: gate correctly PASSED (exit 0)"
fi

cleanup_git
rm -f "$GATE_TMP" 2>/dev/null || true

# Pop stash to restore working tree
info "  Restoring working tree from stash..."
git stash pop 2>&1 | tail -3 || info "  (nothing to pop or stash already restored)"

# ---------------------------------------------------------------------------
# Final result
# ---------------------------------------------------------------------------
if [[ "$CLEANUP_FAIL" -ne 0 ]]; then
  echo ""
  printf "${RED}  mutation_pair_gate self-test: FAILED${RST}\n"
  exit 1
fi

echo ""
echo "============================================================"
printf "${GRN}  mutation_pair_gate self-test: ALL PASS${RST}\n"
echo "  Simulator A (tautological): Stryker killed 0, gate FAILED"
echo "  Simulator B (rigorous):     Stryker killed ≥1, gate PASSED"
echo "============================================================"
exit 0
