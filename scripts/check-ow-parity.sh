#!/bin/bash
# Byte-identical gate for the `ow` CLI migration: replays deterministic cases
# against two binaries and diffs. Any difference → unified diff + exit 1.
# Usage: scripts/check-ow-parity.sh <old-ow> <new-ow>
# (`doctor` is compared by envelope keys + exit code only — ages/sizes vary.)
#
# M2 intended deltas (enumerated — everything else stays byte-identical):
# - `help` stdout: four lines changed by decision (asserted on the new
#   binary below, then normalized out of the diff): the `--since` line
#   (shared grammar, no false `default 1d`), the `failures` line (shared
#   `30m|3h|1d|1w` tokens), the `--boundaries` line (all eight readers),
#   the `--json` verb list (+`doctor`).
# - `sessions --json`: additive `"window":null` on the new binary
#   (unwindowed call) — asserted present, stripped on both sides.
# - `doctor --json`: top-level `identity` envelope (introduced in M2) —
#   asserted by key shape on BOTH binaries (HEAD contains the committed
#   identity work), stripped from the old-vs-new top-keys diff.
# - exits/stderr: unchanged everywhere (new notices are flag-gated and no
#   fixture passes those flags; `up --check` never announces state).
# V2 intended deltas (same pattern — assert on new, normalize the diff):
# - `help` stdout: the `scenarios` line and the `scenario run` line
#   (probe-only lanes point at `record` + `contract check`).
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

# M2 help normalization: the four intended lines are asserted on the new
# binary, then blanked on both sides so the diff still guards every byte.
# V2 adds the two probe-only scenario lines (same pattern).
normalize_help() {
  sed -e 's/--since  window:.*//' -e 's/^  failures \[--since.*//' -e 's/--boundaries <path>.*//' -e 's/--json  machine output.*//' -e 's/^  scenarios --check.*//' -e 's/^  scenario run <name>.*//'
}

run_case_help() {
  "$OLD" --help >"$OUT/help.old.out" 2>"$OUT/help.old.err"
  local old_code=$?
  "$NEW" --help >"$OUT/help.new.out" 2>"$OUT/help.new.err"
  local new_code=$?
  echo "$old_code" >"$OUT/help.old.code"
  echo "$new_code" >"$OUT/help.new.code"
  for line in \
    '--since  window: 30m|3h|1d|1w (sessions/show/stuck/reads/logs/failures/trace/timeline)' \
    'failures [--since 30m|3h|1d|1w]' \
    'scenario-run/scenario-env only' \
    '--json  machine output (English keys): doctor/show' \
    'scenarios --check [--file] [--json]  ow.scenarios.yaml v1 schema validation (no runs; probe-only lanes: record + contract check)' \
    'scenario run <name> [--file] [--json] [--run <id>] [--off-local]  narrowed deterministic run (5 phases, restore mandatory; probe-only lanes without restore: record + contract check)' \
  ; do
    if ! grep -qF -- "$line" "$OUT/help.new.out"; then
      echo "PARITY FAIL(help line missing on new): $line"
      fail=1
    fi
  done
  if ! diff -u <(normalize_help <"$OUT/help.old.out") <(normalize_help <"$OUT/help.new.out"); then
    echo "PARITY FAIL(stdout): help"
    fail=1
  fi
  if ! diff -u "$OUT/help.old.err" "$OUT/help.new.err"; then
    echo "PARITY FAIL(stderr): help"
    fail=1
  fi
  if [ "$old_code" != "$new_code" ]; then
    echo "PARITY FAIL(exit $old_code vs $new_code): help"
    fail=1
  fi
}

# M2 window normalization: additive `"window":null` is asserted on the new
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

run_case_help
run_case check-good up --check --file "$FIX/ow-good.yaml"
run_case check-logsonly up --check --file "$FIX/ow-logs-only.yaml"
run_case ps-missing ps --file "$FIX/ow-good.yaml" --json
run_case logs-missing logs --file "$FIX/ow-good.yaml" --json
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
    # M2: `identity` is compared by shape below, never in the top-keys diff.
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
# V2 reality: HEAD contains the committed M2 `identity` work, so the old
# binary carries it too — pin the same key shape on old (values vary by
# construction: no sidecar ships beside the scratch old binary, so its
# `installed` reads None by build method; both exact shapes accepted).
for expected in "identity=present" "supervisor=['sha8', 'startedAt', 'state', 'time']" "matchkey=True"; do
  if ! grep -qxF "$expected" "$OUT/doctor.old.ident"; then
    echo "PARITY FAIL(identity keys, old): $expected"
    fail=1
  fi
done
if ! grep -qxE "installed=(None|\['binary8', 'dirty', 'sha8', 'time'\])" "$OUT/doctor.old.ident"; then
  echo "PARITY FAIL(identity keys, old): installed shape"
  fail=1
fi
for expected in "identity=present" "installed=['binary8', 'dirty', 'sha8', 'time']" "supervisor=['sha8', 'startedAt', 'state', 'time']" "matchkey=True"; do
  if ! grep -qxF "$expected" "$OUT/doctor.new.ident"; then
    echo "PARITY FAIL(identity keys): $expected"
    fail=1
  fi
done
if [ "$old_code" != "$new_code" ]; then
  echo "PARITY FAIL(exit $old_code vs $new_code): doctor"
  fail=1
fi

if [ "$fail" = 0 ]; then
  echo "parity OK"
fi
exit "$fail"
