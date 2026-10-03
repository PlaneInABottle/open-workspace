#!/bin/sh
# Guided installer for the agent-browser observer shim.
#
# Coverage honesty: the shim observes ONLY calls passing through it. An
# absolute-binary invocation, another PATH entry winning, or any alternate
# launch path bypasses it, and an empty log proves nothing. Install ends
# with a harmless probe (--version through the installed shim) that asserts
# one call WAS observed; --verify separately reports PATH activation.
#
# The installer NEVER edits shell rc files. PATH activation is either a
# project-scoped env export (preferred for this experiment) or an explicit
# manual step whose exact line is printed for review. Rollback is the
# reverse: drop the PATH entry and optionally --uninstall the shim file.
#
# Usage: install-browser-shim.sh [--prefix DIR] [--real PATH] [--yes]
#                                   [--verify] [--uninstall] [--help]

set -u

ow_me=$(basename "$0" 2>/dev/null || printf 'install-browser-shim.sh')
ow_script_dir=$(dirname -- "$0" 2>/dev/null || printf '.')
case "$ow_script_dir" in /*) ;; *) ow_script_dir="$PWD/$ow_script_dir" ;; esac
ow_template="$ow_script_dir/agent-browser-shim.sh"
ow_prefix="${OPENWORKSPACE_HOME:-${HOME:-/nonexistent}}"
ow_real_override=""
ow_yes=0
ow_mode="install"

ow_usage() {
  cat <<OW_USAGE
Usage: $ow_me [--prefix DIR] [--real PATH] [--yes] [--verify] [--uninstall]

install (default): pin the real agent-browser binary and write the observer
  shim to DIR/bin/agent-browser (DIR defaults to OPENWORKSPACE_HOME or
  ~/.local/share/openworkspace). Prints a PATH line for manual,
  project-scoped activation; never edits shell rc files. Ends with a probe
  asserting one call was observed in the owned log.
--verify: report shim presence, pinned-identity health, version match, and
  whether the shim is active on PATH (inactive: CLI still works,
  observation off).
--uninstall: remove the installed shim + sidecar (log files are kept).
--real PATH: name the real binary explicitly (default: first on PATH).
--prefix DIR: owned install root. --yes: skip the consent prompt.
--force: overwrite an existing non-shim file at the target (install only).
Rollback: drop the PATH entry, then '$ow_me --uninstall'.
OW_USAGE
}

for _arg in "$@"; do
  case "$_arg" in
    --prefix) ow_want_prefix=1 ;;
    --real) ow_want_real=1 ;;
    --yes) ow_yes=1 ;;
    --force) ow_force=1 ;;
    --verify) ow_mode="verify" ;;
    --uninstall) ow_mode="uninstall" ;;
    --help|-h) ow_usage; exit 0 ;;
    -*)
      printf '%s: unknown flag %s\n' "$ow_me" "$_arg" >&2; ow_usage >&2; exit 2 ;;
    *)
      if [ "${ow_want_prefix:-0}" -eq 1 ]; then ow_prefix="$_arg"; ow_want_prefix=0;
      elif [ "${ow_want_real:-0}" -eq 1 ]; then ow_real_override="$_arg"; ow_want_real=0;
      else printf '%s: unexpected arg %s\n' "$ow_me" "$_arg" >&2; ow_usage >&2; exit 2; fi
      ;;
  esac
done

ow_bin="$ow_prefix/bin"
ow_target="$ow_bin/agent-browser"
ow_sidecar="$ow_bin/.agent-browser-shim.json"
ow_logdir="${OW_BROWSER_SHIM_LOG_DIR:-$ow_prefix/browser-shim-logs}"
ow_logfile="$ow_logdir/agent-browser-observations.jsonl"

ow_resolve() {
  _p=$(command -v "$1" 2>/dev/null) || return 1
  if command -v realpath >/dev/null 2>&1; then
    realpath "$_p" 2>/dev/null || printf '%s' "$_p"
  elif command -v readlink >/dev/null 2>&1 && readlink -f "$_p" >/dev/null 2>&1; then
    readlink -f "$_p"
  else
    printf '%s' "$_p"
  fi
  return 0
}

ow_stat_owner_perms() {
  _st=$(stat -f '%Su %Lp' "$1" 2>/dev/null) || _st=$(stat -c '%U %a' "$1" 2>/dev/null) || return 1
  printf '%s' "$_st"
  return 0
}

ow_json_quote() {
  printf '%s' "$1" | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' \
    | LC_ALL=C sed -e 's/\\/&&/g' -e 's/"/\\"/g'
}

ow_sidecar_field() {
  LC_ALL=C sed -n -e "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -n 1
}

ow_do_verify() {
  _rc=0
  if [ -x "$ow_target" ] && grep -q 'OW_AGENT_BROWSER_OBSERVER_SHIM_V1' "$ow_target" 2>/dev/null; then
    printf 'shim: present at %s\n' "$ow_target"
  else
    printf 'shim: MISSING at %s (run install first)\n' "$ow_target"
    return 1
  fi
  _real=""; _pinned=""
  if [ -f "$ow_sidecar" ]; then
    _real=$(ow_sidecar_field "$ow_sidecar" real) || _real=""
    _pinned=$(ow_sidecar_field "$ow_sidecar" pinnedVersion) || _pinned=""
  fi
  if [ -z "$_real" ]; then
    printf 'identity: sidecar missing, cannot check pin\n'
    _rc=1
  elif [ ! -x "$_real" ]; then
    printf 'identity: pinned %s MISSING (shim will fail loudly, no PATH fallback)\n' "$_real"
    _rc=1
  else
    printf 'identity: pinned %s executable\n' "$_real"
  fi
  if [ -n "$_real" ] && [ -n "$_pinned" ]; then
    _cur=$("$_real" --version 2>/dev/null | head -c 256 | head -n 1 | LC_ALL=C tr -d '\r') || _cur=""
    if [ "$_cur" = "$_pinned" ]; then
      printf 'version: match (%s)\n' "$_pinned"
    else
      printf 'version: MISMATCH pinned=%s observed=%s (re-run install to re-pin)\n' "$_pinned" "$_cur"
      _rc=1
    fi
  fi
  _active=$(ow_resolve agent-browser 2>/dev/null) || _active=""
  if [ "$_active" = "$ow_target" ]; then
    printf 'path: ACTIVE (calls resolve through the shim)\n'
  else
    printf 'path: inactive (CLI still works, observation off; prepend %s to PATH project-wide or manually)\n' "$ow_bin"
  fi
  return "$_rc"
}

if [ "$ow_mode" = "verify" ]; then ow_do_verify; exit $?; fi

if [ "$ow_mode" = "uninstall" ]; then
  rm -f "$ow_target" "$ow_sidecar" 2>/dev/null || { printf '%s: uninstall failed\n' "$ow_me" >&2; exit 1; }
  printf 'uninstalled shim + sidecar (logs kept at %s). Drop %s from PATH to finish rollback.\n' "$ow_logdir" "$ow_bin"
  exit 0
fi

# ---- install ----
if [ ! -f "$ow_template" ]; then
  printf '%s: template missing: %s\n' "$ow_me" "$ow_template" >&2; exit 1
fi
if [ -n "$ow_real_override" ]; then
  ow_real="$ow_real_override"
else
  ow_real=$(ow_resolve agent-browser) || { printf '%s: agent-browser not on PATH (use --real PATH)\n' "$ow_me" >&2; exit 1; }
fi
case "$ow_real" in /*) ;; *) ow_real="$PWD/$ow_real" ;; esac
if [ ! -f "$ow_real" ] || [ ! -x "$ow_real" ]; then
  printf '%s: real binary not executable: %s\n' "$ow_me" "$ow_real" >&2; exit 1
fi
if grep -q 'OW_AGENT_BROWSER_OBSERVER_SHIM_V1' "$ow_real" 2>/dev/null; then
  printf '%s: refusing: %s is already the shim (loop). Use --real to name the actual CLI.\n' "$ow_me" "$ow_real" >&2; exit 1
fi
_st=$(ow_stat_owner_perms "$ow_real") || { printf '%s: cannot stat %s\n' "$ow_me" "$ow_real" >&2; exit 1; }
ow_owner=${_st%% *}; ow_perms=${_st##* }
ow_last=$(printf '%s' "$ow_perms" | LC_ALL=C sed 's/.*\(.\)$/\1/') || ow_last=""
case "$ow_last" in 2|3|6|7)
  printf '%s: refusing: %s is world-writable (perm %s)\n' "$ow_me" "$ow_real" "$ow_perms" >&2; exit 1 ;;
esac
ow_version=$("$ow_real" --version 2>/dev/null | head -c 256 | head -n 1 | LC_ALL=C tr -d '\r') || ow_version=""
if [ -z "$ow_version" ]; then
  printf '%s: refusing: could not read --version from %s\n' "$ow_me" "$ow_real" >&2; exit 1
fi
if [ -e "$ow_target" ] && ! grep -q 'OW_AGENT_BROWSER_OBSERVER_SHIM_V1' "$ow_target" 2>/dev/null; then
  if [ "${ow_force:-0}" -ne 1 ]; then
    printf '%s: refusing: %s exists and is not a shim (pass --force to overwrite)\n' "$ow_me" "$ow_target" >&2
    exit 1
  fi
  printf 'Forced: overwriting non-shim %s\n' "$ow_target"
fi

printf 'Preview (nothing written yet):\n'
printf '  real binary : %s (owner %s, perm %s)\n' "$ow_real" "$ow_owner" "$ow_perms"
printf '  pinned ver  : %s\n' "$ow_version"
printf '  shim target : %s\n' "$ow_target"
printf '  log dir     : %s (0600 JSONL, 1MiB/1000-line ring; captures 256KiB/100-line)\n' "$ow_logdir"
printf '  PATH step   : export PATH="%s:$PATH"  # project-scoped, your call; rc files untouched\n' "$ow_bin"
printf '  behavior    : metadata-only log; browser calls unchanged; identity failure = loud, no PATH fallback\n'

if [ "$ow_yes" -eq 0 ]; then
  if [ ! -t 0 ]; then
    printf '%s: non-interactive without --yes; refusing to proceed.\n' "$ow_me" >&2; exit 2
  fi
  printf 'Proceed? [y/N] '
  read -r ow_ans < /dev/tty 2>/dev/null || read -r ow_ans
  case "$ow_ans" in y|Y|yes|YES) ;; *)
    printf 'Aborted (nothing written).\n'; exit 0 ;;
  esac
fi

mkdir -p "$ow_bin" 2>/dev/null || { printf '%s: cannot create %s\n' "$ow_me" "$ow_bin" >&2; exit 1; }
_esc_real=$(printf '%s' "$ow_real" | LC_ALL=C sed 's/[\\&]/\\&/g')
_esc_ver=$(printf '%s' "$ow_version" | LC_ALL=C sed 's/[\\&]/\\&/g')
_esc_owner=$(printf '%s' "$ow_owner" | LC_ALL=C sed 's/[\\&]/\\&/g')
OW_R="$_esc_real" OW_V="$_esc_ver" OW_O="$_esc_owner" LC_ALL=C awk '{ gsub(/__OW_SHIM_REAL_BIN__/, ENVIRON["OW_R"]); gsub(/__OW_SHIM_PINNED_VERSION__/, ENVIRON["OW_V"]); gsub(/__OW_SHIM_REAL_OWNER__/, ENVIRON["OW_O"]); print }' "$ow_template" >"$ow_target" \
  || { printf '%s: failed to render shim\n' "$ow_me" >&2; exit 1; }
chmod 755 "$ow_target"
ow_now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown')
printf '{"real":"%s","pinnedVersion":"%s","owner":"%s","installedAt":"%s"}\n' \
  "$(ow_json_quote "$ow_real")" "$(ow_json_quote "$ow_version")" "$(ow_json_quote "$ow_owner")" "$ow_now" >"$ow_sidecar" \
  || { printf '%s: failed to write sidecar\n' "$ow_me" >&2; exit 1; }
chmod 600 "$ow_sidecar"

# Harmless end-of-setup probe: one real call through the shim that MUST show
# up in the owned log, proving observation works (not proving PATH order).
ow_probe="shim-probe-$$-$(date +%s 2>/dev/null || printf 'x')"
OPENWORKSPACE_SESSION="$ow_probe" OW_BROWSER_SHIM_LOG_DIR="$ow_logdir" "$ow_target" --version >/dev/null 2>&1
ow_probe_rc=$?
if [ "$ow_probe_rc" -ne 0 ]; then
  printf '%s: PROBE FAILED (rc=%s): shim could not run the pinned binary. Reinstall or roll back.\n' "$ow_me" "$ow_probe_rc" >&2; exit 1
fi
if grep -q "$ow_probe" "$ow_logfile" 2>/dev/null; then
  printf 'probe: observed via shim (marker %s in log)\n' "$ow_probe"
else
  printf '%s: PROBE FAILED: call ran but no entry reached %s (bypassed or unwritable log?). Investigate before relying on observations.\n' "$ow_me" "$ow_logfile" >&2; exit 1
fi

printf 'Installed. Activate per-project: export PATH="%s:$PATH"\n' "$ow_bin"
printf 'Verify anytime: %s --verify (inactive PATH: CLI works, observation off).\n' "$0"
exit 0
