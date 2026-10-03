#!/bin/sh
# OpenWorkspace agent-browser observer shim (transparent passthrough).
#
# Installed as `agent-browser` into an owned bin dir that precedes the real
# CLI on PATH. Every invocation runs the real binary and appends one
# best-effort metadata line to an owned log for learning.
#
# DESIGN PRIORITIES (binding):
#   1. No sensitive data in the log, alongside no shell injection. The
#      default record is metadata ONLY: sanitized action name, flag names,
#      URL host, safe session identifier, duration, exit code. Fill/type and
#      all other positional VALUES are dropped by construction (never logged,
#      not even redacted). URL path/query/fragment never logged, host only.
#      Token-shape masking remains as an extra defense on the few
#      logged identifiers, documented as a non-guarantee.
#   2. Observer invisibility. The shim NEVER refuses or fails a browser call
#      for an observation problem (logging/drift-check failure): worst case
#      is a missing log line, never a broken invocation.
#   3. Program identity is NOT an observation problem. A missing, changed,
#      or owner/perm-bad pinned executable NEVER falls back to a PATH
#      alternative; the launch fails LOUDLY with a reinstall pointer.
#
# COVERAGE HONESTY: only calls passing through this shim are observed. An
# absolute-binary invocation, another PATH entry winning, a pre-opened
# process, or any alternate launch path bypasses it, and long-running call
# internals are invisible. An empty log proves nothing (browser unused OR
# shim bypassed). Setup ends with a probe that asserts one call WAS
# observed; the skill states the log is learning input, not proof.
#
# SUPERVISOR CHOICE (explicit): even metadata-only TTY mode does NOT
# exec-and-forget. The shim runs the child backgrounded without job control
# in the same process group with fully inherited fds (stdin, TTY behavior,
# and stdout/stderr separation are exactly the real binary's own) and waits
# to record exit code and duration. A literal exec could not observe
# anything; the supervisor adds no buffering and no fd rewriting, so
# behavior stays byte-identical while every call yields its metadata
# receipt. Waiting (not a foreground spawn) lets parent-targeted INT/TERM/
# HUP/QUIT interrupt into a forwarder, so a killed shim takes its browser
# child with it instead of orphaning it. Fatal signals are re-raised to
# self so parents observe signal death, not just 128+N. The caller's umask
# is restored around every spawn; the locked 077 applies to shim-owned log
# writes only, never to artifacts the real CLI creates.
#
# NON-BLOCKING LOG PATH: metadata mode never buffers child streams (they
# are inherited, so they drain however the caller consumes them). Opt-in
# capture mode lets the child write to temp files, never through the shim,
# so a slow log cannot fill a pipe and hang the child. Log appends are
# post-delivery and fast-fail guarded; on append failure the call is
# unaffected and a drop counter records the loss for the next good entry.
#
# Template placeholders __OW_SHIM_REAL_BIN__, __OW_SHIM_PINNED_VERSION__
# and __OW_SHIM_REAL_OWNER__ are baked by
# scripts/install-browser-shim.sh. Env overrides (tests/dev only):
# OW_AGENT_BROWSER_REAL, OW_SHIM_PINNED_VERSION, OW_BROWSER_SHIM_LOG_DIR.
# Per-task capture opt-in (default OFF): OW_BROWSER_SHIM_CAPTURE=1, only
# honored with batch/--json argv on a non-TTY; captures land in a separate
# short-retention file. OPENWORKSPACE_SESSION tags entries when set.
#
# Marker: OW_AGENT_BROWSER_OBSERVER_SHIM_V1

set -u
# The caller's umask is restored around every child spawn: shim-owned files
# get 0600/0700 via the locked umask below, but artifacts the real CLI
# creates (screenshots, PDFs, HARs) must keep the caller's modes.
ow_caller_umask=$(umask 2>/dev/null) || ow_caller_umask="022"
case "$ow_caller_umask" in [0-7][0-7][0-7]*) ;; *) ow_caller_umask="022" ;; esac
umask 077
ow_child=""
ow_got_sig=""

