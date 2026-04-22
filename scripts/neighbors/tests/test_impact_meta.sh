#!/usr/bin/env bash
# scripts/neighbors/tests/test_impact_meta.sh
#
# Meta-test for the impact gate (scripts/neighbors/impact.sh).
#
# Strategy: the gate is pure function of a git-diff range. We create a
# temporary worktree at HEAD, mutate a known TS file there (case A) and a
# never-tested file (case B), then invoke impact.sh with the worktree's
# HEAD_REF as a SHA. This keeps the main repo untouched — no branch
# creation in the primary checkout.
#
# Assertions:
#   Case A (file is covered by existing tests): impact.sh exits 0 AND at
#     least one vitest check records ran > 0.
#   Case B (file has no test coverage anywhere): impact.sh exits 0 AND no
#     check records ran > 0.
#   Case C (no changes at all): impact.sh exits 0 AND no work was done.
#
# We do NOT actually require the tests pass — the meta-test is about the
# gate's SHAPE, not the suite's health. If the repo's related tests fail
# for unrelated reasons, this meta-test documents that as a Case-A
# regression. But we special-case exit=1 with >0 ran tests as "gate
# working, tests failing" → pass the meta-test (we're testing the gate,
# not the suite).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMPACT="$REPO_ROOT/scripts/neighbors/impact.sh"

PASS=0
FAIL=0

say() { printf '[meta-impact] %s\n' "$*"; }
pass() { PASS=$((PASS+1)); say "PASS: $*"; }
fail() { FAIL=$((FAIL+1)); say "FAIL: $*"; }

