# `ow` CLI (product-owned, bun-only)

`ow` is the shell-observer command line: session analysis
(`sessions/show/meta/reads/doctor`) plus dev-service
supervision (`up/down/ps/logs`) for user-agent-written `ow.yaml` files.
The observer hooks that feed it live in the opencode plugin directory
(`~/.config/opencode/opencode-plugins/shell-observer/` — `index.ts` +
`shell-observer-core.ts` only); every other CLI source lives here.

Agent skill entry points: `skills/ow/SKILL.md` (pointer) →
`skills/ow-runtime/SKILL.md` (supervision/readiness); generated client
packs live under `plugins/`.

## Bun-only

`cli/` runs **only** under bun. Sources use `bun:sqlite`,
`Bun.spawn`, `Bun.file`/`Bun.serve`, and `bun:test` irreducibly — no
node port (no dual-runtime abstraction by design). There is no typecheck
gate for `cli/`; `bun test cli/` is the gate.

```sh
bun test cli/            # CLI suites (unit + contract)
pnpm ow:build            # compile cli/cli.ts → cli/ow (+ cli/ow.build.json sidecar)
pnpm ow:test             # same as bun test cli/
pnpm ow:fresh            # fresh/stale check for the built binary
pnpm ow:parity           # scripts/check-ow-parity.sh <old> <new> (migration gate)
```

## Build / symlink / freshness

- Build output `cli/ow` (plus temp `cli/ow.cmp` and sidecar
  `cli/ow.build.json`) is gitignored (`/cli/ow*`) — never commit the binary.
- `~/.local/bin/ow` symlinks to `<product>/cli/ow`. Rebuilds are manual
  (`pnpm ow:build`), matching the previous binary discipline.
- `pnpm ow:fresh` compares the sidecar `{sha,dirty}` against current `HEAD`
  + worktree: `fresh` (0), `stale (sources changed, rebuild)` (1),
  sidecar/binary missing (2).
- Byte-identical migration gate: `scripts/check-ow-parity.sh` replays
  `--help`, `up --check` on both committed fixtures, `ps`/`logs --json`
  on missing state, `sessions --json` on the committed fixture log
  (byte-compared), and `doctor --json` by envelope keys + exit code only
  (wall-clock fields vary by construction). Fixtures: `cli/parity-fixtures/`.

## Self-documentation and resolution (`version`, `--help`, `where`)

- `ow --version` / `ow version [--json]` prints the installed build
  identity from the running binary's sidecar (`ow <version> (build
  <sha8>, <time>[, dirty])`; `--json` mirrors `{version,sha,time,dirty,sidecar}`).
  A missing sidecar reads `ow (no build sidecar — rebuild with pnpm ow:build)`
  — never a guessed version. Unrelated flags refuse (exit 2).
- Per-verb help: `ow <command> --help` (and `ow help <command>`) renders
  that verb's usage line, flags, exits and one example. The full
  command list stays on `ow --help`; the global list is the single usage
  source the verb help derives from (help-coverage test).
- `ow where [--file] [--json]` answers "which files did you read?": the
  resolved root, how it was resolved (`--file`, walked up from cwd, or cwd
  with no `.ow` found), and the `ow.yaml` / state dir / `supervisor.json` /
  observer log / intent DB paths ow would use, each with `present|missing`.
  Read-only, always exit 0 (a missing file is data, not a failure);
  unsupported flags refuse exit 2.

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
# session account / reads
./ow meta <sessionID>
./ow reads <sessionID> [--since 1d]
# machine output (stable English keys) for show/meta/sessions
./ow show <sessionID> --json
# exit codes: 0 ok, 1 structural failure, 2 usage error; always non-interactive
```

No bun fallback needed for reading: `ow` is compiled from `cli/cli.ts`
(`pnpm ow:build` → `cli/ow`, darwin-arm64; linux-x64 build is a follow-up).
Direct `bun doctor.ts` / `bun join.ts <session>
[--tree] ...` invocations remain as fallback and share the same
tree loader (`tree.ts`); `ow` subcommands map 1:1 to those views.