ow_real="${OW_AGENT_BROWSER_REAL:-__OW_SHIM_REAL_BIN__}"
ow_pinned="${OW_SHIM_PINNED_VERSION:-__OW_SHIM_PINNED_VERSION__}"
ow_owner_pin="__OW_SHIM_REAL_OWNER__"
ow_home="${OPENWORKSPACE_HOME:-${HOME:-/nonexistent}}"
ow_logdir="${OW_BROWSER_SHIM_LOG_DIR:-$ow_home/browser-shim-logs}"
ow_logfile="$ow_logdir/agent-browser-observations.jsonl"
ow_capfile="$ow_logdir/agent-browser-captures.jsonl"
ow_marker="$ow_logdir/.version-check-day"
ow_dropped="$ow_logdir/.dropped-count"
OW_CAP_BYTES=65536
OW_ROTATE_BYTES=1048576
OW_ROTATE_LINES=1000
OW_CAP_ROTATE_BYTES=262144
OW_CAP_ROTATE_LINES=100

# Forward a parent-targeted signal to the supervised child (TERM/HUP/QUIT
# arrive only at the shim when sent to its PID; without forwarding the child
# and its browser daemon would be orphaned).
ow_fwd() {
  ow_got_sig="$1"
  if [ -n "$ow_child" ]; then kill -"$1" "$ow_child" 2>/dev/null || true; fi
}

ow_die_if_signalled() {
  if [ -n "$ow_got_sig" ]; then
    trap - INT TERM HUP QUIT 2>/dev/null || true
    kill -"$ow_got_sig" "$$" 2>/dev/null || exit 1
  fi
}

# Runs the browser call supervised: backgrounded under the caller's umask
# (same process group, no job control, so TTY/stdin/pipe behavior is
# unchanged) while wait lets parent-targeted signals interrupt into ow_fwd.
# The kill -0 loop re-waits after a trap so _code is always the child's real
# status, never wait's 128+N interruption artifact.
ow_run_child() {
  ow_child=""; ow_got_sig=""
  umask "$ow_caller_umask"
  # Explicit <&0: shells redirect a backgrounded stdin to /dev/null, which
  # would swallow piped input; re-duping fd 0 keeps the caller's pipe/TTY
  # byte-identical while the job stays in this process group.
  "$@" <&0 & ow_child=$!
  umask 077
  _code=0
  while [ -n "$ow_child" ] && kill -0 "$ow_child" 2>/dev/null; do
    wait "$ow_child"; _code=$?
  done
  ow_child=""
}

ow_ts() {
  date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown'
}

ow_now_ms() {
  _ms=$(perl -MTime::HiRes=time -e 'printf "%d\n", (time() * 1000)' 2>/dev/null) || _ms=""
  case "$_ms" in ''|*[!0-9]*) _ms=$(date +%s 2>/dev/null)000 || _ms="0" ;; esac
  case "$_ms" in ''|*[!0-9]*) _ms="0" ;; esac
  printf '%s' "$_ms"
}

# ow_json_escape: stdin bytes -> JSON string body (no surrounding quotes).
# Strips C0 controls except tab, joins physical lines with literal \n, then
# doubles backslashes and escapes quotes/tabs/CRs. LC_ALL=C keeps this
# byte-oriented so non-UTF8 bytes never error the pipeline.
ow_json_escape() {
  _tab=$(printf '\t') || _tab=""
  _cr=$(printf '\r') || _cr=""
  LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' \
    | LC_ALL=C awk '{ if (NR > 1) printf "%s", "\\n"; printf "%s", $0 }' \
    | LC_ALL=C sed -e 's/\\/&&/g' -e 's/"/\\"/g' -e "s/$_tab/\\\\t/g" -e "s/$_cr/\\\\r/g"
}

ow_json_quote() {
  _q=$(printf '%s' "$1" | ow_json_escape) || _q=""
  printf '"%s"' "$_q"
}

# Fixed agent-browser verb vocabulary (first-level commands from the real
# --help output). Anything else as a first positional is data, not an
# action, and is logged as "unknown" WITHOUT its value.
ow_known_verb() {
  case "$1" in
    open|read|click|dblclick|type|fill|press|keyboard|hover|focus|check|uncheck|select|drag|upload|download|scroll|scrollintoview|wait|screenshot|pdf|snapshot|eval|connect|close|back|forward|reload|get|is|find|mouse|set|network|cookies|storage|tab|diff|trace|profiler|record|console|errors|highlight|inspect|clipboard|stream|webmcp|react|vitals|a11y|pushstate|removeinitscript|batch|auth|plugin|confirm|deny|session|mcp|chat|dashboard|install|upgrade|doctor|profiles|skills) return 0 ;;
    *) return 1 ;;
  esac
}

