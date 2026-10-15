#!/bin/bash
# Byte-identical gate for the `ow` CLI migration: replays deterministic cases
# against two binaries and diffs. Any difference → unified diff + exit 1.
# Usage: scripts/check-ow-parity.sh <old-ow> <new-ow>
# (`doctor` is compared by envelope keys + exit code only — ages/sizes vary.)
# Observer-only: supervision was retired (compose owns runtime), so the
# gate replays `--help`, `sessions --json` and `doctor --json` only.
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

# Window normalization: additive `"window":null` is asserted on the new
# binary, stripped on both sides so the diff still guards every byte.
strip_window() {
  sed -e 's/,"window":null//' -e 's/"window":null,//'
}

run_case_window_json() {
  local name="$1"
  shift
  "$OLD" "$@" >"$OUT/$name.old.out" 2>"$OUT/$name.old.err"
  local old_code=$?
  "$NEW" "$@" >"$OUT/$name.new.out" 2>"$OUT/$name.new.err"
  local new_code=$?
  echo "$old_code" >"$OUT/$name.old.code"
  echo "$new_code" >"$OUT/$name.new.code"
  if ! grep -qF '"window":null' "$OUT/$name.new.out"; then
    echo "PARITY FAIL(window key missing on new): $name"
    fail=1
  fi
  if ! diff -u <(strip_window <"$OUT/$name.old.out") <(strip_window <"$OUT/$name.new.out"); then
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
run_case_window_json sessions sessions --json --log "$FIX/shell-events.jsonl"

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
    return [f"top={sorted(k for k in d.keys() if k != 'identity')}", f"names={names}", f"checkkeys={sub}"]
def ident(path):
    try:
        d = json.load(open(path))
    except Exception:
        return ["<unparseable>"]
    i = d.get("identity")
    if i is None:
        return ["identity=<absent>"]
    inst = i.get("installed")
    sup = i.get("supervisor", {})
    return [
        "identity=present",
        f"installed={sorted(inst.keys()) if isinstance(inst, dict) else None}",
        f"supervisor={sorted(sup.keys()) if isinstance(sup, dict) else None}",
        f"matchkey={'match' in i}",
    ]
open(f"{out}/doctor.old.keys", "w").write("\n".join(keys(f"{out}/doctor.old.out")) + "\n")
open(f"{out}/doctor.new.keys", "w").write("\n".join(keys(f"{out}/doctor.new.out")) + "\n")
open(f"{out}/doctor.old.ident", "w").write("\n".join(ident(f"{out}/doctor.old.out")) + "\n")
open(f"{out}/doctor.new.ident", "w").write("\n".join(ident(f"{out}/doctor.new.out")) + "\n")
EOF
if ! diff -u "$OUT/doctor.old.keys" "$OUT/doctor.new.keys"; then
  echo "PARITY FAIL(keys): doctor"
  fail=1
fi
for expected in "identity=present" "supervisor=['sha8', 'startedAt', 'state', 'time']" "matchkey=True"; do
  if ! grep -qxF "$expected" "$OUT/doctor.new.ident"; then
    echo "PARITY FAIL(identity keys): $expected"
    fail=1
  fi
done
if ! grep -qxE "installed=(None|\['binary8', 'dirty', 'sha8', 'time'\])" "$OUT/doctor.new.ident"; then
  echo "PARITY FAIL(identity keys): installed shape"
  fail=1
fi
if [ "$old_code" != "$new_code" ]; then
  echo "PARITY FAIL(exit $old_code vs $new_code): doctor"
  fail=1
fi

# Retired supervision verbs refuse on the new binary (exit 2).
for verb in up restart down reconcile ps logs init render where; do
  if "$NEW" "$verb" >"$OUT/retired-$verb.out" 2>"$OUT/retired-$verb.err"; then
    echo "PARITY FAIL(retired verb exits 0): $verb"
    fail=1
  fi
  code=$?
  if [ "$code" != "2" ]; then
    echo "PARITY FAIL(retired verb exit $code, want 2): $verb"
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "parity OK"
fi
exit "$fail"
