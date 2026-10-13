# `ow` CLI (product-owned, bun-only)

`ow` is the shell-observer command line: session analysis
(`sessions/show/stuck/meta/prompts/reads/doctor`) plus dev-service
supervision (`up/down/ps/logs`) for user-agent-written `ow.yaml` files.
The observer hooks that feed it live in the opencode plugin directory
(`~/.config/opencode/opencode-plugins/shell-observer/` — `index.ts` +
`shell-observer-core.ts` only); every other CLI source lives here.

Agent skill entry points: `skills/ow/SKILL.md` (pointer) →
`skills/ow-runtime/SKILL.md` (supervision/readiness) +
`skills/ow-scenarios/SKILL.md` (scenarios/evidence); generated client
packs live under `plugins/`.

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

Grouped `show` counts records, not commands: the task header
`(N records, M failed)` sums every joined row (shell commands, file
edits, tool calls alike), and `Σruns` over groups always reconciles to
the input row count. `durationMs` scopes narrower: `stuck` `slow:` only
considers command rows with `durationMs ≥ 30s` (edits/reads never
surface there); retries key on command signatures. `--since` windows
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
`host:container`), `logs`, `env`, `depends_on`. Unknown fields warn (`unknown field ignored`), never fail; block-sequence lists are rejected with a
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
ow up <name> [-d] [--file ow.yaml]  # live: add one service via the supervisor (no live lock → bulk up)
ow restart <name> [--file ow.yaml]  # live: lstart-verified stop + respawn in place (no lock → exit 2)
ow down [name] [--file ow.yaml]  # single: stop only the target (lock/state files kept; --rm is bulk-only → exit 2)
ow reconcile --check [--json] [--file ow.yaml]  # read-only drift report (never mutates)
ow provision --check [--json] [--probe] [--file ow.yaml]  # worktree checklist: .env symlink + .venv + HEAD + preflight gate (read-only, exit 0 pass / 1 missing / 2 usage; never gates up/ps/reconcile/preflight)
ow ps [--json]                 # pid, uptime, cpu%, mem, port, listen=yes/no
ow logs [svc] [--tail 200] [--grep foo] [--since 30m] [--json]
ow down [--rm]                 # SIGTERM→5s→SIGKILL; --rm also drops supervisor.json
ow doctor                      # observer health plus an informational up: line
ow init [--force] [--tracing]  # scaffold ow.yaml from repo detection (never overwrites without --force)
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
  single-`up` ignores `-d`/`--wait`: the result wait is always the fixed
  one-shot 10s, independent of `--wait`. With no live lock, `up <name>` falls
  back to classic bulk `up`, `restart` refuses (exit 2, `no running supervisor for restart`), and
  `down <name>` stops the target directly without touching the lock file. Single `down` confirms
  post-stop (`confirmed: {stopped, code}` in `--json`, `follow-up: ow ps <name>` on human output) —
  the pre-shape `diff` goes stale once the process is gone, so re-verify with `ps`.
- `ow reconcile --check` is the witness line: it never mutates, only reports
  `missing | extra | stopped | config-mismatch(cmd-shape/cwd/port/env-names/
  depends_on) | lstart-mismatch | foreign-port` plus the suggested open
  command (`ow up/restart/down <name>`). A descendant listener (the
  supervisor records the launcher pid; forking launchers put the listener
  on a child) is owned, not foreign; a partly foreign port reports
  `foreign-port` with additive `ownership: "shared"` (JSON only) and the
  hint `port <p> also held by a foreign listener (UNVERIFIED) — no kill,
  verify the owner`. Exit 0 in sync, 1 on drift, 2 on
  usage. `--json` adds the `reconcile: {inSync, drifts: [{service, kind,
  expected?, running?, hint}]}` envelope (additive). Probes run only on the
  witness verbs: `--probe` works with `reconcile --check`, `preflight`,
  `readiness` and `provision --check` (exit 2 elsewhere), and `ps` never executes
  `git`/`lsof`/probes — only the spawn-time and reconcile paths may.
