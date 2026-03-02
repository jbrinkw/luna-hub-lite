#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_FILE="$REPO_ROOT/packages/db-types/src/database.types.ts"

if [ -f "$REPO_ROOT/.env" ]; then
  export $(grep -v '^#' "$REPO_ROOT/.env" | xargs)
fi

PROJECT_REF=$(echo "$SUPABASE_URL" | sed 's|https://\(.*\)\.supabase\.co|\1|')

echo "Generating types for project: $PROJECT_REF"
echo "Output: $OUTPUT_FILE"

npx supabase gen types typescript \
  --project-id "$PROJECT_REF" \
  --schema hub,coachbyte,chefbyte,private \
  > "$OUTPUT_FILE"

echo "Types generated successfully"
