---
name: ow-ow-runtime
description: "Supervise ow services and readiness: up/ps/logs/reconcile/preflight/readiness, init/provision, replay/contract recipes, trace lookup. Use for service state, readiness gates, or traces."
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
- `depends_on: [a, b]` sorts spawn order only; unknown names, self-deps,
  cycles → exit 2 before anything spawns.
- `ow up` ensures the repo `.gitignore` covers `.ow/` (warn-only).
- `ow doctor` also prints an informational `up:` line (never affects
  exit code). Readers walk upward to the nearest `.ow/`; explicit
  `--file` wins; `ow up` stays in cwd.

## Drift, provenance, preflight, readiness

- `ow reconcile --check` drift kinds with English hints (`missing`,
  `extra`, `stopped`, `config-mismatch`, `lstart-mismatch`,
  `foreign-port`, `stale-build` for stale build identity). A descendant
  listener (forking launcher) is owned, not foreign; a partly foreign
  port reports `foreign-port` with `ownership: "shared"` (JSON only) and
  `port <p> also held by a foreign listener (UNVERIFIED) — no kill,
  verify the owner`. Never kill a port-holder on this output.
- `ow preflight [--file] [--json] [--probe]`: read-only gate, no
  mutation; exits 0 pass / 1 missing / 2 usage. `--probe` is one-shot
  loopback TCP on declared ports only (≤60s budget).
- `ow readiness [--file] [--json] [--probe]`: full preflight
  composition (4 gates: reconcile/provenance/readiness + boundary)
  plus digest/migration report; never runs probes. Exits 0 ready /
  1 missing-stale-false-green / 2 usage-or-invalid-ow.yaml.
  `--json` is `{ready, missing[], stale[], falseGreens[], gates[]}`.
  Port-open alone is never readiness evidence — teach `readiness`.
- The boundary gate (`boundary:`-prefixed, fail-closed) matches
  scenario `real-read-only | real-state-changing | subscribed` claims
  against recorded evidence; `unverified`, `network-deny`,
  `blocked:*`, and unknown services never fail it. Known-false-green
  catalog (positive evidence only): `stale-jar` (`stale-build:`),
  `origin-403` (a recorded 403 is an origin gate, not down),
  `msw-vite-trap` (mock markers or frozen `vite preview` build),
  `v5-confusion` (non-v1 ow.yaml `version:` assumed v1).

## Init and provision

- `ow init [--force] [--tracing]` scans the directory (read-only,
  capped) and writes at most `ow.yaml` + `ow.scenarios.yaml` +
  `.ow/replay/.gitkeep`. Empty/compose-only dirs: honest message, no
  files. Existing files refuse without `--force` (exit 2,
  byte-identical); `--force` keeps exactly one `.bak` per yaml.
  The scenarios file is INERT (commented probes, placeholder keeps
  `--check` green; the singular runner refuses it until uncommented).
  A bounded `question:` question catalog prints when scaffolding.
- `ow provision --check [--file] [--json] [--probe]` is the
  workspace checklist (`.env` symlink + `.venv` + HEAD + preflight
  gate). Read-only, exits 0 pass / 1 missing; never gates other verbs.

## Replay and contract

Deterministic scenarios ship with a recorded contract (plan M5,
landed). `ow record <scenario> [--file]` captures one deterministic
scenario's declared probes once (bounded one-shot exec of declared
argv only) into `.ow/replay/<boundary>/<hash>.jsonl`: line 0 is the
provenance envelope (`{checkout, head, interpreter, runnerHash, at,
scenario?, attempt?}`, all four first fields mandatory or the record
fails closed), the rest are probe outcomes (digests, masked shapes,
scrubbed notes — never raw argv/stdout/paths). Per-file `0600`,
≤256KB / ≤500 lines, atomic tmp+rename. `replayedFrom` is always null
on capture and is the SOLE replay-linkage mechanism; `X-Ow-Replay`
stays future-HTTP-only, never on probe transport.

