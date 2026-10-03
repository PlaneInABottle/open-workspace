# OpenWorkspace — evolving product plan

Status: active; decisions may change with pilot evidence. This is the single product/architecture roadmap, not an incident diary. Update the affected section rather than adding parallel plans.

## Promise and audience

Keep your own AI agent. Give it a workspace where it can understand the whole project, work within explicit permissions, and verify real results.

Start with developers in multi-service projects who already use a coding assistant but do not maintain elaborate skills/MCP setups. Keep the UX approachable: one next action, clear permissions, human-readable failures, and no fabricated green states. The core is reusable; the first workflow is deliberately narrow.

## Fixed direction

- Build our own product, informed by OpenSEO's shared UI + MCP + skills model; do not fork its SEO implementation.
- Host-native local service and web dashboard. No new agent runtime, IDE, or mandatory chat interface.
- Project-first default, AI-led technical preparation: show an approved project's useful inventory before requiring an AI connection. The user's assistant then discovers technical prerequisites, proposes configuration, applies authorized setup, and explains human-only steps. Advanced users may begin directly through their assistant.
- PM2 and Docker/Compose are alternative application runners, not frontend/backend categories. Running, healthy, and scenario-verified are distinct states.
- Jira is optional. A workspace and verification run work without a ticket or integration. Future issue providers attach references, not core identities.
- Database/log/browser capabilities attach independently. Start with PostgreSQL and Elasticsearch; MongoDB is a future adapter, not a different workspace model.
- Browser MCP tools will wrap a pinned/checked agent-browser CLI in owned sessions. A power user may keep direct CLI usage; neither path requires replacing their coding assistant.
- Keep a local target identity in every connection/result now; defer named DEV/UAT profiles, mixed remote/local environments, cloud inventories and hosted architecture.
- No document treadmill: definitions have one authoritative home, transient work stays in private machine-readable state, and reusable learning becomes a small correction or executable guard.
- Parallel delivery is the second major product milestone (M2), not part of the first vertical workflow. Design stable workspace/run/resource identities now without implementing a scheduler prematurely.

## Architecture boundaries

UI and MCP call the same workspace operations. A local stdio MCP bridge is the first transport: clients do not copy our service credential into their configuration. HTTP MCP can follow once pairing and client compatibility are verified.

The local service owns registrations and authorization. A directory is explicitly approved before discovery reads it. Read only known manifest/instruction metadata, never environment/credential files during discovery. Discovered commands are candidates until a bounded execution verifies them.

Adapters implement concrete capabilities: application runner, datastore reader, log reader, browser operator, issue provider. Implement adapters as ordinary modules; no marketplace/plugin loading framework in the MVP. No connector is required by unrelated capabilities.

### Pluggable product direction (user clarification)

Repos are the stable center; surrounding tools are replaceable connections. The long-term model is add/remove/enable/disable a capability provider per workspace, not configure one mandatory product stack. Jira vs another tracker, PostgreSQL vs MongoDB and PM2 vs Compose must not change core workspace identity. A connection can advertise only the capabilities it actually supports; do not pretend SQL and document queries have identical semantics.

Use ports/adapters and dependency inversion at real operation boundaries: core operations depend on small capability contracts, providers own vendor-specific requests/credentials/errors. Prefer composition and ordinary module injection over inheritance, a universal provider superclass or a generic workflow DSL. Add a capability registry when the first actual runtime adapters are implemented in M1; keep discovery separate from execution. Do not create empty interfaces for hypothetical integrations in M0.

Future plugin packaging adds a versioned descriptor (provider ID/version, offered capabilities, configuration schema and required permissions), lifecycle (connect/check/disconnect) and compatibility checks around these same contracts. UI and MCP enumerate available capabilities instead of hardcoding a Jira-first flow. Removing a provider stops new operations and disconnects owned resources; it must not erase repos, learned facts or historical runs. An active run must stop/queue safely rather than switch provider silently.

