# Worktree Farm Convention (Option C)

This is the written ritual for operating one shared `ow.yaml` across many
worktrees of the same repository. It is a convention, not automation: `ow`
witnesses the shape, never fixes it.

## Farm layout

- One repository, many checkouts (worktrees). Each worktree is registered as
  its own root (`workspace_register({name, roots})` — one entry per worktree,
  never a parent+child pair: the overlap rule still refuses those).
- One shared `ow.yaml` at the repo root (same content in every worktree).
- Never stash across worktrees (the stash namespace is shared per clone — one
  worker's stash can silently discard another's work). Save a patch or use a
  disposable checkout for baseline comparisons instead.

## Per-worktree ritual (30-second checklist, not 10–20 minutes)

Every fresh worktree needs two local links before `ow up`:

1. `.env` must be a **symlink** to the farm's shared env file (never a copy —
   copies drift). A regular `.env` file, a missing link, or a dangling link
   all fail the checklist with distinct notes.
2. `.venv` must exist with `bin/python` (managed by the project's own
   toolchain — `ow` never installs it).

Then run the witness from inside the worktree:

```sh
ow provision --check [--json] [--probe]
```

- Exit `0` all-ok / `1` any-fail / `2` usage (mirrors the preflight
  contract). Bare `ow provision` without `--check` is a usage error.
- Human output is one line per check (`ok: <name> …` /
  `missing: <name> … → …`) plus a summary (`provision passed` /
  `provision missing: N`). `--json` carries stable English keys
  (`{pass, root, rootBase, revShort, branch, checks, missing, human,
  portBase}`); `root` (absolute) appears only in that local stdout, never on
  the wire or in the DOM. `portBase` is a reserved seam and is always `null`
  (see below).
- The `preflight` line composes the same pure gate as `ow preflight`
  (read-only, no `--probe` unless flagged). It never gates anything:
  `provision` never blocks `up`/`ps`/`reconcile`/`preflight`, and a broken
  checklist changes none of their outputs.

## Shared-`ow.yaml` port discipline

Ports are declared once in the shared file. A conflict warns
(`warning: port conflict: <port> in use (<name> still starting)`) and `up` still spawns —
warn-and-spawn is unchanged. Per-worktree port offsets or service isolation
are the application's own architecture decision (ResAI-side follow-up); the
only ow-side seam is the reserved `portBase` field in provision JSON, which
stays `null` until a later plan amendment defines a source for it. `ow` never
reassigns ports, kills, or breaks locks.

## Identity: who is live where

Readiness entries carry an additive `worktree: {rootBase, revShort}` identity
(only when more than one root is registered — single-root snapshots are
byte-identical to before). The dashboard renders it as an inline
`<rootBase>@<revShort7>` chip (basename only when the rev is unknown) plus a
`wt:<basename>` filter token, both inside the existing provenance card. No new
panel, no polling, no action buttons. Absolute paths and full revs never reach
the DOM (full revs travel only as copy-button clipboard payloads, as before).

## Ownership ledger + advisory collisions (who is live where)

With more than one root registered, the coordinator snapshot carries a
`worktrees` ownership ledger — one row per root: `rootBase`, `revShort`,
`branch`, `lock` (`live`/`stale`/`absent`/`corrupt`/`unknown`), `liveServices`
(spawn-recorded, not known-dead), and supervisor-file `state`
(`ok`/`missing`/`corrupt`/`bad-version`). Same-name services are listed under
each root (no silent first-wins collapse at this layer). The dashboard renders
it as a read-only list inside the existing coordinator view (no buttons, no
polling); single-root snapshots carry no ledger at all.

Port sharing (same declared port recorded under ≥2 roots) and service
double-ownership (same service recorded alive under ≥2 roots) surface as
advisory snapshot warnings only — scoped with `worktree:<base>` tags and
explicit non-gating wording `(informational, no blocking)`. They never fail
the preflight gate and never block `up` (warn-and-spawn is unchanged).

Ledger-only fallback: if a ≥2-week farm pilot shows zero avoided incidents or
warning fatigue, the matrix warnings drop out and only the ledger ships (this
paragraph is the fallback — no code change needed beyond ignoring the
advisory lines, which old readers already skip).

## Witness boundary (what provision never does)

- Never reads secret values (`.env` contents are never opened — only the
  symlink target's existence is checked).
- Never copies or auto-provisions env files, never installs tools.
- Never spawns, stops, probes (without `--probe`), or touches locks/state.
- Every note/missing/human string passes through `maskSecrets()`.
