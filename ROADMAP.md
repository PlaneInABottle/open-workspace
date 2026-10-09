# OpenWorkspace — direction

Status: active source preview. This is the single product doc — decisions and forward scope only, no milestone history, no incident diary. Update the affected section; do not add parallel plans.

## Promise and audience

Keep your own coding agent. Give it an observer that shows what it actually did, a supervisor for the dev services around it, and a small memory that learns from mistakes — so setup repeats less and the next task starts warm. Everything runs locally; the harness keeps its own shell.

Start with a developer who already uses a coding assistant but leaves value on the table: they lift frontend + backend + db to develop one feature, never fully test with the agent, or need a place to see what the agent is doing instead of waiting on a chat reply. OpenWorkspace hands them that workflow as a workspace and a coordination surface.

## Product

Three surfaces, one local service:

- **`ow` CLI — the primary interface.** Read-only session observer (`sessions`, `show`, `stuck`, `meta`, `prompts`, `reads`, `tree`, `timeline`), dev-service supervision (`up`/`down`/`ps`/`logs`) from a repo `ow.yaml`, and opt-in OpenTelemetry tracing through an embedded loopback receiver. Observed via the OpenCode shell-observer plugin.
- **Dashboard.** Observer-first, read-only React/TypeScript view: recorded agent activity plus environment status, AI setup and privacy/access removal. A coordination surface, not an operate console.
- **MCP bridge + skills.** Project registration, owned-environment orchestration and a compact learning loop for the user's existing assistant. 13 MCP tools, 7 MCP-served consumer skills, project-local client snapshots. The dashboard does not create projects.

## Fixed direction

- **Harness-first (no-fight).** MCP covers environment orchestration plus memory only. Anything the harness already does via shell — commands, log tails, process control, database queries — is not re-served. No workstream/lease/checkpoint ceremony; the harness tracks tasks natively.
- **Host-native local service and web dashboard.** No new agent runtime, IDE or mandatory chat interface. Persist only platform-owned state outside application repos.
- **Repos are the stable center.** Surrounding tools are replaceable connections (PM2 vs Compose, Jira vs another tracker, Postgres vs Mongo) and must not change core workspace identity. Adapters are ordinary modules; no plugin marketplace or generic workflow DSL.
- **Observer-first dashboard.** Read-only visibility first (timeline, environment status, lessons). Registration and orchestration stay project-based over MCP.
- **One strict state schema.** Explicit `roots` arrays, no versioned upgrades; unknown shapes fail closed and stay byte-identical.
- **No document treadmill.** One authoritative home per definition; reusable learning becomes a small correction or a regression test; transient state stays machine-readable. No `memory.md`, `evidence.md`, vector DB or automatic transcript mining.
- **Jira is optional.** A workspace and a verification run work without a ticket or integration. Issue providers attach references, not core identities.

## Non-goals / excluded

New agent/chat/IDE, generic visual workflow builder, MCP marketplace, Kubernetes management, every connector, automatic production fixes, model-routing, vector memory, universal session importer, per-service shell/log MCP tools, and workstream/lease surfaces. Docker is presence-only inventory (no control operations). Platform scope is macOS + Linux (POSIX); Windows is deferred. Dirty-state surfacing in the dashboard stays shelved unless explicitly requested.

## Open / next (no commitment until pilot evidence)

- **Package the CLI.** Remove the manual Node/bun + `pnpm ow:build` + symlink ritual so the platform's own toolchain is not a prerequisite for operating it; validate on a fresh machine, including a Java-only project with no system Node/pnpm.
- **Verify external-client setup on real clients** (Claude Code, Codex, VS Code/Copilot, OpenCode). All per-client surfacing rows are UNVERIFIED until a live run proves them.
- **Second pilot + measurement.** Time to first useful verification, human actions and repeated prerequisite failures across pilots.
- **Optional additions, only on demand:** browser tracing recipe pack, further datastore/issue adapters, environment profiles, hybrid/remote targets.

## Pilots and safety gates

ResAI is the first pilot (read-only topology discovery, no existing runtime/data changes). A second open-source pilot is selected from adjacent personal projects; confirm its prerequisites before touching it.

Security release gates: loopback-only HTTP with strict Host/Origin checks; dedicated private state that fails closed on unsafe permissions/symlinks; explicit directory registration separate from read/execute/write permissions; no secrets in prompts, output, arguments or transferable definitions; idempotency and reconciliation at mutation boundaries; report failed/unverified boundaries honestly. Never weaken an assertion, bypass confirmation, alter a pilot's toolchain or add global installs just to obtain PASS.
