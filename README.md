# OpenWorkspace

Keep your own coding agent. OpenWorkspace shows what it actually did and runs the dev services around it — locally, without replacing your harness.

- **`ow` CLI** — read-only session observer (`sessions`, `show`, `stuck`, `meta`, `prompts`, `reads`, `tree`, `timeline`) plus dev-service supervision (`up`/`down`/`ps`/`logs`) and optional OpenTelemetry tracing.
- **Dashboard** — observer-first, read-only view of recorded agent activity, environment status, AI setup and privacy.
- **MCP bridge + skills** — project registration, environment orchestration and a small learning loop for your existing assistant. Shell-native work (commands, log tails, process control, database queries) stays in your harness; MCP never duplicates it.

**Source preview — no packaged release yet.** `ow` is bun-only and built manually; the dashboard runs from source with Node/pnpm. This is not a Node-free installer.

## Develop from source

Prerequisites: Node.js 22.20+ and pnpm 11.24.0 for the service/dashboard; [bun](https://bun.sh) for the `ow` CLI. Node 26.8.1 has been exercised; Node 22 compatibility is declared but not yet executed.

```sh
pnpm install --frozen-lockfile
pnpm build        # dashboard bundle -> web-dist/ (required before start)
pnpm start        # Node-served dashboard at http://127.0.0.1:4318
pnpm ow:build     # compile cli/cli.ts -> cli/ow (bun)
```

Run package scripts **from this source directory**, never from a registered project. `pnpm start` opens the dashboard at `http://127.0.0.1:4318` after readiness; use `127.0.0.1`, not the `localhost` alias. `OPENWORKSPACE_NO_OPEN=1` (or the source companion `start --no-open`) keeps startup headless. Startup opens only a secret-free URL — there is no password, pairing command or key-entry step.

The Node service preflights the built manifest before it listens; a missing/invalid `web-dist/` exits with a build instruction. Vite is the build tool, not a production server.

### The `ow` CLI

```sh
pnpm ow:build                         # build once (gitignored binary)
ln -sf "$PWD/cli/ow" ~/.local/bin/ow  # put it on PATH
ow doctor                             # health: log growing, hooks firing, db readable
ow sessions                           # what ran, where, how much
ow show <session> [--tree]            # grouped task view, incl. subagent sessions
ow stuck <session>                    # retries, re-reads, slow commands
ow show <session> --json              # stable machine output (English keys)
```

`ow` observes **OpenCode sessions** through the shell-observer plugin (`~/.config/opencode/opencode-plugins/shell-observer/`); other harnesses are not observed — an empty result means "not observed", never "nothing happened". Session analysis is read-only. Service supervision, the `ow.yaml` schema, tracing recipes and caps live in [cli/README.md](cli/README.md); the consumer skills in `skills/` are the operator guidance.

### Dashboard and MCP

The dashboard is the observer/coordination surface. Project registration happens through your assistant over MCP (`workspace_register({name, roots})`); the dashboard does not create projects and remains read-only for agent activity. It shows recorded sessions, environment status, AI setup guidance and privacy/access removal.

The Environments view carries a read-only **Coordinator** section per environment (dashboard-only `GET /api/workspaces/:name/coordinator?environment=X`): a reconcile badge (in-sync vs drifted with expected→running rows and a read-only diff preview), a preflight badge (launchable vs missing ports), a checkpoint strip (stage flow with a stale queue and a text-only next-step suggestion) and a provenance card (expected/running table plus a short-hash rev strip with copy buttons; full hashes never render). Everything arrives in one snapshot on the top-bar Refresh — no polling, no action buttons, no secrets or absolute paths on the wire.

To connect an assistant, use **Connect your AI → Copy setup prompt** in the dashboard: one pasted self-install message the agent runs project-locally (MCP entry, MCP-served skills, a marker-delimited `AGENTS.md` note, reload, then free-read verification). The client governs writes; the dashboard records what ran and never writes global client settings. Installed command copies refresh manually via `/ow-update`.

## Custom local configuration

- `OPENWORKSPACE_PORT`: local HTTP port; default 4318.
- `OPENWORKSPACE_HOME`: absolute dedicated private state directory; default `~/.local/share/openworkspace`.
- `OPENWORKSPACE_NO_OPEN=1`: keep startup headless (source companion also accepts `start --no-open`).

State requires 0700 directories and 0600 files, owned by the current user, without symlinked state-directory ancestors; use canonical paths on platforms with filesystem aliases. One service owns a state directory; a second instance exits instead of taking over. After an ungraceful crash, verify no service still owns that directory before removing its `service.lock`.

`connection.json` is strict private `{origin,mcpToken}` state for the companion/MCP bridge, not a dashboard credential. The MCP credential never enters URLs, HTML, console output or client config. Restart preserves registrations.

The `ow` CLI keeps its own repo-local state in `<root>/.ow/` (0700/0600), and its optional tracing receiver binds `127.0.0.1:4319` — never the dashboard's 4318.

## What works

- **`ow` observer:** session inventory, grouped task view with subagent trees, stuck/retry signals, prompts, file reads, cost/tokens and JSON output — read-only over OpenCode's session store.
- **`ow` supervision:** start/stop/list/log declared dev services from a repo `ow.yaml` as plain child processes; `lstart`-guarded pids, repo-local state, port-conflict warnings (never reassignment).
- **`ow` tracing:** opt-in embedded loopback OTLP/HTTP-protobuf receiver with redacted, capped span storage and `ow trace` / `ow timeline` views.
- **Dashboard:** React/TypeScript + Tailwind 4 + source-owned shadcn/Base UI; observer-first views plus environments, AI setup and privacy/access removal.
- **MCP tools (13):** `workspace_list`, `workspace_register`, `workspace_inspect`, `onboarding_plan`, `environment_propose`, `environment_set`, `environment_status`, `environment_up`, `environment_down`, `environment_verify`, `environment_rename`, `run_import`, `learning_record`.
- **Consumer skills (7):** `onboarding`, `learn-from-mistake`, `update`, `ow`, `ow-debug`, `setup-ow`, `setup-tracing`, served over MCP and snapshotted per client.
- **Bounded discovery:** manifests, guidance filenames, script **names** and Compose-file presence per registered root; hidden/dependency/symlinked entries skipped; found executables shown separately from unverified runtime/readiness.
- **Private project state:** one strict schema, explicit `roots` arrays, no versioned upgrades; unknown shapes fail closed and stay byte-identical.

Owned-environment start/stop with readiness (`environment_up`/`environment_down`) and receipt-bound verification of one repo-native script (`environment_verify`) are available over MCP and the dashboard, authorized by your assistant's permission model and recorded in recent activity. Docker is presence-only inventory; commands, logs and process control stay in your own shell.

## Security boundary

HTTP listens only on `127.0.0.1` with strict Host/Origin/fetch-metadata checks. The dashboard is open loopback (dev-only personal use: any local process can call it); the MCP credential gates the MCP-bridge path and is never minted from or exposed to the dashboard. Static assets contain no credential; no cookies or secret-bearing URLs. The stdio bridge runs as your local user and is trusted local code — not an OS sandbox.

Registration is intentionally narrower than code execution or secret access. Metadata may still be confidential; MCP results are visible to your assistant and may be sent to its model provider. Test coverage is a baseline, not a security audit.

## Verify

```sh
pnpm typecheck                    # backend + frontend
pnpm test                         # Node tests + React behavior suite
bun test cli/                     # ow CLI suites (bun-only)
pnpm audit
```

Tests use owned temporary directories, loopback HTTP, a real stdio MCP client/server and a separate React behavior suite; they do not touch application repositories, read real credentials, install tools or start application services.
