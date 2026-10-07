#!/bin/bash
# Report whether product-built cli/ow matches current cli/ sources.
# Exit 0 `taze`, 1 stale, 2 missing sidecar/binary. Rebuild: `pnpm ow:build`.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
if [ ! -x cli/ow ] || [ ! -f cli/ow.build.json ]; then
  echo "derleme bilgisi yok — pnpm ow:build çalıştırın"
  exit 2
fi
if python3 - "$ROOT" <<'EOF' 2>/dev/null; then
import json, subprocess, sys
root = sys.argv[1]
try:
    side = json.load(open(f"{root}/cli/ow.build.json"))
except Exception:
    sys.exit(1)
def digest():
    import subprocess
    files = subprocess.run(["find", "cli", "scripts/build-ow.sh", "-type", "f"],
                           capture_output=True, text=True, cwd=root).stdout.split()
    files = sorted(f for f in files if f.endswith(".ts") or f.endswith("build-ow.sh"))
    if not files:
        return None
    out = subprocess.run(["git", "hash-object", *files],
                         capture_output=True, text=True, cwd=root).stdout.split()
    return "|".join(out) if out else None
head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=root).stdout.strip()
current = digest()
if current is None:
    sys.exit(1)
saved = side.get("digest")
if saved is None:
    # legacy sidecar without digest: fall back to sha+dirty comparison once
    porc = subprocess.run(["git", "status", "--porcelain", "--", "cli/", "scripts/build-ow.sh"],
                          capture_output=True, text=True, cwd=root).stdout
    dirty = len(porc.strip()) > 0
    sys.exit(0 if (side.get("sha") == head and side.get("dirty") == dirty) else 1)
sys.exit(0 if saved == current else 1)
EOF
  echo "taze"
  exit 0
else
  echo "bayat (kaynaklar değişti, yeniden derleyin)"
  exit 1
fi
