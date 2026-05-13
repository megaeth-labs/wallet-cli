#!/usr/bin/env bash
set -euo pipefail

prefix="${MEGA_WALLET_CLI_PREFIX:-$HOME/.local}"
install_root="${MEGA_WALLET_CLI_HOME:-$HOME/.mega/wallet-cli}"
bin_dir="${MEGA_WALLET_CLI_BIN_DIR:-$prefix/bin}"
config_dir_overridden=0
if [ "${MEGA_WALLET_CLI_CONFIG_DIR:-}" ]; then
  config_dir="$MEGA_WALLET_CLI_CONFIG_DIR"
else
  case "$(uname -s)" in
    Darwin)
      config_dir="$HOME/Library/Application Support/megaeth/wallet-cli"
      ;;
    *)
      config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/megaeth/wallet-cli"
      ;;
  esac
fi
legacy_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/mega-wallet-cli"
codex_home="${CODEX_HOME:-$HOME/.codex}"
claude_home="${CLAUDE_HOME:-$HOME/.claude}"
skill_name="mega-wallet-cli"
agents="all"
remove_config=0
force=0
dry_run=0

usage() {
  cat <<'USAGE'
Usage: scripts/uninstall.sh [options]

Remove a local MegaETH Wallet CLI developer install.

Options:
  --prefix DIR             Prefix used when --bin-dir is omitted (default: ~/.local)
  --bin-dir DIR            Directory containing mega/wallet wrappers (default: <prefix>/bin)
  --install-root DIR       Versioned install root to remove (default: ~/.mega/wallet-cli)
  --agent codex|claude|all|none
                           Agent skill directory to remove (default: all)
  --codex-home DIR         Codex home directory (default: $CODEX_HOME or ~/.codex)
  --claude-home DIR        Claude home directory (default: $CLAUDE_HOME or ~/.claude)
  --name NAME              Skill directory name (default: mega-wallet-cli)
  --config                 Also remove wallet CLI config/profile state
  --config-dir DIR         Config dir for --config (default matches the CLI's platform
                           config root, e.g. ~/Library/Application Support/megaeth/wallet-cli on macOS)
  --force                  Remove mega/wallet wrappers even if they do not look repo-owned
  --dry-run                Print actions without removing files
  -h, --help               Show this help

Examples:
  scripts/uninstall.sh --config
  scripts/uninstall.sh --agent codex --dry-run
  scripts/uninstall.sh --bin-dir "$HOME/bin" --install-root "$HOME/.mega/wallet-cli"
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    --prefix)
      prefix="${2:?missing value for --prefix}"
      bin_dir="$prefix/bin"
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
    --agent)
      agents="${2:?missing value for --agent}"
      shift 2
      ;;
    --codex-home)
      codex_home="${2:?missing value for --codex-home}"
      shift 2
      ;;
    --claude-home)
      claude_home="${2:?missing value for --claude-home}"
      shift 2
      ;;
    --name)
      skill_name="${2:?missing value for --name}"
      shift 2
      ;;
    --config)
      remove_config=1
      shift
      ;;
    --config-dir)
      config_dir="${2:?missing value for --config-dir}"
      config_dir_overridden=1
      shift 2
      ;;
    --force)
      force=1
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

case "$skill_name" in
  *[!a-z0-9-]*|"")
    echo "skill name must contain only lowercase letters, digits, and hyphens" >&2
    exit 2
    ;;
esac

remove_path() {
  path="$1"
  label="$2"

  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    echo "skip missing $label: $path"
    return
  fi

  if [ "$dry_run" -eq 1 ]; then
    echo "would remove $label: $path"
    return
  fi

  rm -rf "$path"
  echo "removed $label: $path"
}

wrapper_is_owned() {
  wrapper="$1"

  if [ ! -f "$wrapper" ]; then
    return 1
  fi

  grep -Fq "$install_root/current/dist/" "$wrapper"
}

remove_wrapper() {
  name="$1"
  wrapper="$bin_dir/$name"

  if [ ! -e "$wrapper" ] && [ ! -L "$wrapper" ]; then
    echo "skip missing wrapper: $wrapper"
    return
  fi

  if [ "$force" -eq 1 ] || wrapper_is_owned "$wrapper"; then
    remove_path "$wrapper" "wrapper"
    return
  fi

  echo "skip non-owned wrapper: $wrapper (use --force to remove)" >&2
}

remove_skill() {
  agent="$1"
  home_dir="$2"

  remove_path "$home_dir/skills/$skill_name" "$agent skill"
}

remove_wrapper "mega"
remove_wrapper "wallet"
remove_path "$install_root" "install root"

case "$agents" in
  codex)
    remove_skill "codex" "$codex_home"
    ;;
  claude)
    remove_skill "claude" "$claude_home"
    ;;
  all)
    remove_skill "codex" "$codex_home"
    remove_skill "claude" "$claude_home"
    ;;
  none)
    ;;
  *)
    echo "unsupported --agent value: $agents" >&2
    echo "expected one of: codex, claude, all, none" >&2
    exit 2
    ;;
esac

if [ "$remove_config" -eq 1 ]; then
  remove_path "$config_dir" "config"
  if [ "$config_dir_overridden" -eq 0 ] && [ "$legacy_config_dir" != "$config_dir" ]; then
    remove_path "$legacy_config_dir" "legacy config"
  fi
else
  echo "kept config: $config_dir (pass --config to remove wallet profiles)"
fi
