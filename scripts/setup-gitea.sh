#!/usr/bin/env bash
# Sets up Gitea in Docker with a test user and vault repo.
# Idempotent — safe to run multiple times.
set -euo pipefail

GITEA_PORT=3000
GITEA_CONTAINER=luna-gitea-test
GITEA_URL="http://localhost:${GITEA_PORT}"
GITEA_USER=testuser
GITEA_PASS=testpass123
GITEA_EMAIL=test@luna.dev
REPO_NAME=obsidian-vault

# Start container if not running
if ! docker ps --format '{{.Names}}' | grep -q "^${GITEA_CONTAINER}$"; then
  docker rm -f "${GITEA_CONTAINER}" 2>/dev/null || true
  echo "Starting Gitea container..."
  docker run -d \
    --name "${GITEA_CONTAINER}" \
    -p "${GITEA_PORT}:3000" \
    -e GITEA__security__INSTALL_LOCK=true \
    -e GITEA__server__ROOT_URL="${GITEA_URL}" \
    -e GITEA__server__OFFLINE_MODE=true \
    gitea/gitea:latest-rootless
  echo "Waiting for Gitea to start..."
  for i in $(seq 1 30); do
    if curl -sf "${GITEA_URL}/api/v1/version" >/dev/null 2>&1; then
      echo "Gitea is up."
      break
    fi
    sleep 1
  done
else
  echo "Gitea container already running."
fi

# Create admin user (idempotent — fails silently if exists)
docker exec "${GITEA_CONTAINER}" gitea admin user create \
  --username "${GITEA_USER}" \
  --password "${GITEA_PASS}" \
  --email "${GITEA_EMAIL}" \
  --admin 2>/dev/null || true

# Generate API token
TOKEN_RESP=$(curl -sf -X POST "${GITEA_URL}/api/v1/users/${GITEA_USER}/tokens" \
  -u "${GITEA_USER}:${GITEA_PASS}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"luna-test-$(date +%s)\",\"scopes\":[\"all\"]}" 2>/dev/null || echo '{}')
TOKEN=$(echo "${TOKEN_RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha1',''))" 2>/dev/null || echo "")

if [ -z "${TOKEN}" ]; then
  echo "Could not create new token (may already exist). Using basic auth for setup."
else
  echo "GITEA_TOKEN=${TOKEN}"
fi

# Create repo if it doesn't exist
REPO_CHECK=$(curl -sf -o /dev/null -w "%{http_code}" \
  -u "${GITEA_USER}:${GITEA_PASS}" \
  "${GITEA_URL}/api/v1/repos/${GITEA_USER}/${REPO_NAME}" 2>/dev/null || echo "000")

if [ "${REPO_CHECK}" != "200" ]; then
  curl -sf -X POST "${GITEA_URL}/api/v1/user/repos" \
    -u "${GITEA_USER}:${GITEA_PASS}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${REPO_NAME}\",\"auto_init\":true,\"default_branch\":\"main\"}" >/dev/null
  echo "Created repo ${GITEA_USER}/${REPO_NAME}"
else
  echo "Repo ${GITEA_USER}/${REPO_NAME} already exists."
fi

# Seed vault with test data
seed_file() {
  local filepath="$1" content="$2"
  local b64
  b64=$(echo -n "${content}" | base64 -w 0)
  # Check if file exists
  local check
  check=$(curl -sf -o /dev/null -w "%{http_code}" \
    -u "${GITEA_USER}:${GITEA_PASS}" \
    "${GITEA_URL}/api/v1/repos/${GITEA_USER}/${REPO_NAME}/contents/${filepath}" 2>/dev/null || echo "000")
  if [ "${check}" = "200" ]; then
    return 0
  fi
  curl -sf -X POST \
    "${GITEA_URL}/api/v1/repos/${GITEA_USER}/${REPO_NAME}/contents/${filepath}" \
    -u "${GITEA_USER}:${GITEA_PASS}" \
    -H "Content-Type: application/json" \
    -d "{\"content\":\"${b64}\",\"message\":\"seed: ${filepath}\"}" >/dev/null
  echo "  Seeded: ${filepath}"
}

echo "Seeding vault data..."

# Project: Luna Development (root)
seed_file "Projects/Luna/Luna.md" "---
project_id: luna-development
---

# Luna Development

Main development project for Luna Hub."

# Project: Luna Lite (child of Luna Development)
seed_file "Projects/Luna/Lite/Lite.md" "---
project_id: luna-lite
project_parent: luna-development
---

# Luna Lite

Serverless refactor of Luna Hub."

# Notes for Luna Lite
seed_file "Projects/Luna/Lite/Notes.md" "---
note_project_id: luna-lite
---

3/5/26

Started extension parity work.

## Milestones

Completed DB schema.

3/4/26

Set up Gitea for testing.

3/1/26

Initial project setup."

# Project: Research (root)
seed_file "Projects/Research/Research.md" "---
project_id: research
---

# Research

General research notes."

# Notes for Research
seed_file "Projects/Research/Notes.md" "---
note_project_id: research
---

3/6/26

Explored Home Assistant onboarding API.

3/3/26

Reviewed Obsidian sync architecture."

echo ""
echo "=== Gitea Setup Complete ==="
echo "URL:   ${GITEA_URL}"
echo "API:   ${GITEA_URL}/api/v1"
echo "Repo:  ${GITEA_USER}/${REPO_NAME}"
echo "User:  ${GITEA_USER} / ${GITEA_PASS}"
[ -n "${TOKEN:-}" ] && echo "Token: ${TOKEN}"