TMPDIR="$(mktemp -d)"
cleanup() {
  if [ -n "${WORKTREE:-}" ] && [ -d "${WORKTREE:-}" ]; then
    ( cd "$REPO_ROOT" && git worktree remove --force "$WORKTREE" >/dev/null 2>&1 ) || true
  fi
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

WORKTREE="$REPO_ROOT/.worktrees/meta-impact-$$"
mkdir -p "$(dirname "$WORKTREE")"

( cd "$REPO_ROOT" && git worktree add --detach "$WORKTREE" HEAD ) >/dev/null 2>&1 \
  || { fail "git worktree add failed"; exit 1; }

# Meta-test runs the gate in plan-only mode (IMPACT_DRY_RUN=1). This
# exercises the diff classification and target selection logic without
# invoking the actual test runners (slow + flaky in a worktree with no
# node_modules). The FAIL-path of the real runners is already exercised
# every time a real diff causes a test failure — that's how we verified
# exit codes (see scripts/reviewer/tests for the end-to-end variant).
export IMPACT_DRY_RUN=1

# --------------------------------------------------------------------------
# Case C — no changes. Run impact.sh in a mode where HEAD_REF==BASE_REF so
# no files differ. This is the simplest shape test.
# --------------------------------------------------------------------------

ART_DIR="$REPO_ROOT/.verify"
CASE_C_OUT="$TMPDIR/case-c.log"
bash "$IMPACT" HEAD HEAD > "$CASE_C_OUT" 2>&1
ec=$?
if [ "$ec" = "0" ] && grep -q '0 changed files' "$CASE_C_OUT"; then
  pass "Case C: empty diff → exit 0, zero work"
else
  fail "Case C: expected exit 0 + 0 changed files; got exit=$ec; log=$CASE_C_OUT"
fi

# --------------------------------------------------------------------------
# Case A — mutate a known-covered file. We pick a file that clearly imports
# from or is imported by at least one .test.ts in the web workspace.
# apps/web/src/shared/supabase.ts is a good target: it's imported by many
# hooks and pages, all of which have integration tests. In DRY_RUN mode the
# gate identifies the workspace + file list but doesn't spawn vitest, so the
# assertion is "the web vitest check is present and dry-run=true".
# --------------------------------------------------------------------------

COVERED_FILE="apps/web/src/shared/supabase.ts"

if [ ! -f "$WORKTREE/$COVERED_FILE" ]; then
  fail "Case A skipped: target $COVERED_FILE not present in worktree"
else
  # Amend the worktree: append a harmless comment, commit, then run impact.
  ( cd "$WORKTREE" \
    && printf '\n// meta-test: impact marker %s\n' "$$" >> "$COVERED_FILE" \
    && git -c user.email=meta@test -c user.name=meta \
         commit --no-verify -q -am "meta: impact marker" ) \
    || { fail "Case A: could not amend worktree"; exit 1; }

  CASE_A_SHA="$(cd "$WORKTREE" && git rev-parse HEAD)"
  CASE_A_BASE="$(cd "$WORKTREE" && git rev-parse HEAD~1)"
  CASE_A_OUT="$TMPDIR/case-a.log"

  ( cd "$WORKTREE" && bash "$IMPACT" "$CASE_A_BASE" "$CASE_A_SHA" \
      > "$CASE_A_OUT" 2>&1 )
  a_ec=$?

  art="$WORKTREE/.verify/impact.json"
  if [ ! -s "$art" ]; then
    fail "Case A: no artifact produced at $art"
  else
    web_check=$(jq -r '.checks[] | select(.name=="vitest:@luna-hub/web") | .evidence // empty' "$art")
    planned_ran=$(jq -r '[.checks[] | select(.name=="vitest:@luna-hub/web") | .ran // 0] | add // 0' "$art")
    if [ -z "$web_check" ]; then
      fail "Case A: expected vitest:@luna-hub/web check in artifact; got $(jq -c .checks "$art")"
    elif [ "$a_ec" != "0" ]; then
      fail "Case A: expected exit 0 in DRY_RUN mode; got $a_ec"
    elif [ "$planned_ran" -lt 1 ]; then
      fail "Case A: expected ≥1 file planned; got $planned_ran. evidence=$web_check"
    else
      pass "Case A: web file change → gate planned vitest on $planned_ran file(s) (evidence=$web_check)"
    fi
  fi
fi

# --------------------------------------------------------------------------
# Case B — mutate a file with no test coverage. We pick a doc file (docs/*
# doesn't match any of the impact gate's type filters, so ran=0 and exit=0).
# --------------------------------------------------------------------------

UNCOVERED_FILE="docs/VERIFY.md"
# VERIFY.md is touched by the subagent contract but the gate doesn't claim
# to run anything on .md files — so it's a perfect "no neighbours" fixture.
# But docs/VERIFY.md is read-only for this agent per task instructions, so
# use a sibling: create a brand-new file.
UNCOVERED_FILE_NEW="docs/_meta_impact_marker.md"

if [ -d "$WORKTREE/docs" ]; then
  ( cd "$WORKTREE" \
    && printf 'meta-impact marker %s\n' "$$" > "$UNCOVERED_FILE_NEW" \
    && git add "$UNCOVERED_FILE_NEW" \
    && git -c user.email=meta@test -c user.name=meta \
         commit --no-verify -q -m "meta: uncovered marker" ) \
    || { fail "Case B: could not add uncovered file"; exit 1; }

  CASE_B_SHA="$(cd "$WORKTREE" && git rev-parse HEAD)"
  CASE_B_BASE="$(cd "$WORKTREE" && git rev-parse HEAD~1)"
  CASE_B_OUT="$TMPDIR/case-b.log"

  ( cd "$WORKTREE" && bash "$IMPACT" "$CASE_B_BASE" "$CASE_B_SHA" \
      > "$CASE_B_OUT" 2>&1 )
  b_ec=$?
  art="$WORKTREE/.verify/impact.json"

  if [ "$b_ec" = "0" ] && [ -s "$art" ]; then
    # Doc-only: no vitest/pytest/pgtap check should appear — only the
    # default "nothing to check" is acceptable (since we didn't even
    # trigger any hit classification). Accept any artifact where the
    # classification hits line shows all 0s.
    hits_line="$(grep 'hits:' "$CASE_B_OUT" || true)"
    ran_checks=$(jq -r '[.checks[] | select(.name | test("^(vitest|pytest|supabase)"))] | length' "$art")
    if [ "$ran_checks" = "0" ]; then
      pass "Case B: doc-only change → no vitest/pytest/pgtap checks fired (exit 0)"
    else
      fail "Case B: doc-only change produced $ran_checks runner checks (expected 0). hits=$hits_line"
    fi
  else
    fail "Case B: expected exit 0 + artifact; got exit=$b_ec"
  fi
else
  fail "Case B skipped: docs/ not in worktree"
fi

# --------------------------------------------------------------------------

say "summary: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
