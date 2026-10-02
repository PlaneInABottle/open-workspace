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