`join.ts` is fail-soft: unreadable DB or missing message table yields records with `intent: null` plus a stderr warning, never a crash. The DB schema is OpenCode-internal; if a future version moves the table, only intent attachment degrades — shell logging is unaffected.

Grouped `show` counts records, not commands: the task header
`(N records, M failed)` sums every joined row (shell commands, file
edits, tool calls alike), and `Σruns` over groups always reconciles to
the input row count. Repeated commands group by signature key.
`--since` windows
announce themselves (`window: --since <raw> (cutoff <ISO>)` on stderr,
human only) and ride `--json` as the additive `window: {since, cutoff}`
(or null; absent only on the no-state early-empty `logs` path, where no
window applies); empty renders stay honest (`no X (store: …; window: …)`
naming the searched store, never a silent blank or a false empty).

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
`host:container`), `logs`, `env`, `required-env`, `readiness`. Any other
service option (including the retired `depends_on`) fails `up`/`up --check`
with exit 2 (`<name>: unknown service option: <key>`, key masked) before
anything spawns; block-sequence lists are rejected with a
line-naming error; a service needs `cmd` or `logs` (both allowed —
`logs` then runs as a sibling tail). Services spawn in YAML declaration
order; no ordering feature exists.

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

```yaml
services:
  configuration:
    cmd: ./gradlew bootRun
    port: 8901
  web-live:
    logs: docker logs -f front
```

```sh
ow up --check --file ow.yaml   # validate only (exit 0/2)
ow up -d [--wait 120s]         # detach: one supervisor per ow.yaml dir
ow up <name> [--wait 120s] [--health <name>=<path>] [--file ow.yaml]  # live: add one service via the supervisor + waited (no live lock → bulk up; -d ignored)
ow restart <name> [--wait 120s] [--health <name>=<path>] [--file ow.yaml]  # live: lstart-verified stop + respawn in place + waited (no lock → exit 2)
ow down [name] [--file ow.yaml]  # single: stop only the target (lock/state files kept; --rm is bulk-only → exit 2)
ow reconcile --check [--json] [--file ow.yaml]  # read-only drift report (never mutates)
ow ps [--json]                 # pid, uptime, cpu%, mem, port, listen=yes/no
ow logs [svc] [--tail 200] [--grep foo] [--since 30m] [--json]
ow down [--rm]                 # SIGTERM→5s→SIGKILL; --rm also drops supervisor.json
ow doctor                      # observer health plus an informational up: line
ow init [--force]  # scaffold ow.yaml from repo detection (never overwrites without --force)
```

`ow up -d --wait <duration> [--health <name>=<path> ...]` (e.g. `--wait 150s
--health configuration=/actuator/health`, `--wait` at most 5m) detaches first,
then waits until every declared `port` accepts a TCP connection: exit 0
with `ready: <name> :<port> (<n>s)` per service, exit 1 when any port times
out (`timeout: ...`) or a service exits early (`exited: ... (exit code
N) — ow logs <name>`). A `--health`-flagged service additionally waits for
HTTP 2xx on `http://127.0.0.1:<port><path>` after its TCP gate, and its
`ready:` line carries the path (`ready: configuration
:8901/actuator/health (42s)`); unflagged services keep pure TCP.
`--health` is repeatable (one `<name>=<path>` per occurrence, comma-separated
also accepted) and a CLI flag only — never an `ow.yaml` key, never
supervisor state. Unknown service names, slash-less paths, port-less
services, `--health` without `--wait` (or without `-d`), and any `--health`
with `--check` are usage errors (exit 2, nothing spawns). Services without
a `port` are named (`port undefined (not waited): ...`)
but never waited on; with no declared ports at all `up -d --wait` refuses
exit 2 (`ow: nothing to wait for`), never a silent pass. `--wait` without `-d/--detach` is a usage error (exit 2, nothing
spawns, no `.ow` created), as is any `--wait` combined with `--check`
(`--check` only validates, never waits). `--json` mirrors the human lines with stable
English keys (`{ready, services: [{name, port, status, waitedSec, exitCode?, healthPath?}], noPort}`).
Single-service `--wait` (`up`/`restart <name>`, live supervisor only) reuses the same loop target-only;
see the single-service section below (bulk rules above do not apply there).
`ps` probes the same way per declared port: human `listen=yes/no`,
JSON additive `listening` key (present only with `port`).

