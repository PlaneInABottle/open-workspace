# Review: remove the dashboard permission layer

Date: 2026-10-02
Status: accepted direction, not yet implemented
Trigger: founder review — users of Claude Code / Copilot / Codex already manage
permissions in their client; a second permission gate in the dashboard adds
friction without adding safety.

## Problem

OpenWorkspace currently acts as a permission gate in front of the user's own
agent:

1. **Directory access gate.** `workspace_propose` (`src/mcp.ts:21-28`) saves a
   pending request only; no metadata is read until a human approves every root
   in the dashboard. Approval lives in `WorkspaceService.approve`
   (`src/workspace.ts:45-58`), wired to `POST /api/proposals/:id/approve`
   (`src/http.ts:323-327`) and the dashboard approve flow
   (`frontend/src/use-workbench.ts:519-552`, `frontend/src/App.tsx:306`).
2. **Operation gate.** Service restart/stop and repository test runs are
   dashboard-only with explicit per-run approval and denied over MCP
   (`src/workspace.ts:94-104`, `src/mcp.ts:34-43`,
   `src/workspace.ts:152-158` onboarding steps). Workstream creation/status
   and lease acquire/release are likewise dashboard-only.
3. **Revocation UI as permission UI.** `PrivacyView` presents "Approved project
   access" with per-project revoke (`frontend/src/features/privacy/PrivacyView.tsx`,
   `frontend/src/use-workbench.ts:559-561`).

This duplicates what permission-capable clients already do (workspace trust,
allowlists, plan/approval modes). Result: two sources of truth for "can the
agent touch this?", two review surfaces, and approval fatigue. Metadata
discovery itself is read-only and bounded (`src/discovery.ts`), so gating it
behind a click buys little risk reduction.

## Decision

Remove permissions from the dashboard entirely:

- Project roots become **registered context**, not access grants. Registration
  may read bounded metadata immediately; there is no propose → approve queue
  for reads.
- Dangerous operations are authorized by the **client's own permission model**
  (and/or an explicit per-run confirmation in chat), not by a dashboard click.
  The dashboard keeps an **audit log** (what ran, where, when, what revision),
  never a gate.
- Keep the guards that are execution safety, not permissions: symlink/redirect
  rejection (`src/discovery.ts:104-108`, `src/verify.ts:176-199`), output caps,
  timeouts, no secret-file reads, loopback-only HTTP. Those stay.

## What must change (implementation checklist)

- `src/workspace.ts`: retire `propose`/`approve`/`reject` gate semantics
  (register/remove instead); make `serviceAction`/`verify` callable without a
  prior dashboard approval; rewrite `onboarding()` steps that advertise
  `dashboard_only` / `approved` ownership.
- `src/mcp.ts`: update server instructions and tool descriptions; lift the
  artificial read-only bans on service/test/workstream/lease mutations once
  client-side approval is the authority.
- `src/http.ts`: retire or repurpose
  `/api/proposals/:id/(approve|reject)` routes; revoke becomes
  unregister/remove-context; keep auth/session hardening untouched.
- `src/store.ts` state: migrate `proposals` + `workspaces` to registered
  contexts (data-only, preserve IDs/names/roots); no silent reset.
- Frontend: `use-workbench.ts` approve/decline/revoke flows,
  `ProjectsView` pending-approval UI, `PrivacyView` "Approved project access"
  language, `AiSetupView`/`format-setup.ts` setup copy that references
  dashboard approval.
