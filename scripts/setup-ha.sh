#!/usr/bin/env bash
# Sets up Home Assistant in Docker with programmatic onboarding.
# Outputs HA_TOKEN for use in tests. Idempotent.
set -euo pipefail

HA_PORT=8123
HA_CONTAINER=luna-ha-test
HA_URL="http://localhost:${HA_PORT}"
HA_USER=testuser
HA_PASS=testpass123
HA_NAME="Test User"
CLIENT_ID="http://localhost"

# Start container if not running
if ! docker ps --format '{{.Names}}' | grep -q "^${HA_CONTAINER}$"; then
  docker rm -f "${HA_CONTAINER}" 2>/dev/null || true
  echo "Starting Home Assistant container..."
  docker run -d \
    --name "${HA_CONTAINER}" \
    -p "${HA_PORT}:8123" \
    homeassistant/home-assistant:latest
  echo "Waiting for HA to start (this takes 30-60s)..."
  for i in $(seq 1 90); do
    if curl -sf "${HA_URL}/api/" >/dev/null 2>&1; then
      echo "HA HTTP is up."
      break
    fi
    sleep 2
  done
  # Extra wait for onboarding to be ready
  sleep 5
else
  echo "HA container already running."
fi

# Check if already onboarded (user step done = true means onboarding completed)
ONBOARD_STATUS=$(curl -sf "${HA_URL}/api/onboarding" 2>/dev/null || echo "error")
if echo "${ONBOARD_STATUS}" | python3 -c "
import sys,json
steps=json.load(sys.stdin)
user_done=any(s.get('step')=='user' and s.get('done') for s in steps)
sys.exit(0 if user_done else 1)
" 2>/dev/null; then
  echo "HA already onboarded."
  echo ""
  echo "=== HA Setup Complete ==="
  echo "HA_URL=${HA_URL}"
  echo "Note: Use token from previous run or re-create container."
  exit 0
fi

# Step 1: Create owner account
echo "Creating owner account..."
AUTH_RESP=$(curl -sf -X POST "${HA_URL}/api/onboarding/users" \
  -H "Content-Type: application/json" \
  -d "{
    \"client_id\": \"${CLIENT_ID}\",
    \"name\": \"${HA_NAME}\",
    \"username\": \"${HA_USER}\",
    \"password\": \"${HA_PASS}\",
    \"language\": \"en\"
  }" 2>/dev/null || echo "{}")
AUTH_CODE=$(echo "${AUTH_RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('auth_code',''))" 2>/dev/null || echo "")

if [ -z "${AUTH_CODE}" ]; then
  echo "Failed to get auth_code. Response: ${AUTH_RESP}"
  echo "HA may already be onboarded. Try: docker rm -f ${HA_CONTAINER} && re-run this script."
  exit 1
fi

# Step 2: Exchange auth code for tokens
echo "Exchanging auth code for tokens..."
TOKEN_RESP=$(curl -sf -X POST "${HA_URL}/auth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=${AUTH_CODE}&client_id=${CLIENT_ID}" 2>/dev/null || echo "{}")
ACCESS_TOKEN=$(echo "${TOKEN_RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

if [ -z "${ACCESS_TOKEN}" ]; then
  echo "Failed to get access_token. Response: ${TOKEN_RESP}"
  exit 1
fi

# Step 3: Complete remaining onboarding steps
echo "Completing onboarding steps..."
curl -sf -X POST "${HA_URL}/api/onboarding/core_config" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}' >/dev/null 2>&1 || true

curl -sf -X POST "${HA_URL}/api/onboarding/analytics" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}' >/dev/null 2>&1 || true

curl -sf -X POST "${HA_URL}/api/onboarding/integration" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"client_id\":\"${CLIENT_ID}\",\"redirect_uri\":\"${CLIENT_ID}\"}" >/dev/null 2>&1 || true

echo ""
echo "=== HA Setup Complete ==="
echo "HA_URL=${HA_URL}"
echo "HA_TOKEN=${ACCESS_TOKEN}"
