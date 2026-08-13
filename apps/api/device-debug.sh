#!/bin/bash

BASE="http://localhost:3000"

echo "===== DEVICE SUMMARY ====="
curl -s "$BASE/portal/state" | jq '.deviceSummary // .summary'

echo
echo "===== ALL DEVICES ====="
curl -s "$BASE/portal/state" | jq '.devices[] | {
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
curl -s "$BASE/portal/state" | jq '.devices[] 
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
curl -s "$BASE/portal/network/scan" | jq '.devices[] | {
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
curl -s "$BASE/portal/bus/mqtt?token=dev-token-admin" | jq

