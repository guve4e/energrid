#!/usr/bin/env bash
set -euo pipefail

# Installed once as root at /usr/local/sbin/energrid-deploy-activate.
# The deploy account may invoke this with no arguments only.
[[ "${EUID:-$(id -u)}" == 0 ]] || { echo "Must run through the scoped sudo rule." >&2; exit 77; }
[[ "$#" == 0 ]] || { echo "This helper accepts no arguments." >&2; exit 2; }

root=/var/www/energrid
releases=/var/www/energrid-releases
current="$root/current"
api_unit=/etc/systemd/system/energrid-api.service.d/10-auth-v1.conf
state=/var/lib/energrid-deploy
release_env="$state/release.env"
request="$state/request/release-action"
backups="$state/backups"
api_port=3000
core_port=3102
deploy_user_file="$state/deploy-user"
changed=0
backup_dir=""
old_api_pid=""
old_core_pid=""
old_current_target=""
old_release_id=""
target_release_id=""
target_commit=""
target_release=""
action=""
legacy_rollback=0
trap 'rm -f "$request"' EXIT

die() { echo "Pi deployment: $*" >&2; exit 1; }

api_healthy() {
  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 4 \
    "http://127.0.0.1:$api_port/portal/state" 2>/dev/null)" || return 1
  [[ "$status" == 200 || "$status" == 401 ]]
}

core_healthy() {
  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 4 \
    "http://127.0.0.1:$core_port/core/weather/performance" 2>/dev/null)" || return 1
  [[ "$status" == 2* ]]
}

portal_healthy() {
  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 4 \
    http://127.0.0.1/ 2>/dev/null)" || return 1
  [[ "$status" == 2* ]]
}

release_version_matches() {
  [[ "$(readlink -f "$current")" == "$target_release" ]] || return 1
  if (( legacy_rollback )); then return 0; fi
  local response
  response="$(curl --silent --fail --max-time 4 http://127.0.0.1/release.json 2>/dev/null)" || return 1
  grep -Fq '"releaseId":"'"$target_release_id"'"' <<<"$response" &&
    grep -Fq '"commit":"'"$target_commit"'"' <<<"$response"
}

api_process_matches() {
  local pid exec_start command_line environment
  pid="$(systemctl show energrid-api --property=MainPID --value)"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/cmdline" ]] || return 1
  exec_start="$(systemctl show energrid-api --property=ExecStart --value)"
  command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
  environment="$(tr '\0' '\n' <"/proc/$pid/environ")"
  [[ "$exec_start" == *"/var/www/energrid/current/dist/api/main.js"* &&
    "$command_line" == *"/var/www/energrid/current/dist/api/main.js"* ]] &&
    grep -Fxq "ENERGRID_RELEASE_ID=$target_release_id" <<<"$environment" &&
    grep -Fxq "ENERGRID_COMMIT=$target_commit" <<<"$environment"
}

core_process_matches() {
  local pid exec_start command_line environment
  pid="$(systemctl show energrid-core --property=MainPID --value)"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/cmdline" ]] || return 1
  exec_start="$(systemctl show energrid-core --property=ExecStart --value)"
  command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
  environment="$(tr '\0' '\n' <"/proc/$pid/environ")"
  [[ "$exec_start" == *"/var/www/energrid/current/dist/apps/core/main.js"* &&
    "$command_line" == *"/var/www/energrid/current/dist/apps/core/main.js"* ]] &&
    grep -Fxq "ENERGRID_RELEASE_ID=$target_release_id" <<<"$environment" &&
    grep -Fxq "ENERGRID_COMMIT=$target_commit" <<<"$environment"
}

write_release_env() {
  local temp
  temp="$(mktemp "$state/release.env.XXXXXX")"
  printf 'ENERGRID_RELEASE_ID=%s\nENERGRID_COMMIT=%s\n' "$target_release_id" "$target_commit" >"$temp"
  chown root:root "$temp"
  chmod 0644 "$temp"
  mv -f "$temp" "$release_env"
}

set_previous_good() {
  local temp
  temp="$(mktemp "$state/previous-good-release.XXXXXX")"
  printf '%s\n' "$1" >"$temp"
  chmod 0600 "$temp"
  mv -f "$temp" "$state/previous-good-release"
}

restore_previous() {
  local rc=$?
  trap - ERR
  if (( changed == 0 )); then exit "$rc"; fi
  set +e
  local rollback_failed=0
  echo "Release verification failed; restoring the previous release..." >&2
  if [[ -n "$old_current_target" ]]; then
    ln -s "$old_current_target" "$root/current.rollback-$$" && mv -Tf "$root/current.rollback-$$" "$current" || rollback_failed=1
  fi
  if [[ -s "$backup_dir/release.env" ]]; then
    install -o root -g root -m 0644 "$backup_dir/release.env" "$release_env.rollback-$$" &&
      mv -f "$release_env.rollback-$$" "$release_env" || rollback_failed=1
  fi
  systemctl restart energrid-core energrid-api || rollback_failed=1
  if (( rollback_failed == 0 )) && systemctl is-active --quiet energrid-core && systemctl is-active --quiet energrid-api &&
      systemctl is-active --quiet nginx && systemctl is-active --quiet mosquitto &&
      core_healthy && api_healthy && portal_healthy; then
    [[ -n "$old_release_id" ]] && set_previous_good "$old_release_id"
    echo "Previous release restored; API, Core, Portal and Mosquitto checks pass." >&2
  else
    echo "Rollback attempted; one or more service checks still need operator attention." >&2
  fi
  exit "$rc"
}
trap restore_previous ERR