Installing an in-process plugin grants code execution under the host account. Later third-party plugins need explicit provenance/permission approval and a separately designed process/isolation boundary; interface design alone is not a sandbox. No untrusted dynamic loading in the MVP. Change these contracts with observed pilot needs rather than freezing a speculative full plugin API now.

Persistent portable definitions contain repo paths/relative mappings, selected commands, resource references and skills; credentials and runtime identities are local/private. Credentials are referenced by identity, not copied to manifests or prompts. File/env writes in M1 require an exact destination and proposed scope, preserve existing values/comments, and support a preview. External account/API-key acquisition, OAuth consent, SSO, MFA and elevation stay human actions.

M2 introduces a workstream referencing one or more repository checkouts and an explicit runtime revision set. Resource ownership is separate from Git isolation. Shared DB/mailbox/browser/deployment targets serialize unless genuinely isolated. Worktrees are not security sandboxes.

## Onboarding flow

1. Start the local app; it opens the secret-free canonical dashboard URL. Select Connect this browser once, with no terminal key. The first substantive task is project selection and useful inventory, not MCP configuration.
2. Create a named project, select its explicit repository roots, and review the whole access list. Advanced users can call `workspace_propose({name, roots})`. Native macOS selection has a trusted helper with cancellation/headless fallback; actual GUI interaction remains unobserved. Approval does not authorize execution or secret-file reads, and a wrapper/common parent is not required.
3. Discover metadata and installed executable availability and show the useful inventory before requiring an AI connection. Show found/missing/unverified separately. Offer the chosen assistant's version-checked connection flow as the next technical-preparation step, not a prerequisite for viewing approved metadata.
4. Assistant proposes required installs, runtime configuration and connection references. Execute only approved changes, scoped to this workspace. Never silently modify global agent configuration or install every optional tool.
5. For optional Jira, offer Atlassian MCP configuration only when Jira is selected. Preserve client config, explain OAuth login steps, and verify connection before claiming success. Platform authentication and Atlassian authentication remain separate.
6. Request unavailable external keys through a private connection form, not conversation text. Explain minimum privileges and test the intended connection without exposing secrets.
7. Start only the necessary PM2/Compose services and prove readiness. Resume from verified prerequisites after interruption.

### Launch and browser connection

**Implemented cutover — no-key browser connection:** manual pairing/password UI, `/api/bootstrap`, `src/pair.ts`, CLI `pair` and `pnpm pair` are removed, without a legacy fallback. Start opens the secret-free local dashboard URL after readiness. A single **Connect this browser** action issues a separate tab-scoped dashboard session; project directory approvals remain independent. Native/UI and owned production smoke checks passed; final independent security/browser gates are tracked in Progress.

- `POST /api/dashboard-session`: no Authorization header at all; exact canonical Host/Origin, `Sec-Fetch-Site: same-origin`, JSON plus intent header and strict `{consent:true}`. No GET/effect-based issuance or CORS relaxation. Same-OS-user processes are trusted, so this is not physical-click/process-identity proof.
- Dashboard bearers are memory-only, have a 12-hour absolute expiry and an 8-active-session cap (selected bounded defaults), and are revoked on disconnect/restart. A failed network revoke still clears the tab; expiry bounds the server fallback. Tokens never enter URLs, HTML, CLI output, build assets or MCP configuration.
- The strict private connection file is `{origin,mcpToken}`; MCP route authorization allows only list/propose/inspect/onboarding, not approvals, revocation, client configuration or browser-session issuance/deletion. Do not accept the old shared credential as compatibility.
- `src/main.ts` owns browser opening once; `--no-open` / `OPENWORKSPACE_NO_OPEN=1` suppress it for headless operation and tests. Opener failure leaves the ready service usable and prints only a safe URL/action. Platform opener support must be tested, not inferred from command names.
- Preserve private-view resets, late-response/mutation guards, strict static delivery/CSP and workspace-state data. Packaged Node-free installation, multi-repo project creation and native repository picking remain distinct work; do not mix them into this auth change.

### Project creation and smoothness evaluation

