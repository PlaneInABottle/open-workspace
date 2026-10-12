---
name: ow-scenarios
description: "Validate ow scenarios and checkpoint evidence: schema, checkpoints/failures reads, the preflight runner recipe, scenario-run and data-clock recipes. Use for scenario authoring and evidence review."
---

# ow-scenarios — scenarios and evidence

`ow.yaml` never swells: scenarios live in a separate
`<root>/ow.scenarios.yaml` (`version: 1`), which `ow` validates but
never runs. Runner writes evidence, `ow` only shows it. Full schema,
caps, and non-goals: product `cli/README.md`.

## Scenario schema (read-only validation)

`ow scenarios --check [--json] [--file]` validates only (never runs
probes). Each scenario references ow.yaml service names (unknown names
warn as UNVERIFIED, never fail). Boundaries are the M1 taxonomy —
`real-read-only | real-state-changing | network-deny | subscribed |
blocked:<reason> | unverified` — with legacy dual-read warnings
(`real→real-state-changing`, `local→real-read-only`,
`captured-response→subscribed`, `fake→unverified`,
`test→unverified`, each `legacy-boundary: <v> → <m> (warning)` once per
file). Unknown/empty values fall to `unverified` with a
`unknown boundaries: <v> (UNVERIFIED)` warning (never a failure,
never silent). `blocked` needs a quoted reason (`blocked:"<reason>"`,
1–128 chars) or it is a schema error. Targets/checkpoints are opaque
strings (secret-masked, no network policy). Each probe is
`{id, argv (≤16 parts, ≤512B each, no shell), timeout (5s|10s|30s,
default 10s)}`.

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

Explicit `services: []` means no services by decision (probe-only);
it still needs ≥1 probe or it is a schema error, and a missing
`services:` key stays a schema error. Readers bring nothing up for
empty services; the boundary gate passes vacuously with a probe-only
note, never a silent skip.

Exits: 0 ok (even with warnings), 1 schema error, 2 usage; a missing
file is exit 1 (a `--check` must never silently pass a wrong path).
`--json` is additive (`boundariesNormalized[]` +
`boundaryWarnings[]`, old keys unchanged; raw argv never prints).
Subset-YAML single-line rule: block-map style fails naming the line
with an inline example.

## Scenario placement and per-context differences

Author scenarios at the workspace root — `<root>/ow.scenarios.yaml`
next to `ow.yaml`. Do not create per-repo or per-worktree copies;
one shared matrix per workspace root keeps valuable rows from dying
with a deleted worktree. (Reachability follows the root: run from the
workspace root or pass `--file`; a sibling checkout does not inherit
the root file automatically.)

When contexts need different fakes (worktree A fakes COMIS, worktree B
uses the real endpoint), do NOT fork the base file. Put context-local
rows in `<root>/.ow/boundaries.local.yaml` (conventional, disposable,
never committed); an explicit `--boundaries <path>` overrides it for a
single invocation. Precedence is flag > local > base, and a scenario's
overlay boundary list replaces the base list wholesale (never a union).
`ow` only reads overlays and never writes them; invalid values warn as
UNVERIFIED rather than refuse. `--boundaries` is accepted by
`scenarios`, `preflight`, `readiness`, `provision`, `record`,
`contract`, `scenario run` and `scenario env` only; other commands exit
2. Keep shared rows in the base file and note worktree-only rows in the
worktree handoff.

Scaffolded files (`ow init`) are INERT: the exact header
`# INERT — ow scenarios --check passes, ow scenario run refuses until uncommented`,
commented real probes, one `{id: inert, argv: [true]}` placeholder
keeping `--check` green, and a commented boundary matrix.

## Checkpoints and failures

- `<root>/.ow/checkpoints/<run>.jsonl` is runner-written;
  `ow checkpoints list [--file] [--json]` inventories runs (read-only).
- `ow checkpoints show <run> [--file] [--json]` renders
  confirmed/stale/not_observed + last-verified/first-gap +
  `safe_next_action` passthrough (never prunes, never judges proof
  content).
- `ow failures [--since 1h|24h|7d] [--file] [--json]` lists recurring
  findings (read-only, mechanical).

## Preflight runner recipe

The runner calls `ow preflight --json` as the first line of `prepare`;
on `pass:false` it does not start the job and logs `missing[]`
verbatim (reports only). `--probe` adds budgeted one-shot loopback
TCP. No retries or suggestions are generated ow-side. The boundary
gate (`boundary:`-prefixed entries) and the known-false-green catalog
live in the `ow-runtime` skill.

## Scenario run

`ow scenario run <name> [--json] [--file ow.scenarios.yaml] [--run <id>]
[--off-local]` runs one deterministic scenario through five strictly
ordered phases — `setup → run → assert → restore → report`. `ow`
spawns ONLY declared probe argv (bounded one-shot class); restore
execution is runner-side, never spawned by `ow`, and the restore phase
runs unconditionally (try/finally, even after assert failure).

- Setup refuses with exit 2: unknown scenario, INERT-marked file
  (`INERT: <file>`), non-goal keys (`fault|soak|load-test|schedul*|
  `deploy*`), off-local without `--off-local`, out-of-scope boundary,
  missing restore declaration, unreadable run id. A tampered or
  unrecorded contract exits 1 via the shared contract verdict before
  any probe runs.
- Assertions: `negative` (expects probe failure), `readback-by-consumer`
  (ready consumer probe plus a confirmed checkpoint stage),
  `call-count` (exact envelope count per stage), `budget` (wall ms
  within limit). Checkpoint reads come from `--run <id>` or the latest
  run. Restore renders the masked argv shape plus outcome (`restored:`
  or `restore-failed:` suffix).
- Exits: 0 pass / 1 assert-or-restore failure / 2 usage-or-refusal.
  `--json` is `{scenario, phases: [{name, ok, detail}], restored,
  contract: {pass}, report}`. Schema additions (`mode`, `restore`,
  `assert`, `triggers`, `queue`, `webhook`, `deps`, `proxies`,
  `apiMode`, `browser`, `viewport`, `seed`, `artifact`) are additive
  and validated at parse; fault/soak/load/scheduled/deployed stay
  explicit non-goals.

## Scenario env

`ow scenario env <name> [--json] [--file] [--boundaries <path>]`
renders the decided boundary matrix as eval-clean environment lines
(`ow` decides, the app substitutes): one `OW_BOUNDARY_<name>=<mode>`
line per boundary, modes closed-vocabulary only (never secrets,
never reasons — `blocked:<reason>` renders `blocked`). Reads the
merged matrix (flag > local > base) read-only; refusals mirror the
run gates (unknown scenario / INERT → exit 2, missing file → exit 1);
key collisions refuse exit 1 (`duplicate env key:`).

## Data clock (read-only witness)

- The runner writes `<root>/.ow/data-clock.json` (4KB cap); `ow` only
  reads it for presence and shape and renders it as a masked line in
  `readiness` and `provision --check` (`dataClock:` line and the
  `dataClock` JSON block). It never gates `pass` or `missing` and never
  writes the file.
- `ow` never connects to a database, runs migrations, or reads
  credentials. Freshness is the wall-clock comparison only; any
  database-level check belongs to the runner.
