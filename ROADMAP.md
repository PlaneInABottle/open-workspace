# OpenWorkspace — evolving product plan

Status: active; decisions may change with pilot evidence. This is the single product/architecture roadmap, not an incident diary. Update the affected section rather than adding parallel plans.

## Promise and audience

Keep your own AI agent. Give it a ready multi-service environment plus memory that learns from its mistakes — so setup repeats less and the next task starts warm. Shell-native work (commands, log tails, process control, database queries) stays in the agent's own harness: anything the harness already does via shell is not re-served over MCP. The platform owns environment orchestration and learning; the harness owns execution.

Start with developers who already use a coding assistant but leave value on the table. The advanced user lifts four or five repos (frontend, backend, db) to develop one feature; most users work frontend-only and simple, never fully test with the agent and still verify by hand — or change the backend, curl once, and never check whether the db actually changed. OpenWorkspace hands them the advanced workflow as a workspace: the user pastes one setup prompt in their own repo, their agent registers repos (multi-repo into one workspace) and the platform holds the environment and the memory while the agent works in its own shell. No-fight principle: MCP serves environment orchestration plus memory only; shell-native work stays in shell. Learning from the agent's own shell work under the workspace — receipts and lessons — makes every next task faster and easier. Developers are becoming coordinators: while the agent works, they need a place to see what is being done and how — live status, receipts, and learned lessons — instead of waiting on a chat reply. The dashboard earns its place as that coordination surface: read-only visibility first (timeline, environment status, lesson list), no operate controls. Inventory, receipts, and guardrails exist to serve that loop: do the task, prove it, learn from it. The core is reusable; scope grows only where pilot evidence shows leverage.

## Fixed direction

- Build our own product, informed by OpenSEO's shared UI + MCP + skills model; do not fork its SEO implementation.
- Host-native local service and web dashboard. No new agent runtime, IDE, or mandatory chat interface.
- Observer-first dashboard (dev-only, user-ordered replacement): the dashboard opens on observed agent activity (sessions/tree/mistakes/stuck/cost) plus environments, AI setup and privacy — project selection, inventory, records and lessons UI are removed. Registration and orchestration stay project-based over MCP; the project-first default below now describes the MCP/assistant path, not the dashboard landing.
- PM2 and Docker/Compose are alternative application runners, not frontend/backend categories. Running, healthy, and scenario-verified are distinct states.
- Jira is optional. A workspace and verification run work without a ticket or integration. Future issue providers attach references, not core identities.
- Log capabilities attach independently. Browser observation, datastore adapters, per-service shell control, log tails and declared local tools are shed (harness-first pivot): no browser MCP tools, no observer shim, no direct datastore query tool, no `service_control`/`service_logs`, no `local_tool_status` and no scaffold flow. Workstreams and leases are shed with the same no-fight rule (harness tracks tasks natively; single-user local needs no lock ceremony): no workstream/lease MCP tools, routes, store slices, board UI or `new-task` skill. A power user keeps direct CLI usage outside the platform; neither path requires replacing their coding assistant. MCP covers environment orchestration plus memory only — anything the harness already does via shell is not re-served.
- Keep a local target identity in every connection/result now; defer named DEV/UAT profiles, mixed remote/local environments, cloud inventories and hosted architecture.
- No document treadmill: definitions have one authoritative home, transient work stays in private machine-readable state, and reusable learning becomes a small correction or executable guard.
- Parallel delivery is the second major product milestone (M2), not part of the first vertical workflow. Design stable workspace/run/resource identities now without implementing a scheduler prematurely.

## Architecture boundaries

UI and MCP call the same workspace operations. A local stdio MCP bridge is the first transport: clients do not copy our service credential into their configuration. HTTP MCP can follow once client compatibility is verified.

The local service owns registrations. A directory is explicitly registered before discovery reads it. Read only known manifest/instruction metadata, never environment/credential files during discovery. Discovered commands are candidates until a bounded execution verifies them.

Adapters implement concrete capabilities: the owned application runner (environment orchestration) and issue provider. Datastore reader, log reader, per-service shell control and browser automation adapters are shed by the harness-first pivot — the agent's own shell covers them, so no second implementation lives behind MCP. Implement adapters as ordinary modules; no marketplace/plugin loading framework in the MVP. No connector is required by unrelated capabilities.

### Pluggable product direction (user clarification)

Harness first (Claude Code / Codex / OpenCode): the user's harness is the execution surface and OpenWorkspace never fights it. Agent-first setup — the user pastes one setup prompt in their own repo and their agent registers repos, including multi-repo, into one workspace — replaces product-led provisioning. Providers attach environment orchestration and memory around that shell-native work, never a second shell.

Repos are the stable center; surrounding tools are replaceable connections. The long-term model is add/remove/enable/disable a capability provider per workspace, not configure one mandatory product stack. Jira vs another tracker, PostgreSQL vs MongoDB and PM2 vs Compose must not change core workspace identity. A connection can advertise only the capabilities it actually supports; do not pretend SQL and document queries have identical semantics.

Use ports/adapters and dependency inversion at real operation boundaries: core operations depend on small capability contracts, providers own vendor-specific requests/credentials/errors. Prefer composition and ordinary module injection over inheritance, a universal provider superclass or a generic workflow DSL. Add a capability registry when the first actual runtime adapters are implemented in M1; keep discovery separate from execution. Do not create empty interfaces for hypothetical integrations in M0.

