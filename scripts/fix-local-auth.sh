#!/usr/bin/env bash
#
# fix-local-auth.sh — Fix GoTrue JWT compatibility after `supabase start`
#
# Problem: Supabase CLI v2.75.0 starts GoTrue v2.187.0 with GOTRUE_JWT_KEYS
# (auto-generated EC key). This causes GoTrue to reject HS256 JWTs even though
# HS256 is in GOTRUE_JWT_VALIDMETHODS. Kong still generates HS256 JWTs from
# the anon/service_role keys, breaking edge function auth.
#
# Fix: Recreate the GoTrue container without GOTRUE_JWT_KEYS, using the cached
# v2.186.0 image which doesn't have this issue. Run after `supabase start`.
#
# Usage: ./scripts/fix-local-auth.sh
#
set -euo pipefail

PROJECT="luna-hub-lite"
CONTAINER="supabase_auth_${PROJECT}"
NETWORK="supabase_network_${PROJECT}"
TARGET_IMAGE="public.ecr.aws/supabase/gotrue:v2.186.0"

# Check if container exists
if ! docker inspect "$CONTAINER" &>/dev/null; then
  echo "Error: Container $CONTAINER not found. Run 'supabase start' first."
  exit 1
fi

# Check current image
CURRENT_IMAGE=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')
echo "Current GoTrue image: $CURRENT_IMAGE"

# Check if GOTRUE_JWT_KEYS is set (the problematic env var)
if docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q "GOTRUE_JWT_KEYS"; then
  echo "GOTRUE_JWT_KEYS detected — fixing..."
else
  echo "GOTRUE_JWT_KEYS not present — GoTrue is already configured correctly."
  exit 0
fi

# Ensure target image is available
if ! docker image inspect "$TARGET_IMAGE" &>/dev/null; then
  echo "Pulling $TARGET_IMAGE..."
  docker pull "$TARGET_IMAGE"
fi

# Save env vars (excluding GOTRUE_JWT_KEYS)
TMPENV=$(mktemp)
docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -v "GOTRUE_JWT_KEYS" > "$TMPENV"

# Stop and remove the current container
echo "Replacing GoTrue container..."
docker stop "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null

# Recreate with v2.186.0 and cleaned env
docker run -d \
  --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias auth \
  --restart unless-stopped \
  --env-file "$TMPENV" \
  "$TARGET_IMAGE" >/dev/null

rm "$TMPENV"

# Wait for health
echo -n "Waiting for GoTrue to be ready"
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" wget -qO- http://localhost:9999/health &>/dev/null; then
    echo " OK"
    echo "GoTrue fixed: $TARGET_IMAGE (GOTRUE_JWT_KEYS removed)"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo " TIMEOUT"
echo "Warning: GoTrue may not be healthy. Check: docker logs $CONTAINER"
exit 1
