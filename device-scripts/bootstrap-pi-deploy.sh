#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
target="${1:-}"

if [[ -z "$target" || ! "$target" =~ ^[a-z_][a-z0-9_-]*@[a-zA-Z0-9._-]+$ ]]; then
  echo "Usage: npm run bootstrap:pi-deploy -- USER@HOST" >&2
  exit 2
fi
deploy_user="${target%@*}"
key="$HOME/.ssh/energrid-pi-deploy"
target_config="${XDG_CONFIG_HOME:-$HOME/.config}/energrid/deploy-pi-target"
bootstrap_payload="$script_dir/bootstrap-pi-deploy-root.sh"
helper_payload="$script_dir/deploy-pi-activate.sh"

for command in ssh scp ssh-keygen ssh-add shasum awk; do
  command -v "$command" >/dev/null || { echo "$command is required." >&2; exit 1; }
done

echo "One-time setup target: $target"
echo "This will install a dedicated SSH key, create a stable release link, and add one narrowly scoped sudo rule."
echo "It will restart the existing API and Core once and reload Nginx once; Mosquitto and application data are not changed."
read -r -p "Type SETUP to continue: " confirmation
[[ "$confirmation" == SETUP ]] || { echo "Setup cancelled." >&2; exit 1; }

mkdir -p "$HOME/.ssh"
chmod 0700 "$HOME/.ssh"
if [[ ! -f "$key" ]]; then
  echo "Create the deployment key. Use a passphrase; macOS Keychain will keep it available for releases."
  ssh-keygen -t ed25519 -a 64 -f "$key" -C "energrid-pi-deploy"
fi
[[ -f "$key" && -f "$key.pub" ]] || { echo "Deployment key pair is incomplete." >&2; exit 1; }
chmod 0600 "$key"
chmod 0644 "$key.pub"

if [[ "$(uname -s)" == Darwin ]]; then
  ssh-add --apple-use-keychain "$key"
else
  ssh-add "$key"
fi

ssh_common=(-o StrictHostKeyChecking=yes -o ConnectTimeout=8)
echo "Installing the public key on the Pi (SSH may request the account password once)."
ssh "${ssh_common[@]}" "$target" 'umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; IFS= read -r keyline; grep -Fxq "$keyline" "$HOME/.ssh/authorized_keys" || printf "%s\n" "$keyline" >>"$HOME/.ssh/authorized_keys"; chmod 0700 "$HOME/.ssh"; chmod 0600 "$HOME/.ssh/authorized_keys"' <"$key.pub"

if ! ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes "${ssh_common[@]}" "$target" true; then
  echo "Dedicated SSH-key login failed; privileged setup was not attempted." >&2
  exit 1
fi

scp -i "$key" -o IdentitiesOnly=yes "${ssh_common[@]}" "$helper_payload" "$target:/tmp/energrid-deploy-activate.sh"
scp -i "$key" -o IdentitiesOnly=yes "${ssh_common[@]}" "$bootstrap_payload" "$target:/tmp/energrid-bootstrap-pi-deploy.sh"
helper_sha="$(shasum -a 256 "$helper_payload" | awk '{print $1}')"
bootstrap_sha="$(shasum -a 256 "$bootstrap_payload" | awk '{print $1}')"
echo "The next step requests the Pi administrator password interactively. It is not saved or echoed."
ssh -tt -i "$key" -o IdentitiesOnly=yes "${ssh_common[@]}" "$target" \
  "sudo install -o root -g root -m 0700 /tmp/energrid-bootstrap-pi-deploy.sh /usr/local/sbin/energrid-bootstrap-install && printf '%s  %s\\n' '$bootstrap_sha' /usr/local/sbin/energrid-bootstrap-install | sudo sha256sum -c - && sudo /usr/local/sbin/energrid-bootstrap-install '$deploy_user' '$helper_sha'"
ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes "${ssh_common[@]}" "$target" \
  'rm -f /tmp/energrid-deploy-activate.sh /tmp/energrid-bootstrap-pi-deploy.sh'

config_dir="$(dirname -- "$target_config")"
mkdir -p "$config_dir"
chmod 0700 "$config_dir"
config_tmp="$target_config.tmp.$$"
umask 077
printf '%s\n' "$target" >"$config_tmp"
chmod 0600 "$config_tmp"
mv -f "$config_tmp" "$target_config"

echo "Bootstrap completed for $target. Next, use npm run deploy:pi."