Readiness defaults to TCP-accept (a listener answers on the port), not
HTTP/app-health: plain `--wait`/`ps listen` never send HTTP requests and never
inspect response bodies. `--health` is the explicit opt-in that adds one
loopback GET per flagged service — still one-shot and bounded, never a
restart/healthcheck daemon. That stays distinct from the
spawn-time port-conflict probe, which is a best-effort HTTP fetch warning
(`port conflict`) before spawning. One-shot bounded wait only — no
restart/healthcheck daemon semantics.

### Single-service lifecycle + read-only reconcile (M1)

No separate `.ow` patch is needed to add or refresh one service: while the
supervisor lock is live, `up/restart/down <name>` affects only that service —
healthy services are never signaled.

- While the lock is live the client never spawns: it prints a pre-mutation
  diff (`+ to-start:` / `restart:` / `to-stop:`, cmd in masked
  shape), writes one atomic request under `.ow/requests/`, and waits one-shot
  10s for the supervisor's result (no result → exit 1 `request unanswered`,
  never an assumed half-spawn). The supervisor is the sole writer; requests
  run FIFO. An already-running target reports `already running:` (exit 2,
  no spawn). A blind target (unverifiable `lstart`) reports `may already be running:` (exit 2, no spawn — the slot is never treated as free). Live
  single-`up`/`restart` accept `--wait <duration>` (live supervisor only): the action runs first,
  then readiness waits one-shot for the target alone through the same TCP→HTTP/probe loop as bulk
  (exit 0 ready, 1 timeout or early exit; `--health <name>=<path>` is target-only and needs `--wait`).
  With `--json --wait` the action merges one object only on success
  (`{service,action,pid?,diff,ready,services,noPort}` — failed actions keep the plain shape).
  `-d` stays ignored on the single-service path (documented, never detached). A `--wait` on a target
  with no port and no probe refuses exit 2 before any request is written (`ow: nothing to wait for`),
  never a silent pass. With no live lock, `up <name>` falls
  back to classic bulk `up`, `restart` refuses (exit 2, `no running supervisor for restart`), and
  `down <name>` stops the target directly without touching the lock file. Single `down` confirms
  post-stop (`confirmed: {stopped, code}` in `--json`, `follow-up: ow ps <name>` on human output) —
  the pre-shape `diff` goes stale once the process is gone, so re-verify with `ps`.
- `ow reconcile --check` is the witness line: it never mutates, only reports
  `missing | extra | stopped | config-mismatch(cmd-shape/cwd/port/env-names)` plus the suggested open
  command (`ow up/restart/down <name>`). A descendant listener (the
  supervisor records the launcher pid; forking launchers put the listener
  on a child) is owned, not foreign; a partly foreign port reports
  `foreign-port` with additive `ownership: "shared"` (JSON only) and the
  hint `port <p> also held by a foreign listener (UNVERIFIED) — no kill,
  verify the owner`. Exit 0 in sync, 1 on drift, 2 on
  usage. `--json` adds the `reconcile: {inSync, drifts: [{service, kind,
  expected?, running?, hint}]}` envelope (additive). Probes run only on the
  witness verb: `--probe` works with `reconcile --check` only
  (exit 2 elsewhere), and `ps` never executes
  `git`/`lsof`/probes — only the spawn-time and reconcile paths may.
- Secret values never reach state/output/logs: recorded `cmd`/`logsCmd` are
  masked shapes (deterministic, so expected-vs-running shape compare still
  works); `envNames` in state carries manifest-declared names only, never values.

### Runtime provenance (M2, witness report — no mutation)

