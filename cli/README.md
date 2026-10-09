# `ow` CLI (product-owned, bun-only)

`ow` is the shell-observer command line: session analysis
(`sessions/show/stuck/meta/prompts/reads/doctor`) plus dev-service
supervision (`up/down/ps/logs`) for user-agent-written `ow.yaml` files.
The observer hooks that feed it live in the opencode plugin directory
(`~/.config/opencode/opencode-plugins/shell-observer/` — `index.ts` +
`shell-observer-core.ts` only); every other CLI source lives here.

## Bun-only

`cli/` runs **only** under bun. Sources use `bun:sqlite`, `Bun.spawn`,
`Bun.file`/`Bun.serve`, and `bun:test` irreducibly — no node/tsc port
(no dual-runtime abstraction by design). Node-side gates (`pnpm test`,
`pnpm typecheck`) never match `cli/` (product `tsconfig.json` includes
only `src/**`, `test/**`, configs).

```sh
bun test cli/            # CLI suites (unit + contract)
pnpm ow:build            # compile cli/cli.ts → cli/ow (+ cli/ow.build.json sidecar)
pnpm ow:test             # same as bun test cli/
pnpm ow:fresh            # taze/bayat check for the built binary
pnpm ow:parity           # scripts/check-ow-parity.sh <old> <new> (migration gate)
```

## Build / symlink / freshness

- Build output `cli/ow` (plus temp `cli/ow.cmp` and sidecar
  `cli/ow.build.json`) is gitignored (`/cli/ow*`) — never commit the binary.
- `~/.local/bin/ow` symlinks to `<product>/cli/ow`. Rebuilds are manual
  (`pnpm ow:build`), matching the previous binary discipline.
- `pnpm ow:fresh` compares the sidecar `{sha,dirty}` against current `HEAD`
  + worktree: `taze` (0), `bayat (kaynaklar değişti, yeniden derleyin)` (1),
  sidecar/binary missing (2).
- Byte-identical migration gate: `scripts/check-ow-parity.sh` replays
  `--help`, `up --check` on both committed fixtures, `ps`/`logs --json`
  on missing state, `sessions --json` on the committed fixture log
  (byte-compared), and `doctor --json` by envelope keys + exit code only
  (wall-clock fields vary by construction). Fixtures: `cli/parity-fixtures/`.

## Intent join (session-end pipeline)

The sidecar record carries `messageID` (null for old rows), which keys into OpenCode's local `opencode.db` (`session_message` table, row id == hook messageID). The join script attaches the agent's sentence to each command:

```sh
# health first: is the log growing, are hooks firing, db readable?
./ow doctor
# session inventory: id, counts, time span, workdir — filter by window/dir
./ow sessions [--since 1d] [--dir /path/to/project]
# grouped human view (default): one taskRef header, repeats collapsed with xN refs
./ow show <sessionID> [--since 3h]
# whole task tree: parent session plus child (subagent) sessions, hierarchical
./ow show <sessionID> --tree [--since 1d]
# full text for a window / one line / all failures
./ow show <sessionID> --since 3h --full
./ow show <sessionID> --show <ref>
./ow show <sessionID> --show-fails
# tool slices: shell, file edits, MCP/code-mode/read/...
./ow show <sessionID> --kind tool-call --tool mcp
# stuck signals (retries, re-reads, slow runs, interruptions) / session account / prompts / reads
./ow stuck <sessionID> [--tree] [--since 1d]
./ow meta <sessionID>
./ow prompts <sessionID>
./ow reads <sessionID> [--since 1d]
# machine output (stable English keys) for show/stuck/meta/sessions
./ow show <sessionID> --json
# exit codes: 0 ok, 1 structural failure, 2 usage error; always non-interactive
```

No bun fallback needed for reading: `ow` is compiled from `cli/cli.ts`
(`pnpm ow:build` → `cli/ow`, darwin-arm64; linux-x64 build is a follow-up).
Direct `bun doctor.ts` / `bun join.ts <session>
[--tree] [--stuck] ...` invocations remain as fallback and share the same
tree loader (`tree.ts`); `ow` subcommands map 1:1 to those views.

