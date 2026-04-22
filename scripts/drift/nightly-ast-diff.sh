#!/usr/bin/env bash
# scripts/drift/nightly-ast-diff.sh
#
# VERIFY.md "Gate: Drift → Nightly". Deeper local-vs-prod schema check
# than the PR-time dry-run (scripts/drift/check.sh): dumps full DDL from
# both sides, normalizes to a canonical AST-ish text form, diffs the
# normalized outputs. Opens/updates a GitHub issue (from the wrapping
# workflow) on non-empty diff.
#
# Real-run flow:
#   1. `supabase db reset` → brings a local supabase up-to-date with
#      migrations/*.sql. Then `supabase db dump --local --schema-only`
#      for the local side.  (We use `supabase db dump --local` rather
#      than pg_dump directly because it matches the same extraction
#      that prod uses, removing spurious diffs.)
#   2. `supabase db dump --linked --schema-only` for the remote side.
#   3. Normalize both via `lib/normalize_schema.py`.
#   4. `diff -u` normalized local vs. normalized prod.
#   5. Write .verify/drift-nightly.json + .verify/diff.patch.
#
# Mock-test flow (load-bearing for CI meta-tests and local dev):
#   bash scripts/drift/nightly-ast-diff.sh \
#     --mock-local <path-to-local.sql> \
#     --mock-prod  <path-to-prod.sql>
#
#   Skips all supabase CLI calls; feeds the files into the normalizer
#   directly. This is how scripts/drift/tests/test_nightly_ast_meta.sh
#   drives the gate deterministically.
#
# Exit codes:
#   0 — normalized diff empty (local and prod agree after normalization)
#   1 — normalized diff non-empty (drift — issue should be opened)
#   2 — runtime error (CLI missing, dumps failed, etc.)
#
# Contract: VERIFY.md shared artifact schema. Output at
# `.verify/drift-nightly.json`, and diff patch at `.verify/diff.patch`.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# -----------------------------------------------------------------------------
# Args
# -----------------------------------------------------------------------------
MOCK_LOCAL=""
MOCK_PROD=""
KEEP_TMP=""

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mock-local)
      MOCK_LOCAL="$2"; shift 2 ;;
    --mock-prod)
      MOCK_PROD="$2"; shift 2 ;;
    --keep-tmp)
      KEEP_TMP="1"; shift 1 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# Both or neither — you can't mock one side only.
if [[ -n "$MOCK_LOCAL" && -z "$MOCK_PROD" ]] || [[ -z "$MOCK_LOCAL" && -n "$MOCK_PROD" ]]; then
  echo "[drift-nightly] --mock-local and --mock-prod must be passed together" >&2
  exit 2
fi

mkdir -p "$REPO_ROOT/.verify"
ARTIFACT="$REPO_ROOT/.verify/drift-nightly.json"
DIFF_PATCH="$REPO_ROOT/.verify/diff.patch"
LOG_FILE="$REPO_ROOT/.verify/drift-nightly.log"

NORMALIZER="$REPO_ROOT/scripts/drift/lib/normalize_schema.py"
if [[ ! -f "$NORMALIZER" ]]; then
  echo "[drift-nightly] normalizer not found at $NORMALIZER" >&2
  exit 2
fi

START_MS=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")
RAN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

TMPDIR_PATH="$(mktemp -d -t drift-nightly.XXXXXX)"
cleanup() {
  if [[ -z "$KEEP_TMP" ]]; then
    rm -rf "$TMPDIR_PATH"
  else
    echo "[drift-nightly] keeping tmpdir: $TMPDIR_PATH" >&2
  fi
}
trap cleanup EXIT

LOCAL_RAW="$TMPDIR_PATH/local.sql"
PROD_RAW="$TMPDIR_PATH/prod.sql"
LOCAL_NORM="$TMPDIR_PATH/local.norm.sql"
PROD_NORM="$TMPDIR_PATH/prod.norm.sql"

