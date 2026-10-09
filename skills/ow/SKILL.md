---
name: ow
description: Operate the ow CLI: past session analysis plus dev-service supervision and trace lookup. Use for agent work, service state, or which trace a request produced.
---

# ow — session observer operator manual

`ow` shows what agents did: shell commands, file edits, tool calls,
grouped by task with the agent's own words attached. Read-only; it never
changes sessions, files, or the database.

Run it as `ow` from anywhere (via `/setup-ow` install, or `ow` on PATH).
Never memorize log paths or schemas — `ow` handles that.

## Scope (honest)

`ow` observes **opencode sessions** (shell-observer hooks record shell,
file-edit, and tool-call rows plus intent join). Other harnesses (Claude Code,
Codex, Copilot CLI, …) are not observed — `sessions` omits them. An empty
result for a foreign session means "not observed", never "nothing happened".

## Commands

```sh
ow doctor                             # health first: log growing? hooks firing? db readable?
ow sessions [--since 1d] [--dir /path]   # inventory: who worked, where, how much
ow show <session> [--since 30m|3h|1d|1w]  # summary: task header + signature lines + xN repeats + intents
ow show <session> --tree [--since 1d]     # task tree incl. subagent sessions
ow show <session> --since 3h --full       # full period text (large — keep window narrow)
ow show <session> --show <line> [--bytes 1k]  # single-line detail, gradual
ow show <session> --show-fails [--bytes 4k]   # every failure, full text
ow show <session> --kind shell|file-edit|tool-call [--tool <name>]
ow meta <session>                     # cost, tokens, models, line changes, turns, prompts
ow prompts <session>                  # latest 20 user instructions, chronological
ow reads <session> [--since 1d]       # which files were read most, by whom, which lines
ow stuck <session> [--since 1d] [--tree]  # retries, overlap depth, slow commands
ow timeline [session] [--trace <id>] [--since 1d]  # agent rows + spans merged; kesin/exact vs tahmini/estimated links
ow show <session> --json              # stable machine output (all commands, English keys)
ow show                               # no session → latest session
```

No ID known: use the `sessionID` of the last sidecar line, or run bare for the
latest session. Exits: 0 ok, 1 failure, 2 usage error; non-interactive.

## Service supervision (`up`/`down`/`ps`/`logs`)

Supervises dev services from a repo's `ow.yaml` as plain child processes —
no Docker, restarts, or dashboard.

```sh
ow up --check --file ow.yaml   # validate only (unknown fields warn, never fail)
ow up -d [--wait 120s]         # detach: one supervisor per ow.yaml dir; second up → exit 2
ow up <svc>                    # live: add one service via the supervisor (healthy ones untouched)
ow restart <svc>               # live: lstart-verified stop + respawn in place (no lock → exit 2)
ow down [svc]                  # single: stop only the target (lock/state files kept; --rm is bulk-only)
ow reconcile --check [--json]  # read-only drift report (never mutates; exit 1 on drift)
ow ps [--json]                 # running/exited/stopped/unknown + pid, uptime, cpu, mem, port, listen=evet/hayır
ow ps --explain [svc] [--json]  # expected-vs-running, never executes
ow logs [svc] [--tail 200] [--grep foo] [--since 30m] [--json]
ow down [--rm]                 # SIGTERM→5s→SIGKILL; --rm also drops supervisor.json
```

- After `ow up -d`, prefer `ow up -d --wait 15s` (max 5m) over manual
  sleep/curl: waits until every declared `port` accepts TCP, exit 1 on
  timeout (`zaman aşımı:`) or early exit (`bitti:` — with an `ow logs <svc>`
  pointer), exit 2 for `--wait` without `-d`. Port-less services are named,
  never waited on. `--check` rejects `--wait` (exit 2).
- Slow-boot services (Spring listens long before actuator is UP): add
  `--health <svc>=<path>` (repeatable, CLI-only, needs `--wait`):
  `ow up -d --wait 150s --health configuration=/actuator/health`. The
  flagged service waits for HTTP 2xx on `127.0.0.1:<port><path>` after TCP;
  others stay TCP-only. Unknown service, slash-less path, `--health`
  without `--wait`/`-d`, or with `--check` → exit 2.