- Secret values never reach state/output/logs: recorded `cmd`/`logsCmd` are
  masked shapes (deterministic, so expected-vs-running shape compare still
  works); `envNames`/`dependsOn` in state carry names only, never values.

### Runtime provenance (M2, witness report — no mutation)

The supervisor records one observation per spawn (best-effort, ≤2s per
exec): resolved cwd, `git rev-parse HEAD` + `status --porcelain`
(checkout rev/dirty), masked argv shape, interpreter inferred from argv
(`python*|uv|bun|node|java|gradlew` — no version exec), java classpath
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
(`up -d --wait`, `reconcile --check --probe`) — the supervisor never
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

### Evidence envelope + checkpoint convention (P2-A)

The runner (project-owned) writes its verified steps as one-JSON-per-line
envelopes into `<root>/.ow/checkpoints/<run>.jsonl` (atomic tmp+rename,
≤256KB/≤500 lines — on overrun the runner prunes oldest-first); ow only
reads and shows them, never writes/prunes. The envelope carries `{stage,
status confirmed|not_observed|stale, proof, at, by, code?, runtime?,
safe_next_action?, side_effect? (none|attempted|confirmed|unknown),
side_effect_counts? ({attempted?, confirmed?} 0..999999), scenario?,
attempt? (1..999), step_signature? (1..128ch), code? ({runner?, fixture?,
body?, provider_contract?} — each slot 1..64ch)}`; `proof` is capped at
8KB + secret-masked, and with both `code`/`runtime` absent the envelope
becomes `stale (missing_basis)` (counted as a one-sided missing code-map
mismatch). The basis is the first (earliest-written) confirmed line of the
same stage in the file: the 4 code slots are compared in fixed order
(runner → fixture → body → provider_contract), and any code-slot
difference yields the enum-constant `stale (script_hash)` (code-map
mismatch; no new `stale_reason`), then runtime. Legacy
`script_hash`/`checkout_rev` are accepted on read (`script_hash→body`,
`checkout_rev→runner`); if the same slot arrives under both names the line
is corrupt (fail-closed, no silent win). Every slot follows the 1..64ch
`revField` discipline (a secret-shaped `***` is masked, a long value breaks
the line).

`ow checkpoints list [--json]` lists runs (name + envelope count + summary
+ last `at`); `ow checkpoints show <run> [--json]` renders the lines in
`confirmed/not-observed/stale` language, adds one
`side-effect: <stage> (none|attempted|confirmed|unknown[, attempted: N][, confirmed: M])`
flag line per envelope, and at the end shows `last confirmed` + `first
missing` + the runner's `next` passthrough (comments are not included). A
missing `side_effect` ≡ `unknown` (no warning); the counts are render-only
(ow never computes them). When a stage has `attempted` without a following
`confirmed`, one locked hint line is printed:
`before-retry: ow reconcile --check` (no button/automatic action). Lineage
(`scenario` 1..64ch RUN_NAME_PATTERN-shaped, `attempt` 1..999 integer,
`step_signature` 1..128ch opaque string — all three additive-optional; a
malformed value breaks the line) is grouped into a `scenario: <name>` →
`attempt <N>: <stage> (<status>[, unconfirmed])` tree: explicit fields win,
otherwise the run-name suffix (`-attempt<N>`) is the fallback,
and with neither the line stays unattributed (in the flat list, never
grouped). Freshness ignores these fields (orthogonal). A missing file is
exit 1, corrupt lines are skipped as `corrupt-line: N (skipped)`, an
invalid run name is exit 2. Live exec (probe/health/git/lsof) is absent on
these paths; ow never interprets the `proof` content.

