#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo_root/artifacts"
version="${GITHUB_REF_NAME:-}"
build=1
dry_run=0
asset_prefix="mega-wallet-cli"

usage() {
  cat <<'USAGE'
Usage: scripts/package-release.sh [options]

Build a self-contained MegaETH MOSS CLI release tarball.

Options:
  --version VERSION       Release tag to package (default: v<package.json version>)
  --out-dir DIR           Directory for release assets (default: ./artifacts)
  --skip-build            Reuse existing dist/ instead of running pnpm install/build
  --dry-run               Print actions without writing files or running builds
  -h, --help              Show this help

Outputs:
  mega-wallet-cli-<VERSION>.tar.gz
  mega-wallet-cli-<VERSION>.tar.gz.sha256
  mega-wallet-cli-<VERSION>-install.sh
  mega-wallet-cli-<VERSION>-install.sh.sha256
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    --version)
      version="${2:?missing value for --version}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:?missing value for --out-dir}"
      shift 2
      ;;
    --skip-build)
      build=0
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$version" ]; then
  version="v$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version)" "$repo_root/package.json")"
fi

case "$version" in
  */*|"")
    echo "invalid release version: $version" >&2
    exit 2
    ;;
esac

release_name="$asset_prefix-$version"
archive_name="$release_name.tar.gz"
archive_path="$out_dir/$archive_name"
checksum_path="$archive_path.sha256"
installer_name="$release_name-install.sh"
installer_path="$out_dir/$installer_name"
installer_checksum_path="$installer_path.sha256"

if [ "$dry_run" -eq 1 ]; then
  echo "would package release: $release_name"
  echo "would include installer: scripts/install-release.sh"
  echo "would include script: scripts/uninstall.sh"
  echo "would write archive: $archive_path"
  echo "would write checksum: $checksum_path"
  echo "would write installer: $installer_path"
  echo "would write installer checksum: $installer_checksum_path"
  exit 0
fi

if [ "$build" -eq 1 ]; then
  pnpm -C "$repo_root" install --frozen-lockfile
  pnpm -C "$repo_root" build
fi

if [ ! -f "$repo_root/dist/index.js" ]; then
  echo "dist/ is missing; run without --skip-build or run pnpm build first" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
release_dir="$tmp_dir/$release_name"

mkdir -p "$release_dir/scripts"
cp "$repo_root/package.json" "$release_dir/package.json"
cp "$repo_root/pnpm-lock.yaml" "$release_dir/pnpm-lock.yaml"
cp "$repo_root/README.md" "$release_dir/README.md"
cp "$repo_root/SKILL.md" "$release_dir/SKILL.md"
cp "$repo_root/scripts/install-skill.sh" "$release_dir/scripts/install-skill.sh"
cp "$repo_root/scripts/uninstall.sh" "$release_dir/scripts/uninstall.sh"
cp -R "$repo_root/dist" "$release_dir/dist"
cp -R "$repo_root/references" "$release_dir/references"
chmod 0755 \
  "$release_dir/dist/index.js" \
  "$release_dir/scripts/install-skill.sh" \
  "$release_dir/scripts/uninstall.sh"

pnpm -C "$release_dir" install --prod --frozen-lockfile

mkdir -p "$out_dir"
rm -f "$archive_path" "$checksum_path" "$installer_path" "$installer_checksum_path"
tar -czf "$archive_path" -C "$tmp_dir" "$release_name"
cp "$repo_root/scripts/install-release.sh" "$installer_path"
chmod 0755 "$installer_path"

write_checksum() {
  file_path="$1"
  output_path="$2"
  file_name="$(basename "$file_path")"

  if command -v sha256sum >/dev/null 2>&1; then
    checksum="$(sha256sum "$file_path" | awk '{print $1}')"
  else
    checksum="$(shasum -a 256 "$file_path" | awk '{print $1}')"
  fi
  printf '%s  %s\n' "$checksum" "$file_name" >"$output_path"
}

write_checksum "$archive_path" "$checksum_path"
write_checksum "$installer_path" "$installer_checksum_path"

echo "packaged release archive: $archive_path"
echo "packaged release checksum: $checksum_path"
echo "packaged release installer: $installer_path"
echo "packaged release installer checksum: $installer_checksum_path"