`join.ts` is fail-soft: unreadable DB or missing message table yields records with `intent: null` plus a stderr warning, never a crash. The DB schema is OpenCode-internal; if a future version moves the table, only intent attachment degrades — shell logging is unaffected.

## Service supervision (`ow up/down/ps/logs`)

A user-agent-written `ow.yaml` at a repo root declares dev services; `ow`
supervises them as plain child processes — no Docker control, no dashboard,
no restart/healthchecks (explicit non-goals).

```yaml
services:
  web:
    cmd: bun run dev        # string → sh -c, or argv list (direct, no shell)
    cwd: ./app              # optional, must be a real directory (symlink-rejected)
    port: 3000              # optional; conflict warns, never reassigns
  ext:
    logs: docker logs -f c  # watch-only tail: sibling child, merged as `log`
```

Schema notes: top-level `services:` required; per-service keys are
`cmd|command`, `cwd|working_dir`, `port|ports` (flow list or
`host:container`), `logs`, `env`, `depends_on`. Unknown fields warn (`bilinmeyen alan
yoksayıldı`), never fail; block-sequence lists are rejected with a
line-naming error; a service needs `cmd` or `logs` (both allowed —
`logs` then runs as a sibling tail).

`env` sets per-service environment variables over the inherited process
environment (service value wins over an inherited one; `OW_SERVICE` is always
set last to the service name). It is a single inline flow map of scalar
strings on ONE line, because the YAML subset reads line by line and has
no block maps (a wrapped `{...}` fails `up --check`):

```yaml
  web:
    cmd: bun run dev
    env: {NODE_ENV: development, API_URL: "http://localhost:4000"}
```

Limits: keys `^[A-Za-z_][A-Za-z0-9_]*$`, at most 64 entries, each key+value
at most 4096 bytes. A non-map `env:` (scalar, list, or a block map) is a
hard error naming the service, not a warning, so user environment is never
silently dropped. Values are never printed: not in `ow up --check --json`,
logs, `ps`, `doctor`, or error text.
`required-env: [DB_PASSWORD]` declares names that must exist in the merged
env (`process.env` under service `env:`); missing names fail `up --check`
(and `up`) with exit 2 naming service and variables — key names only, never
values — so a valid-YAML/missing-credential boot failure is caught early.

`depends_on: [ad, ...]` declares order-only startup sequencing: the named
services spawn first, in topological order that stays stable in YAML order
(dep-less files spawn exactly as written). Nothing waits — no port/health
gating, no restart coupling. Unknown names, self-deps and cycles fail
`up`/`up --check` with exit 2 before anything spawns (`up --check --json`
shows the resolved order with `dependsOn` per service):

```yaml
services:
  configuration:
    cmd: ./gradlew bootRun
    port: 8901
  web-live:
    logs: docker logs -f front
    depends_on: [configuration]
```

```sh
ow up --check --file ow.yaml   # validate only (exit 0/2)
ow up -d [--wait 120s]         # detach: one supervisor per ow.yaml dir
ow up <ad> [-d] [--file ow.yaml]  # live: add one service via the supervisor (no live lock → bulk up)
ow restart <ad> [--file ow.yaml]  # live: lstart-verified stop + respawn in place (no lock → exit 2)
ow down [ad] [--file ow.yaml]  # single: stop only the target (lock/state files kept; --rm is bulk-only → exit 2)
ow reconcile --check [--json] [--file ow.yaml]  # read-only drift report (never mutates)
ow ps [--json]                 # pid, uptime, cpu%, mem, port, listen=evet/hayır
ow logs [svc] [--tail 200] [--grep foo] [--since 30m] [--json]
ow down [--rm]                 # SIGTERM→5s→SIGKILL; --rm also drops supervisor.json
ow doctor                      # observer health plus an informational up: line
ow init [--force] [--tracing]  # scaffold ow.yaml from repo detection (never overwrites without --force)
```

