---
name: ow
description: Operate the ow CLI: past session analysis plus dev-service supervision and trace lookup. Use for agent work, service state, or which trace a request produced.
---

# ow — session observer operator manual

`ow` shows what agents actually did: shell commands, file edits, tool calls,
grouped by task with the agent's own words attached. Read-only; it never
changes sessions, files, or the database.

Run it as `ow` from anywhere (via `/setup-ow` install, or `ow` on PATH).
Never memorize log paths or database schemas — `ow` handles all of that.

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
ow timeline [oturum] [--trace <id>] [--since 1d]  # agent rows + spans merged; kesin/exact vs tahmini/estimated links
ow show <session> --json              # stable machine output (show/stuck/meta/sessions/reads/prompts/ps/logs/down/trace)
ow show                               # no session → latest session
```

No ID known: use the `sessionID` of the last sidecar line, or run bare for the
latest session. Exits: 0 ok, 1 structural failure, 2 usage error; non-interactive.

## Service supervision (`up`/`down`/`ps`/`logs`)

Separate surface: supervises dev services declared in a repo's `ow.yaml`
(dev servers, watch-only tails) as plain child processes — no Docker,
no restarts, no dashboard.

```sh
ow up --check --file ow.yaml   # validate only (unknown fields warn, never fail)
ow up -d                       # detach: one supervisor per ow.yaml dir; second up → exit 2
ow ps [--json]                 # running/exited/stopped/unknown + pid, uptime, cpu, mem, port
ow logs [svc] [--tail 200] [--grep foo] [--since 30m] [--json]
ow down [--rm]                 # SIGTERM→5s→SIGKILL; --rm also drops supervisor.json
```

- State is repo-local (`<root>/.ow/`); every pid is `lstart`-guarded, so a
  recycled pid is reported unknown, never signaled.
- Port conflicts warn and still spawn, never reassign.
- `logs:`-only services are legal (external tail watched as `log` stream);
  an early-exiting tail is recorded while siblings survive.
- `env: {K: V}` per service passes env to the child (`OW_SERVICE` always wins,
  never printed). Single line only — the YAML subset reads line by line.
- `required-env: [VAR, ...]` declares what the service needs; `up --check`
  fails (exit 2) naming service + missing vars before anything spawns.
- `ow up` ensures the repo `.gitignore` covers `.ow/` (warn-only).
- `ow doctor` also prints an informational `up:` line (never affects exit code).
- Full schema, caps, and non-goals: product `cli/README.md` ("Service supervision").

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

- Exits: 0 ok/quiet-empty, 1 unknown id or unreadable store, 2 bad/ambiguous id.
- `--json` keys are English (`traces`/`traceId`/`spans`/`truncated`/`depth`).
- Secrets are masked at write time (query strings, credential key=value
  pairs, Bearer forms, UUID/32+hex blobs become `:id`); endpoints and route
  words stay verbatim (doctrine: values never, structure always). Trace output
  is semi-sensitive — review before pasting into public issues. Correlate by
  traceId + endpoint + time, not business IDs.
- Per-stack recipes (Java `-javaagent`, Python `opentelemetry-instrument`,
  browser `-otlp-proto` + CORS): product `cli/README.md` ("İzleme tarifleri").
  App code lives in the app repo; `ow.yaml` carries only `env:` + endpoint.
- Proving a flow: generate the trace ID BEFORE the action, deliver via `set
  headers` (rotates, clears with `'{}'`); never `open --headers` (per-origin
  sticky binding keeps the old ID).

## Working with logs and traces (best practices)

- Run from anywhere under the workspace root — readers (`ps`/`logs`/`trace`/
  `doctor`/`down`) walk upward to the nearest `.ow/`; explicit `--file`
  always wins; `ow up` creates state in cwd only.
- Start narrow, widen on demand: `--service`/`--since`/`--tail`/`--grep`
  first, full dump never. `--full` and `--show-fails` are the expensive
  ones — check counts first (see Budgets).
- Prefer `--json` when piping into further analysis (stable English keys).
- Join the two worlds by traceId: `ow trace <id>` for timing across services,
  `ow logs --grep <traceId>` for values (once apps log it).
- Respect two lags: sidecar rows land ~5s after session end; browser spans
  arrive 5–15s late in batches (`--wait 15s` covers it).

## Reading the output (Turkish labels)

- `görev: ... (N komut, M patlak)` — task header. `[n] <signature> — <outcome>
  xN` — repeats of one command shape; `(agent)` tag shows who ran it.
- `kayıt:` — real command (clipped); full text via `--show`. `niyet:` — the
  agent's sentence. `(sebep: ...)` / `çıktı:` on failures — diagnosis and raw
  output. `(görev yok)` — intent missing; report the count, don't invent
  causes. `(klasör yok)` — cosmetic only.

## Budgets (hard numbers, respect them)

- Success excerpts: 2KB stored, 300 chars shown. Failures: up to 16KB stored.
- `--show-fails` opens EVERY failure at full size. Check the failure count in
  the summary first; with more than 2–3 failures open them one by one with
  `--show N`, most-repeated shape first.
- `--full` dumps every body whole — always pair with a narrow `--since`.

## Rules

- `doctor` first when results look wrong (stale tail, missing session).
- Sidecar writes are asynchronous — wait ~5 seconds after a session ends
  before reading, or the tail may be missing.
- Honesty: report only what the output shows; `completed` with no exit code
  is unknown, not success. Never invent causes. Stuck claims need `--stuck`
  numbers, not impressions.

## Analyzing a session (method)

1. Start with a `--since 1d` summary: where is the volume, where are failures?
   For coordinator work spanning subagents, add `--tree`.
2. If failures exist: `--show-fails` for full text of those only.
3. Report: what the task was, what repeated, what failed (with reason),
   one-sentence lesson for next time.
4. Close the loop: propose a script or prompt/skill rule easing the repeat.
   Next analysis checks whether repeats dropped.