# Long opaque-looking strings get masked even where an identifier is
# expected. Extra defense only, NOT a secrecy guarantee.
ow_is_token() {
  _t="$1"
  [ "${#_t}" -ge 32 ] || return 1
  case "$_t" in -*|/*|.*|*" "*|*"	"*|*://*|:*|*@*) return 1 ;; esac
  _stripped=$(printf '%s' "$_t" | LC_ALL=C tr -d 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_+=/.-') || return 1
  [ -z "$_stripped" ]
}

ow_safe_id() {
  if ow_is_token "$1"; then printf '%s' "[REDACTED_TOKEN]"; else printf '%s' "$1"; fi
}

# Parses argv into metadata ONLY. Positional values are dropped by
# construction; the ONLY positional-derived outputs are the action verb
# (allowlisted) and a URL host. Flag values are dropped except --session.
# Prints four single-line records (all values JSON-quoted upstream, so no
# embedded newlines can break field splitting): action, flags body,
# session-or-null, host-or-null.
ow_parse_argv() {
  _action=""; _flags=""; _ffirst=1; _session=""; _host=""; _next_session=0
  for _a in "$@"; do
    if [ "$_next_session" -eq 1 ]; then _next_session=0; _session="$_a"; continue; fi
    case "$_a" in
      --session) _next_session=1; _f="--session" ;;
      --session=*) _session="${_a#--session=}"; _f="--session" ;;
      --*) _f="${_a%%=*}"; _f=${_f%%=*} ;;
      # Single-dash: strip =value. A longer token whose short is one of the
      # known value-taking shorts (-s selector, -d depth, -p provider) may
      # carry an attached value (-sSEL); mask to the bare short. Other
      # longer tokens are combined booleans from fixed vocabulary (-vq).
      -*) _f="$_a"
        case "$_f" in *=*) _f=${_f%%=*} ;; esac
        case "$_f" in -s?*|-d?*|-p?*) _f=$(printf '%s' "$_f" | cut -c1-2) || _f="$_a" ;; esac
        ;;
      *)
        if [ -z "$_action" ]; then
          if ow_known_verb "$_a"; then _action="$_a"; else _action="unknown"; fi
        fi
        case "$_a" in
          http://*|https://*)
            if [ -z "$_host" ]; then
              # Host only: strip scheme, then userinfo (which may precede
              # ? or # when there is no path slash), then cut at the first
              # /, ?, or #, then drop any port.
              _host=$(printf '%s' "$_a" | LC_ALL=C sed -e 's|^[A-Za-z][A-Za-z0-9+.-]*://||' -e 's|^[^/?#]*@||' -e 's|[/?#].*$||' -e 's|:.*$||') || _host=""
            fi
            ;;
        esac
        continue
        ;;
    esac
    _q=$(ow_json_quote "$_f") || _q='""'
    if [ "$_ffirst" -eq 1 ]; then _ffirst=0; else _flags="$_flags,"; fi
    _flags="$_flags$_q"
  done
  if [ -z "$_action" ]; then
    _first_flag=$(printf '%s' "$_flags" | LC_ALL=C sed -e 's/^"//' -e 's/".*//') || _first_flag=""
    if [ -n "$_first_flag" ]; then _action="$_first_flag"; else _action="(none)"; fi
  fi
  _session=$(ow_safe_id "$_session") || _session=""
  _action_q=$(ow_json_quote "$_action") || _action_q='"(none)"'
  _sess_j="null"; _host_j="null"
  if [ -n "$_session" ]; then _sess_j=$(ow_json_quote "$_session") || _sess_j="null"; fi
  if [ -n "$_host" ]; then _host_j=$(ow_json_quote "$_host") || _host_j="null"; fi
  printf '%s\n%s\n%s\n%s\n' "$_action_q" "$_flags" "$_sess_j" "$_host_j"
}

ow_append_log() {
  mkdir -p "$ow_logdir" 2>/dev/null || { ow_note_dropped; return 0; }
  chmod 700 "$ow_logdir" 2>/dev/null || true
  if { printf '%s\n' "$1" >>"$ow_logfile"; } 2>/dev/null; then
    chmod 600 "$ow_logfile" 2>/dev/null || true
    ow_rotate "$ow_logfile" "$OW_ROTATE_LINES" "$OW_ROTATE_BYTES" || true
  else
    ow_note_dropped || true
  fi
  return 0
}

