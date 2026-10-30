#!/usr/bin/env bash
set -Eeuo pipefail

release_id="${1:?Usage: deploy-pi-activate.sh RELEASE_ID}"
[[ "$release_id" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo "Invalid release ID" >&2; exit 2; }

root=/var/www/energrid
release="$root-releases/$release_id"
apps="$root/dist/apps"
portal="$apps/portal"
core="$apps/core"
api_unit=/etc/systemd/system/energrid-api.service.d/10-auth-v1.conf
api_port=3000
core_port=3102
backup_core="$apps/core.before-$release_id"
previous_api="$release/api-unit.before-deploy"
previous_portal=""
node_bin=""
changed=0

api_healthy() {
  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 \
    "http://127.0.0.1:$api_port/portal/state" 2>/dev/null)" || return 1
  [[ "$status" == 200 || "$status" == 401 ]]
}

core_healthy() {
  curl --silent --fail --output /dev/null --max-time 3 \
    "http://127.0.0.1:$core_port/core/weather/performance" 2>/dev/null
}

portal_healthy() {
  curl --silent --fail --output /dev/null --max-time 3 http://127.0.0.1/ 2>/dev/null
}

restore_previous() {
  local rc=$?
  trap - ERR
  if (( changed == 0 )); then
    echo "Activation stopped before changing live paths."
    exit "$rc"
  fi

  echo "A deployment check failed; restoring the previous API, Core and Portal..."
  if [[ -e "$backup_core" || -L "$backup_core" ]]; then
    rm -rf "$core"
    mv "$backup_core" "$core" || true
  fi
  if [[ -n "$previous_portal" ]]; then
    ln -sfn "$previous_portal" "$portal.rollback-$release_id" || true
    mv -Tf "$portal.rollback-$release_id" "$portal" || true
  fi
  if [[ -s "$previous_api" ]]; then
    install -m 0644 "$previous_api" "$api_unit" || true
  fi
  systemctl daemon-reload || true
  systemctl restart energrid-core energrid-api || true
  nginx -t && systemctl reload nginx || true
  if systemctl is-active --quiet energrid-core && systemctl is-active --quiet energrid-api &&
      core_healthy && api_healthy && portal_healthy; then
    echo "Previous release restored and responding."
  else
    echo "Rollback ran; one or more service checks still need attention."
  fi
  exit "$rc"
}

trap restore_previous ERR

[[ -d "$release" && -s "$release/dist/api/main.js" &&
   -s "$release/dist/apps/core/main.js" && -s "$release/dist/apps/portal/index.html" ]]
[[ -f "$api_unit" ]]
[[ ! -e "$backup_core" && ! -L "$backup_core" ]]
node_bin="$(systemctl show energrid-api --property=ExecStart --value |
  sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -n 1)"
[[ -x "$node_bin" ]]
previous_portal="$(readlink -f "$portal")"
[[ -n "$previous_portal" && -d "$previous_portal" ]]

install -m 0644 "$api_unit" "$previous_api"
cat > "$release/api-unit.new" <<EOF
[Service]
WorkingDirectory=$release
$(grep -E '^(Environment|EnvironmentFile)=' "$api_unit" || true)
ExecStart=
ExecStart=$node_bin $release/dist/api/main.js
EOF

changed=1
mv "$core" "$backup_core"
ln -s "$release/dist/apps/core" "$apps/core.deploy-$release_id"
mv -Tf "$apps/core.deploy-$release_id" "$core"
ln -s "$release/dist/apps/portal" "$apps/portal.deploy-$release_id"
mv -Tf "$apps/portal.deploy-$release_id" "$portal"
install -m 0644 "$release/api-unit.new" "$api_unit"
systemctl daemon-reload
systemctl restart energrid-core energrid-api
nginx -t
systemctl reload nginx

for attempt in $(seq 1 30); do
  if systemctl is-active --quiet energrid-core && systemctl is-active --quiet energrid-api &&
      core_healthy && api_healthy && portal_healthy; then
    trap - ERR
    echo "Deployment healthy: Core :$core_port, API :$api_port, Portal via nginx."
    systemctl --no-pager status energrid-core energrid-api nginx
    exit 0
  fi
  sleep 1
done

echo "Health checks timed out: Core=$(systemctl is-active energrid-core || true), API=$(systemctl is-active energrid-api || true)." >&2
false