The supervisor records one observation per spawn (best-effort, ≤2s per
exec): resolved cwd, `git rev-parse HEAD` + `status --porcelain`
(checkout rev/dirty), masked argv shape, interpreter inferred from argv
through one `env`-style wrapper (`NAME=value`/`-i`/`-u`/`-C`/`--unset`/`--`
skipped by position, unknown options fail closed to uninferred;
`python*|uv|bun|node|java|gradlew` — no version exec), java classpath
count/JAR names, `.env*` FILE NAMES in cwd (contents are never read),
record time. Raw argv, secret values and env contents never enter state;
`git`/`lsof` run ONLY at spawn time and on the explicit `reconcile --check`
path — `ps`/`ps --explain` never run them (they render the recorded
value).

```sh
ow ps --explain [service] [--json]  # expected vs running + diff + reason
```

For each service it prints `expected:` (ow.yaml cmd-shape/cwd/port/env-names) vs
`running:` (pid/status/lstart-verdict/listen/cwd/rev/interpreter) +
`readiness:` (probe definition + last-known) + `diff:` lines + a single `reason:`
line. `--json` adds
`{services, explanations: [{service, explanation:
{expected, running, diffs[], provenance, reason, readiness}}]}`.
`reconcile --check`
also shows the recorded rev + live checkout rev (`diff: revision
<old>→<new> (live checkout; no restart needed, report)` — not a
drift, exit unchanged).

### Project-defined readiness (M3, client-side one-shot, no gating)

A service defines an arbitrary local command via
`readiness: {probe: [...], timeout: 10s, needsPort: true}`
(single-line inline; argv-only, no shell; timeout 5s|10s|30s; `needsPort`
without a port is a schema error). The probe runs ONLY on the client
(`up -d --wait`, single `up`/`restart --wait`, `reconcile --check --probe`) — the supervisor never
runs it, no gating/daemon. Contract: the first JSON object on stdout
`{ready: bool, note?, checks?}`; `ready:true` + exit 0 +
timeout-bound + valid JSON = ready, everything else not-ready
(no retry/restart). Timeout is a single-pid kill (a grandchild may leak:
`may-be-leftover-grandchild`); stdout ≤64KB, secret masking mandatory.
`up -d --wait` waits per target first TCP (`needsPort`) then the probe
(`not ready: <name> (probe: <note>)`, JSON `readiness: {kind:
tcp|http-health|probe, ok, note?, waitedSec}`); `reconcile --check
--probe` reports drift + `readiness: ready/not-ready` (total ≤60s
soft budget — the last-starting probe may exceed by one timeout; on overrun
`unmeasured (timeout-budget)`; exit follows drift).
Probe notes classify strictly (no tolerant parser): `no JSON object
(expected first stdout object)` (nothing to parse), `invalid JSON
(expected first stdout object)` (unparseable), `invalid contract
(ready must be true/false)` (parsed, `ready` not boolean); stdout
claiming `ready:true` with a nonzero exit reports
`ready:true on stdout but exit code N` (the claim is suspect, never
trusted).
If `--health` collides with a defined probe, exit 2. Results are recorded
via the request channel (`lastReadiness`, pid-verified); `ps --explain`
shows the definition + result, never runs it.

### Probe code identity + stale-build drift (M-C)

The probe contract carries additive `path?` (resolved module path,
1..512ch) + `digest?` (hex 7..128ch) on `checks[]` entries; a malformed
field drops, the entry survives (no contract-fatal). `reconcile --check
--probe` compares the `basename(path) → digest` declaration of ok entries
against the recorded `artifactDigests` map (live service): mismatch →
`stale-build: <svc> (<base> changed) → rebuild + ow restart <svc>`
(locked template; exit 1, same as other drifts); unrecorded basename →
record-observation (the sole-writer supervisor merges it via the request
channel; no drift/warning). The map is ≤200 entries per service (cap); it
is not revived on respawn (a dead pid's build does not contaminate the new
pid). Wire/human sees ONLY basename + short-8 (≤32 shown, the rest
counted); full path/full digest/probe-argv never reach DOM/HAR/log/wire
(the state file keeps them raw). `--json` adds `artifactDigests`
(abbreviated) + `artifactStale` keys. `ps --explain` shows the recorded map
on a `build: <base>@<short-8> (+N more)` line.