ow_append_capture() {
  mkdir -p "$ow_logdir" 2>/dev/null || { ow_note_dropped; return 0; }
  chmod 700 "$ow_logdir" 2>/dev/null || true
  { printf '%s\n' "$1" >>"$ow_capfile"; } 2>/dev/null || { ow_note_dropped; return 0; }
  chmod 600 "$ow_capfile" 2>/dev/null || true
  ow_rotate "$ow_capfile" "$OW_CAP_ROTATE_LINES" "$OW_CAP_ROTATE_BYTES" || true
  return 0
}

# Best-effort drop counter so a later good entry can report lost lines.
ow_note_dropped() {
  _n=$(cat "$ow_dropped" 2>/dev/null) || _n=""
  case "$_n" in ''|*[!0-9]*) _n=0 ;; esac
  { printf '%s' "$((_n + 1))" >"$ow_dropped"; } 2>/dev/null || true
  return 0
}

ow_take_dropped() {
  _d=$(cat "$ow_dropped" 2>/dev/null) || _d=""
  case "$_d" in ''|*[!0-9]*) _d=0 ;; esac
  rm -f "$ow_dropped" 2>/dev/null || true
  printf '%s' "$_d"
  return 0
}

ow_rotate() {
  _file="$1"; _lines="$2"; _bytes="$3"
  _size=$(wc -c <"$_file" 2>/dev/null | LC_ALL=C tr -d ' \t\n') || return 0
  case "$_size" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$_size" -gt "$_bytes" ]; then
    _tmp="$_file.rotate.$$"
    if { tail -n "$_lines" "$_file" >"$_tmp"; } 2>/dev/null; then
      _size2=$(wc -c <"$_tmp" 2>/dev/null | LC_ALL=C tr -d ' \t\n') || _size2=""
      case "$_size2" in ''|*[!0-9]*) _size2=0 ;; esac
      if [ "$_size2" -gt "$_bytes" ]; then
        { tail -c "$_bytes" "$_file" >"$_tmp"; } 2>/dev/null || return 0
      fi
      { cat "$_tmp" >"$_file"; } 2>/dev/null || true
      chmod 600 "$_file" 2>/dev/null || true
    fi
    rm -f "$_tmp" 2>/dev/null || true
  fi
  return 0
}

# Daily cached version re-check. Mismatches go to the LOG FILE ONLY, never
# stderr: CLI output is sacred, and drift is an observer-grade concern.
ow_version_check() {
  _today=$(date -u +%F 2>/dev/null || date +%F 2>/dev/null) || return 0
  case "$_today" in ????-??-??) ;; *) return 0 ;; esac
  if [ -f "$ow_marker" ]; then
    _last=$(cat "$ow_marker" 2>/dev/null) || _last=""
    [ "$_last" = "$_today" ] && return 0
  fi
  case "$ow_pinned" in ''|__OW_SHIM*) return 0 ;; esac
  _observed=$("$ow_real" --version 2>/dev/null | head -c 256 | head -n 1 | LC_ALL=C tr -d '\r') || _observed=""
  [ -n "$_observed" ] || return 0
  mkdir -p "$ow_logdir" 2>/dev/null || return 0
  { printf '%s' "$_today" >"$ow_marker"; } 2>/dev/null || return 0
  chmod 600 "$ow_marker" 2>/dev/null || true
  if [ "$_observed" != "$ow_pinned" ]; then
    ow_append_log "{\"type\":\"version-drift\",\"ts\":\"$(ow_ts)\",\"pinned\":$(ow_json_quote "$ow_pinned"),\"observed\":$(ow_json_quote "$_observed"),\"action\":\"re-run scripts/install-browser-shim.sh\"}" || true
  fi
  return 0
}

# Portable "owner perms" probe: prints "owner octal" or fails.
ow_stat_owner_perms() {
  _st=$(stat -f '%Su %Lp' "$1" 2>/dev/null) || _st=$(stat -c '%U %a' "$1" 2>/dev/null) || return 1
  printf '%s' "$_st"
  return 0
}

