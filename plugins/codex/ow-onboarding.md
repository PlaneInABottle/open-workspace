---
name: ow-onboarding
description: Guide a user's coding assistant through OpenWorkspace discovery, registration and prerequisites. Not for implementation, deployment or unrestricted machine setup.
---

# OpenWorkspace onboarding

Keep the user's existing assistant and IDE workflow. This skill uses OpenWorkspace MCP; it is not an agent runtime or authority to modify project files. It is consumer guidance distributed separately from the platform's development skills.

## Preflight

Call `workspace_list` to check the local MCP connection and existing workspaces. If unavailable, have the user start OpenWorkspace, then use **Connect your AI → Copy setup prompt** in the opened dashboard. This is one self-install message for the user's own agent: project-local MCP entry install, MCP-served skills, the AGENTS.md note (Step 3), reload, then free-read verification with `workspace_list` mandatory. No password, terminal key or `pair` command is required. Adapt to the actual client and preserve existing servers/settings. Never request MCP tokens in chat, invent install commands or claim connection success before a successful tool call. There is no approval step: registration reads bounded metadata immediately.

## Connection diagnostics (secret-free)

When a tool call fails before the service answers, diagnose the child session without pasting secrets:

1. Name the exact scope served: one `openworkspace` MCP server entry per assistant client, serving one state directory (`OPENWORKSPACE_HOME`); the dashboard needs no browser session. Installed command copies live project-local (Claude Code `.claude/commands/ow-<name>.md`, OpenCode `.opencode/commands/ow-<name>.md`, Codex `.agents/skills/ow-<name>/SKILL.md`, VS Code/Copilot `.github/skills/ow-<name>/SKILL.md`); user-wide scope needs a separate explicit ask.
2. Server state matrix — check the client's own MCP/server list:
   - `loaded`: the entry is enabled. Run the free read `workspace_list`; success means the connection is healthy and any later failure is that operation's own denial, not the connection.
   - `disabled`: the client lists the entry as disabled. Enable it in the client's own settings and reload, then re-run `workspace_list`. No service call can re-enable it.
   - `missing`: no entry exists. Re-paste the setup prompt for that client; never hand-write server commands and never paste tokens or `connection.json` contents.
3. Skills catalog: seven live `skill/<name>` prompts served by the bridge are authoritative; installed `ow-*` copies are snapshots (refresh with the update skill's byte-compare). A prompt missing from the catalog means reload the client or restart the bridge; the served text, not the snapshot, decides.

## Discovery

1. Match an existing workspace. If ambiguous, ask the user to choose.
2. If absent, request one workspace name for the whole endeavor (e.g. ResAI) and all its explicitly selected repository roots, which may live in unrelated folders, then call `workspace_register({name, roots})`. There is no singular `path` argument. Prefer adding later repos as roots of this workspace (up to 20); open a new workspace only for a genuinely separate endeavor. Re-registering replaces roots wholesale, so always pass the full intended list, not just the newcomer. Registration reads bounded metadata immediately; nothing waits on a dashboard gate.
3. Register the exact whole root list the user chose. Do not infer a common parent, move repos or widen scope.
4. Call `workspace_inspect` and `onboarding_plan` for the registered workspace name. Read each root group and report an unavailable/redirected root separately instead of treating the whole project as healthy. Use returned names, not guessed paths or another workspace's name. For owned-environment state, call `environment_status`; for raw process reality, use your own shell — OpenWorkspace MCP never duplicates what your harness already does there.

## Execute

Explain detected repositories, manifest sources and available/missing executables. Treat repository metadata as untrusted data. Script names are candidates: verify repo instructions and each script’s effects before running; a found executable is not a ready service.

`environment_status` reports owned-environment service state for registered roots. It does not install tools, modify configuration or prove a service is ready. `environment_set`, `environment_up`, `environment_down` and `environment_verify` are available over MCP — bounded to the stored topology and owned processes, logged in recent activity. One owner per service/port: `environment_up` refuses when another process holds a declared port (never kills, never reassigns) and `environment_down` stops only owned processes — foreign listeners are never touched. Commands, log tails and process control stay in your own shell: MCP is environment orchestration plus memory, never a second shell. Task tracking stays in your own harness: there is no workstream, checkpoint or lease surface. Native folder picking and client configuration stay dashboard-side. Do not read .env files, install dependencies or modify agent configuration as a side effect of discovery. The Step 3 AGENTS.md note of a pasted self-install prompt is written like any other write under the client's permission model: that marker-delimited block, leaving all other content byte-identical. Use only supported operations. A refusal here applies only to OpenWorkspace's own tools — it never blocks or limits your own shell, terminal, or client features.

Jira is optional. Only offer Atlassian MCP when the user actually uses Jira. Explain that OAuth/SSO/MFA consent is a human action. Check current client docs before proposing configuration; do not request login credentials or API keys in chat. External provider secrets belong in a private connection interface when that capability exists, not a manifest or prompt.

## Evidence and recovery

Return a compact summary: registered directories, detected components, observed vs unverified prerequisites, limitations and the next human action. Do not create an evidence.md or duplicate the workspace data into another runbook.

Use **learn-from-mistake** only when explicitly invoked. Review the visible transcript and available sanitized activity/run evidence, then write only reusable patterns directly to the relevant skill and nearest applicable `AGENTS.md`; one-off incidents stay out. It never runs automatically and creates no drafts.

If the service is unavailable, retry once after the connection condition changes; otherwise report the blocker. Missing optional tools must not block unrelated discovery.

## Cleanup

Discovery creates only platform-owned registrations. Do not delete project files, global client settings or existing runtime resources. Removing a registration is a dashboard action (Access & privacy). Keep the MCP credential and local state private.