Future plugin packaging adds a versioned descriptor (provider ID/version, offered capabilities, configuration schema and required permissions), lifecycle (connect/check/disconnect) and compatibility checks around these same contracts. UI and MCP enumerate available capabilities instead of hardcoding a Jira-first flow. Removing a provider stops new operations and disconnects owned resources; it must not erase repos, learned facts or historical runs. An active run must stop/queue safely rather than switch provider silently.

Installing an in-process plugin grants code execution under the host account. Later third-party plugins need explicit provenance/permission approval and a separately designed process/isolation boundary; interface design alone is not a sandbox. No untrusted dynamic loading in the MVP. Change these contracts with observed pilot needs rather than freezing a speculative full plugin API now.

Persistent portable definitions contain repo paths/relative mappings, selected commands, resource references and skills; credentials and runtime identities are local/private. Credentials are referenced by identity, not copied to manifests or prompts. File/env writes in M1 require an exact destination and suggested scope, preserve existing values/comments, and support a preview. External account/API-key acquisition, OAuth consent, SSO, MFA and elevation stay human actions.

M2 introduces a workstream referencing one or more repository checkouts and an explicit runtime revision set. Resource ownership is separate from Git isolation. Shared DB/mailbox/browser/deployment targets serialize unless genuinely isolated. Worktrees are not security sandboxes.

## Onboarding flow

1. Start the local app; it opens the secret-free canonical dashboard URL. The first substantive task is project selection and useful inventory, not MCP configuration.
2. Create a named project, select its explicit repository roots, and review the whole list. Advanced users can call `workspace_register({name, roots})`. Native macOS selection has a trusted helper with cancellation/headless fallback; actual GUI interaction remains unobserved. Registration does not authorize secret-file reads, and a wrapper/common parent is not required.
3. Discover metadata and installed executable availability and show the useful inventory before requiring an AI connection. Show found/missing/unverified separately. Offer the chosen assistant's version-checked connection flow as the next technical-preparation step, not a prerequisite for viewing registered metadata.
4. Assistant suggests required installs, runtime configuration and connection references and applies them scoped to this workspace; the dashboard records what ran. Never silently modify global agent configuration or install every optional tool.
5. For optional Jira, offer Atlassian MCP configuration only when Jira is selected. Preserve client config, explain OAuth login steps, and verify connection before claiming success. Platform authentication and Atlassian authentication remain separate.
6. Request unavailable external keys through a private connection form, not conversation text. Explain minimum privileges and test the intended connection without exposing secrets.
7. Bring up only the necessary owned environment services and prove readiness (`environment_up` with loopback readiness). Raw process control stays in the agent's own shell. Resume from verified prerequisites after interruption.

### Launch and dashboard access

**Cutover — no browser token:** manual pairing/password UI, `/api/bootstrap`, `src/pair.ts`, CLI `pair`, `pnpm pair`, `src/dashboard-sessions.ts` and `POST`/`DELETE /api/dashboard-session` are removed, without a legacy fallback. Start opens the secret-free local dashboard URL after readiness. The dashboard is open loopback (dev-only personal use); project registration stays independent.

- Dashboard requests carry no bearer: loopback Host/Origin/fetch-metadata checks are the boundary, and any local process can call dashboard HTTP. Unknown bearers are rejected; the MCP bearer keeps gating the bridge path. Same-OS-user processes are trusted, so this is not a process-identity proof.
- The strict private connection file stays `{origin,mcpToken}` for the companion/MCP bridge; native folder picking and client configuration stay dashboard-side. Do not accept the old shared credential as compatibility.
- `src/main.ts` owns browser opening once; `--no-open` / `OPENWORKSPACE_NO_OPEN=1` suppress it for headless operation and tests. Opener failure leaves the ready service usable and prints only a safe URL/action. Platform opener support must be tested, not inferred from command names.
- Preserve private-view resets, late-response/mutation guards, strict static delivery/CSP and workspace-state data. Packaged Node-free installation, multi-repo project creation and native repository picking remain distinct work; do not mix them into this auth change.

### Project creation and smoothness evaluation

The accepted connected-project rail stays. Named projects group explicitly selected roots from unrelated directories; a ResAI-style wrapper is optional. Projects flow: Create project → name → select repo folders → review exact access → useful inventory. No repos are moved and no common-parent permission is inferred.

Bounded contract: project IDs and `workspaces` storage/API ownership remain; registrations use `roots: string[]`. Validated v1 records migrate data-only to `roots: [path]`, preserving ID/name/timestamp as registered workspaces. ResAI keeps one wrapper registration. No discovery widening occurs during migration. Malformed/unknown/oversized state stays byte-identical; writes are atomic/private and capped at 1 MiB. The same repo can be linked to different projects.

Registration limits must agree: up to 20 roots, each at most 4096 UTF-16 characters, with an explicit 512 KiB encoded JSON-body cap only for registration requests. Parse a buffered byte stream once with fatal UTF-8 decoding, not per-chunk `toString()`, so split multibyte characters round-trip and invalid bytes fail closed. Enforce the serialized state cap before replacing any stored file. Registration validates all roots before one commit and refuses within-project duplicate/ancestor overlaps without widening scope to a common parent. Inventory groups by root and reports a changed/unavailable root without following a new target.

