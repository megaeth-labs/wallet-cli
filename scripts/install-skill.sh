#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skill_name="mega-wallet-cli"
agents="all"
force=0
dry_run=0
codex_home="${CODEX_HOME:-$HOME/.codex}"
claude_home="${CLAUDE_HOME:-$HOME/.claude}"

usage() {
  cat <<'USAGE'
Usage: scripts/install-skill.sh [options]

Install the MegaETH Wallet CLI agent skill from this checkout.

Options:
  --agent codex|claude|all  Agent skill directory to install into (default: all)
  --codex-home DIR          Codex home directory (default: $CODEX_HOME or ~/.codex)
  --claude-home DIR         Claude home directory (default: $CLAUDE_HOME or ~/.claude)
  --name NAME               Destination skill directory name (default: mega-wallet-cli)
  --force                   Replace an existing installed skill
  --dry-run                 Print actions without writing files
  -h, --help                Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
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

source_skill="$repo_root/SKILL.md"
source_references="$repo_root/references"
if [ ! -f "$source_skill" ]; then
  echo "missing source skill: $source_skill" >&2
  exit 1
fi

skill_is_up_to_date() {
  dest="$1"
  dest_skill="$dest/SKILL.md"

  if [ ! -f "$dest_skill" ] || ! cmp -s "$source_skill" "$dest_skill"; then
    return 1
  fi

  if [ -d "$source_references" ]; then
    [ -d "$dest/references" ] || return 1
    diff -qr "$source_references" "$dest/references" >/dev/null
    return $?
  fi

  [ ! -e "$dest/references" ]
}

copy_skill_files() {
  dest="$1"
  dest_skill="$dest/SKILL.md"

  mkdir -p "$dest"
  cp "$source_skill" "$dest_skill"
  chmod 0644 "$dest_skill"

  if [ -d "$source_references" ]; then
    rm -rf "$dest/references"
    mkdir -p "$dest/references"
    cp -R "$source_references/." "$dest/references/"
    find "$dest/references" -type d -exec chmod 0755 {} +
    find "$dest/references" -type f -exec chmod 0644 {} +
  fi
}

install_one() {
  agent="$1"
  home_dir="$2"
  dest="$home_dir/skills/$skill_name"

  if [ "$dry_run" -eq 1 ]; then
    echo "would install $agent skill: $repo_root -> $dest"
    return
  fi

  if [ -e "$dest" ] && [ "$force" -ne 1 ]; then
    if skill_is_up_to_date "$dest"; then
      echo "$agent skill already up to date: $dest"
      return
    fi
    echo "$agent skill already exists at $dest; rerun with --force to replace it" >&2
    exit 1
  fi

  if [ "$force" -eq 1 ]; then
    rm -rf "$dest"
  fi

  copy_skill_files "$dest"
  echo "installed $agent skill: $dest"
}

case "$agents" in
  codex)
    install_one "codex" "$codex_home"
    ;;
  claude)
    install_one "claude" "$claude_home"
    ;;
  all)
    install_one "codex" "$codex_home"
    install_one "claude" "$claude_home"
    ;;
  *)
    echo "unsupported --agent value: $agents" >&2
    echo "expected one of: codex, claude, all" >&2
    exit 2
    ;;
esac

if [ "$dry_run" -ne 1 ]; then
  echo "restart the target agent so it can load the updated skill"
fi
