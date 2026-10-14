---
name: ow
description: "Operate the ow CLI: past session analysis plus dev-service supervision. Use for agent work, service state, or session history."
---

# ow — operator pointer

`ow` is the shell-observer command line: past session analysis plus
dev-service supervision. Read-only; it never changes sessions, files,
or the database. Run it as `ow` from anywhere (via `/setup-ow`
install, or `ow` on PATH).

Detail skills (load the one matching the task by its skill name; they
are installed beside this one and do not resolve as relative paths):
- `ow-runtime` — service supervision and readiness:
  `up/down/restart/ps/logs`, `reconcile`, provenance, `init`.

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
`--since` narrow; open failures one by one, repeats first. Handoff
between agents carries readings (`ow ps`, state dir, `up:` line),
never pids/logs/env — detail: `ow-runtime`.

Output labels (English, quoted verbatim): `task:` task header
(`N records, M failed` — every joined row counts, not just commands),
`record:` real command, `intent:` agent sentence, `(reason:)` /
`(output:)` on failures (several distinct reasons collapse to
`(reason: <first>; +N more)`, drilled down as
`--- reasons (from command text) ---` under `--show N`). Budgets: success excerpts 2KB stored and
300 chars shown, failures up to 16KB; 3h of history runs about 150KB.

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
| `doctor --json` | `{checks[] ({name, ok, detail}), identity: {installed {sha8, dirty, time, binary8}\|null, supervisor {state, startedAt, sha8, time}, match}}` (`up` is not part of the exit; digests compared internally, shorts only on the wire) |

Full schema, caps, and non-goals: product `cli/README.md`.
