#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${MEGA_WALLET_CLI_PREFIX:-$HOME/.local}"
install_root="${MEGA_WALLET_CLI_HOME:-$HOME/.mega/wallet-cli}"
bin_dir="${MEGA_WALLET_CLI_BIN_DIR:-$prefix/bin}"
build=1
dry_run=0
with_skill=1
skill_agent="all"
force_skill=0
assume_yes=0
default_wallet_url="${MEGA_WALLET_CLI_DEFAULT_WALLET_URL:-}"
required_node_major=22
package_manager="$(grep -E '"packageManager":' "$repo_root/package.json" | head -n 1 | sed -E 's/.*"packageManager":[[:space:]]*"([^"]+)".*/\1/')"
pnpm_package="pnpm@10.23.0"
case "$package_manager" in
  pnpm@*) pnpm_package="$package_manager" ;;
esac
pnpm_version="${pnpm_package#pnpm@}"

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [options]

Build and install the MegaETH Wallet CLI from this checkout.

Options:
  --prefix DIR             Prefix used when --bin-dir is omitted (default: ~/.local)
  --bin-dir DIR            Directory for the mega wrapper (default: <prefix>/bin)
  --install-root DIR       Versioned install root (default: ~/.mega/wallet-cli)
  --skip-build             Reuse existing dist/ instead of running pnpm install/build
  --no-skill               Skip installing the agent skill from SKILL.md
  --skill-agent AGENT      Skill target: codex, claude, or all (default: all)
  --force-skill            Replace existing installed skill when it differs
  --default-wallet-url URL Bake a wallet URL override into the installed wrapper (default: none)
  -y, --yes                Install missing prerequisites without prompting
  --dry-run                Print actions without writing files or running builds
  -h, --help               Show this help

Examples:
  scripts/install.sh
  scripts/install.sh --skill-agent all
  scripts/install.sh --bin-dir "$HOME/bin" --install-root "$HOME/.mega/wallet-cli"
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
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
    --no-skill)
      with_skill=0
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
    --default-wallet-url)
      default_wallet_url="${2:?missing value for --default-wallet-url}"
      shift 2
      ;;
    -y|--yes)
      assume_yes=1
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

if [ -n "$default_wallet_url" ]; then
  case "$default_wallet_url" in
    http://*|https://*) ;;
    *)
      echo "--default-wallet-url must be an HTTP(S) URL" >&2
      exit 2
      ;;
  esac
fi

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

confirm_install() {
  prompt="$1"

  if [ "$dry_run" -eq 1 ]; then
    echo "would prompt: $prompt"
    return 0
  fi

  if [ "$assume_yes" -eq 1 ]; then
    return 0
  fi

  if [ ! -t 0 ]; then
    echo "$prompt" >&2
    echo "not running interactively; rerun with --yes to install missing prerequisites" >&2
    return 1
  fi

  printf '%s [y/N] ' "$prompt" >&2
  read -r answer
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

node_major_version() {
  node -p "Number(process.versions.node.split('.')[0])"
}

install_node_with_brew() {
  reason="$1"

  if ! command -v brew >/dev/null 2>&1; then
    echo "$reason" >&2
    echo "no supported automatic Node.js installer found; install Node.js >= $required_node_major and rerun" >&2
    exit 1
  fi

  if ! confirm_install "$reason Install or upgrade Node.js with Homebrew now?"; then
    echo "Node.js >= $required_node_major is required" >&2
    exit 1
  fi

  run brew install node || run brew upgrade node

  if [ "$dry_run" -eq 1 ]; then
    return
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js install completed, but node is still not on PATH" >&2
    exit 1
  fi
}

ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    install_node_with_brew "Node.js >= $required_node_major is missing."
    return
  fi

  current_major="$(node_major_version)"
  if [ "$current_major" -lt "$required_node_major" ]; then
    install_node_with_brew "Node.js >= $required_node_major is required; found major version $current_major."
  fi
}

detect_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm_cmd=(pnpm)
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    if ! confirm_install "pnpm is not installed. Activate $pnpm_package with Corepack now?"; then
      echo "pnpm is required; install pnpm or rerun and approve Corepack activation" >&2
      exit 1
    fi
    run corepack enable
    run corepack prepare "$pnpm_package" --activate

    if command -v pnpm >/dev/null 2>&1; then
      pnpm_cmd=(pnpm)
      return
    fi

    pnpm_cmd=(corepack pnpm)
    return
  fi

  if command -v npm >/dev/null 2>&1; then
    if ! confirm_install "pnpm is not installed. Install pnpm@$pnpm_version globally with npm now?"; then
      echo "pnpm is required" >&2
      exit 1
    fi
    run npm install -g "pnpm@$pnpm_version"
    if [ "$dry_run" -ne 1 ] && ! command -v pnpm >/dev/null 2>&1; then
      echo "pnpm install completed, but pnpm is still not on PATH" >&2
      exit 1
    fi
    pnpm_cmd=(pnpm)
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    if ! confirm_install "pnpm is not installed. Install pnpm with Homebrew now?"; then
      echo "pnpm is required" >&2
      exit 1
    fi
    run brew install pnpm
    if [ "$dry_run" -ne 1 ] && ! command -v pnpm >/dev/null 2>&1; then
      echo "pnpm install completed, but pnpm is still not on PATH" >&2
      exit 1
    fi
    pnpm_cmd=(pnpm)
    return
  fi

  echo "pnpm is missing and no supported automatic installer was found" >&2
  echo "install pnpm@$pnpm_version or enable Corepack, then rerun" >&2
  exit 1
}

wrapper_is_owned() {
  wrapper="$1"

  if [ ! -f "$wrapper" ]; then
    return 1
  fi

  grep -Fq "$install_root/current/dist/" "$wrapper"
}

remove_legacy_wallet_wrapper() {
  target="$bin_dir/wallet"

  if [ "$dry_run" -eq 1 ]; then
    echo "would remove legacy wallet wrapper if repo-owned: $target"
    return
  fi

  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    return
  fi

  if wrapper_is_owned "$target"; then
    rm -f "$target"
  else
    echo "skip non-owned legacy wallet wrapper: $target" >&2
  fi
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
    if [ -n "$default_wallet_url" ]; then
      printf 'export MEGA_WALLET_CLI_WALLET_URL="${MEGA_WALLET_CLI_WALLET_URL:-%s}"\n' "$default_wallet_url"
    fi
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

ensure_node
detect_pnpm

if [ "$dry_run" -eq 0 ] && [ "$build" -eq 1 ]; then
  run "${pnpm_cmd[@]}" -C "$repo_root" install --frozen-lockfile
  run "${pnpm_cmd[@]}" -C "$repo_root" build
fi

if [ "$dry_run" -eq 0 ]; then
  if [ ! -f "$repo_root/dist/index.js" ]; then
    echo "dist/ is missing; run without --skip-build or run pnpm build first" >&2
    exit 1
  fi
fi

version="$(grep -E '"version":' "$repo_root/package.json" | head -n 1 | sed -E 's/.*"version":[[:space:]]*"([^"]+)".*/\1/')"
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
remove_legacy_wallet_wrapper

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
  if ! path_contains "$bin_dir"; then
    echo "add $bin_dir to PATH to run mega wallet commands without an absolute path"
  fi
fi
