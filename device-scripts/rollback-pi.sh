#!/usr/bin/env bash
set -Eeuo pipefail

target_config="${XDG_CONFIG_HOME:-$HOME/.config}/energrid/deploy-pi-target"
key="$HOME/.ssh/energrid-pi-deploy"
[[ -f "$target_config" && ! -L "$target_config" && -f "$key" ]] || {
  echo "Pi deployment is not bootstrapped; rollback is unavailable." >&2
  exit 2
}
target="$(cat "$target_config")"
[[ "$target" =~ ^[a-z_][a-z0-9_-]*@[a-zA-Z0-9._-]+$ ]] || { echo "Invalid configured Pi target." >&2; exit 2; }
ssh_args=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8)
ssh "${ssh_args[@]}" "$target" \
  "umask 077; printf 'rollback\\n' > /var/lib/energrid-deploy/request/release-action.tmp; mv -f /var/lib/energrid-deploy/request/release-action.tmp /var/lib/energrid-deploy/request/release-action; if sudo -n /usr/local/sbin/energrid-deploy-activate; then :; else rc=\$?; if test \"\$(cat /var/lib/energrid-deploy/request/release-action 2>/dev/null)\" = rollback; then rm -f /var/lib/energrid-deploy/request/release-action; fi; exit \$rc; fi"