`ow checkpoints diff <runA> <runB> [--json]` compares two runs in an
envelope-by-stage table (read-only, no mutation/spawn): one
`diff: <stage> (<statusA> -> <statusB>)` line per stage plus only the
changed `proof:` (masked + root-folded 80-char head) and `digest:`
(short-8) cells; one-sided stages render as `missing`. Identical runs
print a single line (`identical: <runA> == <runB> (<n> stages)`).
`--json` is additive `{runA, runB, identical, rows: [{stage, statusA,
statusB, staleReasonA, staleReasonB, proofHeadA, proofHeadB, digestA,
digestB, changed}], skipped: {runA, runB}}`. Exits: 0 table shown
(identical included), 1 missing/unreadable run, 2 usage error. The
digest covers status, stale reason, proof, code/runtime slots and the
freshness-orthogonal witness fields (side_effect, counts, scenario,
attempt, step_signature, data).

### Export bundle (one redacted snapshot for tickets)

`ow export --bundle [<run>] [--file] [--out <path>]` composes existing
readers only — `ps --explain`, per-service `logs` tails (50 per
service), `failures --since 24h`, `preflight --json`, plus
`checkpoints show <run>` when a run is given — into ONE local markdown
file with a fenced `preflight --json` block. No new data collection,
no trace readers (trace IDs/spans never enter the bundle as readings).
Redaction applies to every section: trace/span/traceparent-shaped values
masked, secret masking on all free text, abs paths folded (`<root>` for
the workspace root, `<elsewhere>/<basename>` for any other absolute
path), full revs/digests shortened to 8 chars. The preflight fence is
parsed first and redacted per JSON value with explicit serialization,
so masking can never corrupt its structure; a present-but-invalid fence
refuses the bundle loudly instead of embedding broken text. The default
path is `.ow/bundle-<timestamp>.md`; `--out` must stay root-relative
(absolute/traversal values refuse with exit 2 echoing the basename
only). Writes are atomic tmp+rename with `0600` perms. Exits: 0
written (`bundle: <relative-path>`), 1 nothing readable (no file
written), 2 usage. Sections with no data render an explicit
`empty: <reason>` line, never silence.

Composition runs in a killable child under a 60s deadline (timers
alone cannot interrupt synchronous in-process work, so the parent
SIGKILLs the child on expiry): timeout prints
`export: timed out after <N>ms (no bundle written)`, exits 1, and
writes no file. Cooperative phase checks abort slow-but-moving runs
at section boundaries with the same line.

### Mechanical failure list (M-D, read-only)

`ow failures [--since 30m|3h|1d|1w] [--json]` lists repeat failure classes
across every retained checkpoint run. Candidates are post-freshness
non-confirmed envelopes, optionally filtered by envelope `at` (any
`<amount>m|h|d|w` window; `--since` outside the shared grammar is a
usage error, exit 2). Buckets use
strictly the runner-declared tuple `(stage, status, stale_reason,
step_signature)` — a missing step forms its own bucket and renders
as `-` in human output (`step: null` in `--json`, so a literal
runner-declared `"-"` step stays distinguishable); nothing else decides
the bucket (no message scan, no inference). The two-attempt rule lives
here, never in `show`: a `(scenario, stage)` partition renders only with
2+ non-confirmed occurrences (explicit lineage fields win, run-name
suffix is the fallback, unattributed lines partition under no scenario);
singletons fold into one fixed line, `no-repeat: <n> unique findings
unlisted`. Empty output names its store (`no findings (store: <dir>;
window: <raw|all>)`). Exit is 0 except when files
exist but nothing is readable (all corrupt/capped → exit 1). The command
never executes, writes, or prunes (bounded file reads only). `--json`
returns additive English keys `{groups: [{stage, status, stale_reason,
step, count}], singletons, skipped: {corrupt, overCap}, window}` (`window`
is `{since, cutoff}` when `--since` filters, else null).

### Preflight gate (P2-B, read-only)
`ow preflight [--json] [--probe] [--file ow.yaml]` is the single gate
before the runner's `prepare`: it combines the `reconcile --check` diffs +
the expected/running config identity of live services (provenance lens) +
the state's `lastReadiness` (last-known) results into one envelope; it also
drops the gate on stale/not-observed lines in the checkpoint envelopes. No
mutation (never calls spawn/stop/restart), no gating (the runner decides).
On pass, exit 0 (`ready: environment passed preflight`); on failure, exit 1
+ the missing list (`missing: …`, `stale: …`, `not-ready: …`); a
usage error is exit 2. `--json` adds `{pass, gates: [{name:
reconcile|provenance|readiness|boundary, pass, detail}], missing, envelopes}`
(`detail` embeds the M1 subtrees verbatim). There is NO unflagged live
exec; `--probe` adds one-shot loopback TCP confirmation for declared ports
(total ≤60s budget, on overrun `(unmeasured: timeout-budget)`); a recorded
failure (`not-ready`) beats live TCP. With no `lastReadiness` the gate
drops with `unmeasured`.