`ow up -d --wait <süre> [--health <ad>=<yol> ...]` (ör. `--wait 150s
--health configuration=/actuator/health`, `--wait` en fazla 5m) detaches first,
then waits until every declared `port` accepts a TCP connection: exit 0
with `hazır: <ad> :<port> (<sn>sn)` per service, exit 1 when any port times
out (`zaman aşımı: ...`) or a service exits early (`bitti: ... (çıkış kodu
N) — ow logs <ad>`). A `--health`-flagged service additionally waits for
HTTP 2xx on `http://127.0.0.1:<port><yol>` after its TCP gate, and its
`hazır:` line carries the path (`hazır: configuration
:8901/actuator/health (42sn)`); unflagged services keep pure TCP.
`--health` is repeatable (one `<ad>=<yol>` per occurrence, comma-separated
also accepted) and a CLI flag only — never an `ow.yaml` key, never
supervisor state. Unknown service names, slash-less paths, port-less
services, `--health` without `--wait` (or without `-d`), and any `--health`
with `--check` are usage errors (exit 2, nothing spawns). Services without
a `port` are named (`port tanımsız (beklenmedi): ...`)
but never waited on; with no declared ports at all `up -d --wait` exits 0
immediately. `--wait` without `-d/--detach` is a usage error (exit 2, nothing
spawns, no `.ow` created), as is any `--wait` combined with `--check`
(`--check` only validates, never waits). `--json` mirrors the human lines with stable
English keys (`{ready, services: [{name, port, status, waitedSec, exitCode?, healthPath?}], noPort}`).
`ps` probes the same way per declared port: human `listen=evet/hayır`,
JSON additive `listening` key (present only with `port`).

Readiness defaults to TCP-accept (a listener answers on the port), not
HTTP/app-health: plain `--wait`/`ps listen` never send HTTP requests and never
inspect response bodies. `--health` is the explicit opt-in that adds one
loopback GET per flagged service — still one-shot and bounded, never a
restart/healthcheck daemon. That stays distinct from the
spawn-time port-conflict probe, which is a best-effort HTTP fetch warning
(`port çakışması`) before spawning. One-shot bounded wait only — no
restart/healthcheck daemon semantics.

### Tek-servis yaşam döngüsü + salt-okunur reconcile (M1)

No separate `.ow` patch is needed to add or refresh one service: while the
supervisor lock is live, `up/restart/down <ad>` affects only that service —
healthy services are never signaled.

- While the lock is live the client never spawns: it prints a pre-mutation
  diff (`+ başlatılacak:` / `yeniden:` / `durdurulacak:`, cmd in masked
  shape), writes one atomic request under `.ow/requests/`, and waits one-shot
  10s for the supervisor's result (no result → exit 1 `istek yanıtsız`,
  never an assumed half-spawn). The supervisor is the sole writer; requests
  run FIFO. An already-running target reports `zaten çalışıyor:` (exit 2,
  no spawn). A blind target (unverifiable `lstart`) reports `zaten çalışıyor
  olabilir:` (exit 2, no spawn — the slot is never treated as free). Live
  single-`up` ignores `-d`/`--wait`: the result wait is always the fixed
  one-shot 10s, independent of `--wait`. With no live lock, `up <ad>` falls
  back to classic bulk `up`, `restart` refuses (exit 2, `önce ow up`), and
  `down <ad>` stops the target directly without touching the lock file.
- `ow reconcile --check` is the witness line: it never mutates, only reports
  `eksik | fazla | durmuş | config-farklı(cmd-şekil/cwd/port/env-adları/
  depends_on) | lstart-uyuşmazlığı | port-yabancı` plus the suggested open
  command (`ow up/restart/down <ad>`). Exit 0 in sync, 1 on drift, 2 on
  usage. `--json` adds the `reconcile: {inSync, drifts: [{service, kind,
  expected?, running?, hint}]}` envelope (additive). No probe runs here:
  `--probe` belongs to M3 (exit 2 until then), and `ps` never executes
  `git`/`lsof`/probes — only the spawn-time and reconcile paths may.
- Secret values never reach state/output/logs: recorded `cmd`/`logsCmd` are
  masked shapes (deterministic, so expected-vs-running shape compare still
  works); `envNames`/`dependsOn` in state carry names only, never values.

### Spring tarifi (uyku/curl yerine)

Spring servisleri portu actuator UP olmadan çok önce dinlemeye başlar:
TCP hazır ≠ uygulama hazır. `sleep 90; curl` döngüleri üretmeyin:

```sh
ow up -d --wait 150s --health configuration=/actuator/health
```

- `8901 /` adresinde 404 NORMAL Spring davranışıdır — beklemeyi `/`
  yerine `/actuator/health` (2xx) üzerinde yapın.
- Yeniden başlatma: `ow down && ow up -d --wait 150s --health ...` —
  araya `sleep 4` koymayın, `down` senkron durur.
- `pkill` asla: bayat `zaten çalışıyor` görürseniz `ow down` (ölü
  kalıntıysa `ow down --rm`) ile temizleyin.
- Bekleme sırasında `down` çalıştırırsanız her servis `bitti:` raporlar
  (143 civarı çıkış) — bu beklenen durumdur, hata değil; `hazır:`
  gelmeyen servisin nedenini `ow logs <ad>` ile okuyun.
- TCP≈hazır portlar için bayrak gerekmez — yalın `--wait` yeter.

`ow init` scans the current directory (read-only, capped) for build files
and writes a starter `ow.yaml`: commands only from strong signals (wrappers,
Spring markers, declared scripts), ports and `required-env` names where
provable, weak signals as `#` comments plus a printed checklist. `--tracing`
adds the `trace:` block and per-service OTel `env:` (single-line flow maps);
the generated file is re-validated in-process before reporting. `--force`
keeps a single backup (`ow.yaml.bak`, overwritten each time) — accepted
single-generation behavior, not a rotation.

State lives repo-local in `<root>/.ow/` (`supervisor.json`, `supervisor.lock`,
`logs/<service>.jsonl`), all `0700`/`0600`, atomic tmp+rename writes.
`ow up` also ensures the repo-root `.gitignore` covers `.ow/`
(create-or-append, warn-only) so tooling state never gets committed.
Readers (`ps`/`logs`/`trace`/`down`/`doctor`) resolve the root upward to the
nearest real `.ow/` (explicit `--file` always wins); writers stay put — `ow up`
creates state in the cwd only, never in a parent repo.
Detached runs also append startup warnings/errors to `supervisor.out` —
bounded to a handful of lines (per-line service output streams to the
terminal in foreground, and always persists to per-service JSONL).
Every recorded pid is paired with its `ps lstart` string: any later signal
path re-reads `lstart` and never signals a mismatch (PID-reuse guard).
A second `up` while the lock is live exits 2 (`zaten çalışıyor`); stale
locks are reclaimed only after `lstart`-verified death; an unreadable
`lstart` refuses reclaim (no `--force` in v1).

Per-service logs keep `{t, stream, line}` rows (`stdout|stderr|log|event`),
5 MiB / 10,000 lines newest-wins, 8 KiB per-line cap (`…[kesildi]…`).
Capture batches in memory (bounded) and drops with a visible `…[atıldı: N
satır]…` event rather than blocking the child. An early-exiting `logs:`
tail records `logs komutu bitti` + `logsEnded` while siblings keep running.

### İzleme tarifleri (per-stack)

Distributed tracing is opt-in per repo: a `trace:` block starts the embedded
loopback OTLP/HTTP receiver (`127.0.0.1:4319` by default, `trace: {port: N}`
overrides), and each service opts in by writing `env:` explicitly — `ow`
never injects OTEL variables into services (D4). Spans land redacted and
capped in `<root>/.ow/traces/spans.jsonl`; read them with `ow trace`
(recent list) and `ow trace <id>` (one parent/child tree).
`ow trace --wait 15s` polls up to 5 minutes for a newly arriving span
(batch exporters land late) and then renders once. If the receiver port is taken, `up` warns loudly with host+port and `ow doctor` appends an `alıcı dinlemiyor` hint to the trace line.
The trace list hides ok single-span orphans (noise); `--min-spans 1` shows all, `--min-spans N` keeps ≥N-span traces. Error traces always render; direct `ow trace <id>` is unaffected.

```yaml
trace:
  port: 4319
services:
  api:
    cmd: ./gradlew bootRun
    env: {JAVA_TOOL_OPTIONS: "-javaagent:.ow/otel/opentelemetry-javaagent.jar", OTEL_SERVICE_NAME: api, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4319", OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf, OTEL_METRICS_EXPORTER: none, OTEL_LOGS_EXPORTER: none}
  worker:
    cmd: opentelemetry-instrument python -m app
    env: {OTEL_SERVICE_NAME: worker, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4319", OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf, OTEL_METRICS_EXPORTER: none, OTEL_LOGS_EXPORTER: none}
```