# -----------------------------------------------------------------------------
# Resolve supabase binary (same logic as check.sh, but factored here so we
# don't touch that file).
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
# Write a FAIL artifact and bail.
# -----------------------------------------------------------------------------
emit_error_artifact() {
  local check_name="$1"
  local message="$2"
  local detail="${3:-}"
  local end_ms duration_ms
  end_ms=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")
  duration_ms=$((end_ms - START_MS))

  # Escape the detail field for JSON.
  local esc_detail
  esc_detail="$(printf '%s' "$detail" | python3 -c "
import json, sys
sys.stdout.write(json.dumps(sys.stdin.read()))
")"

  cat >"$ARTIFACT" <<EOF
{
  "gate": "drift",
  "subgate": "nightly-ast-diff",
  "ok": false,
  "ran_at": "$RAN_AT",
  "duration_ms": $duration_ms,
  "mode": "$([[ -n "$MOCK_LOCAL" ]] && echo mock || echo real)",
  "diff_bytes": 0,
  "checks": [
    { "name": "$check_name", "ok": false, "evidence": "$message" }
  ],
  "failures": [
    { "check": "$check_name", "message": "$message", "detail": $esc_detail }
  ]
}
EOF
}

# -----------------------------------------------------------------------------
# 1. Obtain raw local + prod dumps.
# -----------------------------------------------------------------------------
if [[ -n "$MOCK_LOCAL" ]]; then
  if [[ ! -f "$MOCK_LOCAL" ]]; then
    emit_error_artifact "mock-input" "mock-local file not found" "$MOCK_LOCAL"
    exit 2
  fi
  if [[ ! -f "$MOCK_PROD" ]]; then
    emit_error_artifact "mock-input" "mock-prod file not found" "$MOCK_PROD"
    exit 2
  fi
  cp "$MOCK_LOCAL" "$LOCAL_RAW"
  cp "$MOCK_PROD"  "$PROD_RAW"
  echo "[drift-nightly] mock mode: local=$MOCK_LOCAL prod=$MOCK_PROD" >&2
else
  SUPABASE_BIN_PATH="$(resolve_supabase)"
  if [[ -z "$SUPABASE_BIN_PATH" ]]; then
    emit_error_artifact "cli-available" "supabase CLI not found" "Install via devDependency or on PATH"
    exit 2
  fi
  echo "[drift-nightly] supabase CLI: $SUPABASE_BIN_PATH" >&2

  # Reset the local DB to the state described by supabase/migrations/*.
  # This ensures the local dump reflects the current migration graph, not
  # whatever state the dev container was left in.
  echo "[drift-nightly] running: supabase db reset --no-seed" >&2
  if ! "$SUPABASE_BIN_PATH" db reset --no-seed >"$LOG_FILE" 2>&1; then
    emit_error_artifact "local-reset" "supabase db reset failed" "$(tail -50 "$LOG_FILE" 2>/dev/null || echo '(no log)')"
    exit 2
  fi

  # Dump local schema.
  echo "[drift-nightly] running: supabase db dump --local --schema-only" >&2
  if ! "$SUPABASE_BIN_PATH" db dump --local --schema-only >"$LOCAL_RAW" 2>>"$LOG_FILE"; then
    emit_error_artifact "local-dump" "supabase db dump --local failed" "$(tail -50 "$LOG_FILE" 2>/dev/null || echo '(no log)')"
    exit 2
  fi

  # Dump linked (prod) schema.
  echo "[drift-nightly] running: supabase db dump --linked --schema-only" >&2
  if ! "$SUPABASE_BIN_PATH" db dump --linked --schema-only >"$PROD_RAW" 2>>"$LOG_FILE"; then
    emit_error_artifact "prod-dump" "supabase db dump --linked failed" "$(tail -50 "$LOG_FILE" 2>/dev/null || echo '(no log)')"
    exit 2
  fi
fi

# Sanity: neither file can be empty — an empty "prod" dump would be a false
# all-diff and an empty "local" would be nonsensical.
if [[ ! -s "$LOCAL_RAW" ]]; then
  emit_error_artifact "local-dump-size" "local dump is empty" "$LOCAL_RAW"
  exit 2
fi
if [[ ! -s "$PROD_RAW" ]]; then
  emit_error_artifact "prod-dump-size" "prod dump is empty" "$PROD_RAW"
  exit 2