- Readiness = TCP-accept (HTTP/app health only via `--health`); `readiness: {probe: [...], timeout: 10s}` runs project probes in `up -d --wait`/`reconcile --probe` (argv-only, masked, budgeted; `--health` conflicts exit 2).
- Spring notes: `/` 404 is NORMAL — wait on `/actuator/health`. TCP≈ready
  ports need no flag. Prefer `ow restart <svc>` over `ow down && ow up -d`
  (no `sleep 4`; single-service restart leaves healthy services untouched).
  Never `pkill`: a stale `zaten çalışıyor` clears via `ow down`
  (`ow down --rm` for dead residue). `down` during a wait reports `bitti:`
  everywhere (143-ish) — expected, not an error.
- `ow reconcile --check` reports drift without changing anything:
  `eksik|fazla|durmuş|config-farklı|lstart-uyuşmazlığı|port-yabancı` plus the
  suggested `ow up/restart/down <svc>` command (exit 0 in sync, 1 on drift; rev lines informational).
  `--probe` runs project probes one-shot (budgeted); never in `ps`.
- `ow ps --explain [svc]`: expected shapes vs running + `fark:`/`neden:`; recorded only, never executes.
- State is repo-local (`<root>/.ow/`); every pid is `lstart`-guarded, so a
  recycled pid is reported unknown, never signaled.
- Port conflicts warn and still spawn, never reassign.
- `logs:`-only services are legal (external tail watched as `log` stream);
  an early-exiting tail is recorded while siblings survive.
- `env: {K: V}` per service passes env to the child (`OW_SERVICE` always wins,
  never printed). Single line only — the YAML subset reads line by line.
- `required-env: [VAR, ...]` declares what the service needs; `up --check`
  fails (exit 2) naming service + missing vars before anything spawns.
- `depends_on: [a, b]` sorts spawn order only (stable YAML order otherwise):
  named services spawn first; nothing waits for ports/health, no restart
  coupling. Unknown names, self-deps, cycles → exit 2 before anything
  spawns. E.g. a live tail after config: `web-live` with
  `depends_on: [configuration]`.
- `ow up` ensures the repo `.gitignore` covers `.ow/` (warn-only).
- `ow doctor` also prints an informational `up:` line (never affects exit code).
- `<root>/.ow/checkpoints/<run>.jsonl` is runner-written; `ow checkpoints show <run>` only renders confirmed/stale/not_observed + last-verified/first-gap + `safe_next_action` passthrough (never prunes, never judges proof content).
- `prepare` begins with `ow preflight --json`; on `pass:false` stop and log `missing[]` verbatim (reports only, Türkçe `eksik:`/`bayat:`/`hazır-değil:`). `--probe` adds budgeted one-shot loopback TCP.
- `ow scenarios --check` validates `ow.scenarios.yaml` only (never runs probes); unknown names/boundaries warn as UNVERIFIED, never fail.
- Full schema, caps, and non-goals: product `cli/README.md` ("Service supervision").

### `--json` anahtarları (tek tablo, additive)

Turkish human lines; stable English `--json` keys (old keys never change, new keys only add):

| komut | zarf |
|---|---|
| `up --check --json` | `{file, services[] ({name, cmd?, cwd?, port?, logs?, dependsOn?}), warnings[], spawnOrder?}` (`spawnOrder` yalnız `depends_on` varsa) |
| `up -d --wait --json` | `{ready, services[] ({name, port?, status, waitedSec, exitCode?, healthPath?, readiness?}), noPort[], note?}` |
| `up <svc>`, `restart --json` | `{service, action, pid?, diff, code?}` (`code` yalnız başarısızlıkta) |
| `down [--rm]`, `down <svc> --json` | `{stopped[] ({name, stopped, note}), warnings[]}` |
| `ps --json` | `{services[] ({name, status, pid, uptimeSec, cpuPct, memBytes, port?, listening?, exitCode?})}` |
| `logs --json` | `{service, lines[]}` |
| `reconcile --check --json` | `{reconcile: {inSync, drifts[] ({service, kind, expected?, running?, hint})}, revisions[], readiness[] (yalnız --probe ile)}` |
| `ps --explain --json` | `{services[], explanations[] ({service, explanation: {expected, running, diffs[], provenance, neden, readiness}})}` |
| `preflight --json` | `{pass, gates[] ({name: reconcile\|provenance\|readiness, pass, detail}), missing[], envelopes[]}` |
| `doctor --json` | `{checks[] ({name, ok, detail})}` (çıkışa `up`/`trace` katılmaz) |

