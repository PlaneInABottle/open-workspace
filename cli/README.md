# `ow` CLI (product-owned, bun-only)

`ow` is the shell-observer command line: session analysis
(`sessions/show/meta/reads/last/doctor`) plus build identity (`version`).
Read-only, non-interactive; it supervises nothing — compose owns
runtime now. The observer hooks that feed it live in the opencode plugin directory
(`~/.config/opencode/opencode-plugins/shell-observer/` — `index.ts` +
`shell-observer-core.ts` only); every other CLI source lives here.

Agent skill entry point: `skills/ow/SKILL.md` — the single authored source.
The user-global copy `~/.agents/skills/ow/SKILL.md` is produced from it by
`pnpm ow:skill-install` (never edit that copy by hand); generated client packs
live under `plugins/` (`pnpm build-skill-packs`).

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
pnpm ow:skill-install    # copy skills/ow/SKILL.md → ~/.agents/skills/ow/SKILL.md (--check: report stale)
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
  `--help`, `sessions --json` on the committed fixture log
  (byte-compared), and `doctor --json` by envelope keys + exit code only
  (wall-clock fields vary by construction). Fixtures: `cli/parity-fixtures/`.

## Self-documentation (`version`, `--help`)

- `ow --version` / `ow version [--json]` prints the installed build
  identity from the running binary's sidecar (`ow <version> (build
  <sha8>, <time>[, dirty])`; `--json` mirrors `{version,sha,time,dirty,sidecar}`).
  A missing sidecar reads `ow (no build sidecar — rebuild with pnpm ow:build)`
  — never a guessed version. Unrelated flags refuse (exit 2).
- Per-verb help: `ow <command> --help` (and `ow help <command>`) renders
  that verb's usage line, flags, exits and one example. The full
  command list stays on `ow --help`; the global list is the single usage
  source the verb help derives from (help-coverage test).

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
# newest successful command matching a pattern (cwd + re-runnable text; secrets masked)
./ow last <pattern> [-n K] [--failed] [--since 1d] [--dir /path]
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
(or null); empty renders stay honest (`no X (store: …; window: …)`
naming the searched store, never a silent blank or a false empty).

`sessions --json` also carries the additive `coverage` object (or null when
the log has no readable bounds):

```json
"coverage": { "firstTimestamp": "<ISO>", "lastTimestamp": "<ISO>", "pruned": false }
```

`firstTimestamp`/`lastTimestamp` are the oldest and newest records still in
the store. `pruned` is `true` only when a `--since` window starts before
`firstTimestamp` (records older than the window may have been dropped by the
ring cap); it is `false` without a window. Human output prints the same fact
as a stderr line `log starts at <ISO>; older records were pruned by the ring cap`.

## Observer health (`doctor`) and build identity

`ow doctor` reports shell-log growth, hook firing, ring-buffer fill and
intent-DB readability (`log/hook/ring/db`); exit 1 on any failing check,
exit 0 when all pass. The `ring` line also states what the store can and
cannot tell you: `binding line cap 50k` or `binding byte cap 100MB` (whichever
fill is higher), the `oldest`/`newest` record timestamps actually present, and
the count of `unparseable line(s)` (corrupt lines are skipped by every reader).
Reading the bounds scans the whole log once (measured 140–170 ms on a 73 MB store). `ow doctor --json` adds the build `identity`
envelope beside `checks`: `installed` (the running binary's sidecar:
short-8 `sha8`/`binary8`, `dirty`, `time` — null with no sidecar).
Human output prints plain `identity:` lines outside the check lines, so
the exit rule never sees them. Full sha/digest values never reach the
wire — shorts only. Free-text error detail is secret-masked by
construction (`up-evidence.ts`, single source).

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