Runner recipe (docs-only, no code): the runner calls `ow preflight --json`
on the first line of `prepare`; if `pass:false` it does not start the job
and logs `missing[]` verbatim; no retry/suggestion is produced on the ow
side.

### Scenario schema (read-only validation)

`ow.yaml` stays lean: scenarios live in a separate file
(`<root>/ow.scenarios.yaml`, `version: 1`) that ow validates but never
RUNS (`ow scenarios --check [--json] [--file]`). Each scenario
references ow.yaml service names (unknown names warn as UNVERIFIED,
never fail); boundaries follow the M1 taxonomy (`real-read-only |
real-state-changing | network-deny | subscribed | blocked:<reason> |
unverified`), legacy values dual-read with a warning (never fail);
targets/checkpoints are opaque strings (no network policy,
secret-masked); each probe carries `{id, argv (at most 16 parts, at
most 512B each, no shell), timeout (5s|10s|30s, default 10s)}`:

```yaml
version: 1
scenarios:
  truck-approval:
    services: [api]
    boundaries: [real-read-only]
    targets: [http://127.0.0.1:8901/approval]
    probes: [{id: ready, argv: [./scripts/ready-approval.sh, --local], timeout: 10s}]
    checkpoints: [approval-ready]
```

Explicit `services: []` is valid and means "no services by decision"
(probe-only scenarios such as env audits); it still requires at least
one probe, otherwise a schema error (exit 1) — a scenario that checks
nothing never goes green by vacuity. A missing `services:` key stays a
schema error. Readers treat empty services as nothing to bring up:
no `up`, no service readiness, no service-bound claims; `preflight` /
`readiness` pass the boundary gate vacuously with an explicit
`unmeasured: boundary claims (probe-only: <name>)` note (plus a
`serviceless[]` entry in the gate detail), never a silent skip.

Legacy mapping (unconditional dual-read, one warning per value per file
`legacy-boundary: <v> → <m> (warning)`): `real→real-state-changing`,
`local→real-read-only`, `captured-response→subscribed`, `fake→unverified`,
`test→unverified`. `network-deny` is new-only (no legacy source).
Unknown/empty values fall to `unverified` with an `unknown boundaries:
<v> (UNVERIFIED)` warning (never a failure, never silent). `blocked`
cannot stand alone — `blocked:<1..128-char reason>` is required (e.g.
`blocked:"maintenance work"`; quoting is mandatory for reasons with
commas), otherwise a schema error (exit 1).

Exits: 0 ok (even with warnings), 1 schema error, 2 usage; a missing
file is exit 1 (`scenario file missing` — `--check` is a validation
verb, never silently passing a wrong path). `--json` is additive
`{file, scenarios: [{name, services, boundaries, targets, probes:
[{id, argvShape, timeout}], checkpoints}], boundariesNormalized:
[{scenario, boundaries}], boundaryWarnings[], warnings}` (raw argv
never prints, masked shape only; `boundaries` holds raw file values,
the normalized view lives in `boundariesNormalized`). Subset-YAML
single-line rule: block-map style fails naming the line with an inline
example.

### Readiness (boundary-witnessed readiness)

Open port ≠ ready, health-200 ≠ ready: port/health green alone is never
readiness evidence — teach `ow readiness`, not sleep/curl loops.
`ow readiness [--json] [--probe] [--file]` is a read-only full preflight
composition (4 gates: reconcile/provenance/readiness + boundary) plus a
digest/migration report; it never RUNS probes (`--probe` is one-shot
loopback TCP on declared ports only, ≤60s total budget).