Keep this first model unit small: whole-project removal remains the existing operation (`DELETE /api/workspaces/:id`) and clears every selected root/cache; partial-root remove/edit is deferred until needed, not added merely by the plan. Consumer tool guidance and copied setup context use explicit roots with the API/MCP contract. The native picker is dashboard-only, exact-origin gated, static trusted script through a verified `/usr/bin/osascript` on the macOS pilot, `shell:false`, minimal environment and JSON output (never newline-split paths). It only selects a draft, never registers/scans automatically. Cancel/unavailable/timeouts leave the draft intact; unsupported/headless hosts get an honest manual-roots fallback. Native GUI observation remains a bounded implementation experiment, not passed evidence.

The macOS native-picker helper and v2 schema provide explicit cancel/unavailable/error outcomes and manual fallback. Browser `showDirectoryPicker()` returns a handle, not a trusted Node-host absolute path. Selection is path-picking only; registration happens explicitly afterwards. Actual native GUI selection and OS cancellation remain unobserved. Do not describe those mocks as native-GUI verification or claim Linux/Windows chooser support.

For smoothness, correct DOM/data clearing during same-project background refresh before adding animations. Same-project background refresh retains stable inventory with a busy indication through the inspection. Identity/selection changes still clear it immediately. No motion library or opacity trick is used to mask stale data.

Same-selection background refresh keeps content mounted and busy through both reads, while clearing on identity/permission changes. Projects navigation now clears selection and UUID context even on `#overview`; late inspection cannot reselect it. An identical raw scrollY after a new success notice is not claimed.

### AI setup: one-copy primary flow

The primary action is **Copy setup prompt**: one pasted self-install message that the user's own agent executes — project-local MCP entry install, MCP-served skills, a confirmed AGENTS.md note (marker-delimited, personal edits preserved), reload, then free-read verification (`workspace_list` mandatory; config listings are not proof). Preserve existing client configuration and show an exact diff for any write. Do not require the user to copy configuration and a separate prompt in two trips. Live per-client install paths remain UNVERIFIED until run; do not put MCP/dashboard tokens or project secret files into any copied text.

Client guidance is version-checked against official sources and does not write settings automatically:

- [VS Code / GitHub Copilot](https://code.visualstudio.com/docs/agent-customization/mcp-servers): current docs prefer portable project `.mcp.json` with `mcpServers`; guided **MCP: Add Server**, trust and **MCP: List Servers** verification. The traditional `.vscode/mcp.json` format uses `servers` and is documented as compatibility; do not silently conflate the two or force global configuration.
- [Claude Code](https://code.claude.com/docs/en/mcp): project `.mcp.json` uses `mcpServers`; local/user scope differs. Standard stdio options/command arguments are separated by `--`; verify via `/mcp` or `claude mcp list`. An added entry is not proof it connected.
- [OpenCode V2](https://opencode.ai/v2/docs/mcp-servers): `mcp.servers`, local `type`, executable-plus-args `command` array and `environment` rather than the generic `env` field; verify with `/mcps` / `opencode mcp list`.
- [Codex](https://developers.openai.com/codex/extend/mcp): project `.codex/config.toml` or user `~/.codex/config.toml`, `[mcp_servers.openworkspace]` with `command`, `args`, and environment mapping. CLI/IDE share configuration. Do not advertise a global install/config change as already performed.

Show bounded source-preview instructions and external-client verification gaps honestly. Enterprise MCP policy restrictions are not permission to bypass organization controls. Actual external-client installation remains unverified. They are not a new provider/agent runtime.

Installed command visibility is live-untested: every row below is UNVERIFIED until a real-client run proves it. Refresh installed copies via installed `/ow-update` (manual re-fetch + byte-compare + verbatim overwrite + diff report), or re-paste the setup prompt. There is no auto-refresh.

| Installed copy (project-local) | Expected surfacing | Status |
| --- | --- | --- |
| `.claude/commands/ow-<name>.md` (Claude Code) | Slash-command list (`/ow-<name>`) | UNVERIFIED |
| `.opencode/commands/ow-<name>.md` (OpenCode) | Slash commands (incl. picker) | UNVERIFIED |
| `.agents/skills/ow-<name>/SKILL.md` (Codex) | Skill invocation; slash-vs-picker surfacing | UNVERIFIED |
| `.github/skills/ow-<name>/SKILL.md` (VS Code/Copilot) | Preview-era path; slash-vs-picker surfacing | UNVERIFIED |
| MCP `skill/<name>` prompts | Client's MCP prompt picker after connect; authoritative fallback always | UNVERIFIED rendering |

The application's own language/toolchain must not be a prerequisite for operating OpenWorkspace. The future distribution should bundle its runtime so a Java-only user need not install Node/pnpm. Current source setup still requires Node/pnpm; no packaged Node-free installer or keychain integration is shipped. Do not put a capability secret in a URL/history/argv to chase zero-click behavior: no browser credential step exists, separate from project registration.

### End-to-end adoption journey: GitHub to first value

1. GitHub README clearly identifies audience, current preview limitations and the quickest supported install path. Separate **download/run the product** from **contribute from source**. Do not ask users to clone repos, install pnpm or modify their Java project's engine settings simply to operate the distributed product.
2. Release download/installer verifies provenance and supported OS/architecture, includes the runtime, and opens a loopback dashboard. No unexplained shell script fetching arbitrary code; elevation is a separate consent step. Initial packaging targets follow pilot needs; Windows support is not assumed from macOS tests.
3. Startup opens the dashboard directly with no browser consent step; project selection follows. There is no separate key transfer through chat or terminal. Source opening/headless behavior is in place; packaged-launcher behavior still needs its distribution tests.
4. User selects project directories, reviews precise paths/capabilities and sees bounded useful metadata. Do not require Jira, PostgreSQL, a particular repository language or an external AI connection for this first value. Advanced users retain a direct assistant onboarding entry.
5. Offer client-specific, version-checked AI setup with config previews, preserving existing integrations. The connected assistant discovers technical prerequisites, suggests only needed tools/settings, and walks the user through unavailable provider keys/OAuth. Show useful progress and recovery, not an all-or-nothing setup wizard.
6. First value is an honest project inventory followed by a small real verification, not an empty dashboard of future features. Show unfinished prerequisites and the next action.

M1 launch acceptance must exercise this whole journey on a fresh target machine, from downloaded artifact through first verification, including a Java-only project with no system Node/pnpm, an existing AI config, paths with spaces, a missing optional tool and a human-only OAuth/key step. These are gates for distribution, not evidence from today's source preview.

The project-first default was selected with the user after reference research, not proved universally best by a usability study. Compare first-value time, human actions, setup errors and abandoned prerequisites in the two pilots. Preserve the alternative path rather than automatically maximizing automation.

### Interface references and selected principles

Official documentation and actual published screenshots were inspected; the competing products were not installed or user-tested during this research.

| Reference | Use the interaction principle, not the visual skin |
| --- | --- |
| [Superset first workspace](https://docs.superset.sh/first-workspace) and [install](https://docs.superset.sh/install) | Explicit local project opening, a clear project/workspace hierarchy and observable prerequisite checks. Do not copy its in-app coding chat: our user keeps an external assistant. |
| [Docker Desktop containers](https://docs.docker.com/desktop/use-desktop/container/) | Comparable process/container inventory with details separated into logs/inspect/stats, not a card for every metric. |
| [Portainer initial setup](https://docs.portainer.io/start/install-ce/server/setup) and [containers](https://docs.portainer.io/user/docker/containers) | Useful local inventory early, separate environment connection from resource state, and honest running/healthy/unhealthy labels. Do not inherit its infrastructure-admin density for first-time users. |
| [OpenSEO agent setup](https://openseo.so/docs/agent-setup) | Let the existing assistant perform scoped setup, prefer a supported MCP + skills pack, and separate installed, authenticated and verified states. |

Visual direction: a compact workspace/resource navigation, real project identity and exceptions first, comparable inventory in the center, and progressive detail for readiness/connections. First run is a focused project-and-permission flow; repeat use is an operational workspace. Avoid decorative KPI tiles, giant marketing headlines inside the app, fabricated status data and copying a terminal/chat product's entire interface. The first implementation is a reversible direction, not an empirically established universal best UX.

## Learning, kept small

M1 starts with a compact lesson store (scope, correction, source, verified date) and simple search. The assistant can suggest updates; low-risk fact corrections may be auto-applied only under a user-selected policy. Credential access, new commands and changed targets stay explicit human actions; the dashboard records what ran. Deduplicate and replace stale entries rather than appending every failure. Use revision checks for concurrent writes.

Do not add a mandatory memory.md, vector database, automatic transcript mining or separate evidence.md. Long procedures remain skills; brief facts remain lessons; operation results and cleanup remain run state. A repeated failure should become an early probe or regression test when practical.

Development guidance and consumer guidance have different homes: `AGENTS.md` plus `.agents/skills/openworkspace-development/` guide work on this product; `skills/onboarding/` is the consumer distribution source. Keep the latter out of the active development skill tree.

For consumer distribution, favor a versioned client-native MCP + skill installation pack where the selected client supports one (the OpenSEO pattern), with a consent/config-diff step and verification. Keep plain SKILL.md + MCP instructions as a portable fallback. A generic skills CLI is an optional developer/power-user route, not the default for a Java-only user: its documented npx path requires a Node toolchain and has default telemetry. No package installation, telemetry or global skill write is implicit. Do not advertise unpublished repository/plugin install commands; verify target-client behavior before shipping either path.

## Delivery milestones

### M0 — safe foundation and AI onboarding entry

Current slice: host-native service, dashboard, direct project registration, bounded metadata discovery, executable availability checks and scoped MCP tools. Persist only platform-owned state outside application repos. Provide one consumer onboarding skill and an MCP onboarding prompt.

UI: useful empty state, project registration, connected workspace/repo inventory, tool availability and a copyable assistant setup prompt. Do not display services as running merely because a repo or CLI was detected.

Acceptance: an isolated fixture can be registered through MCP, inspected through MCP and seen in the dashboard; cross-origin requests, wrong token roles and symlink escapes fail closed. Workspace state survives app recreation. No project file, secret or application runtime is modified.

M0 is not the complete MVP: no tool installation, env-file writing, app start/stop, DB/log query or browser MCP execution is claimed by this slice.

### M0 UI foundation — React migration (user authorized)

Move the dashboard to React + TypeScript + Vite + Tailwind CSS 4 + shadcn/ui before service, connection and workflow screens grow. Use source-owned primitives and a deliberately composed product interface, not a copied dashboard template. OpenSEO's inspected source uses React 19, Vite, Tailwind 4 and shadcn `base-nova`/Base UI with its own theme; its TanStack Start/SSR/Cloudflare stack is not a requirement for our local dashboard.

Keep the Node service, HTTP/MCP operations, project registration and credential policy stable. Static frontend build assets must be served from the same protected loopback origin with correct CSP, MIME types and path restrictions; no public project/state/source-file access or Vite dev server requirement in normal product operation. Backend and browser code remain separated. Install only components needed for the existing pairing, project-first inventory, AI setup and access flows. Add routing/query/table/form libraries only for a current need, not because a reference product uses them.

Preserve the project-first and advanced-AI paths, inline errors/focus, registration state, UUID-only context, accurate setup boundaries and discarding late responses from a previous refresh. Do not combine this migration with automatic launch/pairing or M1 runner/resource capabilities.

Required UI regression: registration/removal that completes while an overview refresh is in flight must reconcile against post-mutation state. A loading flag must not silently drop the needed refresh, and a pre-mutation response must not restore a removed workspace. Cover this together with auth-role changes, not just the happy-path inventory.

The bounded migration contract received PLAN approval; the React dashboard is current. Acceptance requires a production frontend build, affected native checks, safe static-asset/auth negative checks, independent final review and an explicit desktop/narrow-screen accessibility matrix including **every** pairing, empty/populated overview, setup and privacy view. Reuse valid unchanged CLI/MCP evidence; do not backfill superseded vanilla-UI screenshots. A failed or missing audit is not a PASS. A bundled frontend is not proof of a Node-free end-user installer.

Migration mutation scope explicitly includes `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.gitignore`, frontend/build/typecheck configuration, Node static-asset/startup code and affected tests. Add `web-dist/` to ignored generated output. Select Vite 7.3.6 or a reviewed compatible 7.3 patch; registry metadata for 7.3.6 permits esbuild `^0.27.0 || ^0.28.0`, unlike the earlier reviewed 7.3.1 candidate. Inspect the actual resolved lockfile and permit only exact required lifecycle-script versions before the frozen-install/build gate; do not add unused historical versions or broad build-script permissions.

Built assets must pass a manifest/entrypoint preflight before the service exposes a listener, publishes a new connection or claims dashboard readiness. Missing/invalid build output must fail with a safe build instruction, release only its owned lock and preserve existing state. Normal operation uses the Node-served production bundle, not `vite preview`. Keep backend and frontend typechecks separate and update source-start instructions to build first once the commands pass. Remove obsolete `web/` source and routes at cutover; any temporary rollback source stays outside the product, not in a dual-UI fallback.

The migration contract has received PLAN sign-off. This covers the bounded dependency/CSP experiments and cutover rules, not a successful install, visual direction or browser test; old vanilla-UI runtime results do not establish these new checks.

### M1 — first usable MVP: connect, run and verify

**Scope narrowed with the user:** deliver one runner and one real verification path, sequentially. Initial technical default is PM2 for the current macOS pilot, subject to a bounded read-only feasibility check; do not mutate existing pilot processes. Compose is a later alternative, not a requirement for this milestone.

1. **Identify before operating.** Establish an explicit service-to-registered-root/checkout mapping and opt-in runtime-inspection scope. Reading process metadata is separate from directory metadata registration. Show unknown/ambiguous mappings honestly; neither a process name nor a discovered executable proves checkout identity. Bound and filter returned metadata; do not expose process environments or raw command arguments. First acceptance uses owned fixtures and read-only operations.
2. **Operate one owned service safely.** Preview the exact PM2 identity (name/namespace/pmId), working directory and registered-root mapping; your client governs each execution and the dashboard records what ran. Restart/stop only the designated task-owned process, reconcile the result against fresh process status, and support cancellation/cleanup. Never adopt or stop existing processes implicitly, install tools automatically, or pass arbitrary shell/eval through MCP. Do not expose process environments or raw command arguments. Missing PM2 produces an actionable unavailable state. Bounded readiness remains Step 3. *(Shed in the harness-first pivot: the per-service `service_control`/`service_logs` tools and routes are removed; owned start/stop now goes through `environment_up`/`environment_down`, raw control lives in the harness shell.)*
3. **Verify using the project's existing test.** Execute one repository-native check under your client's permission model; associate its result with the observed checkout revision, working-tree state, service identity and verification time. Keep running, ready and test-passed distinct. Do not label a successful command as end-to-end business verification or an unversioned working tree as an exact reproducible revision. This is diagnostic local context, not a CI verdict or M2 parallel orchestration. Restart recovery reconciles uncertain operations rather than replaying mutations blindly. *(Shed as a standalone tool in the pivot: `verification_run` is removed; receipt-bound verification continues through `environment_verify`.)*
4. **Environment orchestration slice:** discovery-proposed topology applied directly; ordered PM2 up with http-200/process-alive readiness; owned-only down; receipt-bound E2E (this plan).

Finish each step's affected checks and permission/error paths before adding the next behavior. Keep UI and MCP on shared operations. Use an ordinary PM2 module; extract a small shared runner contract only when a second real implementation demonstrates the need. No plugin loader/SDK, marketplace, generic workflow engine, universal provider interface or MCP server split in this milestone. Add only task-meaningful tools with bounded results; measure client context/tool-selection costs before introducing dynamic discovery.

Acceptance: an isolated representative service maps to the intended checkout, starts under the client's permission model, reports fresh process status without claiming readiness, runs an existing confirmed test and reports an honest contextual result; stop/cleanup affects only owned resources. Denial, unavailable runner, failed readiness/test, ambiguous mapping and restart uncertainty remain visible. Validate the actual configured MCP path and dashboard for the affected flow; do not require every connector or advertise packaged/fresh-machine support from source-preview evidence.

Pivot note (history stays as written above): the per-service control/log, standalone verification, container-link and declared-local-tool tools are shed — receipt-bound verification continues through `environment_verify` and owned start/stop through `environment_up`/`environment_down` (see Active request queue).

**Deferred, not discarded:** Compose, PostgreSQL/Elasticsearch, browser MCP, Jira, automatic prerequisite/configuration changes, private provider credential setup and a lesson store. Add the next capability only when the completed pilot workflow needs it. Full UI→API/DB→consumer scenario verification follows those concrete capabilities. Bundled-runtime distribution and fresh-machine/client compatibility remain separate release gates, not claims of this source-development slice.

### M2 — second major milestone: parallel multi-repo delivery

**Scope narrowed with the user (same sequential discipline as M1):** deliver workstreams in small vertical slices. The service never creates checkouts, worktrees, stashes or resets: a workstream binds already-registered roots and pins observed revisions. Enforcement of revision sets, if ever needed, is a later explicit step, not silent mutation.

1. **Workstream identity.** Create/list/get workstreams bound to one registered workspace's roots, each checkout pinned to its observed revision (or honest `unknown`). No versioned state upgrades: one strict schema, unknown shapes fail closed. Creation/status are available over MCP under the client's permission model and recorded in recent activity. No leases, runs or Jira in this slice.
2. **Resource leases.** Named exclusive resources (services, ports, datastores) with acquire/release and a visible queue. Lease acquire/release are available over MCP under the client's permission model and recorded in recent activity. Shared E2E resources serialize here instead of colliding silently.
3. **Parallel verification view.** Associate verification results with workstreams and show each workstream's repos/runtimes/blocked resources with independent Git links. Acceptance: four or five owned fixture workstreams progress in separate checkouts with results tied to actual revisions; no cross-workstream mutation.

Workstream/checkouts, task-local prerequisite provisioning, fixed revision sets, resource ownership/leases and safe cleanup. Optional Jira intake and ticket dossier references; manually initiated work is equally supported. Coordinator/implementer/reviewer roles are a skill pack, not a required agent runtime or hardcoded models.

UI: parallel workstreams, each one's repos/runtimes/blocked resources and independent Git/PR links. Show why work is queued rather than silently serializing everything.

Acceptance: four or five independent workstreams progress in separate checkouts; shared E2E resources queue safely; each result is tied to its actual checkout/revision. No stashing/resetting unrelated work, dirty-worktree deletion or duplicate external side effects.

Pivot note (history stays as written above): the workstream surface (`workstream_create`/`workstream_rename`/`workstream_status`/`workstream_context` + `workspace_workstreams`, routes, store slice, checkpoint/completion machinery, board UI) and the lease surface (`lease_acquire`/`lease_touch`/`lease_release` + `workspace_leases`, routes, store slice) are shed user-authorized — the harness tracks tasks natively and single-user local needs no lock ceremony. 13 MCP tools + 3 consumer skills remain; packs regenerated. Revisit only on measured contention.

### M3 — pilot-driven improvements, not MVP commitments

Additional datastore/issue/log adapters, environment profiles and confirmed hybrid targets, workflow reuse/export, optional timing statistics. Evaluate hosted/paired runners, remote AWS/Azure resources and squad coordination separately after local adoption. No architectural promises about hosted tenancy today.

**Idea parking lot (brainstorm output 2026-10-07, NOT committed — no scope, no milestone, no promise):**
- `ow up/down/ps/logs` runner: user-agent-written `ow.yaml` (services: cmd/cwd/port, plus `logs:` for file/docker-log tails), own tiny supervisor, time-ordered log stream into the observer join ("what the agent did + what the services said" on one timeline). process-compose YAML subset accepted so users bring existing files. Explicitly OUT in v1: restart/auto-heal, port-conflict resolution (detect + warn only), replicas/depends_on chains/TUI, managing inside-Docker services (log-watch only). First proof would be ResAI's own services (java/python/web + docker DB) if the user agrees to move them. Independent of harness (opencode-first, must not depend on observer hooks, to keep the Claude Code/Codex opening).
- Superpower skill patterns ("multi-service log look", config = service list + ports, rest is template) generalized from `resai-debug`-style skills. Smallest first pattern: cross-service log correlation on failure.
- User clarification driving this: single developers running 3–4 services (backend + DB counts), NOT teams; sandbox/bubble idea shelved — user wants leverage on their existing machine, not isolation.
- Distributed tracing (OpenTelemetry) is SECOND WAVE, not core: `ow up` + plain-log join first (passive, zero instrumentation); tracing later on supported stacks (Java `-javaagent` + Python auto-instrumentation first — near-zero code change). Rationale: traces give proof (not timestamp guessing) and collapse token cost to one tree, but require touching user services, so leading with it stalls the first user. Shape when it comes: `ow trace` subcommand (same binary, sleeps when no collector/instrumentation — says so and stays quiet) + recipe pack per stack; logs keep carrying content (stack traces, messages), traces carry flow/timing. Revisit only after `ow up` M1–M4 collect logs cleanly.
- Tracing homework (2026-10-07, docs only, no code): Java `-javaagent` confirmed (one jar + `JAVA_TOOL_OPTIONS` + `OTEL_EXPORTER_OTLP_ENDPOINT`; Spring/HTTP/JDBC + traceparent propagation automatic). Python confirmed (`opentelemetry-distro` + `opentelemetry-exporter-otlp` + `opentelemetry-bootstrap -a install`, prefix with `opentelemetry-instrument`); RISK: `uv` users hit documented bootstrap trouble — test early on our own `uv` setup. Browser injection needs NO Playwright: agent-browser supports it natively via origin-scoped headers (`--headers <json>` global flag, `agent-browser set headers '{...}'` mid-session) — CORRECTION: earlier `route`-based injection claim was wrong (`route` is abort/body only); headers are the mechanism, and origin-scoping is better than assumed (no third-party leak). LIVE-VERIFIED same day (local echo servers): `open --headers` delivers traceparent to that origin; a second origin in the same session receives NOTHING; `set headers` mid-session applies to subsequently visited origins. CAVEAT: an origin first configured via `open --headers` KEEPS the old value even after `set headers` (per-origin binding wins; persisted across revisit and new tab). Protocol rule for trace flows: always use `set headers`, never `open --headers`, so ID rotation works. OTLP/HTTP receiver is small (localhost endpoint → span JSONL, embeddable in `ow`); PORT CLASH: OTel default OTLP/HTTP is 4318 = our preview port — receiver must live elsewhere (e.g. 4319). Trace ID is generated BEFORE the browser action, so no "which was the last trace" protocol is needed.

## Security release gates

- Loopback-only HTTP; strict Host/Origin and same-origin browser requests; authenticated private operations; no permissive CORS.
- Dedicated private local state; fail closed on unsafe permissions/symlinked state. No secrets in prompts, output, process arguments, source files or transferable definitions.
- Explicit directory registration separate from read/execute/write/network permissions. Metadata discovery must not follow links outside the registered root or execute discovered code.
- If a DB path ever returns, it uses actual least-privilege roles/read-only transactions, not SELECT-prefix filtering. Logs/page/ticket content are untrusted data, never instructions.
- No broad PM2/Docker cleanup, global installs without consent, hidden telemetry, secret upload or implicit production access.
- Idempotency and reconciliation at mutation boundaries. Cancellation is not rollback. Report failed/unverified boundaries honestly.
- Node/native operation tests, auth negatives, dependency advisory check and rendered UI verification per changed slice. Do not label a security baseline as a penetration test.

## Pilots and scope exclusions

ResAI is the first pilot, initially read-only topology discovery with no existing runtime/data changes. Select a second real open-source pilot from the adjacent personal projects; chatwoot is a candidate, not a confirmed write/test target yet. Confirm its current prerequisites and affected instructions before touching it.

Measure setup friction, repeated prerequisite failures and time to first useful verification. Later timing dashboards are optional, not the MVP's primary value.

Excluded: new coding agent/chat/IDE, generic visual workflow builder, MCP marketplace, Kubernetes management, every connector, automatic production fixes, model-routing system, vector memory and universal session importer.

## Progress

### Active request queue — do not drop later corrections

| Order | Requested outcome | Status / next boundary |
| --- | --- | --- |
| Done | Pivot, M1–M3 workspace tools, learning-loop v1, declarative local tools, readiness UI, update-roots, checkpoint notes, budgets, fingerprints, stale-scope cleanup, subagent bundle, evidence pinning, POSIX scope. Evidence: git log. |
| 11 | Subagent package: note history + workstream_context bundle + typed completions | Shipped (history append, context bundle, typed completions with solo default). Dashboard history view remains a possible follow-up. |
| 12 | Token-cost worry | Deferred by user: no action until wire measurement shows manifest cost actually binding. Format budgets + byte-delta notes stay, no count cap, no dynamic discovery. |
| 13 | Evidence pinning + correlation IDs (checkpoint kanıt zinciri) | Shipped (bounded evidence refs, pin-exempt eviction, ID correlation). Dashboard pin display remains a possible follow-up. |
| 14 | Self-install setup prompt a la OpenSEO (skill-command layering M1–M2 done) | Prompt + dashboard cutover shipped: tek-mesaj "Copy setup prompt" (7-section self-install: project-local MCP entry, MCP-served skills, onaylı AGENTS.md note, reload + workspace_list doğrulaması, ≤120-word handoff), collapsed client kılavuzları kaldırıldı, SKILL.md discovery yasağına Step 3 carve-out eklendi. Update skill `/ow-update` + Step 2 pointer + stale→refresh fixture + per-client görünürlük tablosu (tümü UNVERIFIED) eklendi. Kalan: live-client runs (bounded experiment; sapma = prompt erratum, feature değil). Kişisel düzenlemeyi sormadan ezmek yok; MCP/dashboard token'ları chat'e/repo'ya girmez. |
| 15 | Harness-first pivot cut (user-authorized breaking removal) | Shed from the MCP surface: `service_control` + `service_logs` (tools + routes), `workspace_container_link` (tool + route), `local_tool_status` + declared local-tool engine (tools + routes + `scaffold-local-tool` skill), `workspace_rename`/`workspace_update_roots`/`workspace_remove` (tools only — dashboard HTTP routes kept), `activity_list` + `recent_runs` (tools only — dashboard observation keeps the routes), `workspace_services` (tool only — dashboard inventory route kept; no fold into `environment_status`: PM2-wide metadata vs owned-env readiness are different responses, gap reported not redesigned). `workspace_register` upserts: re-registering a name replaces roots with the stable ID preserved. Docs re-adapted to harness-first (no-fight: MCP = environment orchestration + memory). 22 MCP tools + 4 consumer skills remain; packs regenerated. |
| 16 | Workstream + lease shed (user-authorized breaking removal) | Shed workstream surface (5 MCP tools + `workspace_workstreams`, all `/api/workstreams` routes, store slice, checkpoint/completion machinery, board UI) and lease surface (3 MCP tools + `workspace_leases`, all `/api/leases` routes, store slice, TTL/queue engine). Deleted `new-task` skill; skills reworded to harness-native task tracking. 13 MCP tools + 3 consumer skills remain; packs regenerated. |

New user requests amend this queue; they do not discard unfinished earlier requests. Mark outcomes verified from actual code/runtime evidence, not from a plan or a suggested UX.

### Thoughts (shelved ideas, not commitments — kept so nothing is lost, out of the queue so nothing confuses)

- Transcript JSONL adapter + Stop-hook automation: skill-side mining already ships; machine-reading client transcript files is shelved (format fragility + secrets entering our process) until interactive use proves need.
- DB onboarding (existing role/location + authenticated/TCP credential-identity): shelved until a ResAI trial proves a socket-only gap.
- MCP proof package (one-click owned-fixture demo bundle): demo/YC value only, no daily value; revisit for demos.
- Prove-it gate as enforcement: cut to skill-level convention; a hard gate would add friction to every "done".
- Mistake inbox as separate screen: dropped — timeline + milestone notes already cover it.
- Masking extra shapes (Basic-auth, DSN userinfo, cookie, bare tokens): background hardening, opportunistic; labels remain the authoritative defense.
- Token-cost worry: no action until wire measurement shows manifest cost binding; format budgets stay.
- Browser automation wrapper (session + actions + evidence suite): plan reviewed + fixed, shelved. Effectiveness evaluation (real QA flow: 11/11 invocations logged, failure localized without re-run, marker redaction proven, bypass documented) ruled shim-sufficient → wrapper stays shelved. Revisit only if standalone log-only diagnosis is needed (terminal transcript unavailable) — that gap, not shim defect, is wrapper M1's trigger. Shim observer is the active track.
- Shell-log consumers (verify-collector vs product): shell-observer log is DEV-ONLY (our dogfood; normal users don't have it). So: verify-collector (join shell calls around verify runs) stays a dev procedure, never a product surface — useful for diagnosing our own e2e flakes, not shippable. checkpoint-nudge and lease-guard are shed with the checkpoint/lease surfaces, not product candidates.
- pnpm audit braces high (GHSA-vfj7-8cjw-p6xm, Patched: None): build-time chain only, not server runtime; revisit when a patch lands.
- Dirty-state surfacing in dashboard (dirty fingerprints, "tree went dirty" markers, clean-vs-changed chips): user disliked, shelved. Revisit only on explicit request — verification history must work without dirty vocabulary.
- Dashboard pivot brainstorm (from retired REVIEW.md appendix, explicitly undecided — shelved, not commitments): session-list + live tool-call/timeline observability (kept only as candidate — raw live view duplicates the client transcript); system graph over systems (page, api-route, table, index) with observed/inferred edges and verification status, collapsed by aggregation rules so repeated calls become one weighted edge; post-run brief + evidence instead of live graphs (auto-brief per run, aggregate status on demand, raw evidence on drill-down; diffs stay aggregated chips with link-out, never rendered). Revisit only if post-run review proves insufficient — that gap, not a defect in the current dashboard, is the trigger.

- Not yet verified: real external-client setup (Claude Code/Codex), fresh-machine prerequisite installation, Node 22 portability, independent security/browser gates. Platform scope is macOS + Linux (POSIX) only; Windows is deferred (sockets, permissions, picker, and path semantics differ — supporting it now would double the verification matrix with no Windows machine to prove it on). Docker is list-only inventory; no Compose control operations or PostgreSQL/Elastic connection is implemented yet.
- Future milestone updates replace these compact lines rather than append an incident diary. Detailed transient observations stay in test output/session state.
