#!/bin/bash
# Build the `ow` CLI binary from product `cli/` sources (bun-only).
# Usage: scripts/build-ow.sh  (or `pnpm ow:build` from the repo root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
bun build --compile ./cli/cli.ts --outfile cli/ow
SHA="$(git rev-parse HEAD)"
DIGEST="$(find cli scripts/build-ow.sh -type f \( -name '*.ts' -o -name 'build-ow.sh' \) | sort | xargs git hash-object 2>/dev/null | paste -sd'|' -)"
DIRTY=false
if [ -n "$(git status --porcelain -- cli/ scripts/build-ow.sh)" ]; then
  DIRTY=true
fi
printf '{"sha":"%s","dirty":%s,"digest":"%s","time":"%s"}\n' "$SHA" "$DIRTY" "$DIGEST" "$(date -u +%FT%TZ)" > cli/ow.build.json
echo "built cli/ow ($SHA, dirty=$DIRTY)"