The boundary gate (`boundary:`-prefixed, fail-closed) matches scenario
`real-read-only | real-state-changing | subscribed` claims against recorded
evidence (lastReadiness/digest-identity/confirmed checkpoints); an
unbacked claim fails the gate with `boundary:<name>:<reason>`. `unverified`,
`network-deny`, `blocked:*`, and unknown services never fail it
(M1 warn-only preserved). A record older than its process yields
`boundary:<name>:stale-record` (stale); an unreadable scenarios file yields
`boundary:scenario-file:unreadable` (fail-closed).

Known-false-green catalog (fires on positive evidence only — silent data
passes silently, the healthy family stays green):

| kind | signal | human line |
|---|---|---|
| `stale-jar` | recorded digest identity ≠ fresh declaration (same basename) | `stale-build: <name> (<base> changed)` |
| `origin-403` | 403 in a recorded note (origin gate, not down) | `origin-suspect: <name> (…)` |
| `msw-vite-trap` | `msw`/mock-service-worker marker in cmd, or `vite preview` (frozen build) | `mock-traffic: <name> (…)` |
| `v5-confusion` | non-v1 ow.yaml `version:` (v1 assumed) | `version-confusion: <name> (…)` |

Exits: 0 ready, 1 missing/stale/false-green, 2 usage or invalid ow.yaml.
`--json` is additive `{ready, missing[], stale[], falseGreens[] ({kind,
service, hint}), gates[]}` (English keys; full digests and raw paths never
reach the wire — basename + short-8). Human output adds a
`build: <name> <base>@<short8>` + `migration: <name> (history recorded|history missing)` report to
the gate lines (when data exists; otherwise the single
`ready: readiness passed` line).

### Replay store, record, contract check

Deterministic scenarios ship with a recorded contract. `ow record
<scenario> [--file]` captures one deterministic scenario's declared
probes once (bounded one-shot exec of declared argv only — nothing
else runs) into `.ow/replay/<boundary>/<hash>.jsonl`, one JSON object
per line: line 0 is the provenance envelope, the rest are probe
outcomes. Store discipline: per-file `0600`, ≤256KB / ≤500 lines
(oldest-first trim by the writer, atomic tmp+rename). The envelope
carries `{checkout, head, interpreter, runnerHash, at, scenario?,
attempt?}` — `runnerHash` is the digest of the record-side runner
inputs (the declared probe set) at record time; a record missing any
of the first four fails closed (`provenance-missing`, exit 1). Stored
outcomes keep digests, masked shapes, and scrubbed notes — raw argv,
raw stdout, and absolute paths never land in the store (digest inputs
live in memory only). `replayedFrom` is always null on capture; it is
the SOLE replay-linkage mechanism (a linkage-absent record reads as
live). The `X-Ow-Replay` header is future-HTTP-only and never travels
on probe transport. Checkpoints and data-clock files are
runner-written — `ow` writes replay only, never checkpoints.

State-changing boundaries are never replayed: `real-state-changing`
and `blocked:*` refuse with exit 2 naming the boundary, on both
verbs. INERT scaffold files refuse on all three verbs (`record`,
`contract check`, `scenario run` → exit 2 `INERT: <file>`): a
placeholder contract is meaningless — edit real probes first.
Unknown scenario names, unverified-only scenarios, and missing
files fail closed without writing. A recorded not-ready probe also
prints `probe not-ready: <id> (<note>)` (witness line — exit stays 0,
a not-ready probe is recorded evidence, not a record failure).

`ow contract check [--json] [--file]` is the ship-order gate: it
recomputes each deterministic scenario's definition digest and
compares it to the recorded contract hash. The digest covers the full
definition (services/boundaries/targets/probes/checkpoints plus M6/M7
mode/restore/asserts/data/env_file and opaque track fields): editing
any of them flips a recorded contract to mismatch — re-record to heal
(old records predate the wider digest and mismatch on first check).
Exits: 0 match, 1
digest-mismatch (`contract-mismatch:`) or unknown hash
(`unknown-record:`, never a silent pass), 2 usage or a
state-changing scenario in scope. `--json` is additive `{pass,
compared[] ({scenario, hash, match, detail}), missing[]}` (English
keys; full digests never render — short-8 plus the verdict).

