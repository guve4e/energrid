#!/bin/bash

BASE="http://localhost:3000"
if [ -z "$AUTH_ACCESS_TOKEN" ]; then
  echo "Set AUTH_ACCESS_TOKEN to a current short-lived administrator access JWT." >&2
  exit 1
fi
auth_config=$(mktemp)
chmod 600 "$auth_config"
trap 'rm -f "$auth_config"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$AUTH_ACCESS_TOKEN" > "$auth_config"
unset AUTH_ACCESS_TOKEN

auth_curl() {
  curl -s --config "$auth_config" "$@"
}

echo "===== DEVICE SUMMARY ====="
auth_curl "$BASE/portal/state" | jq '.deviceSummary // .summary'

echo
echo "===== ALL DEVICES ====="
auth_curl "$BASE/portal/state" | jq '.devices[] | {
id,
displayName,
trustStatus,
adapter: .adapter.driver,
protocol: .adapter.protocol,
configured: .adapter.configured,
capabilities
}'

echo
echo "===== DISCOVERED DEVICES ====="
auth_curl "$BASE/portal/state" | jq '.devices[]
| select(.trustStatus=="discovered") 
| {
id,
displayName,
target: .adapter.target,
driver: .adapter.driver,
protocol: .adapter.protocol,
discovery
}'

echo
echo "===== NETWORK SCAN ====="
auth_curl "$BASE/portal/network/scan" | jq '.devices[] | {
id,
ipAddress,
vendor,
model,
protocol,
status,
confidence
}'

echo
echo "===== MQTT DEBUG ====="
auth_curl "$BASE/portal/bus/mqtt" | jq
