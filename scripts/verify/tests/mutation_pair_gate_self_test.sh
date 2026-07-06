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
# PID-based names prevent collisions with .gitignore patterns from prior runs.
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
fail() { printf "${RED}  FAIL${RST} %s\n" "$*" >&2; SELF_FAIL=1; }
info() { printf "${YLW}  INFO${RST} %s\n" "$*"; }

SELF_FAIL=0

if [[ ! -x "$STRYKER" ]]; then
  echo "[self-test] ERROR: Stryker not installed. Run: pnpm install" >&2
  exit 2
fi

if [[ ! -x "$GATE" ]]; then
  echo "[self-test] ERROR: gate not found or not executable: $GATE" >&2
  exit 2
fi

# PID-based unique names to avoid .gitignore collisions from prior runs
P="$$"
PROD_A="extensions/_mpg_a_${P}/index.ts"
TEST_A="packages/app-tools/src/__tests__/_mpg_a_${P}.test.ts"
PROD_B="extensions/_mpg_b_${P}/index.ts"
TEST_B="packages/app-tools/src/__tests__/_mpg_b_${P}.test.ts"
REPORT_A="$REPO_ROOT/reports/mutation/mpg-self-test-a-${P}.json"
REPORT_B="$REPO_ROOT/reports/mutation/mpg-self-test-b-${P}.json"
CONF_A="$REPO_ROOT/.verify/mpg-self-test-a-${P}.stryker.conf.json"
CONF_B="$REPO_ROOT/.verify/mpg-self-test-b-${P}.stryker.conf.json"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
cleanup_all() {
  # Return to original branch
  git checkout -q "$ORIG_BRANCH" 2>/dev/null || true
  # Remove fixture dirs/files
  rm -rf "$REPO_ROOT/extensions/_mpg_a_${P}" \
         "$REPO_ROOT/extensions/_mpg_b_${P}" 2>/dev/null || true
  rm -f "$REPO_ROOT/$TEST_A" "$REPO_ROOT/$TEST_B" 2>/dev/null || true
  rm -f "$CONF_A" "$CONF_B" "$REPORT_A" "$REPORT_B" 2>/dev/null || true
  rm -f "$GATE_TMP" 2>/dev/null || true
  # Remove temp branches
  git branch -D "$BASE_BRANCH" 2>/dev/null || true
  git branch -D "$BRANCH_A"    2>/dev/null || true
  git branch -D "$BRANCH_B"    2>/dev/null || true
  # Pop stash — re-resolve the ref by message (branch churn during the run can
  # renumber stash@{n}), and NEVER fail silently: an unpopped stash means the
  # user's working tree changes are sitting orphaned in `git stash list`.
  local want_ref="${STASH_REF:-}"
  if [[ -n "$want_ref" ]]; then
    local live_ref
    live_ref=$(git stash list 2>/dev/null | grep -m1 -F "mpg-self-test-stash-$SUFFIX" | cut -d: -f1 || true)
    if [[ -n "$live_ref" ]] && git stash pop "$live_ref"; then
      info "restored stashed working tree changes ($live_ref)"
    else
      printf "${RED}  ERROR${RST} failed to pop self-test stash '%s' — your working tree changes are STILL IN THE STASH.\n" "mpg-self-test-stash-$SUFFIX" >&2
      printf "${RED}       ${RST} recover manually: git stash list && git stash pop <that ref>\n" >&2
      SELF_FAIL=1
    fi
  fi
  info "cleanup done"
}

ORIG_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
SUFFIX="$P"
BASE_BRANCH="mpg-self-test-base-$SUFFIX"
BRANCH_A="mpg-self-test-a-$SUFFIX"
BRANCH_B="mpg-self-test-b-$SUFFIX"
GATE_TMP="/tmp/mpg_gate_$SUFFIX.sh"
STASH_SHA=""

trap cleanup_all EXIT

mkdir -p "$REPO_ROOT/.verify"
mkdir -p "$REPO_ROOT/reports/mutation"

