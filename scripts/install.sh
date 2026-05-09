#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${MEGA_WALLET_CLI_PREFIX:-$HOME/.local}"
install_root="${MEGA_WALLET_CLI_HOME:-$HOME/.mega/wallet-cli}"
bin_dir="${MEGA_WALLET_CLI_BIN_DIR:-$prefix/bin}"
build=1
dry_run=0
with_skill=0
skill_agent="codex"
force_skill=0

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [options]

Build and install the MegaETH Wallet CLI from this checkout.

Options:
  --prefix DIR             Prefix used when --bin-dir is omitted (default: ~/.local)
  --bin-dir DIR            Directory for mega/wallet wrappers (default: <prefix>/bin)
  --install-root DIR       Versioned install root (default: ~/.mega/wallet-cli)
  --skip-build             Reuse existing dist/ instead of running pnpm install/build
  --with-skill             Also install the agent skill from SKILL.md
  --skill-agent AGENT      Skill target: codex, claude, or all (default: codex)
  --force-skill            Replace existing installed skill when --with-skill is used
  --dry-run                Print actions without writing files or running builds
  -h, --help               Show this help

Examples:
  scripts/install.sh
  scripts/install.sh --with-skill --skill-agent all
  scripts/install.sh --bin-dir "$HOME/bin" --install-root "$HOME/.mega/wallet-cli"
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      prefix="${2:?missing value for --prefix}"
      shift 2
      ;;
    --bin-dir)
      bin_dir="${2:?missing value for --bin-dir}"
      shift 2
      ;;
    --install-root)
      install_root="${2:?missing value for --install-root}"
      shift 2
      ;;
    --skip-build)
      build=0
      shift
      ;;
    --with-skill)
      with_skill=1
      shift
      ;;
    --skill-agent)
      skill_agent="${2:?missing value for --skill-agent}"
      shift 2
      ;;
    --force-skill)
      force_skill=1
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

run() {
  if [ "$dry_run" -eq 1 ]; then
    printf '+'
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return
  fi

  "$@"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

detect_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm_cmd=(pnpm)
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    pnpm_cmd=(corepack pnpm)
    return
  fi

  echo "missing pnpm; install pnpm or enable corepack first" >&2
  exit 1
}

write_wrapper() {
  target="$1"
  entry="$2"

  if [ "$dry_run" -eq 1 ]; then
    echo "would write wrapper: $target -> $install_root/current/dist/$entry"
    return
  fi

  mkdir -p "$(dirname "$target")"
  {
    printf '#!/usr/bin/env sh\n'
    printf 'exec node "%s/current/dist/%s" "$@"\n' "$install_root" "$entry"
  } >"$target"
  chmod 0755 "$target"
}

path_contains() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

require_command node
detect_pnpm

if [ "$dry_run" -eq 0 ] && [ "$build" -eq 1 ]; then
  run "${pnpm_cmd[@]}" -C "$repo_root" install --frozen-lockfile
  run "${pnpm_cmd[@]}" -C "$repo_root" build
fi

if [ "$dry_run" -eq 0 ]; then
  if [ ! -f "$repo_root/dist/index.js" ] || [ ! -f "$repo_root/dist/wallet.js" ]; then
    echo "dist/ is missing; run without --skip-build or run pnpm build first" >&2
    exit 1
  fi
fi

version="$(cd "$repo_root" && node -p "require('./package.json').version")"
git_rev="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || true)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_id="$version"
if [ -n "$git_rev" ]; then
  release_id="$release_id-$git_rev"
fi
release_id="$release_id-$timestamp"

release_root="$install_root/releases"
release_dir="$release_root/$release_id"
staging_dir="$release_root/.tmp-$release_id-$$"

if [ "$dry_run" -eq 1 ]; then
  echo "would install release: $release_dir"
else
  rm -rf "$staging_dir"
  mkdir -p "$staging_dir/dist"
  cp "$repo_root/package.json" "$staging_dir/package.json"
  cp "$repo_root/pnpm-lock.yaml" "$staging_dir/pnpm-lock.yaml"
  cp -R "$repo_root/dist/." "$staging_dir/dist/"
  run "${pnpm_cmd[@]}" -C "$staging_dir" install --prod --frozen-lockfile
  rm -rf "$release_dir"
  mv "$staging_dir" "$release_dir"
  if [ -L "$install_root/current" ] || [ -f "$install_root/current" ]; then
    rm -f "$install_root/current"
  elif [ -d "$install_root/current" ]; then
    rm -rf "$install_root/current"
  fi
  ln -s "$release_dir" "$install_root/current"
fi

write_wrapper "$bin_dir/mega" "index.js"
write_wrapper "$bin_dir/wallet" "wallet.js"

if [ "$with_skill" -eq 1 ]; then
  skill_args=(--agent "$skill_agent")
  if [ "$force_skill" -eq 1 ]; then
    skill_args+=(--force)
  fi
  if [ "$dry_run" -eq 1 ]; then
    skill_args+=(--dry-run)
  fi
  if [ "$dry_run" -eq 1 ]; then
    "$repo_root/scripts/install-skill.sh" "${skill_args[@]}"
  else
    run "$repo_root/scripts/install-skill.sh" "${skill_args[@]}"
  fi
fi

if [ "$dry_run" -eq 0 ]; then
  echo "installed MegaETH Wallet CLI"
  echo "  release: $release_dir"
  echo "  mega:    $bin_dir/mega"
  echo "  wallet:  $bin_dir/wallet"
  if ! path_contains "$bin_dir"; then
    echo "add $bin_dir to PATH to run mega wallet commands without an absolute path"
  fi
fi
