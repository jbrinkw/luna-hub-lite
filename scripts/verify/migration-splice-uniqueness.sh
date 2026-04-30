#!/usr/bin/env bash
# scripts/verify/migration-splice-uniqueness.sh
#
# Static check: migrations that use pg_get_functiondef-based splice patterns
# must not use the same v_old_block anchor as another migration.
#
# A collision means two migrations try to splice the same function body block.
# If the first migration runs and replaces the block, the second migration's
# anchor search finds nothing and raises an exception. But if the ordering
# happens to be wrong or the function is re-emitted between migrations, the
# second migration silently patches over the first patch — corrupting the
# function body.
#
# How anchors are identified:
#   Each splice migration defines v_old_block as a multi-line E'' string.
#   We extract the first non-whitespace text line inside that assignment as
#   the "anchor" — typically the unique code pattern that distinguishes this
#   splice from others. Two migrations with the same anchor text (first line
#   of v_old_block) are flagged as a collision.
#
# Exit codes:
#   0 — no collisions (or no splice migrations found)
#   1 — one or more anchor collisions detected

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"

echo "==> migration-splice-uniqueness: scanning $MIGRATIONS_DIR"

# Find all migrations that use pg_get_functiondef.
mapfile -t SPLICE_FILES < <(
  grep -rl 'pg_get_functiondef' "$MIGRATIONS_DIR" 2>/dev/null | sort
)

if [[ ${#SPLICE_FILES[@]} -eq 0 ]]; then
  echo "    OK — no pg_get_functiondef splice migrations found."
  exit 0
fi

echo "    Found ${#SPLICE_FILES[@]} splice migration(s):"
for f in "${SPLICE_FILES[@]}"; do
  echo "      $(basename "$f")"
done
echo ""

# Extract anchors from each file.
# Strategy: find every v_old_block := E'...' assignment and extract
# the first non-empty content line (trimmed). Anchors are the textual
# fingerprint of "what block this splice is looking for."
declare -A ANCHOR_TO_FILE
COLLISIONS=0

for FILE in "${SPLICE_FILES[@]}"; do
  BASENAME="$(basename "$FILE")"

  # Use python3 for reliable multi-line extraction within bash.
  # Read the file and extract text of first E'' line after v_old_block :=
  ANCHORS=$(python3 - "$FILE" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    content = f.read()

# Match every v_old_* := ... assignment that represents a splice anchor.
# Variable names include: v_old_block, v_old_param_block, v_old_insert,
# v_old_param, v_old_body, etc.  We extract the first non-empty text
# line from the RHS as the anchor fingerprint.

anchors = []

# Pattern 1: v_old_* := E'...' || E'...' ; (multi-chunk string)
for m in re.finditer(
    r"v_old_\w+\s*:=\s*(E'[^;]+?)\s*;",
    content, re.DOTALL
):
    raw = m.group(1)
    chunks = re.findall(r"E'(.*?)'", raw, re.DOTALL)
    full_text = "".join(chunks)
    full_text = full_text.replace("\\n", "\n").replace("\\t", "\t")
    for line in full_text.splitlines():
        stripped = line.strip()
        if stripped:
            anchors.append(stripped)
            break

# Pattern 2: v_old_* := 'plain string'; (no E prefix)
for m in re.finditer(
    r"v_old_\w+\s*:=\s*'([^']+)'\s*;",
    content, re.DOTALL
):
    text = m.group(1).replace("\\n", "\n").replace("\\t", "\t")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            anchors.append(stripped)
            break

for a in anchors:
    print(a)
PYEOF
)

  if [[ -z "$ANCHORS" ]]; then
    echo "    WARNING: $BASENAME — no v_old_block anchor extracted (manual review needed)"
    continue
  fi

  # Collect all unique anchors from this file first, then register.
  declare -A FILE_ANCHORS
  while IFS= read -r ANCHOR; do
    [[ -z "$ANCHOR" ]] && continue
    FILE_ANCHORS["$ANCHOR"]=1
  done <<< "$ANCHORS"

  for ANCHOR in "${!FILE_ANCHORS[@]}"; do
    if [[ -v "ANCHOR_TO_FILE[$ANCHOR]" ]]; then
      FIRST="${ANCHOR_TO_FILE[$ANCHOR]}"
      if [[ "$FIRST" != "$BASENAME" ]]; then
        echo "    COLLISION: same anchor in two migrations:"
        echo "      First  : $FIRST"
        echo "      Second : $BASENAME"
        echo "      Anchor : ${ANCHOR:0:80}$([ ${#ANCHOR} -gt 80 ] && echo '...' || true)"
        COLLISIONS=$((COLLISIONS + 1))
      fi
      # Same file owning same anchor is fine (multiple splices in one migration).
    else
      ANCHOR_TO_FILE["$ANCHOR"]="$BASENAME"
      echo "    OK: $BASENAME — anchor: ${ANCHOR:0:72}$([ ${#ANCHOR} -gt 72 ] && echo '...' || true)"
    fi
  done
  unset FILE_ANCHORS
done

echo ""
if [[ $COLLISIONS -gt 0 ]]; then
  echo "    FAIL — $COLLISIONS anchor collision(s) detected."
  echo "    Each collision means two migrations splice the same block."
  echo "    Resolution: make the anchors unique or document that the"
  echo "    collision is intentional (second migration replaces first's patch)."
  exit 1
else
  echo "    PASS — no splice anchor collisions."
  exit 0
fi
