# OpenWorkspace

Keep your AI agent. Give it a ready multi-service environment plus memory that learns from its mistakes — shell-native work stays in your harness, orchestration and learning live here.

**Source preview:** a host-native local service, React/TypeScript dashboard with Tailwind 4 and source-owned shadcn/Base UI components, direct project registration, bounded project discovery, read-only PM2/Docker inventory for the dashboard, owned multi-service environment orchestration with receipt-bound verification, workstreams with resource leases, and an actual stdio MCP bridge. Per-service shell control, log tails, direct database queries and declared local tools are intentionally not served: your harness already does that work. Docker/Compose control, packaged distribution and fresh-machine setup remain later gates. See [ROADMAP.md](ROADMAP.md) for the evolving milestones and plugin direction.

## Install and use the product

There is **no packaged end-user release yet**. This source preview is for local development and early pilots, not a Node-free installer. The intended journey is launch → connect this browser → register projects → see useful inventory → connect your existing AI for technical preparation. A Java project's own toolchain must not change just to operate OpenWorkspace.

The source instructions below are for developing OpenWorkspace itself. Do not run them inside Chatwoot or another application repository, and do not assume a global `openworkspace` command has been installed.

## Develop from source

Prerequisites: Node.js 22.20+ and pnpm 11.24.0. Node 26.8.1 was used for the initial checks; Node 22 compatibility has not been executed yet.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Startup opens the canonical dashboard at `http://127.0.0.1:4318` after readiness. Select **Connect this browser** once, then register projects. There is no key entry, pairing command or `pnpm pair`; connecting the browser does not register a directory. If the default browser cannot be opened, use the printed safe URL. Use `127.0.0.1`, not the `localhost` alias, for the consent route.

The dashboard session expires after 12 hours, is revoked on Disconnect, and becomes invalid when the service restarts. Reload/reconnect using the same one-click screen. Do not copy session or MCP credentials into chat, URLs, logs or client settings. The source distribution still needs Node/pnpm to install OpenWorkspace itself; the bundled-runtime installer is not shipped.

In **Connect your AI**, use **Copy setup prompt**: one pasted self-install message for your own assistant — it installs the secret-free project-local stdio entry, uses MCP-served skills, proposes an AGENTS.md note showing the exact diff, then verifies with free reads after reload. Already connected? Paste the new prompt — your agent re-merges the entry, adds the AGENTS.md note, and re-verifies with workspace_list. Your client governs writes; the dashboard records what ran; the app does not write global client settings. Installed command copies refresh manually via `/ow-update` (or a freshly pasted prompt); per-client command surfacing is UNVERIFIED until run on a real client. The MCP bridge must run under the same local user as the service.

Start the provided onboarding request or install `skills/onboarding/SKILL.md` in your client's supported skill location. This is consumer guidance shipped separately from the development tree, not automatically installed globally. Developers of OpenWorkspace use `AGENTS.md` and `.agents/skills/openworkspace-development/` instead.

### Custom local configuration

- `OPENWORKSPACE_PORT`: local HTTP port; default 4318.
- `OPENWORKSPACE_HOME`: absolute dedicated private state directory; default `~/.local/share/openworkspace`.
- `OPENWORKSPACE_NO_OPEN=1`: keep startup headless. The source companion also accepts `start --no-open`.

No project environment files are imported. State requires 0700 directories and 0600 files, owned by the current user, without symlinked state-directory ancestors. Use canonical paths on platforms with filesystem aliases. One service owns a state directory; a second instance exits instead of taking over. After an ungraceful crash, verify no service still owns that directory before removing its `service.lock`. Never remove another instance's lock just to recover a port.

`pnpm build` creates ignored `web-dist/` assets. The Node service preflights the built manifest and entry before it listens or publishes a connection; a missing/invalid build exits with a build instruction. Vite is the build tool, not a production server. Old `/app.js` and `/styles.css` routes and the vanilla UI are not retained as compatibility fallbacks.

## What works

