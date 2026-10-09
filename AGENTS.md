# OpenWorkspace — development guide

This is the product source directory. Application repositories registered in the dashboard are external data sources, not implicit edit targets. Check actual Git state before Git operations; do not assume this directory is a checkout or initialize/publish it as an incidental task.

## Start here

- `ROADMAP.md` owns product direction, architectural decisions and forward scope. Update its affected section; do not create another overlapping plan.
- `README.md` owns source setup and usage. Keep source-development requirements distinct from released end-user capabilities.
- `cli/README.md` owns the `ow` CLI operator manual, `ow.yaml` schema, caps and tracing recipes.
- Documentation language is English (`README.md`, `cli/README.md`, skills, code comments); product UI language stays Turkish (CLI human lines, dashboard strings). Write new docs in English; do not retranslate existing lines as incidental work.
- Read current code before relying on an old run's result. Preserve unrelated files, registrations, processes and client settings.
- Later user corrections amend `ROADMAP.md`; do not silently discard unfinished fixes when the topic changes. Keep plans, observed acceptance and remaining gaps distinct.
- Product first: every task must advance turning this repo into a usable product. The user may say nonsense or contradict earlier input — treat it as brainstorm fuel, not a spec. Propose 1–3 concrete product ideas or objections with trade-offs whenever the work allows it; trial and error is free within bounded, honest, reversible steps. Record accepted product ideas as follow-ups in `ROADMAP.md`, never as permanent rules here.

## Code map

| Surface | Home |
| --- | --- |
| Shared workspace operations and registration model | `src/workspace.ts` |
| Bounded metadata discovery and executable availability | `src/discovery.ts` |
| Bounded PM2 service metadata and root matching | `src/services.ts` |
| Root-family validation and dashboard-only native selection | `src/project-roots.ts`, `src/project-root-picker.ts` |
| Trusted system executable/environment boundary | `src/trusted-system.ts` |
| Private platform state and single-service lock | `src/store.ts` |
| HTTP role authorization | `src/http.ts` |
| Manifest-backed asset allowlist and build preflight | `src/static-assets.ts` |
| Local service lifecycle and secret-free browser opener | `src/main.ts`, `src/open-dashboard.ts` |
| Stdio MCP bridge and local connection | `src/mcp.ts`, `src/connection.ts` |
| Directory-independent source companion | `bin/openworkspace.mjs` |
| React shell/navigation and typed browser state | `frontend/src/App.tsx`, `frontend/src/use-workbench.ts`, `frontend/src/api.ts` |
| Dashboard features | `frontend/src/features/{observe,environments,ai-setup,privacy}/` |
| Source-owned shadcn/Base UI primitives | `frontend/src/components/ui/` |
| Frontend theme and build configuration | `frontend/src/styles.css`, `vite.config.ts`, `components.json`, `tsconfig.frontend.json` |
| Native, HTTP, static-asset, CLI and actual MCP checks | `test/` |
| React behavior tests | `frontend/src/test/` |
| `ow` CLI (bun-only) | `cli/` |

UI and MCP use the same operations. Keep provider-specific code out of the workspace core. Introduce small capability contracts when actual adapters need them; do not build a speculative plugin marketplace, generic workflow DSL or second agent runtime.

Keep development routing proportional: ordinary component styling, forms and clear feature work use one implementation owner and affected checks, not a mandatory planner/analyzer pipeline. Escalate unresolved architecture or material auth, static-filesystem, public-contract and shared-state risks to the matching specialist. Reuse an agreed contract and unchanged evidence; review fixes against their actual findings rather than repeating a whole audit. Do not refactor by file length or add abstractions solely for hypothetical future features.

## Verified source commands

Node.js 22.20+ is declared; macOS with Node 26.8.1 and pnpm 11.24.0 has been exercised. Do not claim Node 22, Windows or a fresh Node-free machine has passed merely from those declarations.