Rules that are load-bearing, not stylistic:

- `OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf` is pinned in every recipe:
  the receiver decodes protobuf only (Java's first-party exporters ship
  `grpc` + `http/protobuf`; a `grpc` default would silently send nothing).
- `OTEL_METRICS_EXPORTER=none` + `OTEL_LOGS_EXPORTER=none` are mandatory:
  the receiver serves `/v1/traces` only (anything else is 404), so leaving
  metrics/logs enabled spams the service's own stdout with exporter errors.
- The Java agent jar is never auto-downloaded. Provision it by hand into
  the conventional path, then `ow doctor` reports present/absent:
  `mkdir -p .ow/otel && curl -L -o .ow/otel/opentelemetry-javaagent.jar https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar`
- `-javaagent` resolves relative to the service `cwd`; use an absolute jar
  path when the service `cwd` differs from the `ow.yaml` root.

Python + `uv` (verified 2026-10-08, distro 0.66b1): `opentelemetry-bootstrap
-a install` fails inside a `uv`-managed venv because bootstrap shells out
to `python -m pip` and uv venvs ship no pip. Skip bootstrap; install the
needed instrumentors with uv directly, then run the venv's own
`opentelemetry-instrument` binary:

```sh
uv venv --python 3.13 svc && uv pip install --python svc/bin/python \
  opentelemetry-distro opentelemetry-exporter-otlp \
  flask opentelemetry-instrumentation-flask opentelemetry-instrumentation-requests
OTEL_SERVICE_NAME=worker OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319 \
  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
  OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none \
  svc/bin/opentelemetry-instrument svc/bin/python svc/worker.py
```

Interop proof (kept, disposable clone): javaagent 2.32.0 on JDK 24 →
Flask worker crossed one request into a single `traceId`
(`api`-server → `api`-client → `worker`-server, W3C `traceparent` handled
by the agents, no manual header code), decoded by the same M1 path as the
unit fixtures. Only allowlisted keys land on disk; path identifiers arrive
masked (`/orders/:id`), query strings and `Authorization` values never do.
Sanitizer doctrine: values (query strings, credential key=value pairs,
Bearer/credential forms) are never stored; structure (endpoints, short IDs,
route words) is kept verbatim because traces stay local. Trace output is
still semi-sensitive (it carries resource IDs) — review before pasting into
public issues.
Attribute gate: any non-secret key is stored (business attributes like
`silent_dequeue_reason` included) after value sanitization. Dropped outright:
secret-shaped keys (`password`, `secret`, `api_key`, `private_key`,
`credential`, token-family keys, `authorization` header dumps — only the exact
`token_count` metadata key is exempt) and raw-payload keys (`url.full`,
`db.query.text`, headers, `exception.message`). Credential-shaped values
still mask (`Bearer`/JWT/provider tokens/`key=value`/≥32-hex), everything
else stores verbatim. A `File.ext:line` shape after a secret word reads as a
stack location, not a credential, and survives. Exception events decode to type/message/reduced
frames (first 4 events, 5 frames + count); anything else event-shaped is
dropped. The `exception.message` drop above applies to span attributes only;
the exception event's type/message go through the same shared value masking
(`password=`, `Bearer`, provider tokens, long hex), and frames are reduced to
`file:line in function` with arguments and locals stripped. `ow trace <id>`
shows the type and an 80-character message snippet on error spans; full frames
appear only in `--json`.

Local vs second pipeline: local export ALWAYS targets the ow receiver
(`http://127.0.0.1:4319`, `http/protobuf`) — never repurpose that endpoint
for a second backend. Langfuse (or any remote) is a SEPARATE exporter with
its own endpoint/headers (e.g. its OTLP/HTTP URL plus auth headers).
Fail-fast the remote leg so a dead host cannot stall startup:
`OTEL_EXPORTER_OTLP_TIMEOUT` low (export RPC deadline, ms) with a tight
`OTEL_BSP_SCHEDULE_DELAY` (batch export cadence, ms). If startup logs
connection-error spam, it comes from the app's own exporter, not the ow
receiver — check which endpoint the errors name.