- Docs: `README.md` ("approve or decline the exact list", "MCP cannot invoke
  service lifecycle..."), `AGENTS.md` capability boundaries,
  `ROADMAP.md` M0 acceptance ("approved only with dashboard authority"),
  M1 Step 2 ("explicit execution approval"), M2-1/M2-2 ("dashboard-only").
- Tests: `test/workspace.test.ts`, `test/dashboard-auth.test.ts`,
  `test/mcp.test.ts`, `test/cli.test.ts`, `test/verify.test.ts`,
  `test/services.test.ts`, `frontend/src/test/workbench.test.tsx`,
  `frontend/src/features/ai-setup/format-setup.test.ts` — all encode the gate.

## Alternatives considered

- Keep dashboard gating for writes only (reads open). Rejected: same duplicate
  authority problem, just narrower; the client already gates writes.
- Keep dashboard as optional strict mode. Rejected for now: doubles the
  contract and test matrix; revisit only with pilot evidence asking for it.

## Open questions for implementation

1. Registration-time safety text: what exactly do we promise at register time
   (bounded read, no exec, no secrets) without calling it permission?
2. Audit retention: how long to keep the run log, and where (private state only)?
3. Backward compatibility: version the HTTP/MCP contract or hard cutover with
   a state migration?

## Appendix: dashboard pivot brainstorm (open, not decided)

Date: 2026-10-02. Founder brainstorm, recorded as options — no final decision.

### Context

- The real company problem: people cannot fully use AI. The founder's own
  expert workflow is the product target: boot db + backend + frontend together,
  steer the agent across layers (browser → frontend value change → db check),
  let the agent plan against the live environment.
- Juniors fail at: booting the environment, knowing what to tell the agent,
  and telling whether it worked. The product must close that gap without
  oversimplifying everything into plain MCP tools.
- Constraint: user flows are heterogeneous — some arrive with a plan, some
  plan by chatting with Claude Code. The dashboard cannot impose one flow.
- The product stays visible (not invisible infra) and the user keeps their own
  agent; our tools (env runners, agent-browser behind our MCP, verify) make
  that agent's own workflows easier. No separate agent-browser install: our
  MCP pins and runs it.

### What was considered and where it landed

1. **Pure observability (proof / drift / topology / forensics / health).**
   Partially rejected: service-online status alone is Portainer territory;
   worktree-dirty style drift panels were judged noise, not value.
2. **Permission removal (accepted, see Decision above).** Dashboard stops being
   a gate; execution-safety guards (symlink rejection, caps, timeouts, no
   secrets) stay.
3. **Session + timeline observability.** Since flows differ, the unit is the
   agent session, not a "goal": session list, live tool-call view, per-session
   timeline, environment + artifacts panel. Every MCP tool call emits a
   structured event; the dashboard subscribes. No permission semantics.
4. **Live monitoring objection.** Raw live view duplicates what Claude Code
   already shows in transcript form — kept only as a candidate, not the core.
5. **System graph (candidate).** Nodes = systems (page, api-route, table,
   index — never individual components/files); edges = agent actions with
   observed/inferred flags and verification status (proven / seen / failed /
   unknown). Read vs write edges distinguished. Open doubt: at raw granularity
   (e.g. 20 SQL queries) a node graph is noise — see layering below.
6. **Feasibility ladder (discussed, stack-dependent).** Free: browser actions,
   screenshots, network log (method+path+status), our own DB-tool queries, git
   diff per run. Medium: static route scan (framework-specific), schema from
   migrations. Deferred as fragile: component-to-code mapping via
   instrumentation. Backend code changes are tracked exactly via git diff at
   run boundaries; file→system mapping is heuristic and flagged inferred.
7. **Diff is data, not UI (agreed).** Agents can change thousands of lines;
   diffs already live in GitHub/Claude Code. The dashboard never renders diffs:
   code change appears as an aggregate chip with link-out, used internally only
   to guess affected systems.
8. **Noise → 3-layer model (current lean).** Default screen shows verdicts, not
   actions: (1) short auto-brief per run ("what changed, what is proven,
   what was not looked at"); (2) aggregated system status on demand;
   (3) raw evidence (queries, screenshots, outputs) only on drill-down.
   Alternative on the table: skip live graphs entirely — publish the brief +
   evidence at run end (in dashboard archive and/or chat/PR), since
   coordinators review after the run, not mid-run.

### Open questions

1. Do we build any live view at all, or post-run brief + evidence only?
2. Who writes the brief — heuristics over events, or a small summarizer over
   the event log? Where does it run?
3. First vertical slice: bundled browser-navigate + screenshot events,
   or env-up + readiness first? (Company stack answer pending: monorepo vs
   split repos, ORM, compose layout.)
4. Aggregation rules that prevent node/edge explosion (cap nodes at system
   count, collapse repeated calls into one weighted edge).
5. Paying customer: solo-dev comfort vs team "agents must not break things" —
   decides whether team coordination (leases, conflict view) matters.