# ---------------------------------------------------------------------------
# Phase 1: Direct Stryker validation (no git ceremony, proves fixture works)
# ---------------------------------------------------------------------------
info "=== Phase 1: Direct Stryker fixture validation ==="

mkdir -p "$REPO_ROOT/extensions/_mpg_a_${P}"
mkdir -p "$REPO_ROOT/extensions/_mpg_b_${P}"
mkdir -p "$REPO_ROOT/packages/app-tools/src/__tests__"

# Production file A & B (identical logic, different names)
for suffix in "a" "b"; do
  cat > "$REPO_ROOT/extensions/_mpg_${suffix}_${P}/index.ts" <<EOF
// mpg_${suffix} — PR mutation pair gate self-test fixture.
export function grade_${suffix}(score: number): 'fail' | 'pass' | 'ace' {
  if (score < 60) return 'fail';
  if (score < 90) return 'pass';
  return 'ace';
}
EOF
done

# TAUTOLOGICAL test for A: only checks import, never exercises branches
cat > "$REPO_ROOT/$TEST_A" <<EOF
// Tautological fixture — never exercises grade_a's branches.
import { describe, expect, it } from 'vitest';
import { grade_a } from '../../../../extensions/_mpg_a_${P}/index';
describe('grade_a (tautological)', () => {
  it('module imported', () => {
    expect(grade_a).toBeDefined();
    expect(typeof grade_a).toBe('function');
  });
});
EOF

# RIGOROUS test for B: exercises every boundary value
cat > "$REPO_ROOT/$TEST_B" <<EOF
// Rigorous fixture — kills boundary mutations.
import { describe, expect, it } from 'vitest';
import { grade_b } from '../../../../extensions/_mpg_b_${P}/index';
describe('grade_b (rigorous)', () => {
  it('fail below 60', () => { expect(grade_b(0)).toBe('fail'); expect(grade_b(59)).toBe('fail'); });
  it('pass at 60 — kills < 60 → <= 60', () => { expect(grade_b(60)).toBe('pass'); expect(grade_b(60)).not.toBe('fail'); });
  it('pass mid', () => { expect(grade_b(75)).toBe('pass'); expect(grade_b(89)).toBe('pass'); });
  it('ace at 90 — kills < 90 → <= 90', () => { expect(grade_b(90)).toBe('ace'); expect(grade_b(90)).not.toBe('pass'); });
  it('ace above 90', () => { expect(grade_b(95)).toBe('ace'); expect(grade_b(100)).toBe('ace'); });
});
EOF

# Write Stryker configs — note thresholds.break = 0 so Stryker exits 0 even
# with low scores (we check killed count ourselves).
cat > "$CONF_A" <<JSONEOF
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
  "mutate": ["${PROD_A}"],
  "ignorePatterns": ["dist","coverage","legacy","hardware",".verify",".turbo",".wrangler",".vercel",".stryker-tmp",".stryker-tmp-*"],
  "reporters": ["clear-text", "json"],
  "jsonReporter": { "fileName": "${REPORT_A}" },
  "thresholds": { "high": 80, "low": 0, "break": 0 },
  "tempDirName": ".stryker-tmp-mpg-a-${P}",
  "cleanTempDir": true
}
JSONEOF

cat > "$CONF_B" <<JSONEOF
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
  "mutate": ["${PROD_B}"],
  "ignorePatterns": ["dist","coverage","legacy","hardware",".verify",".turbo",".wrangler",".vercel",".stryker-tmp",".stryker-tmp-*"],
  "reporters": ["clear-text", "json"],
  "jsonReporter": { "fileName": "${REPORT_B}" },
  "thresholds": { "high": 80, "low": 0, "break": 0 },
  "tempDirName": ".stryker-tmp-mpg-b-${P}",
  "cleanTempDir": true
}
JSONEOF