### İzleme tarifleri (tarayıcı)

No zero-code option exists for browsers: `ow.yaml` can pass the endpoint
via `env:`, but it cannot inject code into the bundle. The app's
`tracing.ts` lives in the app repo and must be wired by hand; only this
recipe lives here — never advertise browser tracing as automatic.

`src/tracing.ts`, imported first in `main.tsx`, dev-only guard:

```ts
// MUST be the protobuf exporter (D10): the -otlp-http package sends JSON,
// which the receiver does not decode.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { ZoneContextManager } from "@opentelemetry/context-zone"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { getWebAutoInstrumentations } from "@opentelemetry/auto-instrumentations-web"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"

if (import.meta.env.DEV && import.meta.env.VITE_OTEL_ENDPOINT) {
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "web" }),
    spanProcessors: [new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${import.meta.env.VITE_OTEL_ENDPOINT}/v1/traces` }))],
  })
  provider.register({ contextManager: new ZoneContextManager() })
  registerInstrumentations({ instrumentations: [getWebAutoInstrumentations()] })
}
```

Packages: `@opentelemetry/sdk-trace-web`
**`@opentelemetry/exporter-trace-otlp-proto`**
`@opentelemetry/context-zone @opentelemetry/auto-instrumentations-web
@opentelemetry/instrumentation`. The `-proto` suffix is load-bearing: the
`-otlp-http` package sends JSON and produces zero spans against this
receiver (a JSON `content-type` fails loudly, never silently).

`ow.yaml` side (`env:` only — span export goes straight to the receiver,
not through Vite):

```yaml
  web:
    cmd: vite dev
    env: {VITE_OTEL_ENDPOINT: "http://127.0.0.1:4319"}
```

CORS shape (verified live with a real browser):

- Span export relies on the receiver answering preflight for loopback
  origins only (D6). No proxy is involved on this path.
- The app's own `/api` calls stay same-origin through the ordinary Vite
  proxy, which matters only because a same-origin call avoids a backend
  CORS preflight that could strip `traceparent`.
- For any cross-origin frontend→backend hop, the backend must also allow
  `traceparent` through `Access-Control-Allow-Headers`, or continuity
  silently breaks at the boundary.
- Optional paired variant (both change together, otherwise unrelated to
  span export): proxy `/otel/v1` → `127.0.0.1:4319` with a rewrite plus a
  relative `VITE_OTEL_ENDPOINT=/otel`, making export same-origin (no
  preflight at all). The verified v1 path is D6 direct-to-receiver.

Trace roots (D8): the browser hides navigation request headers from page
JS, so a trace starts at the frontend SDK by default — the robot just
clicks and the trace is found via `ow trace` (newest-first). A manual
`window.__TRACE_ID__` bridge (agent writes, `tracing.ts` reads) stays an
optional dev-only pattern: documented here, not implemented or verified.

Live proof (kept, disposable clone): instrumented page → same-origin Flask
API produced one `traceId` (`web`-click → `web`-fetch → `api`-span),
`content-type: application/x-protobuf` decoded by the M1 path; robot
`set headers` rotation yielded disjoint backend traces per injected ID,
`set '{}'` cleared cleanly, and the sentinel sweep over the resulting
`spans.jsonl` found no secrets, query strings, or raw headers.

## Change discipline (evidence before code)

No addition lands on the strength of an idea. Every change must show,
in order:

1. The problem on real log data (a concrete row, not a scenario).
2. Precision on the same data (no false positives — e.g. a loose rule
   flagging 7 healthy families out of 9 gets tightened or dropped).
3. Live verification in a real session that the code does what it claims.

If it doesn't prove useful, it doesn't ship.

## Validation

From the product repo root:

```sh
bun test cli/
```

OpenCode's V2 plugin guide documents `ctx.tool.hook("execute.before" | "execute.after")`; the test harness checks the registered callbacks and serialization without starting or restarting the OpenCode service. Actual service plugin loading requires the user to apply the snippet and reload/restart OpenCode (manual step — this change does not restart any service).
