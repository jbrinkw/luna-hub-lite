#!/usr/bin/env bash
# scripts/drift/check.sh — Migration-drift gate (local vs linked Supabase prod).
#
# Usage:
#   bash scripts/drift/check.sh
#     Runs `supabase db push --dry-run --include-all --linked`, parses output.
#     Exit codes:
#       0 — in sync OR forward-only (local has N new migrations pending apply;
#           annotated, not blocked, per VERIFY.md "Gate: Drift → PR-level").
#       1 — FAIL: unrecoverable drift (remote has migrations newer than local,
#           i.e. "Found local migration files to be inserted before the last
#           migration on remote database" — the historical-order case that
#           bit us with 20260422040000).
#       2 — runtime error (CLI missing, not linked, network, etc.).
#
#   bash scripts/drift/check.sh --mock-dry-run-output <ok|ahead|behind|error>
#     Meta-test mode: skips the real CLI invocation and feeds a canned
#     dry-run output through the parser. Used by
#     scripts/drift/tests/test_drift_meta.sh.
#
#     ok      — output that looks like "Linked project is up to date."
#     ahead   — local has new migrations NOT on remote (forward-only, PASS).
#     behind  — remote has migrations NOT on local (historical-order FAIL).
#     error   — simulated CLI failure.
#
# Contract: VERIFY.md — "Gate: Drift".
#   Writes .verify/drift.json per the shared schema.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# -----------------------------------------------------------------------------
# Arg parsing
# -----------------------------------------------------------------------------
MOCK_MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mock-dry-run-output)
      MOCK_MODE="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$REPO_ROOT/.verify"
ARTIFACT="$REPO_ROOT/.verify/drift.json"
LOG_FILE="$REPO_ROOT/.verify/drift.log"

START_MS=$(date +%s%3N)
RAN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# -----------------------------------------------------------------------------
# Resolve supabase binary: prefer $SUPABASE_BIN (overridable), fall back to
# node_modules pin, then PATH.
# -----------------------------------------------------------------------------
resolve_supabase() {
  if [[ -n "${SUPABASE_BIN:-}" && -x "$SUPABASE_BIN" ]]; then
    echo "$SUPABASE_BIN"; return
  fi
  if [[ -x "$REPO_ROOT/node_modules/.bin/supabase" ]]; then
    echo "$REPO_ROOT/node_modules/.bin/supabase"; return
  fi
  if command -v supabase >/dev/null 2>&1; then
    command -v supabase; return
  fi
  echo ""
}

# -----------------------------------------------------------------------------
# Canned outputs for meta-test / CI dry-runs without a linked project.
#
# Keep these strings close to what the real CLI emits so the parser is
# exercised identically in mock mode.
# -----------------------------------------------------------------------------
mock_output() {
  case "$1" in
    ok)
      cat <<'EOF'
Connecting to remote database...
Linked project is up to date.
EOF
      ;;
    ahead)
      cat <<'EOF'
Connecting to remote database...
Would apply migration 20260421120000_add_voice_ack_table.sql
Would apply migration 20260421130000_drop_legacy_shelves.sql
EOF
      ;;
    behind)
      cat <<'EOF'
Connecting to remote database...
Error: Found local migration files to be inserted before the last migration on remote database.
EOF
      ;;
    error)
      cat <<'EOF'
Error: failed to connect to project: no such host
EOF
      ;;
    *)
      echo "unknown mock token: $1" >&2
      return 2
      ;;
  esac
}

# -----------------------------------------------------------------------------
# Run the dry-run (real or mocked) and capture output + exit code.
# -----------------------------------------------------------------------------
DRY_OUTPUT=""
DRY_EXIT=0

if [[ -n "$MOCK_MODE" ]]; then
  DRY_OUTPUT="$(mock_output "$MOCK_MODE")" || {
    echo "[drift] invalid --mock-dry-run-output value: $MOCK_MODE" >&2
    exit 2
  }
  # Simulate CLI exit: 'behind' and 'error' both exit non-zero in the real CLI.
  case "$MOCK_MODE" in
    behind|error) DRY_EXIT=1 ;;
    *) DRY_EXIT=0 ;;
  esac
else
  SUPABASE_BIN_PATH="$(resolve_supabase)"
  if [[ -z "$SUPABASE_BIN_PATH" ]]; then
    cat >"$ARTIFACT" <<EOF
{
  "gate": "drift",
  "ok": false,
  "ran_at": "$RAN_AT",
  "duration_ms": 0,
  "mode": "real",
  "checks": [
    { "name": "cli-available", "ok": false, "evidence": "supabase CLI not found on PATH or in node_modules/.bin" }
  ],
  "failures": [
    { "check": "cli-available", "message": "supabase CLI not installed", "detail": "Install via devDependency (pinned in root package.json) or PATH" }
  ]
}
EOF
    echo "[drift] supabase CLI not found" >&2
    exit 2
  fi

  echo "[drift] running: $SUPABASE_BIN_PATH db push --dry-run --include-all --linked" >&2
  set +e
  DRY_OUTPUT="$("$SUPABASE_BIN_PATH" db push --dry-run --include-all --linked 2>&1)"
  DRY_EXIT=$?
  set -e 2>/dev/null || true
  printf '%s\n' "$DRY_OUTPUT" > "$LOG_FILE"