extract_killed() {
  local report="$1"
  if [[ ! -f "$report" ]]; then echo "0"; return; fi
  node --input-type=module - "$report" <<'NODE' 2>/dev/null || echo "0"
import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let k = 0;
for (const fd of Object.values(r.files ?? {})) {
  for (const m of fd.mutants ?? []) { if (m.status === 'Killed') k++; }
}
process.stdout.write(String(k));
NODE
}

info "  Phase 1-A: Stryker on tautological fixture..."
"$STRYKER" run "$CONF_A" 2>&1 | grep -E '(Mutation score|killed|survived|# killed)' | tail -3 || true
KILLED_A=$(extract_killed "$REPORT_A")
info "  Phase 1-A: killed=$KILLED_A (want 0)"
if [[ "$KILLED_A" -gt 0 ]]; then
  fail "Phase 1-A: tautological fixture killed $KILLED_A mutants — fixture is NOT tautological!"
else
  ok "Phase 1-A: tautological test killed 0 mutants"
fi

info "  Phase 1-B: Stryker on rigorous fixture..."
"$STRYKER" run "$CONF_B" 2>&1 | grep -E '(Mutation score|killed|survived|# killed)' | tail -3 || true
KILLED_B=$(extract_killed "$REPORT_B")
info "  Phase 1-B: killed=$KILLED_B (want ≥1)"
if [[ "$KILLED_B" -lt 1 ]]; then
  fail "Phase 1-B: rigorous fixture killed 0 mutants — fixture is NOT rigorous!"
else
  ok "Phase 1-B: rigorous test killed $KILLED_B mutant(s)"
fi

# ---------------------------------------------------------------------------
# Phase 2: Full gate path via real git diff
# We copy the gate to /tmp with REPO_ROOT set, stash working tree changes,
# create temp branches with clean commits, and invoke the gate.
# ---------------------------------------------------------------------------
info ""
info "=== Phase 2: Full gate invocation via git diff ==="

# Copy gate to /tmp so git stash doesn't take it (gate is tracked after first commit)
cp "$GATE" "$GATE_TMP"
chmod +x "$GATE_TMP"

# Stash any working tree changes (tracked + untracked, but NOT ignored files)
# The gate script is now TRACKED (committed) so stash won't remove it.
#
# IMPORTANT: capture a stash REFERENCE (stash@{n}) verified by our own message,
# never a raw commit SHA — `git stash pop <sha>` is not a valid stash reference
# and fails, which (when swallowed) silently orphans the user's working tree in
# the stash. That exact failure ate in-flight edits on 2026-06-30.
STASH_REF=""
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  info "  Stashing tracked changes..."
  git stash push -m "mpg-self-test-stash-$SUFFIX" 2>&1 | tail -1 || true
  # Find OUR stash by message; do not blindly take stash@{0} (an unrelated
  # pre-existing stash must never be popped by cleanup).
  STASH_REF=$(git stash list 2>/dev/null | grep -m1 -F "mpg-self-test-stash-$SUFFIX" | cut -d: -f1 || true)
  if [[ -z "$STASH_REF" ]]; then
    info "  (stash push created no entry — tree had no stashable changes)"
  fi
fi

# Create base branch (represents "origin/main" for this test)
git checkout -q -b "$BASE_BRANCH" 2>/dev/null

# --- Simulator A: tautological → gate should FAIL ---
git checkout -q -b "$BRANCH_A" 2>/dev/null
mkdir -p "$REPO_ROOT/extensions/_mpg_a_${P}"
mkdir -p "$REPO_ROOT/packages/app-tools/src/__tests__"

cat > "$REPO_ROOT/$PROD_A" <<EOF
export function grade_a(score: number): 'fail' | 'pass' | 'ace' {
  if (score < 60) return 'fail';
  if (score < 90) return 'pass';
  return 'ace';
}
EOF
cat > "$REPO_ROOT/$TEST_A" <<EOF
import { describe, expect, it } from 'vitest';
import { grade_a } from '../../../../extensions/_mpg_a_${P}/index';
describe('grade_a (tautological)', () => {
  it('module imported', () => { expect(grade_a).toBeDefined(); expect(typeof grade_a).toBe('function'); });
});
EOF
git add -f "$PROD_A" "$TEST_A"
git commit --no-gpg-sign -m "mpg-self-test-a: tautological" 2>&1 | tail -1