### Overlay boundaries (local convention + explicit flag)

Base scenario boundaries stay in `ow.scenarios.yaml`; a local overlay
narrows them without touching the base file. Three layers, fixed
precedence — `--boundaries <path>` flag > `<root>/.ow/boundaries.local.yaml`
convention > base. An absent overlay (no flag, no convention file) is
byte-identical to no overlay at all. The user owns overlay files; `ow`
only reads them (M9 writes nothing — refusals never persist, no `.bak`).

Overlay file shape (`version: 1`, optional `baseDigest:`, per-scenario
`boundaries:` — REPLACE, never union):

```yaml
version: 1
baseDigest: 9f2c41ab # optional pin of the base file digest
scenarios:
  truck-approval:
    boundaries: [network-deny]
```

Merge rule: an overlay `boundaries:` list replaces the base list
wholesale per scenario (a two-value base collapses to a one-value
overlay — never a union). A scenario entry without a `boundaries:` key
refuses (`boundaries required`) — silent emptying is never intended; an
explicit `boundaries: []` stays allowed as intentional empty.
Values still flow through the M1 taxonomy
(`normalizeBoundary`): unknown values warn `unknown boundaries: <v>
(UNVERIFIED)` and never refuse. `blocked:` quoting trap: quote reasons
containing commas (`blocked:"fix, later"`) — an unquoted comma splits
the flow list (`blocked:fix, later` becomes two entries and the tail
warns UNVERIFIED).

Guards (exact strings/exits): traversal/absolute `--boundaries` values
refuse exit 2 echoing the basename only (`overlay-refused: <base>
(path must be root-relative)`); secret-shaped overlay values refuse
exit 1 (`overlay-refused: <base> (secret-shaped value)`); an overlay
naming a scenario absent from base refuses exit 1
(`overlay-dangling: <scenario> (refused)`); any other invalid overlay
refuses exit 1 (`overlay-refused: <base> (<reason>)` — under
`--check` this is the exit-1 path). Overlay files share the replay
caps (256KB/500 lines, `oversize` refusal). Reads are symlink-aware
(lstat + realpath containment + O_NOFOLLOW; accepted tradeoff: a
parent-dir swap between check and open remains — hostile mounts are
out of scope, local operator error is the threat model). A `baseDigest:` mismatch
advises `overlay-stale: base changed since <short-8> (warning)` and
never fails. With git present and no ignore entry, the convention file
warns `overlay-gitignore-missing: boundaries.local.yaml (warning)`
(gitless roots stay silent). `--boundaries` outside the eight readers
(scenarios, preflight, readiness, provision, record, contract,
scenario run, scenario env) is exit 2, never silently ignored.

Source tags (silent overlays are a bug): human rows sourced from the
overlay gain an `[overlay]` suffix; `--json` gains `overlayApplied`,
`overlayFile` (basename only), `boundarySources[]` (`{scenario,
boundary, source: base|local|flag}`), and `overlayWarnings[]`;
provenance-bearing outputs
(record, contract, scenario run) carry the forgotten-overlay banner
`overlay-active: <basename>` (+ `overlayApplied:true` in JSON). The
dashboard follows the same convention path server-side (no flag
channel exists there — flag-scoped runs render the base convention);
its matrix gains a Source badge column and an invalid overlay shows an
error box while the base matrix still renders.

The scrubber runs BEFORE the cap everywhere on this path: shared B3
value masking (`Bearer`/JWT/provider tokens, `key=value`, ≥32-hex)
plus CWD-absolute paths folding to `<root>`; only then are notes
capped. `ow` probes never execute app code beyond declared probe argv
(the bounded one-shot class already used by `reconcile --probe`).

### Data-clock witness (runner-written evidence)