fi

# -----------------------------------------------------------------------------
# Parse dry-run output into state classification.
#
# States:
#   in_sync        — no migrations pending either way
#   ahead          — local has new migrations not yet on remote
#   behind         — remote has migrations LOCAL doesn't know about (historical
#                    order broken) — UNRECOVERABLE, must FAIL
#   cli_error      — CLI failed for other reason (network, auth, etc.)
# -----------------------------------------------------------------------------
STATE="cli_error"
PENDING_MIGRATIONS=()

# The "behind" case is the one that matters. Supabase CLI's exact wording
# has shifted across versions, so match on several known phrases. The common
# thread is "before" / "older" / "behind" in the error.
if grep -qiE 'before the last migration on remote|older local migration than remote|migration history mismatch|local migration files.*before.*remote' <<<"$DRY_OUTPUT"; then
  STATE="behind"
elif [[ "$DRY_EXIT" -ne 0 ]]; then
  STATE="cli_error"
elif grep -qiE 'up to date|no migrations? (to apply|pending)|already in sync|no new migrations' <<<"$DRY_OUTPUT"; then
  STATE="in_sync"
elif grep -qiE 'would apply|pending migration|applying migration|will apply' <<<"$DRY_OUTPUT"; then
  STATE="ahead"
  # Collect the referenced migration filenames for annotation.
  while IFS= read -r line; do
    # Extract anything that looks like a timestamped migration filename.
    mig="$(grep -oE '[0-9]{14}_[A-Za-z0-9_-]+\.sql' <<<"$line" | head -1)"
    if [[ -n "$mig" ]]; then
      PENDING_MIGRATIONS+=("$mig")
    fi
  done <<<"$DRY_OUTPUT"
else
  # No known phrase matched; if exit was 0, treat as in_sync (conservative).
  if [[ "$DRY_EXIT" -eq 0 ]]; then
    STATE="in_sync"
  else
    STATE="cli_error"
  fi
fi

# -----------------------------------------------------------------------------
# Map state → exit code + artifact.
# -----------------------------------------------------------------------------
END_MS=$(date +%s%3N)
DURATION_MS=$((END_MS - START_MS))

case "$STATE" in
  in_sync)
    EXIT_CODE=0
    OK="true"
    CHECK_NAME="no-drift"
    CHECK_OK="true"
    EVIDENCE="supabase db push --dry-run reports linked project up to date"
    FAILURES_JSON="[]"
    ;;
  ahead)
    EXIT_CODE=0
    OK="true"
    CHECK_NAME="forward-only-drift"
    CHECK_OK="true"
    EVIDENCE="Local has ${#PENDING_MIGRATIONS[@]} migration(s) pending apply to remote; forward-only, annotating not blocking"
    FAILURES_JSON="[]"
    ;;
  behind)
    EXIT_CODE=1
    OK="false"
    CHECK_NAME="historical-order"
    CHECK_OK="false"
    EVIDENCE="supabase db push --dry-run reports local migration files ordered BEFORE last remote migration — unrecoverable drift"
    FAILURES_JSON='[{"check":"historical-order","message":"Remote has migrations newer than local insertion point; rebase local migration timestamps before pushing","detail":"See .verify/drift.log for full dry-run output"}]'
    ;;
  cli_error)
    EXIT_CODE=2
    OK="false"
    CHECK_NAME="cli-ran"
    CHECK_OK="false"
    EVIDENCE="supabase db push --dry-run exited non-zero without a recognized drift signal (exit=$DRY_EXIT)"
    FAILURES_JSON='[{"check":"cli-ran","message":"Dry-run failed for unknown reason","detail":"See .verify/drift.log"}]'
    ;;
esac

# Assemble pending-migrations JSON array for the artifact.
if [[ "${#PENDING_MIGRATIONS[@]}" -eq 0 ]]; then
  PENDING_JSON="[]"
else
  PENDING_JSON="["
  for i in "${!PENDING_MIGRATIONS[@]}"; do
    [[ "$i" -gt 0 ]] && PENDING_JSON+=","
    PENDING_JSON+="\"${PENDING_MIGRATIONS[$i]}\""
  done
  PENDING_JSON+="]"
fi

# Escape the (possibly large, possibly multi-line) raw output for JSON.
ESCAPED_OUTPUT="$(printf '%s' "$DRY_OUTPUT" | node -e "
  let s = '';
  process.stdin.on('data', d => s += d);
  process.stdin.on('end', () => process.stdout.write(JSON.stringify(s)));
")"

cat >"$ARTIFACT" <<EOF
{
  "gate": "drift",
  "ok": $OK,
  "ran_at": "$RAN_AT",
  "duration_ms": $DURATION_MS,
  "mode": "${MOCK_MODE:-real}",
  "state": "$STATE",
  "pending_migrations": $PENDING_JSON,
  "checks": [
    { "name": "$CHECK_NAME", "ok": $CHECK_OK, "evidence": "$EVIDENCE" }
  ],
  "failures": $FAILURES_JSON,
  "raw_output": $ESCAPED_OUTPUT
}
EOF

echo "[drift] state=$STATE exit=$EXIT_CODE artifact=$ARTIFACT" >&2
exit "$EXIT_CODE"
