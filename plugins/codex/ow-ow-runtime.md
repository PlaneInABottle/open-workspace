---
name: ow-ow-runtime
description: "Supervise ow services and readiness: up/ps/logs/reconcile, init. Use for service state, readiness gates, or session history."
---

# ow-runtime — supervision and readiness

`ow` supervises dev services from a repo's `ow.yaml` as plain child
processes — no Docker, restarts, or dashboard. Read-only unless the verb
says otherwise; nothing here edits `package.json`/CI/imports or installs
tools. Full schema, caps, and non-goals: product `cli/README.md`.

```sh
ow up --check --file ow.yaml   # validate only (unknown fields warn, never fail)
ow up -d [--wait 120s]         # detach: one supervisor per ow.yaml dir; second up → exit 2
ow up <svc>                    # live: add one service via the supervisor (healthy ones untouched)
ow restart <svc>               # live: lstart-verified stop + respawn in place (no lock → exit 2)
ow down [svc]                  # single: stop only the target (lock/state files kept; --rm is bulk-only)
ow reconcile --check [--json]  # read-only drift report (never mutates; exit 1 on drift)
ow ps [--json]                 # running/exited/stopped/unknown + pid, uptime, cpu, mem, port, listen
ow ps --explain [svc] [--file] [--json]  # expected-vs-running, never executes
ow logs [svc] [--tail 200] [--grep foo] [--since 30m] [--json]
ow down [--rm]                 # SIGTERM→5s→SIGKILL; --rm also drops supervisor.json
```

- After `ow up -d`, prefer `ow up -d --wait 15s` (max 5m) over manual
  sleep/curl: waits until every declared `port` accepts TCP, exit 1 on
  timeout or early exit, exit 2 for `--wait` without `-d`. Port-less
  services are named, never waited on. `--check` rejects `--wait`.
- Slow-boot services (Spring listens long before actuator is UP): add
  `--health <svc>=<path>` (repeatable, CLI-only, needs `--wait`).
  Unknown service, slash-less path, `--health` without `--wait`/`-d`,
  or with `--check` → exit 2.
- Readiness = TCP-accept (HTTP/app health only via `--health`);
  `readiness: {probe: [...], timeout: 10s}` runs project probes in
  `up -d --wait`/`reconcile --probe` (argv-only, masked, budgeted;
  `--health` conflicts exit 2).
- Spring notes: `/` 404 is NORMAL — wait on `/actuator/health`.
  Never `pkill`: a stale `already running` clears via `ow down`
  (`ow down --rm` for dead residue). `down` during a wait reports
  `exited:` everywhere (143-ish) — expected, not an error.
- `ow reconcile --check` reports drift without changing anything
  (exit 0 in sync, 1 on drift; rev lines informational). `--probe`
  runs project probes one-shot (budgeted); never in `ps`.
- `ow ps --explain [svc]`: expected shapes vs running; recorded only,
  never executes. Raw argv never renders (masked shape only).
- State is repo-local (`<root>/.ow/`); every pid is `lstart`-guarded, so
  a recycled pid is reported unknown, never signaled. Port conflicts
  warn and still spawn, never reassign.
- `env: {K: V}` per service passes env to the child (`OW_SERVICE`
  always wins, never printed). `required-env: [VAR, ...]` fails
  (exit 2) naming service + missing vars before anything spawns.
  Unknown service options (including the retired `depends_on`) fail
  with exit 2 before anything spawns; services start in YAML order.
- `ow up` ensures the repo `.gitignore` covers `.ow/` (warn-only).
- `ow doctor` also prints an informational `up:` line (never affects
  exit code). Readers walk upward to the nearest `.ow/`; explicit
  `--file` wins; `ow up` stays in cwd.

## Drift and provenance

- `ow reconcile --check` drift kinds with English hints (`missing`,
  `extra`, `stopped`, `config-mismatch`, `lstart-mismatch`,
  `foreign-port`, `stale-build` for stale build identity). A descendant
  listener (forking launcher) is owned, not foreign; a partly foreign
  port reports `foreign-port` with `ownership: "shared"` (JSON only) and
  `port <p> also held by a foreign listener (UNVERIFIED) — no kill,
  verify the owner`. Never kill a port-holder on this output.
- Port-open alone is never readiness evidence — project probes
  (`readiness:` in `ow.yaml`, run via `up --wait`/`reconcile --probe`)
  are the measure.

## Init

- `ow init [--force]` scans the directory (read-only,
  capped) and writes at most `ow.yaml`. Empty/compose-only dirs: honest
  message, no files. Existing file refuses without `--force` (exit 2,
  byte-identical); `--force` keeps exactly one `.bak`.
  A bounded `question:` question catalog prints when scaffolding.

## Handoff (between agents/sessions)

Hand over supervision with readings, never handles: `ow ps` status,
the `<root>/.ow/` location, and supervisor liveness (the `ow doctor`
`up:` line). Never hand over bare pids (they recycle — `lstart`
guards them), log contents, or env values. The next agent
re-verifies with `ow ps` and `ow reconcile --check` before acting; a
dead supervisor means `ow down` first, never adoption.
