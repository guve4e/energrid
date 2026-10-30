#!/usr/bin/env bash
set -Eeuo pipefail

# Build the current Energrid checkout and deploy API, Core and Portal to the
# home Pi. Working-tree edits are included when origin/main is already at HEAD.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
target="${ENERGRID_PI_SSH_TARGET:-pi5@192.168.1.60}"
release_root=/var/www/energrid-releases

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
command -v ssh >/dev/null || { echo "ssh is required" >&2; exit 1; }
command -v scp >/dev/null || { echo "scp is required" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }

branch="$(git -C "$repo_root" branch --show-current)"
[[ "$branch" == main ]] || {
  echo "Deploy from the main branch (current branch: ${branch:-detached HEAD})." >&2
  exit 1
}

echo "Fetching origin/main..."
git -C "$repo_root" fetch origin main
head_commit="$(git -C "$repo_root" rev-parse HEAD)"
remote_commit="$(git -C "$repo_root" rev-parse origin/main)"
if ! git -C "$repo_root" merge-base --is-ancestor "$remote_commit" "$head_commit"; then
  if ! git -C "$repo_root" diff --quiet || ! git -C "$repo_root" diff --cached --quiet; then
    echo "Tracked local edits are present and origin/main moved. Commit or preserve them, fast-forward, then rerun." >&2
    exit 1
  fi
  git -C "$repo_root" merge --ff-only origin/main
fi

commit="$(git -C "$repo_root" rev-parse --short=12 HEAD)"
release="${commit}-$(date -u +%Y%m%dT%H%M%SZ)"
remote_release="$release_root/$release"
archive="$(mktemp "${TMPDIR:-/tmp}/energrid-release.XXXXXX.tar.gz")"
staging="$(mktemp -d "${TMPDIR:-/tmp}/energrid-release-tree.XXXXXX")"
cleanup() { rm -f "$archive"; rm -rf "$staging"; }
trap cleanup EXIT

echo "Installing local dependencies and building API, Core and Portal..."
(
  cd "$repo_root"
  pnpm install --frozen-lockfile
  pnpm nx build api --skip-nx-cache
  pnpm nx build core --skip-nx-cache
  VITE_BACKEND_LABEL=same-origin pnpm nx build portal --skip-nx-cache
)

for artifact in dist/api/main.js dist/apps/core/main.js dist/apps/portal/index.html; do
  [[ -s "$repo_root/$artifact" ]] || { echo "Build artifact missing: $artifact" >&2; exit 1; }
done

echo "Packaging committed source and built runtime artifacts for $release..."
git -C "$repo_root" archive --format=tar HEAD | tar -xf - -C "$staging"
# Exclude tracked workstation state and dependency-recovery artifacts from the release.
rm -rf "$staging/.idea" "$staging/apps/android/.idea" "$staging/apps/android/.kotlin"
find "$staging" -maxdepth 1 -name 'node_modules.broken-*' -exec rm -rf {} +
find "$staging" -type d \( -name .nx -o -name .kotlin -o -name __pycache__ \) -prune -exec rm -rf {} +
find "$staging" -type f \( -name '.env' -o -name '.env.*' -o -name '*.pyc' \) -delete
mkdir -p "$staging/dist/api" "$staging/dist/apps/core" "$staging/dist/apps/portal"
cp -a "$repo_root/dist/api/." "$staging/dist/api/"
cp -a "$repo_root/dist/apps/core/." "$staging/dist/apps/core/"
cp -a "$repo_root/dist/apps/portal/." "$staging/dist/apps/portal/"
tar -czf "$archive" -C "$staging" .

echo "Copying release to $target..."
ssh "$target" "mkdir -p '$remote_release'"
scp "$archive" "$target:/tmp/energrid-release-$release.tar.gz"
ssh "$target" "tar -xzf '/tmp/energrid-release-$release.tar.gz' -C '$remote_release' && rm -f '/tmp/energrid-release-$release.tar.gz'"
scp "$script_dir/deploy-pi-activate.sh" "$target:/tmp/energrid-activate-$release.sh"
ssh "$target" "chmod 0755 '/tmp/energrid-activate-$release.sh' && cd '$remote_release' && pnpm install --frozen-lockfile"

echo "Ready to activate $release. Enter the Pi sudo password at the next prompt."
ssh -t "$target" "sudo '/tmp/energrid-activate-$release.sh' '$release'"

echo "Deployment $release completed. Previous releases are retained for rollback."