info "  Running gate (Simulator A — tautological, want FAIL)..."
GATE_EXIT_A=0
REPO_ROOT="$REPO_ROOT" bash "$GATE_TMP" --base "$BASE_BRANCH" 2>&1 \
  | grep -E '(\[mutation-pair\]|pair:|GATE)' | tail -8 || GATE_EXIT_A=$?

info "  Gate exit Simulator A: $GATE_EXIT_A (want non-zero)"
if [[ "$GATE_EXIT_A" -eq 0 ]]; then
  fail "Gate-A: gate exited 0 — tautological test NOT caught by gate!"
else
  ok "Gate-A: gate correctly FAILED (exit $GATE_EXIT_A)"
fi

# --- Simulator B: rigorous → gate should PASS ---
git checkout -q "$BASE_BRANCH" 2>/dev/null
git checkout -q -b "$BRANCH_B" 2>/dev/null
mkdir -p "$REPO_ROOT/extensions/_mpg_b_${P}"

cat > "$REPO_ROOT/$PROD_B" <<EOF
export function grade_b(score: number): 'fail' | 'pass' | 'ace' {
  if (score < 60) return 'fail';
  if (score < 90) return 'pass';
  return 'ace';
}
EOF
cat > "$REPO_ROOT/$TEST_B" <<EOF
import { describe, expect, it } from 'vitest';
import { grade_b } from '../../../../extensions/_mpg_b_${P}/index';
describe('grade_b (rigorous)', () => {
  it('fail below 60', () => { expect(grade_b(0)).toBe('fail'); expect(grade_b(59)).toBe('fail'); });
  it('pass at 60', () => { expect(grade_b(60)).toBe('pass'); expect(grade_b(60)).not.toBe('fail'); });
  it('pass mid', () => { expect(grade_b(75)).toBe('pass'); expect(grade_b(89)).toBe('pass'); });
  it('ace at 90', () => { expect(grade_b(90)).toBe('ace'); expect(grade_b(90)).not.toBe('pass'); });
  it('ace above 90', () => { expect(grade_b(95)).toBe('ace'); expect(grade_b(100)).toBe('ace'); });
});
EOF
git add -f "$PROD_B" "$TEST_B"
git commit --no-gpg-sign -m "mpg-self-test-b: rigorous" 2>&1 | tail -1

info "  Running gate (Simulator B — rigorous, want PASS)..."
GATE_EXIT_B=0
REPO_ROOT="$REPO_ROOT" bash "$GATE_TMP" --base "$BASE_BRANCH" 2>&1 \
  | grep -E '(\[mutation-pair\]|pair:|GATE)' | tail -8 || GATE_EXIT_B=$?

info "  Gate exit Simulator B: $GATE_EXIT_B (want 0)"
if [[ "$GATE_EXIT_B" -ne 0 ]]; then
  fail "Gate-B: gate exited $GATE_EXIT_B — rigorous test NOT accepted by gate!"
else
  ok "Gate-B: gate correctly PASSED (exit 0)"
fi

# ---------------------------------------------------------------------------
# Final result
# ---------------------------------------------------------------------------
if [[ "$SELF_FAIL" -ne 0 ]]; then
  echo ""
  printf "${RED}  mutation_pair_gate self-test: FAILED${RST}\n"
  exit 1
fi

echo ""
echo "============================================================"
printf "${GRN}  mutation_pair_gate self-test: ALL PASS${RST}\n"
echo "  Phase 1-A (tautological):  Stryker killed 0   ✓"
echo "  Phase 1-B (rigorous):      Stryker killed ≥1  ✓"
echo "  Gate-A (tautological):     gate FAILED         ✓"
echo "  Gate-B (rigorous):         gate PASSED         ✓"
echo "============================================================"
exit 0
