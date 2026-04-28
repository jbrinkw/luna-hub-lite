#!/usr/bin/env bash
# scripts/verify/realtime_publication_check.sh
#
# Drift detector — keeps the hardcoded list in
# `supabase/tests/hub/realtime_publication_integrity.test.sql` in sync
# with the actual `useRealtimeInvalidation` calls scattered across
# `apps/web/src/`.
#
# Failure mode this catches: a developer adds a new
# `useRealtimeInvalidation('foo', [{ schema: 'chefbyte', table: 'bar' }])`
# call to a page, ships it, and forgets to (a) add `chefbyte.bar` to the
# `supabase_realtime` publication via a migration AND (b) add the matching
# `ok(...)` line to the pgTAP integrity probe. The runtime symptom is
# silent: page loads work, but no postgres_changes events ever arrive
# for the new subscription. By the time a human notices, several days
# of stale UI state may have shipped.
#
# This script extracts the (schema, table) tuples from source on every
# `pnpm verify:full` run, normalizes them, diff-checks against the
# pgTAP file, and exits non-zero on any drift.
#
# Exit codes:
#   0 — every (schema, table) in `useRealtimeInvalidation` calls appears
#       in the pgTAP integrity test
#   1 — drift detected; the offending tuple is printed and the operator
#       must (a) add an ALTER PUBLICATION migration and (b) add the
#       corresponding ok() probe to the pgTAP file
#   2 — invocation error (missing files, wrong CWD)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

WEB_SRC="apps/web/src"
PROBE_FILE="supabase/tests/hub/realtime_publication_integrity.test.sql"

if [[ ! -d "$WEB_SRC" ]]; then
  echo "[realtime-publication-check] missing $WEB_SRC — wrong CWD?" >&2
  exit 2
fi
if [[ ! -f "$PROBE_FILE" ]]; then
  echo "[realtime-publication-check] missing $PROBE_FILE — pgTAP probe not present" >&2
  exit 2
fi

# Extract every (schema, table) tuple appearing in a useRealtimeInvalidation
# call's array literal across the web source. We rely on the convention that
# every entry is of the form
#     { schema: '<schema>', table: '<table>', ... }
# (single quotes, schema-then-table order, on the same or adjacent lines).
# We grep for the schema/table pair on adjacent lines as well as same-line
# inline objects.
extract_tuples() {
  # Strategy: pull every object literal that mentions either `schema:` or
  # `table:` from .ts/.tsx files, then walk the resulting stream pairing
  # each `schema:` with the next `table:`. Prefer ripgrep when available
  # (the repo's dev shell + CI both have it); fall back to a -rn grep
  # over .ts/.tsx so the script still works in stripped-down envs.
  local matches
  if command -v rg >/dev/null 2>&1; then
    matches="$(rg --no-heading -g '*.ts' -g '*.tsx' "schema:\s*'[a-z_]+'|table:\s*'[a-z_]+'" "$WEB_SRC" 2>/dev/null || true)"
  else
    matches="$(grep -rEn --include='*.ts' --include='*.tsx' "schema:\s*'[a-z_]+'|table:\s*'[a-z_]+'" "$WEB_SRC" 2>/dev/null || true)"
  fi

  printf '%s\n' "$matches" \
    | python3 -c '
import re, sys
schema = ""
out = set()
for line in sys.stdin:
    m = re.search(r"schema:\s*\x27([a-z_]+)\x27", line)
    if m:
        schema = m.group(1)
        # If the same line also has a table:, pair them inline.
        m2 = re.search(r"table:\s*\x27([a-z_]+)\x27", line)
        if m2:
            out.add(schema + "." + m2.group(1))
            schema = ""
        continue
    m = re.search(r"table:\s*\x27([a-z_]+)\x27", line)
    if m and schema:
        out.add(schema + "." + m.group(1))
        schema = ""
for t in sorted(out):
    print(t)
'
}

# Pull the (schema, table) pairs the pgTAP probe asserts. Each `ok(...)`
# block contains both `AND schemaname = '<schema>'` and `AND tablename =
# '<table>'`. Because they're inside the same EXISTS, schemaname always
# comes before tablename on adjacent lines.
extract_probe_tuples() {
  python3 -c '
import re, sys
schema = ""
out = set()
with open(sys.argv[1]) as f:
    for line in f:
        m = re.search(r"AND schemaname = \x27([a-z_]+)\x27", line)
        if m:
            schema = m.group(1)
            continue
        m = re.search(r"AND tablename = \x27([a-z_]+)\x27", line)
        if m and schema:
            out.add(schema + "." + m.group(1))
            schema = ""
for t in sorted(out):
    print(t)
' "$PROBE_FILE"
}

src_tuples="$(extract_tuples || true)"
probe_tuples="$(extract_probe_tuples || true)"

if [[ -z "$src_tuples" ]]; then
  echo "[realtime-publication-check] failed to extract any (schema, table) tuples from $WEB_SRC" >&2
  echo "[realtime-publication-check] this means either (a) all useRealtimeInvalidation calls were removed" >&2
  echo "[realtime-publication-check]                or (b) the regex extractor is out of date" >&2
  exit 2
fi

# Diff: find tuples in src but not in probe (the "you forgot to add a probe" path).
missing_in_probe="$(comm -23 <(printf '%s\n' "$src_tuples") <(printf '%s\n' "$probe_tuples"))"
extra_in_probe="$(comm -13 <(printf '%s\n' "$src_tuples") <(printf '%s\n' "$probe_tuples"))"

drift=0
if [[ -n "$missing_in_probe" ]]; then
  drift=1
  echo "[realtime-publication-check] DRIFT — these (schema, table) tuples are subscribed by" >&2
  echo "                              useRealtimeInvalidation in $WEB_SRC but are NOT covered" >&2
  echo "                              by an ok(...) probe in $PROBE_FILE:" >&2
  printf '  - %s\n' $missing_in_probe >&2
  echo "" >&2
  echo "  Fix: (1) add the table to the supabase_realtime publication via a new" >&2
  echo "       migration under supabase/migrations/, AND (2) add a matching ok(...)" >&2
  echo "       block to $PROBE_FILE so the pgTAP probe asserts membership." >&2
fi

if [[ -n "$extra_in_probe" ]]; then
  echo "[realtime-publication-check] WARN — these (schema, table) tuples are asserted by" >&2
  echo "                              the pgTAP probe but no longer appear in any" >&2
  echo "                              useRealtimeInvalidation call. This isn't a hard" >&2
  echo "                              failure (publication membership for an unsubscribed" >&2
  echo "                              table is harmless), but consider deleting the dead" >&2
  echo "                              probe to prevent stale-test rot:" >&2
  printf '  - %s\n' $extra_in_probe >&2
fi

if [[ "$drift" -ne 0 ]]; then
  exit 1
fi

echo "[realtime-publication-check] ok — all $(printf '%s\n' "$src_tuples" | wc -l | tr -d ' ') (schema, table) tuples covered"
exit 0
