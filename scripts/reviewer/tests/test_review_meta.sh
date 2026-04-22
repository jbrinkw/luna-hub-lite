#!/usr/bin/env bash
# scripts/reviewer/tests/test_review_meta.sh
#
# Meta-test for the reviewer gate (scripts/reviewer/review.sh).
#
# Fixtures:
#   - Known-good SHA: 7667e39 (real commit). Adds a pytest file claiming a
#     regression test; reviewer MUST pass.
#   - Known-bad SHA: built at runtime via make_bad_fixture.sh. Adds a
#     tautological vitest file to packages/app-tools while the commit body
#     claims "42/42 tests pass" — a count that does not match the actual
#     2 tests in the file. Reviewer MUST fail with claim_count_match=false.
#
# Both fixtures are replayed against review.sh and the exit code + JSON
# artifact's top-level `ok` field are asserted.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REVIEW="$REPO_ROOT/scripts/reviewer/review.sh"
MAKE_BAD="$SCRIPT_DIR/fixtures/make_bad_fixture.sh"

PASS=0
FAIL=0

say()  { printf '[meta-review] %s\n' "$*"; }
pass() { PASS=$((PASS+1)); say "PASS: $*"; }
fail() { FAIL=$((FAIL+1)); say "FAIL: $*"; }

# ---------------------------------------------------------------------------
# Known-good fixture: 7667e39
# ---------------------------------------------------------------------------
GOOD_SHA="7667e39"
if ! git -C "$REPO_ROOT" rev-parse --verify "$GOOD_SHA^{commit}" >/dev/null 2>&1; then
  fail "known-good fixture SHA $GOOD_SHA not found in repo"
else
  say "running reviewer on known-good $GOOD_SHA"
  good_log="$(mktemp)"
  bash "$REVIEW" "$GOOD_SHA" > "$good_log" 2>&1
  good_ec=$?
  if [ "$good_ec" = "0" ]; then
    pass "known-good: exit 0"
  else
    fail "known-good: expected exit 0; got $good_ec"
    tail -n 30 "$good_log"
  fi
  # Double-check artifact ok=true.
  if [ -s "$REPO_ROOT/.verify/review.json" ]; then
    ok=$(jq -r '.ok' "$REPO_ROOT/.verify/review.json")
    if [ "$ok" = "true" ]; then
      pass "known-good: artifact ok=true"
    else
      fail "known-good: artifact ok=$ok"
    fi
  else
    fail "known-good: no review.json produced"
  fi
  rm -f "$good_log"
fi

# ---------------------------------------------------------------------------
# Known-bad fixture: construct a synthetic commit with a count mismatch.
# ---------------------------------------------------------------------------
say "building known-bad fixture…"
BAD_SHA="$(bash "$MAKE_BAD" 2>/tmp/make_bad_fixture.err)" || {
  fail "make_bad_fixture.sh failed (see /tmp/make_bad_fixture.err)"
  cat /tmp/make_bad_fixture.err || true
  say "summary: $PASS passed, $FAIL failed"
  [ "$FAIL" -gt 0 ] && exit 1
  exit 0
}
say "bad fixture SHA: $BAD_SHA"

if ! git -C "$REPO_ROOT" rev-parse --verify "$BAD_SHA^{commit}" >/dev/null 2>&1; then
  fail "bad-fixture SHA $BAD_SHA did not materialize"
else
  bad_log="$(mktemp)"
  bash "$REVIEW" "$BAD_SHA" > "$bad_log" 2>&1
  bad_ec=$?
  if [ "$bad_ec" != "0" ]; then
    pass "known-bad: reviewer exited non-zero ($bad_ec)"
  else
    fail "known-bad: expected non-zero exit; got 0"
    tail -n 40 "$bad_log"
  fi
  if [ -s "$REPO_ROOT/.verify/review.json" ]; then
    ok=$(jq -r '.ok' "$REPO_ROOT/.verify/review.json")
    claim_ok=$(jq -r '.checks[] | select(.name=="claim_count_match") | .ok' "$REPO_ROOT/.verify/review.json")
    if [ "$ok" = "false" ] && [ "$claim_ok" = "false" ]; then
      pass "known-bad: artifact ok=false AND claim_count_match=false"
    else
      fail "known-bad: artifact ok=$ok, claim_count_match=$claim_ok (expected ok=false, claim_count_match=false)"
      jq . "$REPO_ROOT/.verify/review.json" | head -60
    fi
  else
    fail "known-bad: no review.json produced"
  fi
  rm -f "$bad_log"
fi

say "summary: $PASS passed, $FAIL failed"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
