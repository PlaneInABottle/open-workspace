---
name: ow
description: "Observe past shell-command history with the ow CLI (sessions/show/meta/reads/last/doctor): what ran, what failed, what it cost; reuse a past command. Read-only."
---

# ow — shell-history observer

`ow` reads back past shell commands from OpenCode's session store: what ran,
what failed, and what it cost. Read-only; it never changes sessions, files,
or the database. Run it as `ow` from anywhere. It supervises nothing —
local runtime is docker compose.

## Sessions (quick reference)

`ow` observes **opencode sessions** only — other harnesses are not
observed ("not observed" means exactly that, never "nothing happened").

```sh
ow doctor                             # health first
ow sessions [--since 1d] [--dir /path]
ow show <session> [--since 30m|3h|1d|1w] [--tree] [--full] [--show N] [--show-fails] [--kind ..] [--tool ..]
ow meta/reads <session>             # cost/tokens · read summary
ow last <pattern> [-n K] [--failed] [--since 1d] [--dir /path]  # newest exit-0 command matching <pattern>: cwd + re-runnable text
ow show <session> --json              # stable machine output (all commands, English keys)
```

No ID known: last sidecar line, or bare for latest. Exits: 0 ok,
1 failure, 2 usage error; non-interactive. `doctor` first when results
look wrong; sidecar rows land ~5s after session end, spans 5–15s late.
Report only what the output shows, never invent causes. Check counts
first, keep `--since` narrow; open failures one by one, repeats first.

## Reuse a command that already worked

Before reconstructing a build/test/compose invocation, run `ow last <pattern>`
(case-insensitive substring over the command text). It prints the newest
exit-0 match as `# cwd:` + the recorded command; `-n K` lists K distinct
matches, `--failed` shows the newest failing one with its exit code. Exit 1
= no match. Credential assignments (`*_TOKEN=`, `*_PASSWORD=`, `*_KEY=`,
`*_SECRET=`) print as `NAME=***`; supply the value yourself, never guess it.
Commands where the pattern is the command itself (start, or after `;`, `&&`,
`|`, `(`, an env prefix or `timeout N`) win over mere mentions; `ow`'s own runs
never match. The output is a record, not a promise it still works — check the
cwd and paths.

Self-documentation (all read-only):

```sh
ow --version | ow version [--json]   # installed build identity (sha8/time/dirty from the sidecar)
ow <command> --help | ow help <cmd>  # verb-scoped usage/flags/exits
```

`ow <command> --help` never dumps the full list — the global list stays on
`ow --help`.

Output labels (English, quoted verbatim): `task:` task header
(`N records, M failed` — every joined row counts, not just commands),
`record:` real command, `intent:` agent sentence, `(reason:)` /
`(output:)` on failures (several distinct reasons collapse to
`(reason: <first>; +N more)`, drilled down as
`--- reasons (from command text) ---` under `--show N`). Budgets: success excerpts 2KB stored and
300 chars shown, failures up to 16KB; 3h of history runs about 150KB.
Recorded durations show as `time: <total> recorded across N records (max …)`
plus per-group `· <total> (max <max>)`; a record without a duration claims no time.
A `--since` window that starts before the oldest record is flagged as pruned
(`log starts at <ISO>; older records were pruned by the ring cap`): the store drops old rows silently.

## `--json` keys (single table, additive)

English human lines; stable English `--json` keys (old keys never change, new keys only add):

| command | envelope |
|---|---|
| `sessions --json` | `{sessions[], window, coverage}` (`coverage`: `{firstTimestamp, lastTimestamp, pruned}` or null) |
| `show --json` | `{session, warnings, groups, tree?, window}` |
| `meta --json` | `{meta, warning}` |
| `reads --json` | `{session, reads, window}` |
| `doctor --json` | `{checks[] ({name, ok, detail}), identity: {installed {sha8, dirty, time, binary8}\|null}}` |
| `version --json` | `{version, sha, time, dirty, sidecar}` |

Full behavior: `ow --help` and `ow <command> --help` (verified against
the installed build; past writeups may describe removed commands).

## Handoff (between agents/sessions)

Hand over readings, never handles: the session ID, the `ow show` /
`ow doctor` output observed, and the log/DB paths used. Never hand
over log contents or env values. The next agent re-verifies with
`ow doctor` and `ow show <session>` before acting.