The accepted connected-project rail stays. Implemented named projects group explicitly selected roots from unrelated directories; a ResAI-style wrapper is optional. Projects flow: Create project → name → select repo folders → review exact access → useful inventory. No repos are moved and no common-parent permission is inferred.

Implemented bounded contract: project IDs and `workspaces` storage/API ownership remain; version-2 registrations/proposals use `roots: string[]`. Validated v1 records migrate data-only to `roots: [path]`, preserving ID/name/timestamp and membership in the approved `workspaces` or pending `proposals` collection; there is no literal `status` field. ResAI keeps one wrapper grant. No discovery/permission widening occurs during migration. Malformed/unknown/oversized state stays byte-identical; writes are atomic/private and capped at 1 MiB. The same repo can be linked to different projects.

Proposal limits must agree: up to 20 roots, each at most 4096 UTF-16 characters, with an explicit 512 KiB encoded JSON-body cap only for proposal requests. Parse a buffered byte stream once with fatal UTF-8 decoding, not per-chunk `toString()`, so split multibyte characters round-trip and invalid bytes fail closed. Enforce the serialized state cap before replacing any stored file. Approval validates all roots before one commit and rejects within-project duplicate/ancestor overlaps without granting a common parent. Inventory groups by root and reports a changed/unavailable root without following a new target.

Keep this first model unit small: whole-project access revocation remains the existing operation and clears every selected root/cache; partial-root revoke/edit is deferred until needed, not added merely by the plan. Consumer tool guidance and copied setup context must switch from singular path to explicit roots with the API/MCP contract. The native picker is dashboard-only, exact-origin/session/intent gated, static trusted script through a verified `/usr/bin/osascript` on the macOS pilot, `shell:false`, minimal environment and JSON output (never newline-split paths). It only selects a draft, never proposes/scans/grants automatically. Cancel/unavailable/timeouts leave the draft intact; unsupported/headless hosts get an honest manual-roots fallback. Native GUI observation remains a bounded implementation experiment, not passed evidence.

The macOS native-picker helper and v2 schema are implemented, with explicit cancel/unavailable/error outcomes and manual fallback. Browser `showDirectoryPicker()` returns a handle, not a trusted Node-host absolute path. Selection remains separate from proposal/approval. Static JXA compilation/JSON round-trip and injected picker/API cases passed; actual native GUI selection and OS cancellation remain unobserved. Do not describe those mocks as native-GUI verification or claim Linux/Windows chooser support.

For smoothness, correct DOM/data clearing during same-project background refresh before adding animations. The bounded review traced this reset, and the client correction retains stable, still-authorized inventory with a busy indication through the inspection. Identity/permission changes still clear it immediately. No motion library or opacity trick is used to mask stale data.

The refresh review traced a real collapse: inventory was cleared before background inspection and the loading branch unmounted it. The implemented correction keeps same-selection content mounted and busy through both reads, while clearing on identity/permission changes. Projects navigation now clears selection and UUID context even on `#overview`; late inspection cannot reselect it. Native/UI regression and delayed-read browser checks passed. Browser anchoring kept the inventory visually stable; an identical raw scrollY after a new success notice is not claimed.

### AI setup: one-copy primary flow

The primary action is **Copy setup request**: one assistant-ready message containing the secret-free MCP launch configuration, the selected approved UUID if any, and the onboarding/verification request. Preserve existing client configuration and require a preview/consent for edits. Do not require the user to copy configuration and a separate prompt in two trips. Raw config and client-specific guidance remain collapsed advanced options; do not put MCP/dashboard tokens or project secret files into any copied text.

Client guidance is version-checked against official sources and does not write settings automatically:

- [VS Code / GitHub Copilot](https://code.visualstudio.com/docs/agent-customization/mcp-servers): current docs prefer portable project `.mcp.json` with `mcpServers`; guided **MCP: Add Server**, trust and **MCP: List Servers** verification. The traditional `.vscode/mcp.json` format uses `servers` and is documented as compatibility; do not silently conflate the two or force global configuration.
- [Claude Code](https://code.claude.com/docs/en/mcp): project `.mcp.json` uses `mcpServers`; local/user scope differs. Standard stdio options/command arguments are separated by `--`; verify via `/mcp` or `claude mcp list`. An added entry is not proof it connected.
- [OpenCode V2](https://opencode.ai/v2/docs/mcp-servers): `mcp.servers`, local `type`, executable-plus-args `command` array and `environment` rather than the generic `env` field; verify with `/mcps` / `opencode mcp list`.
- [Codex](https://developers.openai.com/codex/extend/mcp): project `.codex/config.toml` or user `~/.codex/config.toml`, `[mcp_servers.openworkspace]` with `command`, `args`, and environment mapping. CLI/IDE share configuration. Do not advertise a global install/config change as already performed.

Show bounded source-preview instructions and external-client verification gaps honestly. Enterprise MCP policy restrictions are not permission to bypass organization controls. The one-copy request and collapsed format guides are implemented; actual external-client installation remains unverified. They are not a new provider/agent runtime.

The application's own language/toolchain must not be a prerequisite for operating OpenWorkspace. The future distribution should bundle its runtime so a Java-only user need not install Node/pnpm. Current source setup still requires Node/pnpm; no packaged Node-free installer or keychain integration is shipped. Do not put a capability secret in a URL/history/argv to chase zero-click behavior: one explicit short browser consent is the current bounded solution, separate from project permissions.

### End-to-end adoption journey: GitHub to first value

1. GitHub README clearly identifies audience, current preview limitations and the quickest supported install path. Separate **download/run the product** from **contribute from source**. Do not ask users to clone repos, install pnpm or modify their Java project's engine settings simply to operate the distributed product.
2. Release download/installer verifies provenance and supported OS/architecture, includes the runtime, and opens a loopback dashboard. No unexplained shell script fetching arbitrary code; elevation is a separate consent step. Initial packaging targets follow pilot needs; Windows support is not assumed from macOS tests.
3. Startup opens the dashboard and asks for one short local browser consent; project selection follows. There is no separate key transfer through chat or terminal. Source opening/headless behavior is implemented; packaged-launcher behavior still needs its distribution tests.
4. User selects project directories, reviews precise paths/capabilities and sees bounded useful metadata. Do not require Jira, PostgreSQL, a particular repository language or an external AI connection for this first value. Advanced users retain a direct assistant onboarding entry.
5. Offer client-specific, version-checked AI setup with config previews, preserving existing integrations. The connected assistant discovers technical prerequisites, proposes only needed tools/settings, and walks the user through unavailable provider keys/OAuth. Show useful progress and recovery, not an all-or-nothing setup wizard.
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

Visual direction: a compact workspace/resource navigation, real project identity and exceptions first, comparable inventory in the center, and progressive detail for logs/readiness/connections. First run is a focused project-and-permission flow; repeat use is an operational workspace. Avoid decorative KPI tiles, giant marketing headlines inside the app, fabricated status data and copying a terminal/chat product's entire interface. The first implementation is a reversible direction, not an empirically established universal best UX.

## Learning, kept small

M1 starts with a compact lesson store (scope, correction, source, verified date) and simple search. The assistant can propose updates; low-risk fact corrections may be auto-applied only under a user-selected policy. Permission changes, new commands, changed targets and credential access require explicit approval. Deduplicate and replace stale entries rather than appending every failure. Use revision checks for concurrent writes.

Do not add a mandatory memory.md, vector database, automatic transcript mining or separate evidence.md. Long procedures remain skills; brief facts remain lessons; operation results and cleanup remain run state. A repeated failure should become an early probe or regression test when practical.

Development guidance and consumer guidance have different homes: `AGENTS.md` plus `.agents/skills/openworkspace-development/` guide work on this product; `skills/openworkspace-onboarding/` is the consumer distribution source. Keep the latter out of the active development skill tree.

For consumer distribution, favor a versioned client-native MCP + skill installation pack where the selected client supports one (the OpenSEO pattern), with a consent/config-diff step and verification. Keep plain SKILL.md + MCP instructions as a portable fallback. A generic skills CLI is an optional developer/power-user route, not the default for a Java-only user: its documented npx path requires a Node toolchain and has default telemetry. No package installation, telemetry or global skill write is implicit. Do not advertise unpublished repository/plugin install commands; verify target-client behavior before shipping either path.

## Delivery milestones

### M0 — safe foundation and AI onboarding entry

Current slice: host-native service, dashboard, temporary browser sessions, directory-access proposal/approval, bounded metadata discovery, executable availability checks and scoped MCP tools. Persist only platform-owned state outside application repos. Provide one consumer onboarding skill and an MCP onboarding prompt.

UI: useful empty state, directory access disclosure, pending requests, connected workspace/repo inventory, tool availability and a copyable assistant setup prompt. Do not display services as running merely because a repo or CLI was detected.

Acceptance: an isolated fixture can be proposed through MCP, approved only with dashboard authority, inspected through MCP and seen in the dashboard; unapproved reads, cross-origin consent, wrong token roles and symlink escapes are rejected. Workspace state survives app recreation; temporary browser sessions do not. No project file, secret or application runtime is modified.

M0 is not the complete MVP: no tool installation, env-file writing, app start/stop, DB/log query or browser MCP execution is claimed by this slice.

### M0 UI foundation — React migration (user authorized)

Move the dashboard to React + TypeScript + Vite + Tailwind CSS 4 + shadcn/ui before service, connection and workflow screens grow. Use source-owned primitives and a deliberately composed product interface, not a copied dashboard template. OpenSEO's inspected source uses React 19, Vite, Tailwind 4 and shadcn `base-nova`/Base UI with its own theme; its TanStack Start/SSR/Cloudflare stack is not a requirement for our local dashboard.

Keep the Node service, HTTP/MCP operations, directory approvals and credential policy stable. Static frontend build assets must be served from the same protected loopback origin with correct CSP, MIME types and path restrictions; no public project/state/source-file access or Vite dev server requirement in normal product operation. Backend and browser code remain separated. Install only components needed for the existing pairing, project-first inventory, AI setup and access flows. Add routing/query/table/form libraries only for a current need, not because a reference product uses them.

Preserve the project-first and advanced-AI paths, inline errors/focus, pending approvals, UUID-only context, accurate setup boundaries, disconnect/re-pair state reset and rejection of late responses from a previous session. Do not combine this migration with automatic launch/pairing or M1 runner/resource capabilities.

Required UI regression: approval/decline/revocation that completes while an overview refresh is in flight must reconcile against post-mutation state. A loading flag must not silently drop the needed refresh, and a pre-mutation response must not restore a declined request or revoked workspace. Cover this together with session changes, not just the happy-path inventory.

The bounded migration contract received PLAN approval and the React replacement is implemented. Acceptance requires a production frontend build, affected native checks, safe static-asset/auth negative checks, independent final review and an explicit desktop/narrow-screen accessibility matrix including **every** pairing, empty/populated overview, setup and privacy view. Reuse valid unchanged CLI/MCP evidence; do not backfill superseded vanilla-UI screenshots. A failed or missing audit is not a PASS. A bundled frontend is not proof of a Node-free end-user installer.

Migration mutation scope explicitly includes `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.gitignore`, frontend/build/typecheck configuration, Node static-asset/startup code and affected tests. Add `web-dist/` to ignored generated output. Select Vite 7.3.6 or a reviewed compatible 7.3 patch; registry metadata for 7.3.6 permits esbuild `^0.27.0 || ^0.28.0`, unlike the earlier reviewed 7.3.1 candidate. Inspect the actual resolved lockfile and permit only exact required lifecycle-script versions before the frozen-install/build gate; do not add unused historical versions or broad build-script permissions.

Built assets must pass a manifest/entrypoint preflight before the service exposes a listener, publishes a new connection or claims dashboard readiness. Missing/invalid build output must fail with a safe build instruction, release only its owned lock and preserve existing state. Normal operation uses the Node-served production bundle, not `vite preview`. Keep backend and frontend typechecks separate and update source-start instructions to build first once the commands pass. Remove obsolete `web/` source and routes at cutover; any temporary rollback source stays outside the product, not in a dual-UI fallback.

The migration contract has received PLAN approval. This approves the bounded dependency/CSP experiments and cutover rules, not a successful install, build, visual direction or browser test. Remaining acceptance includes the post-mutation refresh regression and the complete production-bundle audit matrix; old vanilla-UI runtime results do not establish these new checks.

### M1 — first usable MVP: connect, run and verify

**Scope narrowed with the user:** deliver one runner and one real verification path, sequentially. Initial technical default is PM2 for the current macOS pilot, subject to a bounded read-only feasibility check; do not mutate existing pilot processes. Compose is a later alternative, not a requirement for this milestone.

1. **Identify before operating.** Establish an explicit service-to-approved-root/checkout mapping and opt-in runtime-inspection scope. Reading process metadata is separate from directory metadata approval. Show unknown/ambiguous mappings honestly; neither a process name nor a discovered executable proves checkout identity. Bound and filter returned metadata; do not expose process environments or raw command arguments. First acceptance uses owned fixtures and read-only operations.
2. **Operate one owned service safely.** Preview the exact PM2 identity (name/namespace/pmId), working directory and approved-root mapping; obtain explicit execution approval independently of directory access. Restart/stop only the designated task-owned process, reconcile the result against fresh process status, and support cancellation/cleanup. Never adopt or stop existing processes implicitly, install tools automatically, or pass arbitrary shell/eval through MCP. Do not expose process environments or raw command arguments. Missing PM2 produces an actionable unavailable state. Bounded readiness remains Step 3.
3. **Verify using the project's existing test.** Execute one explicitly approved repository-native check; associate its result with the observed checkout revision, working-tree state, service identity and verification time. Keep running, ready and test-passed distinct. Do not label a successful command as end-to-end business verification or an unversioned working tree as an exact reproducible revision. This is diagnostic local context, not a CI verdict or M2 parallel orchestration. Restart recovery reconciles uncertain operations rather than replaying mutations blindly.

Finish each step's affected checks and permission/error paths before adding the next behavior. Keep UI and MCP on shared operations. Use an ordinary PM2 module; extract a small shared runner contract only when a second real implementation demonstrates the need. No plugin loader/SDK, marketplace, generic workflow engine, universal provider interface or MCP server split in this milestone. Add only task-meaningful tools with bounded results; measure client context/tool-selection costs before introducing dynamic discovery.

Acceptance: an isolated representative service maps to the intended checkout, starts only after explicit approval, reports fresh process status without claiming readiness, runs an existing approved test and reports an honest contextual result; stop/cleanup affects only owned resources. Denial, unavailable runner, failed readiness/test, ambiguous mapping and restart uncertainty remain visible. Validate the actual configured MCP path and dashboard for the affected flow; do not require every connector or advertise packaged/fresh-machine support from source-preview evidence.

**Deferred, not discarded:** Compose, PostgreSQL/Elasticsearch, browser MCP, Jira, automatic prerequisite/configuration changes, private provider credential setup and a lesson store. Add the next capability only when the completed pilot workflow needs it. Full UI→API/DB→consumer scenario verification follows those concrete capabilities. Bundled-runtime distribution and fresh-machine/client compatibility remain separate release gates, not claims of this source-development slice.

### M2 — second major milestone: parallel multi-repo delivery

**Scope narrowed with the user (same sequential discipline as M1):** deliver workstreams in small vertical slices. The service never creates checkouts, worktrees, stashes or resets: a workstream binds already-approved roots and pins observed revisions. Enforcement of revision sets, if ever needed, is a later explicit step, not silent mutation.

1. **Workstream identity.** Create/list/get workstreams bound to one approved workspace's roots, each checkout pinned to its observed revision (or honest `unknown`). No versioned state upgrades: one strict schema, unknown shapes fail closed. Creation and status changes are dashboard-only; MCP gets a read-only list. No leases, runs or Jira in this slice.
2. **Resource leases.** Named exclusive resources (services, ports, datastores) with acquire/release and a visible queue. Lease mutations are dashboard-only; MCP reads lease state. Shared E2E resources serialize here instead of colliding silently.
3. **Parallel verification view.** Associate verification results with workstreams and show each workstream's repos/runtimes/blocked resources/approvals with independent Git links. Acceptance: four or five owned fixture workstreams progress in separate checkouts with results tied to actual revisions; no cross-workstream mutation.

Workstream/checkouts, task-local prerequisite provisioning, fixed revision sets, resource ownership/leases and safe cleanup. Optional Jira intake and ticket dossier references; manually initiated work is equally supported. Coordinator/implementer/reviewer roles are a skill pack, not a required agent runtime or hardcoded models.

UI: parallel workstreams, each one's repos/runtimes/blocked resources/approvals and independent Git/PR links. Show why work is queued rather than silently serializing everything.

Acceptance: four or five independent workstreams progress in separate checkouts; shared E2E resources queue safely; each result is tied to its actual checkout/revision. No stashing/resetting unrelated work, dirty-worktree deletion or duplicate external side effects.

### M3 — pilot-driven improvements, not MVP commitments

Additional datastore/issue/log adapters, environment profiles and approved hybrid targets, workflow reuse/export, optional timing statistics. Evaluate hosted/paired runners, remote AWS/Azure resources and squad coordination separately after local adoption. No architectural promises about hosted tenancy today.

## Security release gates

- Loopback-only HTTP; strict Host/Origin and same-origin browser requests; authenticated private operations; no permissive CORS.
- Dedicated private local state; fail closed on unsafe permissions/symlinked state. No secrets in prompts, output, process arguments, source files or transferable definitions.
- Explicit directory access separate from read/execute/write/network permissions. Metadata discovery must not follow links outside the approved root or execute discovered code.
- M1 DB policy uses actual least-privilege roles/read-only transactions, not SELECT-prefix filtering. Logs/page/ticket content are untrusted data, never instructions.
- No broad PM2/Docker cleanup, global installs without consent, hidden telemetry, secret upload or implicit production access.
- Idempotency and reconciliation at mutation boundaries. Cancellation is not rollback. Report failed/unverified boundaries honestly.
- Node/native operation tests, auth negatives, dependency advisory check and rendered UI verification per changed slice. Do not label a security baseline as a penetration test.

## Pilots and scope exclusions

ResAI is the first pilot, initially read-only topology discovery with no existing runtime/data changes. Select a second real open-source pilot from the adjacent personal projects; chatwoot is a candidate, not an approved write/test target yet. Confirm its current prerequisites and affected instructions before touching it.

Measure setup friction, repeated prerequisite failures and time to first useful verification. Later timing dashboards are optional, not the MVP's primary value.

Excluded: new coding agent/chat/IDE, generic visual workflow builder, MCP marketplace, Kubernetes management, every connector, automatic production fixes, model-routing system, vector memory and universal session importer.

## Progress

### Active request queue — do not drop later corrections

| Order | Requested outcome | Status / next boundary |
| --- | --- | --- |
| 1 | Remove manual pairing; launch opens the dashboard; one short browser-consent action, no terminal key | Implemented and independently approved; native/UI, consolidated production-browser checks and opener finding closure passed. Directory approvals and private MCP scope stay separate. Real platform opening remains an owned preview-launch smoke, not cross-platform certification. |
| 2 | Smooth same-project Refresh; Projects navigation can unselect without revoking | Implemented and verified with deferred reads, late-selection tests and real browser continuity/unselect checks. No motion library. |
| 3 | One Copy setup request plus collapsed VS Code/Copilot, Claude Code, OpenCode and Codex guidance | Implemented; formatter/UI and production setup-screen checks passed. Official formats verified; no global client config writes or secret-bearing snippets. Actual external-client installation remains unverified. |
| 4 | Named logical projects with explicitly selected repos from unrelated locations; Projects → Create project | Implemented and independently approved; migration, grouped inventory, actual MCP/browser and whole-project revoke checks passed. Existing ResAI registration migrated with IDs/values/access preserved. |
| 5 | Native repo-folder selection instead of an absolute-path-only default | Implemented with trusted macOS helper and manual fallback. User informally observed selection working; automated real GUI selection/cancellation remains unverified because OS automation permission was denied. |
| 6 | Narrow M1 and proceed sequentially without speculative plugin infrastructure | Scope agreed. M1 Steps 1–3 implemented and verified: bounded read-only PM2 service/checkout metadata with `workspace_services`; dashboard-only restart/stop for an exactly mapped owned PM2 process with fresh-status reconciliation and MCP denial; dashboard-only run of one existing `package.json` test script with revision/worktree/service/time context, bounded runtime/output and MCP denial. No readiness/health claim anywhere. M1 closure pass: 10/10 checks against an isolated live service (connect→propose→approve→inspect→map→restart→verify-passed→stop→revoke→post-revoke-denied) with owned git/PM2 fixtures; only owned resources were touched and all fixtures were removed. |
| 7 | Keep M1 verification diagnostic/local, not a CI verdict; preserve parallel multi-service goal for M2 | Accepted. Step 3 remains checkout/service/test context, not a CI badge. Jira-parallel, multi-service and agent-browser orchestration stay M2. |
| 8 | Start M2 with workstream identity; drop versioned state upgrades | Implemented (M2-1): workstreams bind approved roots with pinned revisions; one strict state schema with no migrations, unknown shapes fail closed. Creation/status are dashboard-only; MCP lists only. |
| 9 | Continue M2 with resource leases | Implemented (M2-2): named exclusive leases with visible FIFO queue and promotion on release; acquire/release are dashboard-only, MCP lists only. Additive state fields use optional-with-default so old state files keep parsing. |
| 10 | Operator delegation for the connected assistant | Implemented: one MCP credential whose role upgrades by dashboard delegation (default read-only). Delegated workspaces allow `service_control`, `verification_run`, `lease_acquire`, `lease_release` through MCP with unchanged bounds; denials guide the user to the AI setup grant. Central activity trail records every mutation with its actor. |

New user requests amend this queue; they do not discard unfinished earlier requests. Mark outcomes verified from actual code/runtime evidence, not from a plan or a suggested UX.

- M0 foundation and React UI migration completed: host-native service, project-first React/TypeScript/Vite/Tailwind 4/shadcn Base UI dashboard, bounded discovery, human directory approvals and four stdio MCP tools. Old `web/` sources and asset aliases were removed. Backend/frontend checks, native/API and React regression tests, production build, dependency audit and safe static-serving/startup negatives passed; independent FULL review and focused finding closures approved the implemented boundary. Keep exact current test counts in their run results, not this evolving plan.
- Current production-bundle Chrome matrix covers all five views at desktop and narrow widths with zero axe violations. Only a decorative, aria-hidden disclosure chevron remains an automated contrast-incomplete item; this is not full WCAG certification. Actual layout/hit-tests, same-origin A→B command/config/session isolation, project approval/MCP/revocation, and the approval-success + two synthetic reconciliation-read 503s + real successful inspection/retry scenario passed. No duplicate approval POST occurred.
- Real stdio MCP integration and synthetic multi-repo fixtures proved pending-read denial, approved three-component discovery, symlink and env-sentinel exclusion, and post-revocation denial. QA fixtures/private states, browser/MCP clients and owned temporary services were cleaned up; the user preview and ResAI registration remain. No ResAI or Chatwoot repository/runtime/secret was changed. Validation is macOS/Node 26 source-preview evidence, not an end-user release certification.
- Not yet verified: real Claude Code/Codex client setup, fresh-machine prerequisite installation, Node 22 and Windows portability. No Compose application operations, PostgreSQL/Elastic connection or browser MCP tool is implemented yet. M2 remains next.
- Future milestone updates replace this compact checkpoint rather than append an incident diary. Detailed transient observations stay in test output/session state.
