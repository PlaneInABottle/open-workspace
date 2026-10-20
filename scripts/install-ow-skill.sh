#!/usr/bin/env bash
# Install the authored ow skill (skills/ow/SKILL.md) as the user-global skill.
# Usage: scripts/install-ow-skill.sh [--check]   (--check: exit 1 if stale)
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)/skills/ow/SKILL.md"
dest="${OW_SKILL_DEST:-$HOME/.agents/skills/ow/SKILL.md}"
if [ "${1:-}" = "--check" ]; then
  cmp -s "$src" "$dest" && echo "current: $dest" || { echo "stale or missing: $dest (run pnpm ow:skill-install)"; exit 1; }
  exit 0
fi
mkdir -p "$(dirname "$dest")"
cp "$src" "$dest"
cmp -s "$src" "$dest" && echo "installed: $dest"
