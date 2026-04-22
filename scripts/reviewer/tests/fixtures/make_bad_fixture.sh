#!/usr/bin/env bash
# Builds a synthetic "known-bad" commit for the reviewer meta-test.
#
# The commit:
#   - Adds a test file containing only tautological assertions.
#   - Claims in the commit body "42/42 tests pass" — a count that will NOT
#     match the actual tests run (the test file contains exactly 2 tests).
#
# The reviewer MUST catch this mismatch and FAIL the commit.
#
# Emits the new commit SHA on stdout.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Create an orphan-ish commit via plumbing — we don't touch any branch.
cd "$REPO_ROOT"

# Start a temp worktree at a known good parent so tsconfig + workspace
# configs exist. Pick a recent commit with the vitest tooling in place.
PARENT="$(git rev-parse HEAD)"

WT="$REPO_ROOT/.worktrees/bad-fixture-$$"
mkdir -p "$(dirname "$WT")"
git worktree add --detach "$WT" "$PARENT" >/dev/null 2>&1

cleanup() {
  ( cd "$REPO_ROOT" && git worktree remove --force "$WT" >/dev/null 2>&1 ) || true
  rm -rf "$STAGE"
}
trap cleanup EXIT

cd "$WT"

# Put the fixture test file in a workspace that has vitest wired up.
# app-tools is the simplest (node env, no jsdom) and has low blast radius.
TESTFILE="packages/app-tools/src/__tests__/_meta_bad_fixture.test.ts"
mkdir -p "$(dirname "$TESTFILE")"
cat > "$TESTFILE" <<'TS'
// Synthetic known-bad fixture for the reviewer meta-test.
// Tautological assertions — claims to test feature X but only asserts truthy.
import { describe, expect, it } from "vitest";

describe("meta-bad-fixture: supposedly verifies X", () => {
  it("tautology 1", () => {
    expect(true).toBe(true);
  });
  it("tautology 2", () => {
    expect(1 + 1).toBe(2);
  });
});
TS

git add "$TESTFILE"
git -c user.email=meta@test -c user.name=meta-bad \
  commit --no-verify -q -F - <<'MSG'
test(bad-fixture): claims huge test count but file has 2 tautologies

This commit is a synthetic fixture for the reviewer meta-test. It claims
42/42 tests passing in the body but the only test file added contains 2
tautological tests. The reviewer MUST flag claim_count_match=false and
fail the commit.

Verification stub: 42/42 tests pass
MSG

BAD_SHA="$(git rev-parse HEAD)"

# Leave the commit in the object DB; the worktree cleanup (above) only
# removes the working tree, not the commit object. We pack it as loose so
# gc can't reclaim it for the rest of the session. (Best-effort: worktree
# remove doesn't prune unreachable commits by default.)
cd "$REPO_ROOT"

printf '%s\n' "$BAD_SHA"