# Identity gate. Missing/unreadable/permission-bad pinned executable is a
# program-identity failure: LOUD stderr + nonzero exit, NEVER a silent
# fallback to whatever else is named agent-browser on PATH.
ow_check_identity() {
  if [ ! -f "$ow_real" ] || [ ! -x "$ow_real" ]; then
    printf '%s\n' "agent-browser shim: pinned executable '$ow_real' is missing or not executable. Refusing to fall back to PATH (program identity). Re-run scripts/install-browser-shim.sh to reinstall, or remove the shim dir from PATH to roll back." >&2
    return 127
  fi
  _st=$(ow_stat_owner_perms "$ow_real") || _st=""
  if [ -n "$_st" ]; then
    _owner=${_st%% *}; _perms=${_st##* }
    _last=$(printf '%s' "$_perms" | LC_ALL=C sed 's/.*\(.\)$/\1/') || _last=""
    case "$_last" in 2|3|6|7)
      printf '%s\n' "agent-browser shim: pinned executable '$ow_real' is world-writable (perm $_perms). Refusing to run. Re-run scripts/install-browser-shim.sh to reinstall, or remove the shim dir from PATH to roll back." >&2
      return 127
      ;;
    esac
    case "$ow_owner_pin" in ''|__OW_SHIM*) ;; *)
      if [ "$_owner" != "$ow_owner_pin" ]; then
        printf '%s\n' "agent-browser shim: pinned executable '$ow_real' owner changed ('$_owner', expected '$ow_owner_pin'). Refusing to run. Re-run scripts/install-browser-shim.sh to reinstall, or remove the shim dir from PATH to roll back." >&2
        return 127
      fi
      ;;
    esac
  fi
  return 0
}

