# OpenWorkspace

Keep your AI agent. Give it a local workspace where it can understand the whole project, work within explicit access, and eventually verify real results.

**M0 preview:** a host-native local service, React/TypeScript dashboard with Tailwind 4 and source-owned shadcn/Base UI components, directory-access approval, bounded project discovery and an actual stdio MCP bridge. This is not yet the PM2/Docker/database/browser verification MVP. See [ROADMAP.md](ROADMAP.md) for the evolving milestones and plugin direction.

## Install and use the product

There is **no packaged end-user release yet**. This source preview is for local development and early pilots, not a Node-free installer. The intended journey is launch → connect this browser → select/approve projects → see useful inventory → connect your existing AI for technical preparation. A Java project's own toolchain must not change just to operate OpenWorkspace.

The source instructions below are for developing OpenWorkspace itself. Do not run them inside Chatwoot or another application repository, and do not assume a global `openworkspace` command has been installed.

## Develop from source

Prerequisites: Node.js 22.12+ and pnpm 11.24.0. Node 26.8.1 was used for the initial checks; Node 22 compatibility has not been executed yet.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Startup opens the canonical dashboard at `http://127.0.0.1:4318` after readiness. Select **Connect this browser** once, then select/request project access. There is no key entry, pairing command or `pnpm pair`; connecting the browser does not approve a directory. If the default browser cannot be opened, use the printed safe URL. Use `127.0.0.1`, not the `localhost` alias, for the consent route.

The dashboard session expires after 12 hours, is revoked on Disconnect, and becomes invalid when the service restarts. Reload/reconnect using the same one-click screen. Do not copy session or MCP credentials into chat, URLs, logs or client settings. The source distribution still needs Node/pnpm to install OpenWorkspace itself; the bundled-runtime installer is not shipped.

In **Connect your AI**, use **Copy setup request**: the secret-free stdio configuration and onboarding context are one message for your assistant. Collapsed client guides show VS Code/GitHub Copilot, Claude Code, OpenCode V2 and Codex configuration locations/formats. Raw config is an advanced option. Review proposed client changes; the app does not write global client settings. The MCP bridge must run under the same local user as the service.

Start the provided onboarding request or install `skills/openworkspace-onboarding/SKILL.md` in your client's supported skill location. This is consumer guidance shipped separately from the development tree, not automatically installed globally. Developers of OpenWorkspace use `AGENTS.md` and `.agents/skills/openworkspace-development/` instead.

### Custom local configuration

- `OPENWORKSPACE_PORT`: local HTTP port; default 4318.
- `OPENWORKSPACE_HOME`: absolute dedicated private state directory; default `~/.local/share/openworkspace`.
- `OPENWORKSPACE_NO_OPEN=1`: keep startup headless. The source companion also accepts `start --no-open`.

No project environment files are imported. State requires 0700 directories and 0600 files, owned by the current user, without symlinked state-directory ancestors. Use canonical paths on platforms with filesystem aliases. One service owns a state directory; a second instance is rejected. After an ungraceful crash, verify no service still owns that directory before removing its `service.lock`. Never remove another instance's lock just to recover a port.

`pnpm build` creates ignored `web-dist/` assets. The Node service preflights the built manifest and entry before it listens or publishes a connection; a missing/invalid build exits with a build instruction. Vite is the build tool, not a production server. Old `/app.js` and `/styles.css` routes and the vanilla UI are not retained as compatibility fallbacks.

## What works

- Create a named project from explicitly selected repository folders in unrelated locations; no wrapper, cloning or moving is required. A wrapper/monorepo can still be one selected root.
- Select folders through the macOS native-helper path when available, with cancellation/error feedback and an explicit manual fallback for unsupported/headless hosts. The native helper's real GUI selection has not yet been observed in automated validation; injected picker results are not a GUI-support claim.
- Submit a whole root list for pending approval through the dashboard or MCP `workspace_propose({name, roots})`. Selecting folders alone does not scan or approve them.
- Approve or decline the exact list in the dashboard; revoke the whole project's access in **Access & privacy** without deleting repo files.
- Detect manifests, guidance filenames and script **names** separately per approved root and its bounded immediate components. A changed/unavailable root is reported without hiding healthy groups.
- Skip hidden directories, dependency/build directories, symlinked component directories and symlinked manifest files.
- Show executable availability separately from unverified runtime/readiness.
- Reuse approved workspace state after a service restart.
- MCP tools: `workspace_list`, `workspace_propose`, `workspace_inspect`, `workspace_services`, `workspace_workstreams`, `workspace_leases`, `service_control`, `verification_run`, `lease_acquire`, `lease_release`, `onboarding_plan`. Reads are open to the MCP client; `service_control`, `verification_run`, `lease_acquire` and `lease_release` need operator delegation for the workspace, granted once per workspace in the dashboard AI setup and revocable there. Directory approvals, workstream changes and delegation itself stay dashboard-only. `workspace_services` reports bounded PM2 process metadata mapped to approved roots; it is not a runner option, health check or verification.
- MCP prompt: `workspace_onboarding`.

No project file writes, credential-file reads, dependency installs, application lifecycle operations, database/log queries or browser automation are available in M0. These are M1 slices, not fake working buttons. Manifest metadata may still contain sensitive information; this is not an arbitrary-file secret detector.

Private project state has one strict schema: explicit `roots` arrays, no versioned upgrades. There is no literal status field. Unknown shapes fail closed and the file stays byte-identical; invalid/oversized input fails without reset.

## Security boundary

HTTP listens only on 127.0.0.1. Dashboard-session consent requires exact canonical Origin/Host, same-origin browser metadata and an explicit intent; any Authorization header is rejected on creation. Private API operations remain authenticated. Dashboard sessions and the private MCP credential have different capabilities: MCP can list/propose/inspect/onboard, not approve, revoke or mint dashboard sessions. Static assets contain no credential; no cookies or secret-bearing URLs are used.

Directory approval is intentionally narrower than code execution or secret access. Metadata may still be confidential; MCP results are visible to your assistant and may be sent to its model provider. Local-first does not imply that your external assistant keeps all data local.

The stdio bridge runs as your local user and is trusted local code. This is not an OS sandbox and cannot prevent a coding assistant with independent shell access from reading your files outside platform operations. Test coverage is a baseline, not a security audit or penetration-test certification.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm audit
```

Tests use owned temporary directories, loopback HTTP, a real stdio MCP client/server and a separate React behavior suite. They cover pending approval, auth/session reset, mutation-versus-refresh races and safe static delivery. They do not touch application repositories, read real credentials, install tools or start application services. `pnpm typecheck:backend`, `pnpm typecheck:frontend` and `pnpm test:ui` expose the narrower checks when needed.