[[ -f "$deploy_user_file" && ! -L "$deploy_user_file" ]] || die "bootstrap state is incomplete."
deploy_user="$(cat "$deploy_user_file")"
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die "invalid configured deploy user."
[[ -d "$state/request" && ! -L "$state/request" && -d "$backups" && ! -L "$backups" ]] || die "bootstrap state paths are invalid."
[[ -f "$release_env" && ! -L "$release_env" ]] || die "running release identity file is missing."
exec 9>"$state/activation.lock"
flock -n 9 || die "another deployment activation is already running."
[[ -f "$request" && ! -L "$request" ]] || die "no deployment action was requested."
request_owner="$(stat -c '%U' "$request")"
[[ "$request_owner" == "$deploy_user" ]] || die "deployment request has the wrong owner."
IFS=' ' read -r action requested_id extra <"$request"
[[ -z "${extra:-}" ]] || die "invalid deployment request format."

case "$action" in
  activate) target_release_id="$requested_id" ;;
  rollback) target_release_id="$(cat "$state/previous-good-release" 2>/dev/null || true)" ;;
  *) die "unsupported deployment action." ;;
esac
[[ "$target_release_id" =~ ^[a-f0-9]{12}-[0-9]{8}T[0-9]{6}Z$ ]] || die "no valid release is available for this action."
target_release="$releases/$target_release_id"
[[ -d "$target_release" && ! -L "$target_release" ]] || die "release directory is missing or unsafe: $target_release_id."
[[ "$(readlink -f "$target_release")" == "$releases/$target_release_id" ]] || die "release path resolves outside the configured root."
while IFS= read -r -d '' release_link; do
  link_target="$(readlink -f "$release_link")" || die "release contains a dangling symlink."
  [[ "$link_target" == "$target_release/"* ]] || die "release contains a symlink outside its versioned directory."
done < <(find "$target_release" -type l -print0)
manifest="$target_release/release-manifest.txt"
if [[ -f "$manifest" && ! -L "$manifest" ]]; then
  grep -Fxq "release=$target_release_id" "$manifest" || die "release manifest ID mismatch."
  target_commit="$(sed -n 's/^commit=\([a-f0-9]\{40\}\)$/\1/p' "$manifest")"
  [[ "$target_commit" =~ ^[a-f0-9]{40}$ && "$target_release_id" == "${target_commit:0:12}-"* ]] || die "release commit identity is invalid."
elif [[ "$action" == rollback ]]; then
  legacy_rollback=1
  target_commit="legacy-version:$target_release_id"
else
  die "release manifest is missing."
fi
[[ -s "$target_release/dist/api/main.js" && -s "$target_release/dist/apps/core/main.js" &&
   -s "$target_release/dist/apps/portal/index.html" ]] || die "one or more API/Core/Portal artifacts are missing."
if (( ! legacy_rollback )); then
  [[ -s "$target_release/dist/apps/portal/release.json" ]] || die "Portal release marker is missing."
  grep -Fq '"releaseId":"'"$target_release_id"'"' "$target_release/dist/apps/portal/release.json" || die "Portal release marker ID mismatch."
  grep -Fq '"commit":"'"$target_commit"'"' "$target_release/dist/apps/portal/release.json" || die "Portal commit marker mismatch."
fi

[[ -L "$current" ]] || die "shared current-release link is missing."
[[ "$(systemctl is-active energrid-api)" == active && "$(systemctl is-active energrid-core)" == active &&
   "$(systemctl is-active nginx)" == active && "$(systemctl is-active mosquitto)" == active ]] ||
  die "one or more expected services are not active; refusing activation."

if [[ "$(readlink -f "$current")" == "$target_release" ]] && release_version_matches &&
    api_process_matches && core_process_matches && api_healthy && core_healthy && portal_healthy; then
  rm -f "$request"
  echo "Release $target_release_id is already active and verified."
  exit 0
fi

old_api_pid="$(systemctl show energrid-api --property=MainPID --value)"
old_core_pid="$(systemctl show energrid-core --property=MainPID --value)"
old_current_target="$(readlink -f "$current")"
old_release_id="$(basename "$old_current_target")"
backup_dir="$backups/$target_release_id-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 0700 "$backup_dir"
printf '%s\n' "$old_current_target" >"$backup_dir/current-target"
printf '%s\n' "$old_release_id" >"$backup_dir/release-id"
install -o root -g root -m 0600 "$release_env" "$backup_dir/release.env"

changed=1
write_release_env
ln -s "$target_release" "$root/current.deploy-$$"
mv -Tf "$root/current.deploy-$$" "$current"
systemctl restart energrid-core energrid-api

for attempt in $(seq 1 45); do
  new_api_pid="$(systemctl show energrid-api --property=MainPID --value)"
  new_core_pid="$(systemctl show energrid-core --property=MainPID --value)"
  if systemctl is-active --quiet energrid-core && systemctl is-active --quiet energrid-api &&
      systemctl is-active --quiet nginx && systemctl is-active --quiet mosquitto &&
      [[ "$new_api_pid" != "$old_api_pid" && "$new_core_pid" != "$old_core_pid" ]] &&
      core_healthy && api_healthy && portal_healthy && release_version_matches &&
      api_process_matches && core_process_matches; then
    set_previous_good "$old_release_id"
    trap - ERR
    rm -f "$request"
    echo "Deployment verified: release=$target_release_id version=$target_commit."
    echo "API/Core restarted on the selected current release; Portal reports its release ID and commit; Nginx and Mosquitto remain active."
    exit 0
  fi
  sleep 1
done

echo "Pi deployment: health or running-version checks timed out for release $target_release_id." >&2
false