- Never replayed: `real-state-changing` and `blocked:*` refuse with
  exit 2 naming the boundary, on both verbs. Unknown scenario names
  and unverified-only scenarios fail closed without writing.
- `ow contract check [--json] [--file]` recomputes definition
  digests and compares: exit 0 match, 1 `contract-mismatch:` /
  `unknown-record:` / `provenance-missing:`, 2 usage or a
  state-changing scenario in scope. `--json` is `{pass, compared[]
  ({scenario, hash, match, detail}), missing[]}`.
- Opaque caller claims (record-only): `--claim-entrypoint <text>` +
  repeatable `--claim-boundary <name>=<kind>:<ref>` (kind `real|fake`
  only, stored verbatim). Malformed claims refuse `invalid-boundary:`
  exit 2 before any probe runs; outside `record` both flags refuse
  exit 2. Record echoes and `contract check` reads back verbatim
  (`claims: …` lines; `--json` gains `claims` + `claimsStatus`).
  Claimless records read the unverified gap
  (`claims: unverified (no caller claims recorded)`); tampered ones
  read `claims: uninterpretable (UNVERIFIED)`.
  Claims never affect digests, placement, refusals, or pass/match.
- Scrubber runs BEFORE the cap: B3 value masking plus CWD-absolute
  paths folding to `<root>`. Checkpoints stay runner-written —
  `ow` writes replay only, never checkpoints.

## Handoff (between agents/sessions)

Hand over supervision with readings, never handles: `ow ps` status,
the `<root>/.ow/` location, and supervisor liveness (the `ow doctor`
`up:` line). Never hand over bare pids (they recycle — `lstart`
guards them), log contents, or env values. The next agent
re-verifies with `ow ps` and `ow reconcile --check` before acting; a
dead supervisor means `ow down` first, never adoption.

## Trace (OpenTelemetry, optional)

Off unless the repo's `ow.yaml` has a top-level `trace:` block (flat:
port, default `127.0.0.1:4319` — never 4318, that's the dashboard
port). When on, `ow up` also starts a loopback OTLP/HTTP-protobuf
receiver and stores sanitized spans in
`<root>/.ow/traces/spans.jsonl`. No block → no listener, no dirs,
nothing changes.

```sh
ow trace [--tail 20] [--since 1d] [--service api]  # newest-first list
ow trace <traceId|8hex-prefix> [--json]            # one span tree
ow trace <traceId> --wait 15s                      # wait for late spans, then render
ow doctor                                          # trace open/closed + span count + hint when 0 spans
```

- Exits: 0 ok/empty, 1 unknown/unreadable, 2 bad id. `--json` keys
  are English (`traces`/`traceId`/`spans`/`truncated`/`depth`).
- Secrets are masked at write time (query strings, credential pairs,
  Bearer forms, UUID/32+hex → `:id`); endpoints/route words stay
  verbatim (values never, structure always). Trace output is
  semi-sensitive — review before pasting. Correlate by traceId +
  endpoint + time, not business IDs.
- Per-stack recipes (Java `-javaagent`, Python
  `opentelemetry-instrument`, browser `-otlp-proto` + CORS): product
  `cli/README.md`. App code lives in the app repo; `ow.yaml` carries
  only `env:` + endpoint. Proving a flow: generate the trace ID
  BEFORE the action; deliver via `set headers` in the browser session
  (rotates, `'{}'` clears); never `open --headers`.
- `doctor` hints: 0 spans → `ow ps`; unknown service →
  OTEL_SERVICE_NAME; not-listening → foreign port-holder. One port,
  one receiver: two listeners on 4319 → first wins.
- Start narrow (`--service`/`--since`/`--tail`/`--grep`); prefer
  `--json` when piping. Join the two worlds by traceId: `ow trace
  <id>` for timing, `ow logs --grep <traceId>` for values.