Freshness without database access. The runner writes
`<root>/.ow/data-clock.json` (≤4KB, keys `schema_hash`, `applied_head`,
`seed_profile`, `seed_rev`, `db_identity`, `at` — each a tight 1..64ch
whitespace-free string); `ow provision --check` renders one additive
`dataClock:` line and never gates on it: `dataClock:
<db_identity>@<applied_head> (<seed_profile>/<seed_rev>)` when the
clock is at least as new as the newest checkpoint evidence, the same
line with a `(stale-ignored)` suffix when older (advisory only — stale
data never fails the run), or `dataClock: unmeasured (<reason>)` with
`no-file`, `data-clock-oversize`, or `invalid` when unreadable. Checkpoints
carry an opaque `data` object (`revField`, `freshness-ignores` by
convention; `ow` never interprets values) that survives the read path
verbatim. Scenarios may declare a `data:` block (known keys validated,
unknown keys warn) whose mismatches against the clock warn as
`data mismatch: <key> (UNVERIFIED)` without changing exits, plus an
`env_file:` names-only reference (relative in-project path; provision
validates presence and never reads contents — a declared-but-missing
file is exit 2 naming the file, values never reach wire, state, or
replay). The ledger prints one chip line per scope that has a clock
(root first, then service `cwd` scopes):
`db:<identity> seed:<profile>/<rev> mig:<head> (<scope>)`; two scopes
sharing an identity add `collision-warning: <id> in two checkouts`
(advisory only). All rendered identities are secret-masked; DSNs and
credentials must stay out of these fields (shape discipline plus
masking, enforced by hostile tests).

### Narrowed deterministic scenario run

`ow scenario run <name> [--json] [--file ow.scenarios.yaml] [--run <id>]
[--off-local]` runs one deterministic scenario through five strictly
ordered phases — `setup → run → assert → restore → report` — as a
facade over existing read paths plus bounded probe exec. `ow` spawns
ONLY declared probe argv (same ≤16-part/≤512B/no-shell/timeout/cap
limits as validation; masked shapes in output); restore execution is
runner-side, never spawned by `ow`.

Schema additions (all additive, validated at parse; unknown fields
still warn-only): `mode: local|off-local` (default `local`),
`restore: {argv, timeout?}` (probe limits, validated never spawned),
`assert:` inline-map list, `triggers:`/`queue:`/`webhook:` (opaque,
`queue` must name a declared probe), `deps:` (`mode` per entry),
`proxies:`/`apiMode:`/`browser:`/`viewport:`/`seed:`/`artifact:`
(opaque track fields). Explicit non-goal keys (`fault|soak|load-test|
schedul*|deploy*`) fail closed at parse; the runner maps them to
exit 2.

Phases: setup validates (INERT marker → exit 2 `INERT: <file>`;
unknown scenario, off-local without `--off-local`, out-of-scope
boundary, missing restore, unreadable run → exit 2; tampered or
unrecorded contract → exit 1 via the shared contract verdict, probes
never run); run executes declared probes sequentially with a
wall-clock; assert evaluates `negative` (expects failure),
`readback-by-consumer` (ready consumer probe plus a confirmed
checkpoint stage), `call-count` (exact envelope count per stage),
`budget` (wall ms within limit); restore ALWAYS runs the runner
(sequential guarantee, even after assert failure) and renders the masked
restore shape plus outcome (`restored:` or `restore-failed:` suffix);
report prints the verdict. Exits: 0 pass / 1 assert-or-restore
failure / 2 usage-or-refusal. `--json` is additive `{scenario,
phases: [{name, ok, detail}], restored, contract: {pass}, report}`.

Checkpoint selection for reads: `--run <id>` names the run, otherwise
the latest run (max envelope time) wins; reads come from
`.ow/checkpoints/*.jsonl` (tolerant per file). Time follows the
wall-clock only; `OW_TIME_OFFSET` stays a runner-side convention that
`ow` never reads. Load testing stays project-tool owned and witnessed
through `ps`/`logs` — never an `ow` surface.

### Scenario env (boundary matrix for app-side resolvers)

