#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
target_config="${XDG_CONFIG_HOME:-$HOME/.config}/energrid/deploy-pi-target"
key="$HOME/.ssh/energrid-pi-deploy"
dry_run=0

case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  --help|-h)
    echo "Usage: npm run deploy:pi [-- --dry-run]"
    echo "After one-time bootstrap, a normal run builds, stages, activates and verifies a release."
    exit 0
    ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

if (( dry_run )); then
  target="${ENERGRID_PI_SSH_TARGET:-}"
  [[ -n "$target" ]] || { echo "Set ENERGRID_PI_SSH_TARGET for a local dry run." >&2; exit 2; }
else
  [[ -f "$target_config" && ! -L "$target_config" ]] || {
    echo "Pi deployment is not bootstrapped. Run: npm run bootstrap:pi-deploy -- USER@HOST" >&2
    exit 2
  }
  target="$(cat "$target_config")"
fi
[[ "$target" =~ ^[a-z_][a-z0-9_-]*@[a-zA-Z0-9._-]+$ ]] || {
  echo "Invalid configured Pi SSH target." >&2; exit 2;
}

for command in git pnpm ssh scp tar node; do
  command -v "$command" >/dev/null || { echo "$command is required." >&2; exit 1; }
done

branch="$(git -C "$repo_root" branch --show-current)"
[[ "$branch" == main ]] || { echo "Deploy only from main (current branch: ${branch:-detached HEAD})." >&2; exit 1; }
commit="$(git -C "$repo_root" rev-parse HEAD)"
short_commit="${commit:0:12}"
if ! git -C "$repo_root" diff --quiet HEAD -- . ':(exclude).idea/**'; then
  echo "Tracked application/source changes are not committed. Commit them before deployment." >&2
  exit 1
fi

if (( ! dry_run )); then
  [[ -f "$key" ]] || { echo "Dedicated deployment SSH key is missing; run the bootstrap command." >&2; exit 1; }
  ssh_args=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8)
  ssh "${ssh_args[@]}" "$target" \
    'test -d /var/www/energrid-releases && test -x /usr/local/sbin/energrid-deploy-activate && sudo -n -l /usr/local/sbin/energrid-deploy-activate >/dev/null && test "$(systemctl is-active energrid-api)" = active && test "$(systemctl is-active energrid-core)" = active && test "$(systemctl is-active nginx)" = active && test "$(systemctl is-active mosquitto)" = active && test ! -e /var/lib/energrid-deploy/request/release-action' || {
      echo "Pi preflight failed: bootstrap incomplete, a service is down, or another deployment is pending." >&2
      exit 1
    }
else
  ssh_args=()
fi

release="${short_commit}-$(date -u +%Y%m%dT%H%M%SZ)"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/energrid-pi-build.XXXXXX")"
archive=""
cleanup() {
  [[ -z "$temp_root" ]] || rm -rf "$temp_root"
  [[ -z "$archive" ]] || rm -f "$archive"
}
trap cleanup EXIT
archive="$(mktemp "${TMPDIR:-/tmp}/energrid-pi-release.XXXXXX")"

echo "Building committed main $short_commit in a clean temporary source tree..."
git -C "$repo_root" archive --format=tar HEAD | tar -xf - -C "$temp_root"
rm -rf "$temp_root/.idea" "$temp_root/apps/android/.idea" "$temp_root/apps/android/.kotlin"
find "$temp_root" -maxdepth 1 -name 'node_modules.broken-*' -exec rm -rf {} +
find "$temp_root" -type d \( -name .nx -o -name .kotlin -o -name __pycache__ \) -prune -exec rm -rf {} +
find "$temp_root" -type f -name '.env*' -delete
find "$temp_root" -type f -name '*.pyc' -delete
[[ -d "$repo_root/node_modules" ]] || { echo "Install local dependencies before deploying." >&2; exit 1; }
ln -s "$repo_root/node_modules" "$temp_root/node_modules"
(
  cd "$temp_root"
  NX_DAEMON=false pnpm nx build api --skip-nx-cache
  NX_DAEMON=false pnpm nx build core --skip-nx-cache
  VITE_BACKEND_LABEL=same-origin NX_DAEMON=false pnpm nx build portal --skip-nx-cache
)
rm "$temp_root/node_modules"

for artifact in dist/api/main.js dist/apps/core/main.js dist/apps/portal/index.html; do
  [[ -s "$temp_root/$artifact" ]] || { echo "Build artifact missing: $artifact" >&2; exit 1; }
done
if find "$temp_root" -type f \( -name '.env' -o -name '.env.*' -o -name '*.pyc' \) -print -quit | grep -q .; then
  echo "Unexpected local environment/cache file in release staging; refusing to package." >&2
  exit 1
fi

built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'release=%s\ncommit=%s\nbuilt_at=%s\n' "$release" "$commit" "$built_at" >"$temp_root/release-manifest.txt"
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({releaseId:process.argv[2],commit:process.argv[3],builtAt:process.argv[4]}));' \
  "$temp_root/dist/apps/portal/release.json" "$release" "$commit" "$built_at"

tar -czf "$archive" -C "$temp_root" .
if tar -tzf "$archive" | awk '/(^\/|(^|\/)\.\.($|\/))/{bad=1} END{exit bad}'; then :; else
  echo "Release archive contains an unsafe path." >&2; exit 1
fi
echo "Prepared release=$release commit=$commit size=$(wc -c <"$archive" | tr -d ' ') bytes."
if (( dry_run )); then
  echo "Dry run complete; no SSH connection, transfer or activation was performed."
  exit 0
fi

remote_release="/var/www/energrid-releases/$release"
archive_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
echo "Staging release on $target..."
ssh "${ssh_args[@]}" "$target" "mkdir '$remote_release'"
scp "${ssh_args[@]}" "$archive" "$target:/tmp/energrid-release-$release.tar.gz"
ssh "${ssh_args[@]}" "$target" \
  "printf '%s  %s\\n' '$archive_sha' '/tmp/energrid-release-$release.tar.gz' | sha256sum -c - && tar -xzf '/tmp/energrid-release-$release.tar.gz' -C '$remote_release' && rm -f '/tmp/energrid-release-$release.tar.gz' && cd '$remote_release' && pnpm install --frozen-lockfile"

echo "Requesting passwordless activation through the fixed root-owned helper..."
ssh "${ssh_args[@]}" "$target" \
  "umask 077; printf 'activate %s\\n' '$release' > /var/lib/energrid-deploy/request/release-action.tmp; mv -f /var/lib/energrid-deploy/request/release-action.tmp /var/lib/energrid-deploy/request/release-action; if sudo -n /usr/local/sbin/energrid-deploy-activate; then :; else rc=\$?; if test \"\$(cat /var/lib/energrid-deploy/request/release-action 2>/dev/null)\" = 'activate $release'; then rm -f /var/lib/energrid-deploy/request/release-action; fi; exit \$rc; fi" || {
    echo "Activation failed. The fixed helper rolls back automatically if post-activation health/version checks fail; staged releases are retained." >&2
    exit 1
  }
echo "Deployment complete: release=$release commit=$commit."