- Create a named project from explicitly selected repository folders in unrelated locations; no wrapper, cloning or moving is required. A wrapper/monorepo can still be one selected root.
- Select folders through the macOS native-helper path when available, with cancellation/error feedback and an explicit manual fallback for unsupported/headless hosts. The native helper's real GUI selection has not yet been observed in automated validation; injected picker results are not a GUI-support claim.
- Register a whole root list directly through the dashboard or MCP `workspace_register({name, roots})`. Selecting folders alone does not scan them.
- Remove the whole project's registration in **Access & privacy** (or `DELETE /api/workspaces/:id`) without deleting repo files.
- Detect manifests, guidance filenames, script **names**, and Compose file presence separately per registered root and its bounded immediate components. Compose YAML is not parsed; a changed/unavailable root is reported without hiding healthy groups.
- Skip hidden directories, dependency/build directories, symlinked component directories and symlinked manifest files.
- Show executable availability separately from unverified runtime/readiness.
- Reuse registered workspace state after a service restart.
- MCP tools (22): `workspace_list`, `workspace_register`, `workspace_inspect`, `onboarding_plan`, `workspace_workstreams`, `workspace_leases`, `environment_propose`, `environment_set`, `environment_status`, `environment_up`, `environment_down`, `environment_verify`, `environment_rename`, `lease_acquire`, `lease_touch`, `lease_release`, `workstream_create`, `workstream_status`, `workstream_context`, `workstream_rename`, `run_import`, `learning_record`. Mutations are authorized by your coding assistant's own permission model — your client governs writes; the dashboard records what ran in recent activity instead of gating it. Re-registering a name replaces its root list in place (upsert) with the stable ID preserved. `environment_status` reports owned-environment service state; raw process reality stays in your own shell. Docker mapping requires an exact Compose `working_dir` or config-file directory label match to one registered root; ambiguous/unmatched containers remain visible but unactionable, and missing Docker/daemon is reported unavailable.
- MCP prompts: `workspace_onboarding` plus `skill/<name>` for the four consumer skills (`learn-from-mistake`, `new-task`, `onboarding`, `update`).

Owned environment start/stop with readiness (`environment_up`/`environment_down`) and receipt-bound verification of one repo-native script (`environment_verify`) are available through MCP and the dashboard, authorized by your assistant's permission model and recorded in recent activity. Docker is presence-only: no restart, stop, exec, attach or log operations. Commands, log tails and process control stay in your own shell — MCP never duplicates what your harness already does. Manifest metadata may still contain sensitive information; this is not an arbitrary-file secret detector.

Private project state has one strict schema: explicit `roots` arrays, no versioned upgrades. Unknown shapes fail closed and the file stays byte-identical; invalid/oversized input fails without reset.

## Security boundary

HTTP listens only on 127.0.0.1. Dashboard-session consent requires exact canonical Origin/Host, same-origin browser metadata and an explicit intent; any Authorization header is denied on creation. Private API operations remain authenticated. The MCP credential may use workspace operations; it cannot mint dashboard sessions. Only browser-session issuance/deletion, native folder picking and client configuration stay dashboard-side. Static assets contain no credential; no cookies or secret-bearing URLs are used.

Registration is intentionally narrower than code execution or secret access. Metadata may still be confidential; MCP results are visible to your assistant and may be sent to its model provider. Local-first does not imply that your external assistant keeps all data local.

The stdio bridge runs as your local user and is trusted local code. This is not an OS sandbox and cannot prevent a coding assistant with independent shell access from reading your files outside platform operations. Test coverage is a baseline, not a security audit or penetration-test certification.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm audit
```

Tests use owned temporary directories, loopback HTTP, a real stdio MCP client/server and a separate React behavior suite. They cover registration/removal, auth/session reset, mutation-versus-refresh races and safe static delivery. They do not touch application repositories, read real credentials, install tools or start application services. `pnpm typecheck:backend`, `pnpm typecheck:frontend` and `pnpm test:ui` expose the narrower checks when needed.
