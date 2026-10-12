---
name: ow
description: "Operate the ow CLI: past session analysis plus dev-service supervision and trace lookup. Use for agent work, service state, or which trace a request produced."
---

# ow — operator pointer

`ow` is the shell-observer command line: past session analysis plus
dev-service supervision. Read-only; it never changes sessions, files,
or the database. Run it as `ow` from anywhere (via `/setup-ow`
install, or `ow` on PATH).

Detail skills (load the one matching the task by its skill name; they
are installed beside this one and do not resolve as relative paths):
- `ow-runtime` — service supervision and readiness:
  `up/down/restart/ps/logs`, `reconcile`, provenance, `preflight`,
  `readiness`, `init`/`provision`, `record`/`contract` replay recipes,
  `trace` and tracing setup.
- `ow-scenarios` — scenarios and evidence:
  `ow.scenarios.yaml` schema and boundary enum, the local boundary
  overlay, `scenario env`, `checkpoints`, `failures`, the preflight
  runner recipe, `scenario run` and the read-only data-clock witness.

## Sessions (quick reference)

`ow` observes **opencode sessions** only — other harnesses are not
observed ("not observed" means exactly that, never "nothing happened").

```sh
ow doctor                             # health first
ow sessions [--since 1d] [--dir /path]
ow show <session> [--since 30m|3h|1d|1w] [--tree] [--full] [--show N] [--show-fails] [--kind ..] [--tool ..]
ow stuck [session] [--since] [--tree]  # retries, overlap, slow commands
ow meta/prompts/reads <session>       # cost/tokens · latest 20 instructions · read summary
ow timeline [session] [--trace] [--since]  # agent rows + spans merged
ow show <session> --json              # stable machine output (all commands, English keys)
```

No ID known: last sidecar line, or bare for latest. Exits: 0 ok,
1 failure, 2 usage error; non-interactive. `doctor` first when results
look wrong; sidecar rows land ~5s after session end, spans 5–15s late.
Report only what the output shows, never invent causes. Stuck claims
need `--stuck` numbers, not impressions. Check counts first, keep
`--since` narrow; open failures one by one, repeats first.

Output labels (English, quoted verbatim): `task:` task header,
`record:` real command, `intent:` agent sentence, `(reason:)` /
`(output:)` on failures. Budgets: success excerpts 2KB stored and
300 chars shown, failures up to 16KB; 3h of history runs about 150KB.

## `--json` keys (single table, additive)

English human lines; stable English `--json` keys (old keys never change, new keys only add):

| command | envelope |
|---|---|
| `up --check --json` | `{file, services[] ({name, cmd?, cwd?, port?, logs?, dependsOn?}), warnings[], spawnOrder?}` (`spawnOrder` only when `depends_on` exists) |
| `up -d --wait --json` | `{ready, services[] ({name, port?, status, waitedSec, exitCode?, healthPath?, readiness?}), noPort[], note?}` |
| `up <svc>`, `restart --json` | `{service, action, pid?, diff, code?}` (`code` only on failure) |
| `down [--rm]`, `down <svc> --json` | `{stopped[] ({name, stopped, note}), warnings[]}` |
| `ps --json` | `{services[] ({name, status, pid, uptimeSec, cpuPct, memBytes, port?, listening?, exitCode?})}` |
| `logs --json` | `{service, lines[]}` |
| `reconcile --check --json` | `{reconcile: {inSync, drifts[] ({service, kind, expected?, running?, hint})}, revisions[], readiness[] (only with --probe)}` |
| `ps --explain --json` | `{services[], explanations[] ({service, explanation: {expected, running, diffs[], provenance, neden, readiness}})}` |
| `preflight --json` | `{pass, gates[] ({name: reconcile\|provenance\|readiness\|boundary, pass, detail}), missing[], envelopes[]}` |
| `readiness --json` | `{ready, missing[], stale[], falseGreens[] ({kind, service, hint}), gates[]}` |
| `scenarios --check --json` | `{file, scenarios[] ({name, services, boundaries, targets, probes[] ({id, argvShape, timeout}), checkpoints}), boundariesNormalized[], boundaryWarnings[], warnings[]}` |
| `doctor --json` | `{checks[] ({name, ok, detail})}` (`up`/`trace` are not part of the exit) |

Full schema, caps, and non-goals: product `cli/README.md`.
