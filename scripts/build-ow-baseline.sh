#!/bin/bash
# Build a historical `ow` binary from a commit for the parity gate (offline:
# git archive + bun build, no network). Prints the binary path on stdout.
# Usage: scripts/build-ow-baseline.sh [commit]   (default: the parity pin)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT="${1:-73d6f75}"
DEST="${TMPDIR:-/tmp}/ow-baseline-$COMMIT"
mkdir -p "$DEST"
git -C "$ROOT" archive "$COMMIT" | tar -x -C "$DEST"
bun build --compile "$DEST/cli/cli.ts" --outfile "$DEST/ow" >/dev/null
echo "$DEST/ow"
