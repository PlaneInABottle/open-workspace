---
name: ow
description: "Observe past shell-command history with the ow CLI (sessions/show/meta/reads/last/doctor): what ran, what failed, what it cost; reuse a past command. Read-only."
---

# ow — shell-history observer

`ow` reads back past shell commands from OpenCode's session store: what ran,
what failed, and what it cost. It is read-only and runs as `ow` from anywhere.
It observes opencode sessions only; a harness it does not observe has no rows,
which says nothing about what happened there.

## Use

```sh
ow doctor                  # health first, and whenever results look wrong
ow sessions --since 1d     # find a session
ow show <session>          # what ran; add --show-fails for failures
ow last <pattern>          # newest successful command matching <pattern>
```

No ID known: last sidecar line, or bare for latest. Exits: 0 ok, 1 failure, 2 usage
error; non-interactive. Usage, flags, labels and `--json` shapes: `ow --help` and
`ow <command> --help`. Sidecar rows land ~5s after session end. Report only what
the output shows; keep `--since` narrow and open failures repeats-first.

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

## Reading friction out of a session

To judge how much avoidable work a session cost, read its counts rather than its
narrative: `ow sessions --since 1d` gives commands, files and failures per
session, and `ow show <session> --show-fails` opens the failures, repeats first.
A command retried several times with small edits is a detour even when it
finally succeeded.

Your own session is still open while you work, so its rows are incomplete and
the newest land about 5s after it ends. Treat a reading of the active session as
a lower bound, never as proof that nothing else failed.

## Measurement limits

- Deduplicate sessions by full canonical ID; prefixes and suffixes can name the same session.
- Use `sessions` for command totals and `reads` for file-read counts; `show` row multiplicity
  is not an independent execution count.
- Claim durations only from explicit timings or tool-reported elapsed values: `ow show`'s
  `time:` line is such a timing, and a record without a duration is unknown, never zero.
  Counts, token totals and gaps do not measure model latency; label sampled extrapolations as estimates.
- A repeated command is not proven wasted work without matching inputs, revision and target.
  Check which findings a review produced before treating it as discarded or redundant.

## Handoff (between agents/sessions)

Hand over readings, never handles: the session ID, the `ow show` /
`ow doctor` output observed, and the log/DB paths used. Never hand
over log contents or env values. The next agent re-verifies with
`ow doctor` and `ow show <session>` before acting.