### Spring recipe (instead of sleep/curl)

Spring services start listening long before the actuator is UP:
TCP ready ≠ application ready. Do not create `sleep 90; curl` loops:

```sh
ow up -d --wait 150s --health configuration=/actuator/health
```

- A 404 at `8901 /` is NORMAL Spring behavior — wait on
  `/actuator/health` (2xx) instead of `/`.
- Restart: `ow down && ow up -d --wait 150s --health ...` — do not
  insert a `sleep 4`, `down` stops synchronously.
- Never `pkill`: if you see a stale `already running`, clean it with
  `ow down` (or `ow down --rm` for a dead leftover).
- If you run `down` while waiting, every service reports `exited:`
  (exit around 143) — this is expected, not an error; read the reason a
  service never reached `ready:` with `ow logs <name>`.
- For TCP-ready ports no flag is needed — plain `--wait` suffices.

`ow init` scans the current directory (read-only, capped) for build files
and writes a starter `ow.yaml`: commands only from strong signals (wrappers,
Spring markers, declared scripts), ports and `required-env` names where
provable, weak signals as `#` comments plus a printed checklist.
The generated file is re-validated in-process before reporting. `--force`
keeps a single backup (`ow.yaml.bak`, overwritten each time) — accepted
single-generation behavior, not a rotation.

Init prints a bounded question
catalog (fixed `question:` strings, never interactive): service-cwd confirm,
port confirm, required-env names. Init writes at most the
yaml file — it never edits `package.json`/CI/imports,
never installs anything, never spawns app code.

State lives repo-local in `<root>/.ow/` (`supervisor.json`, `supervisor.lock`,
`logs/<service>.jsonl`), all `0700`/`0600`, atomic tmp+rename writes.
Two clocks: top-level `startedAt` is the supervisor boot (the entry
lock time — a restart never moves it), per-service `startedAt` is the
process spawn (a restart refreshes it). `down` mark-writes preserve
both byte-identically; old files (first-unit-derived top level) still
parse and normalize on the next persist.

`doctor --json` adds the build `identity` envelope beside `checks`:
`installed` (the running binary's sidecar: short-8 `sha8`/`binary8`,
`dirty`, `time` — null with no sidecar) vs the recorded `supervisor`
block (`state` recorded/absent/unreadable, `startedAt`, shorts), plus
`match` (digests compared internally, never emitted: true/false/null).
Human output prints two plain `identity:` lines outside the check
lines, so the exit rule never sees them.
`ow up` also ensures the repo-root `.gitignore` covers `.ow/`
(create-or-append, warn-only) so tooling state never gets committed.
Writers announce their root (`state dir: <root>/.ow` on stderr,
suppressed under `--json`): `up` (except `--check`), `restart`,
`down`. A nested state dir (a
`.ow`-named root or an ancestor workspace) warns — writers stay put
while readers walk up.
Readers (`ps`/`logs`/`down`/`doctor`) resolve the root upward to the
nearest real `.ow/` (explicit `--file` always wins); writers stay put — `ow up`
creates state in the cwd only, never in a parent repo.
Detached runs also append startup warnings/errors to `supervisor.out` —
bounded to a handful of lines (per-line service output streams to the
terminal in foreground, and always persists to per-service JSONL).
Every recorded pid is paired with its `ps lstart` string: any later signal
path re-reads `lstart` and never signals a mismatch (PID-reuse guard).
A second `up` while the lock is live exits 2 (`already running`); stale
locks are reclaimed only after `lstart`-verified death; an unreadable
`lstart` refuses reclaim (no `--force` in v1).

Per-service logs keep `{t, stream, line}` rows (`stdout|stderr|log|event`),
5 MiB / 10,000 lines newest-wins, 8 KiB per-line cap (`…[truncated]…`).
Capture batches in memory (bounded) and drops with a visible `…[dropped: N
lines]…` event rather than blocking the child. An early-exiting `logs:`
tail records `logs command exited` + `logsEnded` while siblings keep running.



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
