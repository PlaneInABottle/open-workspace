---
name: ow-ow
description: "Operate the ow CLI: session analysis (sessions/show/reads) plus dev-service supervision (up/ps/logs/reconcile/render), readiness, and handoffs."
---

# ow — sessions and service supervision

`ow` is the shell-observer command line: past session analysis plus
dev-service supervision. Run it as `ow` from anywhere (via `/setup-ow`
install, or `ow` on PATH). Read-only unless the verb says otherwise;
nothing here edits `package.json`/CI/imports or installs tools.

## Sessions (quick reference)

`ow` observes **opencode sessions** only — other harnesses are not
observed ("not observed" means exactly that, never "nothing happened").

```sh
ow doctor                             # health first
ow sessions [--since 1d] [--dir /path]
ow show <session> [--since 30m|3h|1d|1w] [--tree] [--full] [--show N] [--show-fails] [--kind ..] [--tool ..]
ow meta/reads <session>             # cost/tokens · read summary
ow show <session> --json              # stable machine output (all commands, English keys)
```

No ID known: last sidecar line, or bare for latest. Exits: 0 ok,
1 failure, 2 usage error; non-interactive. `doctor` first when results
look wrong; sidecar rows land ~5s after session end, spans 5–15s late.
Baseline first: run `ow doctor` and note the health lines before
changing anything, re-run after. Report only what the output shows,
never invent causes. Check counts first, keep
`--since` narrow; open failures one by one, repeats first.

Self-documentation and resolution (all read-only):

```sh
ow --version | ow version [--json]   # installed build identity (sha8/time/dirty from the sidecar)
ow <command> --help | ow help <cmd>  # verb-scoped usage/flags/exits (subverb-scoped where it applies)
ow where [--file] [--json]           # resolved root + which files ow would read (present/missing); always exit 0
```

`ow <command> --help` never dumps the full list — the global list stays on
`ow --help`. When output looks like it came from the wrong root, run `ow where`
first: it names the resolved root, how it was resolved and the ow.yaml /
state / supervisor / log / DB paths.

Output labels (English, quoted verbatim): `task:` task header
(`N records, M failed` — every joined row counts, not just commands),
`record:` real command, `intent:` agent sentence, `(reason:)` /
`(output:)` on failures (several distinct reasons collapse to
`(reason: <first>; +N more)`, drilled down as
`--- reasons (from command text) ---` under `--show N`). Budgets: success excerpts 2KB stored and
300 chars shown, failures up to 16KB; 3h of history runs about 150KB.

## Supervision (quick reference)

`ow` supervises dev services from a repo's `ow.yaml` as plain child
processes — no Docker, restarts, or dashboard. Full schema, caps, and
non-goals: product `cli/README.md`.

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
ow render --file ow.yaml --only api,web --set-port api=8901 --out .local-runtime/task/ow.yaml [--force] [--json]
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
  timeout is `<N>s`, 1..300, default 10s; above 30s warns — the flag
  refuses a defined probe on the same service, exit 2).
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

## Render (per-task manifests)

- `ow render --file ow.yaml --only api,web --set-port api=8901
  --out .local-runtime/<task>/ow.yaml [--force] [--json]` derives a
  task manifest from the base without hand-editing it (base stays the
  single source; port allocation stays with the caller, passed as flags).
  Re-parsed before writing; `env:` values never copied; `cmd` keeps its
  base shape; output carries names/ports only, never secret values.
  Existing `--out` refuses without `--force` (exit 2, byte-identical);
  `--force` keeps exactly one `.bak`. One manifest per task dir keeps
  parallel workers on isolated ports; `--file` points each `up`/`ps`
  at its own manifest so roots never collide.

## `--json` keys (single table, additive)

English human lines; stable English `--json` keys (old keys never change, new keys only add):

| command | envelope |
|---|---|
| `up --check --json` | `{file, services[] ({name, cmd?, cwd?, port?, logs?}), warnings[]}` |
| `up -d --wait --json` | `{ready, services[] ({name, port?, status, waitedSec, exitCode?, healthPath?, readiness?}), noPort[], note?}` |
| `up <svc>`, `restart --json` | `{service, action, pid?, diff, code?}` (`code` only on failure) |
| `down <svc> --json` (live supervisor) | `{service, action, diff, code?, confirmed? ({stopped, code})}` (row above + `confirmed`; `confirmed.stopped` is a state witness — read `code` for stopped/already-stopped/refused) |
| `down [--rm]`, `down <svc> --json` (lock-less, no supervisor) | `{stopped[] ({name, stopped, note}), warnings[]}` |
| `ps --json` | `{services[] ({name, status, pid, uptimeSec, cpuPct, memBytes, port?, listening?, exitCode?})}` |
| `logs --json` | `{service, lines[]}` |
| `reconcile --check --json` | `{reconcile: {inSync, drifts[] ({service, kind, expected?, running?, hint})}, revisions[], readiness[] (only with --probe)}` |
| `ps --explain --json` | `{services[], explanations[] ({service, explanation: {expected, running, diffs[], provenance, reason, readiness}})}` |
| `render --json` | `{out, services[] ({name, port?, cwd?}), warnings[]}` |
| `doctor --json` | `{checks[] ({name, ok, detail}), identity: {installed {sha8, dirty, time, binary8}\|null, supervisor {state, startedAt, sha8, time}, match}}` (`up` is not part of the exit; digests compared internally, shorts only on the wire) |

Full schema, caps, and non-goals: product `cli/README.md`.

## Handoff (between agents/sessions)

Hand over readings, never handles: `ow ps` status, the `<root>/.ow/`
location, and supervisor liveness (the `ow doctor` `up:` line). Never
hand over bare pids (they recycle — `lstart` guards them), log
contents, or env values. The next agent re-verifies with `ow ps` and
`ow reconcile --check` before acting; a dead supervisor means `ow down`
first, never adoption.
