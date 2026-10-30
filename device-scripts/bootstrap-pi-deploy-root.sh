#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID:-$(id -u)}" == 0 ]] || { echo "Run this bootstrap as root." >&2; exit 77; }
deploy_user="${1:-}"
expected_helper_sha="${2:-}"
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || { echo "Invalid deploy account." >&2; exit 2; }
[[ "$expected_helper_sha" =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid helper checksum." >&2; exit 2; }
id "$deploy_user" >/dev/null

for service in energrid-api energrid-core nginx mosquitto; do
  systemctl is-active --quiet "$service" || { echo "Required service is not active: $service" >&2; exit 1; }
done

root=/var/www/energrid
releases=/var/www/energrid-releases
api_unit=/etc/systemd/system/energrid-api.service.d/10-auth-v1.conf
core_dropin=/etc/systemd/system/energrid-core.service.d/90-energrid-release.conf
nginx_enabled=/etc/nginx/sites-enabled/energrid-portal.conf
nginx_conf="$(readlink -f "$nginx_enabled")"
helper_source=/tmp/energrid-deploy-activate.sh
helper_dest=/usr/local/sbin/energrid-deploy-activate
state=/var/lib/energrid-deploy
backup_root="$state/bootstrap-backup"
release_env="$state/release.env"
sudoers_file=/etc/sudoers.d/energrid-deploy
changed=0
backup_dir=""
api_tmp=""
core_tmp=""
nginx_tmp=""

die() { echo "Pi deployment bootstrap: $*" >&2; exit 1; }

[[ -f "$nginx_conf" && ! -L "$nginx_conf" ]] || die "cannot resolve the active Nginx Portal configuration."
[[ -f "$helper_source" && ! -L "$helper_source" ]] || die "deployment helper payload is missing."
actual_helper_sha="$(sha256sum "$helper_source" | awk '{print $1}')"
[[ "$actual_helper_sha" == "$expected_helper_sha" ]] || die "helper checksum mismatch; refusing installation."

if [[ -L "$root/current" ]]; then
  current_target="$(readlink -f "$root/current")"
  current_api_exec="$(systemctl show energrid-api --property=ExecStart --value)"
  current_core_exec="$(systemctl show energrid-core --property=ExecStart --value)"
  stable_root_count="$(grep -cE '^[[:space:]]*root[[:space:]]+/var/www/energrid/current/dist/apps/portal;' "$nginx_conf" || true)"
  expected_sudoers="$deploy_user ALL=(root) NOPASSWD: /usr/local/sbin/energrid-deploy-activate \"\""
  if [[ "$current_target" == "$releases/"* && "$current_api_exec" == *"/var/www/energrid/current/dist/api/main.js"* &&
        "$current_core_exec" == *"/var/www/energrid/current/dist/apps/core/main.js"* && "$stable_root_count" == 1 &&
        -f "$sudoers_file" && ! -L "$sudoers_file" && -f "$state/deploy-user" &&
        -f "$release_env" && ! -L "$release_env" &&
        "$(cat "$state/deploy-user")" == "$deploy_user" ]] &&
      grep -Fxq "$expected_sudoers" "$sudoers_file"; then
    current_id="$(basename "$current_target")"
    api_pid="$(systemctl show energrid-api --property=MainPID --value)"
    core_pid="$(systemctl show energrid-core --property=MainPID --value)"
    grep -Fxq "ENERGRID_RELEASE_ID=$current_id" "$release_env" || die "release identity file does not match the current release."
    [[ "$(systemctl is-active energrid-api)" == active && "$(systemctl is-active energrid-core)" == active &&
       "$(systemctl is-active nginx)" == active && "$(systemctl is-active mosquitto)" == active &&
       "$api_pid" =~ ^[1-9][0-9]*$ && "$core_pid" =~ ^[1-9][0-9]*$ ]] || die "one or more configured services are not active."
    tr '\0' '\n' <"/proc/$api_pid/environ" | grep -Fxq "ENERGRID_RELEASE_ID=$current_id" || die "API is not running the current release identity."
    tr '\0' '\n' <"/proc/$core_pid/environ" | grep -Fxq "ENERGRID_RELEASE_ID=$current_id" || die "Core is not running the current release identity."
    [[ "$(systemctl show energrid-api --property=User --value)" == "$deploy_user" &&
       "$(systemctl show energrid-core --property=User --value)" == "$deploy_user" ]] || die "service account differs from the configured deploy account."
    install -o root -g root -m 0755 "$helper_source" "$helper_dest.new"
    [[ "$(sha256sum "$helper_dest.new" | awk '{print $1}')" == "$expected_helper_sha" ]] || die "activation helper checksum mismatch."
    mv -f "$helper_dest.new" "$helper_dest"
    visudo -cf "$sudoers_file"
    echo "Bootstrap already configured for the verified shared release path; root helper updated idempotently."
    exit 0
  fi
  die "a current-release layout exists but does not match this bootstrap; inspect before modifying it."
fi

[[ -f "$api_unit" && ! -L "$api_unit" ]] || die "expected API environment drop-in is missing."
[[ -L "$root/dist/apps/core" && -L "$root/dist/apps/portal" ]] || die "expected Core/Portal release links are missing."
[[ -d "$releases" && "$(stat -c '%U' "$releases")" == "$deploy_user" && -w "$releases" ]] ||
  die "release root must exist and be writable by the deployment account."

current_portal="$(readlink -f "$root/dist/apps/portal")"
current_release_id="$(basename "$(dirname "$(dirname "$(dirname "$current_portal")")")")"
[[ "$current_release_id" =~ ^[a-f0-9]{12}-[0-9]{8}T[0-9]{6}Z$ ]] || die "cannot identify the current versioned release."
current_release="$releases/$current_release_id"
[[ -d "$current_release" && "$(readlink -f "$root/dist/apps/core")" == "$current_release/dist/apps/core" ]] ||
  die "Core and Portal do not point to the same release."
[[ -s "$current_release/dist/api/main.js" && -s "$current_release/dist/apps/core/main.js" &&
   -s "$current_release/dist/apps/portal/index.html" ]] || die "current release is incomplete."
current_api_exec="$(systemctl show energrid-api --property=ExecStart --value)"
[[ "$current_api_exec" == *"$current_release_id/dist/api/main.js"* ]] || die "API and Portal refer to different releases."
[[ "$(systemctl show energrid-api --property=User --value)" == "$deploy_user" &&
   "$(systemctl show energrid-core --property=User --value)" == "$deploy_user" ]] ||
  die "API/Core run under a different account than the deployment identity."
[[ ! -e "$core_dropin" && ! -L "$core_dropin" ]] || die "Core release drop-in already exists; inspect it before bootstrapping."
root_count="$(grep -cE '^[[:space:]]*root[[:space:]]+/var/www/energrid/dist/apps/portal;' "$nginx_conf" || true)"
[[ "$root_count" == 1 ]] || die "Nginx Portal root differs from the expected existing layout."
[[ ! -e "$sudoers_file" && ! -L "$sudoers_file" ]] || die "sudoers file already exists; inspect it before bootstrapping."
if [[ -e "$helper_dest" || -L "$helper_dest" ]]; then
  [[ -f "$helper_dest" && ! -L "$helper_dest" && "$(stat -c '%U:%G:%a' "$helper_dest")" == "root:root:755" ]] ||
    die "existing activation helper has unexpected type, ownership or permissions."
  [[ "$(sha256sum "$helper_dest" | awk '{print $1}')" == "$expected_helper_sha" ]] ||
    die "existing activation helper does not match this verified bootstrap payload."
fi
if [[ -e "$release_env" || -L "$release_env" ]]; then
  [[ -f "$release_env" && ! -L "$release_env" ]] || die "release identity path exists but is not a regular file."
fi

state=/var/lib/energrid-deploy
install -d -o root -g root -m 0711 "$state"
install -d -o "$deploy_user" -g "$(id -gn "$deploy_user")" -m 0700 "$state/request"
install -d -o root -g root -m 0700 "$state/backups" "$backup_root"
backup_dir="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -m 0700 "$backup_dir"
install -o root -g root -m 0600 "$api_unit" "$backup_dir/api-unit"
install -o root -g root -m 0600 "$nginx_conf" "$backup_dir/nginx.conf"
if [[ -f "$release_env" && ! -L "$release_env" ]]; then
  install -o root -g root -m 0600 "$release_env" "$backup_dir/release.env"
else
  : >"$backup_dir/release-env-was-absent"
fi
printf '%s\n' "$current_release" >"$backup_dir/current-target"
printf '%s\n' "$current_release_id" >"$backup_dir/release-id"
old_api_pid="$(systemctl show energrid-api --property=MainPID --value)"
old_core_pid="$(systemctl show energrid-core --property=MainPID --value)"
node_bin="$(systemctl show energrid-api --property=ExecStart --value | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -n 1)"
[[ -x "$node_bin" ]] || die "cannot resolve the API Node.js runtime."

api_tmp="$(mktemp "${api_unit}.bootstrap.XXXXXX")"
{
  printf '[Service]\nWorkingDirectory=%s/current\n' "$root"
  grep -E '^(Environment|EnvironmentFile)=' "$backup_dir/api-unit" | grep -Fv "$release_env" || true
  printf 'EnvironmentFile=%s\n' "$release_env"
  printf 'ExecStart=\nExecStart=%s %s/current/dist/api/main.js\n' "$node_bin" "$root"
} >"$api_tmp"
chmod 0644 "$api_tmp"

install -d -o root -g root -m 0755 "$(dirname "$core_dropin")"
core_tmp="$(mktemp "${core_dropin}.bootstrap.XXXXXX")"
{
  printf '[Service]\nEnvironmentFile=%s\nExecStart=\nExecStart=/usr/bin/node %s/current/dist/apps/core/main.js\n' "$release_env" "$root"
} >"$core_tmp"
chmod 0644 "$core_tmp"

nginx_tmp="$(mktemp "${nginx_conf}.bootstrap.XXXXXX")"
awk -v old='/var/www/energrid/dist/apps/portal' -v new='/var/www/energrid/current/dist/apps/portal' \
  '$1 == "root" && $2 == old ";" { print "  root " new ";"; count++; next } { print } END { if (count != 1) exit 1 }' \
  "$backup_dir/nginx.conf" >"$nginx_tmp"
chmod 0644 "$nginx_tmp"

bootstrap_failure_handled=0
rollback_bootstrap() {
  local rc="${1:-$?}"
  local failed_line="${2:-unknown}"
  local failed_command="${3:-unknown command}"
  if (( bootstrap_failure_handled )); then exit "$rc"; fi
  bootstrap_failure_handled=1
  trap - ERR
  set +e +E
  echo "Bootstrap failed at line $failed_line (status $rc): $failed_command" >&2
  if (( changed == 0 )); then
    rm -f "$helper_dest" "$helper_dest.new" "$api_tmp" "$core_tmp" "$nginx_tmp"
    exit "$rc"
  fi
  echo "Restoring the prior paths and service configuration." >&2
  ln -s "$current_release" "$root/current.rollback-$$" && mv -Tf "$root/current.rollback-$$" "$root/current"
  install -o root -g root -m 0644 "$backup_dir/api-unit" "$api_unit"
  rm -f "$core_dropin"
  install -o root -g root -m 0644 "$backup_dir/nginx.conf" "$nginx_conf"
  if [[ -f "$backup_dir/release.env" ]]; then
    install -o root -g root -m 0644 "$backup_dir/release.env" "$release_env"
  else
    rm -f "$release_env"
  fi
  rm -f "$helper_dest" "$sudoers_file"
  systemctl daemon-reload
  nginx -t && systemctl reload nginx
  systemctl restart energrid-core energrid-api
  echo "Bootstrap rollback finished; API/Core/Nginx health should be rechecked."
  exit "$rc"
}
trap 'rollback_bootstrap "$?" "$LINENO" "$BASH_COMMAND"' ERR

helper_tmp="$helper_dest.new"
install -o root -g root -m 0755 "$helper_source" "$helper_tmp"
[[ "$(sha256sum "$helper_tmp" | awk '{print $1}')" == "$expected_helper_sha" ]] || {
  rm -f "$helper_tmp"; die "installed activation helper checksum mismatch.";
}
mv -f "$helper_tmp" "$helper_dest"

changed=1
ln -s "$current_release" "$root/current.bootstrap-$$"
mv -Tf "$root/current.bootstrap-$$" "$root/current"
release_env_tmp="$(mktemp "$release_env.bootstrap.XXXXXX")"
printf 'ENERGRID_RELEASE_ID=%s\nENERGRID_COMMIT=legacy-version:%s\n' "$current_release_id" "$current_release_id" >"$release_env_tmp"
chown root:root "$release_env_tmp"
chmod 0644 "$release_env_tmp"
mv -f "$release_env_tmp" "$release_env"
mv -f "$api_tmp" "$api_unit"
mv -f "$core_tmp" "$core_dropin"
mv -f "$nginx_tmp" "$nginx_conf"
systemctl daemon-reload
nginx -t
systemctl restart energrid-core energrid-api
systemctl reload nginx

api_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 4 http://127.0.0.1:3000/portal/state 2>/dev/null)"
core_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 4 http://127.0.0.1:3102/core/weather/performance 2>/dev/null)"
portal_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 4 http://127.0.0.1/ 2>/dev/null)"
[[ "$api_status" == 200 || "$api_status" == 401 ]] || die "API health check failed after stable-path configuration."
[[ "$core_status" == 2* && "$portal_status" == 2* ]] || die "Core/Portal health check failed after stable-path configuration."
[[ "$(readlink -f "$root/current")" == "$current_release" ]] || die "shared current link does not resolve to the prior release."
[[ "$(systemctl show energrid-api --property=ExecStart --value)" == *"/var/www/energrid/current/dist/api/main.js"* ]] || die "API unit does not use the shared current link."
[[ "$(systemctl show energrid-core --property=ExecStart --value)" == *"/var/www/energrid/current/dist/apps/core/main.js"* ]] || die "Core unit does not use the shared current link."
new_api_pid="$(systemctl show energrid-api --property=MainPID --value)"
new_core_pid="$(systemctl show energrid-core --property=MainPID --value)"
[[ "$new_api_pid" != "$old_api_pid" && "$new_core_pid" != "$old_core_pid" ]] || die "API/Core did not restart onto the shared release path."
tr '\0' '\n' <"/proc/$new_api_pid/environ" | grep -Fxq "ENERGRID_RELEASE_ID=$current_release_id" || die "API did not load the initial release identity."
tr '\0' '\n' <"/proc/$new_core_pid/environ" | grep -Fxq "ENERGRID_RELEASE_ID=$current_release_id" || die "Core did not load the initial release identity."
for service in energrid-api energrid-core nginx mosquitto; do
  systemctl is-active --quiet "$service" || die "service became inactive: $service"
done

sudoers_tmp="$(mktemp /etc/sudoers.d/energrid-deploy.XXXXXX)"
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/energrid-deploy-activate ""\n' "$deploy_user" >"$sudoers_tmp"
chmod 0440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp" || { rm -f "$sudoers_tmp"; die "generated sudo rule failed validation."; }
mv -f "$sudoers_tmp" "$sudoers_file"
visudo -cf "$sudoers_file"
install -o root -g root -m 0600 /dev/null "$state/deploy-user.new"
printf '%s\n' "$deploy_user" >"$state/deploy-user.new"
mv -f "$state/deploy-user.new" "$state/deploy-user"
install -o root -g root -m 0600 /dev/null "$state/previous-good-release.new"
printf '%s\n' "$current_release_id" >"$state/previous-good-release.new"
mv -f "$state/previous-good-release.new" "$state/previous-good-release"

trap - ERR
echo "Bootstrap complete. Stable current-release link verified; only the root-owned helper can change it."
echo "API and Core were restarted once and Nginx reloaded once. Mosquitto remained active and unchanged."
