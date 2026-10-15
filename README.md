# OpenWorkspace

Keep your own coding agent. OpenWorkspace shows what it actually did and runs the dev services around it — locally, without replacing your harness.

- **`ow` CLI** — read-only session observer (`sessions`, `show`, `meta`, `reads`, `where`, `version`) plus dev-service supervision (`up`/`down`/`ps`/`logs`).

**Source preview — no packaged release yet.** `ow` is bun-only and built manually. This is not a Node-free installer.

## Develop from source

Prerequisites: [bun](https://bun.sh) for the `ow` CLI; pnpm 11.24.0 for skill-pack generation.

```sh
pnpm install --frozen-lockfile
pnpm ow:build     # compile cli/cli.ts -> cli/ow (bun)
```

Run package scripts **from this source directory**, never from an application checkout.

### The `ow` CLI

```sh
pnpm ow:build                         # build once (gitignored binary)
./cli/ow version --json                # inspect the source build before installing
ow doctor                             # health: log growing, hooks firing, db readable
ow sessions                           # what ran, where, how much
ow show <session> [--tree]            # grouped task view, incl. subagent sessions
ow show <session> --json              # stable machine output (English keys)
```

For a persistent PATH installation, copy the verified binary **and** its adjacent
`cli/ow.build.json` sidecar into a user-owned directory outside the source checkout
(for example `~/.local/lib/ow/builds/<binary-sha256>/`), then point
`~/.local/bin/ow` at that copy. Verify its hash, `ow version --json` and a task-owned
service start/stop from an unrelated directory. A direct link to `cli/ow` is a
development convenience, not a durable installation: never leave global `ow`
dependent on a disposable worktree. Preserve the previous artifact for rollback.

`ow` observes **OpenCode sessions** through the shell-observer plugin (`~/.config/opencode/opencode-plugins/shell-observer/`); other harnesses are not observed — an empty result means "not observed", never "nothing happened". Session analysis is read-only. Service supervision, the `ow.yaml` schema and caps live in [cli/README.md](cli/README.md); the consumer skills in `skills/` are the operator guidance.

## Custom local configuration

The `ow` CLI keeps its own repo-local state in `<root>/.ow/` (0700/0600).

## What works

- **`ow` observer:** session inventory, grouped task view with subagent trees, file reads, cost/tokens and JSON output — read-only over OpenCode's session store.
- **`ow` supervision:** start/stop/list/log declared dev services from a repo `ow.yaml` as plain child processes; `lstart`-guarded pids, repo-local state, port-conflict warnings (never reassignment).
- **Consumer skills (8):** `onboarding`, `learn-from-mistake`, `update`, `ow`, `ow-debug`, `ow-runtime`, `setup-ow`, `prepare-local-runtime`, snapshotted per client.

## Consumer skill distribution

`skills/<name>/SKILL.md` is the only hand-edited skill text. `pnpm build-skill-packs` snapshots each skill verbatim per client under `plugins/` with an `ow-` command-name prefix (OpenCode: `plugins/opencode/ow-<name>.md`). Install is a copy performed by your own agent through the `setup-ow` skill into project-local paths (OpenCode: `.opencode/commands/ow-<name>.md`), with human approval before every write. Pack files are self-contained — the copied file carries the full skill text, so no further install step is needed for content. An unprefixed or global binding (for example `~/.config/opencode/commands/learn-from-mistake.md`) is separate manual configuration, never written by the product; project-local-only is the rule unless the user explicitly asks for wider scope.

## Security boundary

The CLI reads application checkouts but never writes them and never reads secret values — only key names. Secret-shaped values are masked everywhere by construction. Registration-style metadata may still be confidential; skill results are visible to your assistant and may be sent to its model provider. Test coverage is a baseline, not a security audit.

## Verify

```sh
bun test cli/                     # ow CLI suites (bun-only)
pnpm audit
```

Tests use owned temporary directories and loopback services; they do not touch application repositories, read real credentials, install tools or start application services.
