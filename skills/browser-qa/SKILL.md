---
name: browser-qa
description: Choose CLI browser exploration vs MCP verification with receipts, under the observer shim. Use for browser QA tasks and reading shim observations.
---

# Browser QA

Two paths: **explore** with the `agent-browser` CLI directly; **verify**
with the MCP wrapper (`browser_check` + `verification_run` + `service_logs`
+ `datastore`) for receipts. The shim log is learning input, never proof:
a log line (or exit 0) is not a verified outcome — only the
expected-observable-result of a verification run counts.

## Rules

- Session per task: `--session ow-<unique>`; `snapshot` before/after
  mutating acts; `close` when done. Repeatable flows go through
  `batch --json`; one-off pokes stay interactive.
- Shim check first: `scripts/install-browser-shim.sh --verify`. If the shim
  is absent or PATH-inactive, the CLI still works — observation is off, and
  an empty log proves nothing (unused or bypassed). Say so honestly.
- The default log holds metadata only (action, host, outcome) — never form
  values or URL paths. Read it for surprise-mining with `learn-from-mistake`;
  never paste it raw. A `version-drift` line means re-run the installer.
- Capture mode (`OW_BROWSER_SHIM_CAPTURE=1`) is per-task opt-in with short
  retention; TTY sessions stay metadata-only. Opt-in captures may contain
  secrets (snapshots, cookies, customer info), and retention is
  capacity-bounded (100 lines/256KiB ring), not time-bounded — disable
  opt-in when done. Roll back by dropping the PATH entry, then `--uninstall`.