## Tracing (OpenTelemetry, optional)

Off unless the repo's `ow.yaml` has a top-level `trace:` block (flat: port,
default `127.0.0.1:4319` — never 4318, that's the dashboard port). When on,
`ow up` also starts a loopback OTLP/HTTP-protobuf receiver and stores
sanitized spans in `<root>/.ow/traces/spans.jsonl`. No block → no listener,
no dirs, nothing changes. Receiver failure only warns; `up` keeps supervising.

```sh
ow trace [--tail 20] [--since 1d] [--service api]  # newest-first list
ow trace <traceId|8hex-prefix> [--json]            # one span tree
ow trace <traceId> --wait 15s                     # wait for late spans (browser batch delay), then render
ow doctor                                          # trace open/closed + span count + hint when 0 spans
```

- Exits: 0 ok/empty, 1 unknown/unreadable, 2 bad id.
- `--json` keys are English (`traces`/`traceId`/`spans`/`truncated`/`depth`).
- Secrets are masked at write time (query strings, credential pairs, Bearer
  forms, UUID/32+hex → `:id`); endpoints/route words stay verbatim (values
  never, structure always). Trace output is semi-sensitive — review before
  pasting. Correlate by traceId + endpoint + time, not business IDs.
- Per-stack recipes (Java `-javaagent`, Python `opentelemetry-instrument`,
  browser `-otlp-proto` + CORS): product `cli/README.md` ("İzleme tarifleri").
  App code lives in the app repo; `ow.yaml` carries only `env:` + endpoint.
- Proving a flow: generate the trace ID BEFORE the action; deliver via `set
  headers` in the browser session (rotates, `'{}'` clears); never `open --headers`.
- `doctor` hints: 0 spans → `ow ps`; `bilinmeyen` service → OTEL_SERVICE_NAME; not-listening → foreign port-holder.
- One port, one receiver: two listeners on 4319 → first wins (`lsof -i :4319`); remote backends get a separate exporter — never repurpose local.
- Business attributes flow (`silent_dequeue_reason`, `conversion_successful`;
  `token_count` exempt); credential keys/values drop or mask. ERROR renders
  only when the app sets status (`unset` = app never said).

## Working with logs and traces (best practices)

- Readers walk upward to the nearest `.ow/`; explicit `--file` wins; `ow up` stays in cwd.
- Start narrow (`--service`/`--since`/`--tail`/`--grep`); `--full`/`--show-fails` are expensive — check counts first.
- Prefer `--json` when piping into further analysis (stable English keys).
- Join the two worlds by traceId: `ow trace <id>` for timing across services,
  `ow logs --grep <traceId>` for values (once apps log it).

## Reading the output (Turkish labels)

- `görev: ... (N komut, M patlak)` — task header. `[n] <sig> — xN` — repeats.
  `kayıt:` real command (full via `--show`); `niyet:` agent's sentence.
  `(sebep:)`/`(çıktı:)` on failures. `(görev yok)` — intent missing, report
  the count. `(klasör yok)` — cosmetic.

## Budgets (hard numbers, respect them)

- Success excerpts: 2KB stored, 300 chars shown; failures: up to 16KB.
- `--show-fails`/`--full` open everything — check counts first, keep
  `--since` narrow (3h ≈ 150KB); open failures one by one, repeats first.

## Rules

- `doctor` first when results look wrong (stale tail, missing session).
- Sidecar rows land ~5s after session end; browser spans arrive 5–15s late
  in batches (`--wait 15s`). Wait before concluding absence.
- Honesty: report only what the output shows; `completed` with no exit code
  is unknown, not success. Never invent causes. Stuck claims need `--stuck`
  numbers, not impressions.

## Analyzing a session (method)

1. `--since 1d` summary first (add `--tree` for subagent work): volume, failures?
2. Failures → `--show-fails` for those bodies only.
3. Report: task, repeats, failures (with reason), one lesson.
4. Close the loop: propose a script or rule easing the repeat.