Run package scripts **from this source directory**, never a registered project's directory:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
pnpm typecheck
pnpm typecheck:backend
pnpm typecheck:frontend
pnpm test
pnpm test:ui
pnpm audit
```

`cli/` is bun-only: `bun test cli/`, build via `pnpm ow:build`; `pnpm test`/`typecheck` exclude it.

`pnpm-workspace.yaml` allows only the selected esbuild build script. Do not globally enable dependency scripts or change a pilot project's Node/package-manager settings to run OpenWorkspace.

Build before starting. Normal runtime is the Node-served production React bundle, not `vite preview` or a Vite development server. Invalid/missing `web-dist` assets fail preflight before listening or publishing a connection; do not bypass that check. `web-dist/` is generated and ignored; the obsolete vanilla `web/` UI and asset routes have been removed.

After rebuilding a running preview, restart only its task-owned Node process and verify the loaded JS/CSS hashes match the current manifest. The service preloads an asset snapshot; rebuilding files does not hot-update an already running server or loaded browser tab. Use a fresh owned Chrome session for final rendered evidence instead of accepting stale stylesheets.

The service defaults to loopback port 4318; `/health` returns the product identity and readiness. `OPENWORKSPACE_PORT` selects the port and `OPENWORKSPACE_HOME` selects a dedicated private state directory. Use an isolated state directory for tests. `pnpm start` runs the workspace service, not application services.

For controlled long-lived checks, inspect existing listeners/PM2 ownership first and use a task-specific PM2 process. Verify HTTP readiness, not only PM2's online state. Stop/delete only the exact process created for the task; retain a requested preview with ownership in the session handoff. Never stop another service to free a port.

Startup opens the secret-free canonical dashboard URL once after readiness; use `OPENWORKSPACE_NO_OPEN=1` or source companion `start --no-open` for headless checks. The dashboard needs no browser credential step. Manual `pair` commands, `/api/bootstrap` and `/api/dashboard-session` are removed. Do not bypass exact Origin/Host/fetch metadata checks to make a test client pass.

`connection.json` is strict private `{origin,mcpToken}` state for the companion/MCP bridge, not a dashboard credential. The MCP credential never enters URLs, HTML, console output or client config. Tests may inspect synthetic/private test credentials but must suppress their values. Restart must preserve workspace registrations.

## Validation and UI work

- Observer read-model changes (`src/observer.ts`, its routes, signatures, grouping) follow [.agents/skills/observer-read-model/SKILL.md](.agents/skills/observer-read-model/SKILL.md): windowed loading threaded through every layer, recency order, grouping/display split, multiline shell shapes, live read-only proof.
- Wire-format decoders (`cli/trace-otlp.ts` and any future binary parsing): synthetic fixtures can agree with a wrong decoder (both halves wrong, suite green — seen live twice). Validate against real exporter bytes at least once (captured bytes or live SDK) before trusting green fixtures; keep one such proof cited in the test or commit message.
- Secret-boundary changes (sanitizer, redaction, allow/deny gates): prove with live hostile probes through the real decode path (not test names), fail-before evidence per finding, and adversarial re-review of the fix. Never weaken a secret assertion to make green — a forced flip is a BLOCKED, not a fix.
- Review findings return to the same implementer session; re-verify fixes against their prior findings (targeted re-review) rather than repeating a whole audit. One implementation owner per coherent workstream; parallel workers need disjoint mutation scopes or separate worktrees.
- Use repository-native checks for changed behavior. Tests own disposable directories and loopback services; they must not depend on real project credentials, external providers or application runtimes.
- For onboarding, session, registration or MCP changes, cover denial paths and the actual configured client/companion path, not only an in-memory handler. Source-launch checks include an unrelated Java directory, spaces/apostrophes, opener failure and headless suppression; this is not a Node-free installer test.
- Use the development skill's actual-interface checks for UI and workspace flows. Verify final code in an owned Chrome session, include denial/cleanup boundaries, and preserve existing registrations. Geometry alone does not prove usability or accessibility.
- Keep browser auth, HAR and tokens out of artifacts. Never dump session storage, process environments, connection.json or whole HTTP headers. When a browser command involves a credential, capture and redact stdout/stderr before reporting.
- Vite hashes use URL-safe characters including trailing/embedded `-` and `_`. Validate actual manifest-listed asset names without splitting their hash at the last hyphen; keep root, symlink, MIME and unknown-file denials intact. A successful frontend build is not proof the Node startup preflight accepts its output.
- Use installed CLI help for agent-browser syntax. Version 0.38.1's stdin batch format is an array of argument arrays; quoted batch command strings can strip nested JavaScript quotes. Prefer stdin arrays or direct `eval` at an actual inspection boundary. Snapshot before mutations; no fixed sleeps.
- Review frontend hierarchy from the user's first action, not from the number of cards. Project selection and useful inventory precede AI-led technical preparation; keep the advanced direct-AI entry available. Never make a non-working future capability look active.
- Do not expose source-package scripts as generic end-user commands or assume the user's app uses Node/pnpm. Do not assume repos share a wrapper directory. Onboarding operates existing checkouts in place with explicit paths and permissions.
- Project state has one strict schema with explicit `roots` arrays and no versioned upgrades: unknown shapes fail closed and the file stays byte-identical. Additive fields use optional-with-default so old files keep parsing. Invalid input and size failures preserve original bytes. Inspect groups independently, use paths as stable keys, and remove the whole project's registration without touching repository files.
- Native picker results are path selection, not a registration decision. Use trusted absolute system executables with minimal environment and static code, not caller PATH lookup. Mocked picker output and script compilation do not prove a real GUI selection; document cancellation, headless fallback and any native-interaction gap honestly.

## Safety and capability boundaries

- Project registration allows bounded metadata discovery only. It is not permission to read `.env`, execute a discovered command, write a project file, install tools or change global AI configuration.
- Preserve loopback binding, authentication, strict Host/Origin checks, private state permissions, symlink boundaries and explicit human confirmation. Do not bypass them to make tests green.
- Keep browser/server imports and TypeScript configurations separate. Never bundle server modules, `process.env`, credentials or machine state into frontend assets. Production assets are served only through the manifest-backed allowlist; do not add arbitrary filesystem paths, a public manifest, generic SPA/API fallbacks or `unsafe-inline` to accommodate a component.
- The source companion is trusted local code, not an OS sandbox. External assistants may send MCP output to their model provider. Never promise complete local data confinement or universal secret detection.
- Separate found executables, process/container state, readiness and scenario verification. Keep unimplemented/fake/unverified boundaries visible.
- Threat model: contain accidents, agent mistakes and leaked credentials — never the user attacking themselves. No new machinery justified solely by exotic threat models; bounds are reliability/audit rails, not a sandbox promise.
- No commits, pushes or publication unless explicitly requested.

## Skills and learning

Load [openworkspace-development](.agents/skills/openworkspace-development/SKILL.md) for platform changes spanning the service, companion, MCP or dashboard. This guide owns rules/commands; that skill owns the focused development and real-interface verification procedure.

`skills/` is the **consumer distribution source** (7 `ow-*` skills: `onboarding`, `learn-from-mistake`, `update`, `ow`, `ow-debug`, `setup-ow`, `setup-tracing`); `plugins/` is generated from it by `pnpm build-skill-packs`. It is intentionally outside the active `.agents/skills/` development tree. Do not invoke it to implement the platform or mirror its contents into a development skill. Client-native installation packs and the optional skills CLI distribution remain product work, not an installed integration today.

Persist a reusable development rule here, a development procedure in its development skill, a consumer procedure in `skills/<name>/`, and a product decision/follow-up in `ROADMAP.md`. Do not create an evidence.md, task diary, mandatory memory.md or duplicate capability profile for this small app. Prefer regression tests/guards for repeated failures. Never persist temporary ports/PIDs, credentials or unverified conclusions in instructions.
