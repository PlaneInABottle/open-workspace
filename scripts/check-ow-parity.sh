#!/bin/bash
# Byte-identical gate for the `ow` CLI migration: replays deterministic cases
# against two binaries and diffs. Any difference → unified diff + exit 1.
# Usage: scripts/check-ow-parity.sh <old-ow> <new-ow>
# (`doctor` is compared by envelope keys + exit code only — ages/sizes vary.)
set -u
OLD="${1:?usage: check-ow-parity.sh <old-ow> <new-ow>}"
NEW="${2:?usage: check-ow-parity.sh <old-ow> <new-ow>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/cli/parity-fixtures"
OUT="/tmp/ow-parity-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
echo "parity outputs: $OUT"
fail=0

run_case() {
  local name="$1"
  shift
  "$OLD" "$@" >"$OUT/$name.old.out" 2>"$OUT/$name.old.err"
  local old_code=$?
  "$NEW" "$@" >"$OUT/$name.new.out" 2>"$OUT/$name.new.err"
  local new_code=$?
  echo "$old_code" >"$OUT/$name.old.code"
  echo "$new_code" >"$OUT/$name.new.code"
  if ! diff -u "$OUT/$name.old.out" "$OUT/$name.new.out"; then
    echo "PARITY FAIL(stdout): $name"
    fail=1
  fi
  if ! diff -u "$OUT/$name.old.err" "$OUT/$name.new.err"; then
    echo "PARITY FAIL(stderr): $name"
    fail=1
  fi
  if [ "$old_code" != "$new_code" ]; then
    echo "PARITY FAIL(exit $old_code vs $new_code): $name"
    fail=1
  fi
}

run_case help --help
run_case check-good up --check --file "$FIX/ow-good.yaml"
run_case check-logsonly up --check --file "$FIX/ow-logs-only.yaml"
run_case ps-missing ps --file "$FIX/ow-good.yaml" --json
run_case logs-missing logs --file "$FIX/ow-good.yaml" --json
run_case sessions sessions --json --log "$FIX/shell-events.jsonl"

# doctor: envelope keys + exit code only (wall-clock fields vary by construction)
"$OLD" doctor --json >"$OUT/doctor.old.out" 2>/dev/null
old_code=$?
"$NEW" doctor --json >"$OUT/doctor.new.out" 2>/dev/null
new_code=$?
python3 - "$OUT" <<'EOF'
import json, sys
out = sys.argv[1]
def keys(path):
    try:
        d = json.load(open(path))
    except Exception:
        return ["<unparseable>"]
    names = sorted(c.get("name", "?") for c in d.get("checks", []))
    sub = sorted({k for c in d.get("checks", []) for k in c.keys()})
    return [f"top={sorted(d.keys())}", f"names={names}", f"checkkeys={sub}"]
open(f"{out}/doctor.old.keys", "w").write("\n".join(keys(f"{out}/doctor.old.out")) + "\n")
open(f"{out}/doctor.new.keys", "w").write("\n".join(keys(f"{out}/doctor.new.out")) + "\n")
EOF
if ! diff -u "$OUT/doctor.old.keys" "$OUT/doctor.new.keys"; then
  echo "PARITY FAIL(keys): doctor"
  fail=1
fi
if [ "$old_code" != "$new_code" ]; then
  echo "PARITY FAIL(exit $old_code vs $new_code): doctor"
  fail=1
fi

if [ "$fail" = 0 ]; then
  echo "parity OK"
fi
exit "$fail"