ow_main() {
  case "$ow_real" in
    ""|__OW_SHIM*)
      printf '%s\n' "agent-browser shim: no real binary pinned (not installed). Re-run scripts/install-browser-shim.sh to install, or remove the shim dir from PATH to roll back." >&2
      return 127
      ;;
  esac
  # Test/dev override bypasses install-time pinning (documented, not a
  # fallback: the caller explicitly names the binary).
  case "${OW_AGENT_BROWSER_REAL:-}" in
    "") ow_check_identity || return $? ;;
  esac
  trap 'ow_fwd INT' INT
  trap 'ow_fwd TERM' TERM
  trap 'ow_fwd HUP' HUP
  trap 'ow_fwd QUIT' QUIT
  ow_version_check || true
  ow_die_if_signalled

  _parsed=$(ow_parse_argv "$@") || _parsed=""
  _action_q=$(printf '%s' "$_parsed" | LC_ALL=C sed -n '1p') || _action_q='"(none)"'
  _flags=$(printf '%s' "$_parsed" | LC_ALL=C sed -n '2p') || _flags=""
  _parse_session=$(printf '%s' "$_parsed" | LC_ALL=C sed -n '3p') || _parse_session=""
  _parse_host=$(printf '%s' "$_parsed" | LC_ALL=C sed -n '4p') || _parse_host=""
  case "$_action_q" in '') _action_q='"(none)"' ;; esac
  _sess="null"
  if [ -n "${OPENWORKSPACE_SESSION:-}" ]; then
    _sess_id=$(ow_safe_id "$OPENWORKSPACE_SESSION") || _sess_id=""
    _sess=$(ow_json_quote "$_sess_id") || _sess="null"
  elif [ "$_parse_session" != "null" ] && [ -n "$_parse_session" ]; then
    _sess="$_parse_session"
  fi
  _host="null"
  if [ "$_parse_host" != "null" ] && [ -n "$_parse_host" ]; then _host="$_parse_host"; fi

  _capture=0
  if [ "${OW_BROWSER_SHIM_CAPTURE:-0}" = "1" ] && [ ! -t 1 ]; then
    for _m in "$@"; do
      case "$_m" in batch|--json|--json=*|--format=json) _capture=1; break ;; esac
    done
  fi

  _start=$(ow_now_ms)
  _output=""
  if [ "$_capture" -eq 1 ]; then
    _tmpd=$(mktemp -d "${TMPDIR:-/tmp}/ow-abshim.XXXXXX" 2>/dev/null) || _tmpd=""
    if [ -n "$_tmpd" ]; then
      # Child writes to temp files, never through the shim: a slow or
      # failed log path cannot fill a pipe and hang the browser call.
      # Supervised (see ow_run_child): umask restored, signals forwarded.
      ow_run_child "$ow_real" "$@" >"$_tmpd/out" 2>"$_tmpd/err"
      _end=$(ow_now_ms)
      cat "$_tmpd/out" || true
      cat "$_tmpd/err" >&2 || true
      _on=$(wc -c <"$_tmpd/out" 2>/dev/null | LC_ALL=C tr -d ' \t\n') || _on=""
      _en=$(wc -c <"$_tmpd/err" 2>/dev/null | LC_ALL=C tr -d ' \t\n') || _en=""
      case "$_on" in ''|*[!0-9]*) _on=0 ;; esac
      case "$_en" in ''|*[!0-9]*) _en=0 ;; esac
      _ot="false"; _et="false"
      _oe=""; _ee=""
      if head -c "$OW_CAP_BYTES" "$_tmpd/out" >"$_tmpd/raw.out" 2>/dev/null; then
        LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' <"$_tmpd/raw.out" >"$_tmpd/cln.out" 2>/dev/null || true
        _oe=$(ow_json_escape <"$_tmpd/cln.out") || _oe=""
        if [ "$_on" -gt "$OW_CAP_BYTES" ]; then _ot="true"; fi
      fi
      if head -c "$OW_CAP_BYTES" "$_tmpd/err" >"$_tmpd/raw.err" 2>/dev/null; then
        LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' <"$_tmpd/raw.err" >"$_tmpd/cln.err" 2>/dev/null || true
        _ee=$(ow_json_escape <"$_tmpd/cln.err") || _ee=""
        if [ "$_en" -gt "$OW_CAP_BYTES" ]; then _et="true"; fi
      fi
      _dropped_n=$(ow_take_dropped)
      ow_append_capture "{\"type\":\"capture\",\"ts\":\"$(ow_ts)\",\"action\":$_action_q,\"targetHost\":$_host,\"exitCode\":$_code,\"stdoutBytes\":$_on,\"stderrBytes\":$_en,\"stdoutTruncated\":$_ot,\"stderrTruncated\":$_et,\"dropped\":$_dropped_n,\"stdoutExcerpt\":\"$_oe\",\"stderrExcerpt\":\"$_ee\"}" || true
      rm -rf "$_tmpd" 2>/dev/null || true
    else
      _capture=0
    fi
  fi
  if [ "$_capture" -eq 0 ]; then
    if [ -z "${_code:-}" ]; then
      # Supervisor with fully inherited fds: stdin, TTY behavior, and
      # stdout/stderr separation are exactly the real binary's own.
      # Backgrounded without job control in the same process group, so
      # terminal input, Ctrl-C delivery, and pipes are unchanged; wait
      # lets parent-targeted signals forward to the child (ow_run_child).
      unset _code
      ow_run_child "$ow_real" "$@"
      _end=$(ow_now_ms)
    fi
    _mode="metadata"
  else
    _mode="capture"
  fi

  case "${_code:-}" in ''|*[!0-9]*) _code=1 ;; esac
  _dur=0
  case "${_start:-} ${_end:-}" in *[!\ 0-9]*) ;; *) _dur=$((_end - _start)); [ "$_dur" -ge 0 ] 2>/dev/null || _dur=0 ;; esac
  _outcome="ok"
  if [ "$_code" -gt 128 ] && [ "$_code" -lt 256 ]; then
    _outcome="signal-$((_code - 128))"
  elif [ "$_code" -ne 0 ]; then
    _outcome="error"
  fi
  _dropped_n=$(ow_take_dropped)
  ow_append_log "{\"type\":\"observation\",\"ts\":\"$(ow_ts)\",\"action\":$_action_q,\"flags\":[$_flags],\"targetHost\":$_host,\"session\":$_sess,\"mode\":\"$_mode\",\"exitCode\":$_code,\"outcome\":\"$_outcome\",\"durationMs\":$_dur,\"dropped\":$_dropped_n}" || true

  # Re-raise a fatal signal so parents observe signal death, not just 128+N.
  # If the shim itself was signalled but the child survived it (signal
  # masker), still die by that signal after logging: receipt, then honesty.
  if [ "$_code" -gt 128 ] && [ "$_code" -lt 256 ]; then
    _sig=$((_code - 128))
    trap - INT TERM HUP QUIT 2>/dev/null || true
    kill -"$_sig" "$$" 2>/dev/null || exit "$_code"
  elif [ -n "$ow_got_sig" ]; then
    ow_die_if_signalled
  fi
  trap - INT TERM HUP QUIT 2>/dev/null || true
  exit "$_code"
}

ow_main "$@"