fi

# -----------------------------------------------------------------------------
# 2. Normalize both dumps.
# -----------------------------------------------------------------------------
if ! python3 "$NORMALIZER" "$LOCAL_RAW" >"$LOCAL_NORM" 2>>"$LOG_FILE"; then
  emit_error_artifact "normalize-local" "normalizer failed on local dump" "$(tail -30 "$LOG_FILE" 2>/dev/null || echo '(no log)')"
  exit 2
fi
if ! python3 "$NORMALIZER" "$PROD_RAW" >"$PROD_NORM" 2>>"$LOG_FILE"; then
  emit_error_artifact "normalize-prod" "normalizer failed on prod dump" "$(tail -30 "$LOG_FILE" 2>/dev/null || echo '(no log)')"
  exit 2
fi

# -----------------------------------------------------------------------------
# 3. Diff. Use -u (unified) so the output is a usable patch for the issue
# body. Absence of diff exits 0; presence exits 1. We collect and don't let
# `diff`'s own exit propagate here.
# -----------------------------------------------------------------------------
set +e
diff -u --label "a/local-normalized.sql" --label "b/prod-normalized.sql" \
  "$LOCAL_NORM" "$PROD_NORM" > "$DIFF_PATCH"
DIFF_EXIT=$?
set -e 2>/dev/null || true

# diff exit: 0 = same, 1 = different, 2 = trouble.
if [[ "$DIFF_EXIT" -ge 2 ]]; then
  emit_error_artifact "diff-run" "diff(1) returned trouble exit" "exit=$DIFF_EXIT"
  exit 2
fi

DIFF_BYTES=$(wc -c < "$DIFF_PATCH" | tr -d '[:space:]')
# Count changed hunks (rough structural metric for the artifact). grep -c
# exits non-zero when count is 0, so swallow its exit and take the number.
set +e
HUNK_COUNT="$(grep -c '^@@' "$DIFF_PATCH" 2>/dev/null)"
set -e 2>/dev/null || true
HUNK_COUNT="${HUNK_COUNT:-0}"
# Strip any whitespace/newlines that wc or grep might have added.
HUNK_COUNT="$(echo "$HUNK_COUNT" | tr -d '[:space:]')"
HUNK_COUNT="${HUNK_COUNT:-0}"

# -----------------------------------------------------------------------------
# 4. Emit artifact + set exit code.
# -----------------------------------------------------------------------------
END_MS=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")
DURATION_MS=$((END_MS - START_MS))

if [[ "$DIFF_EXIT" -eq 0 ]]; then
  OK="true"
  EXIT_CODE=0
  CHECK_OK="true"
  EVIDENCE="normalized schemas are identical (diff_bytes=$DIFF_BYTES)"
  FAILURES_JSON="[]"
else
  OK="false"
  EXIT_CODE=1
  CHECK_OK="false"
  EVIDENCE="normalized schemas diverge (diff_bytes=$DIFF_BYTES, hunks=$HUNK_COUNT)"
  FAILURES_JSON='[{"check":"ast-diff","message":"Local and prod schemas diverge after normalization","detail":"See .verify/diff.patch for unified diff. Workflow opens/updates a GitHub issue with the patch."}]'
fi

cat >"$ARTIFACT" <<EOF
{
  "gate": "drift",
  "subgate": "nightly-ast-diff",
  "ok": $OK,
  "ran_at": "$RAN_AT",
  "duration_ms": $DURATION_MS,
  "mode": "$([[ -n "$MOCK_LOCAL" ]] && echo mock || echo real)",
  "diff_bytes": $DIFF_BYTES,
  "hunks": $HUNK_COUNT,
  "diff_patch_path": ".verify/diff.patch",
  "checks": [
    { "name": "ast-diff", "ok": $CHECK_OK, "evidence": "$EVIDENCE" }
  ],
  "failures": $FAILURES_JSON
}
EOF

echo "[drift-nightly] exit=$EXIT_CODE diff_bytes=$DIFF_BYTES hunks=$HUNK_COUNT artifact=$ARTIFACT" >&2
exit "$EXIT_CODE"