`ow` decides, the app substitutes: `ow scenario env <name> [--json]
[--file ow.scenarios.yaml] [--boundaries <path>]` renders the decided
boundary matrix of one scenario as environment lines — one
`OW_BOUNDARY_<name>=<mode>` line per boundary, trivially eval-able
(`eval $(ow scenario env <name>)`). Modes are closed-vocabulary only
(`real-read-only | real-state-changing | network-deny | subscribed |
blocked | unverified`) — never secret values, never reasons, never
paths. `blocked:<reason>` renders mode `blocked` (the reason stays out
of env and out of `--json`; full reasons live in `scenarios --check`).
Env keys uppercase the mode and fold every non-alphanumeric character
to `_` (`real-read-only` → `OW_BOUNDARY_REAL_READ_ONLY`). Two
boundaries mapping to the same key (e.g. `[local, real-read-only]` or
two `blocked:` reasons) refuse exit 1 naming both sources
(`duplicate env key:`).

The verb reads the MERGED matrix through the overlay helper (flag >
local convention > base, source tags honored) and renders read-only:
it never spawns and never writes. Human stdout stays plain `KEY=value`
(warnings, advisories, and the forgotten-overlay banner go to
stderr); `--json` prints `{scenario, env}` (+ `overlayApplied`,
`overlayFile`, `boundarySources` when an overlay is active) and nothing
else on stdout. Refusals mirror the run gates: unknown scenario →
exit 2, INERT-marked file → exit 2, missing file → exit 1.

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
provable, weak signals as `#` comments plus a printed checklist. `--tracing`
adds the `trace:` block and per-service OTel `env:` (single-line flow maps);
the generated file is re-validated in-process before reporting. `--force`
keeps a single backup (`ow.yaml.bak`, overwritten each time) — accepted
single-generation behavior, not a rotation.

Init v2 also scaffolds `ow.scenarios.yaml` (first scenario INERT — every
real `argv:` line commented, one `{id: inert, argv: [true]}` placeholder
probe keeping `ow scenarios --check` green) plus `.ow/replay/.gitkeep`.
The scenarios file opens with the exact marker
`# INERT — ow scenarios --check passes, ow scenario run refuses until uncommented`
(the landed M6 runner refuses marked files with exit 2, `INERT: <file>` on
stderr; `record`, `contract check` and `scenario run` refuse INERT scaffolds
alike); its commented
boundary matrix lists the M1 new taxonomy, with the `blocked:` example
quoted (`blocked:"<reason>"` — an unquoted reason is a fail-closed parse
risk). The scenarios text is re-validated in-process with the real
`parseScenarios` before either file is written, and an existing
`ow.scenarios.yaml` gets the same single-`.bak` rule
(`ow.scenarios.yaml.bak`, overwritten). Init prints a bounded question
catalog (fixed `question:` strings, never interactive): service-cwd confirm,
port confirm, required-env names, boundary default (`real-read-only`),
scenario name (`first-scenario`), tracing opt-in. Init writes at most the two
yaml files plus `.gitkeep` — it never edits `package.json`/CI/imports,
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
`down`, `record`, `contract`, `scenario run`. A nested state dir (a
`.ow`-named root or an ancestor workspace) warns — writers stay put
while readers walk up.
Readers (`ps`/`logs`/`trace`/`down`/`doctor`) resolve the root upward to the
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

### Tracing recipes (per-stack)

Distributed tracing is opt-in per repo: a `trace:` block starts the embedded
loopback OTLP/HTTP receiver (`127.0.0.1:4319` by default, `trace: {port: N}`
overrides), and each service opts in by writing `env:` explicitly — `ow`
never injects OTEL variables into services (D4). Spans land redacted and
capped in `<root>/.ow/traces/spans.jsonl`; read them with `ow trace`
(recent list) and `ow trace <id>` (one parent/child tree).
`ow trace --wait 15s` polls up to 5 minutes for a newly arriving span
(batch exporters land late) and then renders once. If the receiver port is taken, `up` warns loudly with host+port and `ow doctor` appends a `receiver not listening` hint to the trace line.
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

### Tracing recipes (browser)

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
