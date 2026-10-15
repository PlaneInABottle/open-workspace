---
name: ow-setup-ow
description: "Install OpenWorkspace skills into the current project: detect client, snapshot skills locally, verify. Runs only on explicit invocation."
---

# OpenWorkspace setup

Run only when the user asks to set up OpenWorkspace in their project. The
user's own agent performs every step below — scoped, project-local, with
human approval before every write. This skill is consumer guidance
distributed separately from the platform's development skills.

## A-path (scoped setup)

1. **Detect client from project files (shared marker table — install-dir hit wins; a config-file hit is only a fallback signal).** Check for client markers in this project only: Claude Code — install dir `.claude/`, fallback `~/.claude.json`; OpenCode — install dir `.opencode/`, fallback `opencode.jsonc`; Codex — detect `.agents/skills/` or fallback `.codex/config.toml`, install to `.agents/skills/`; VS Code/Copilot — install dir `.github/`, fallback `.mcp.json`. Use the markers found; when several clients genuinely coexist, ask which one before writing.
2. **Fetch authoritative texts from the product checkout.** Re-read every `skills/<name>/SKILL.md`
   (`learn-from-mistake`, `onboarding`, `ow`, `ow-debug`, `ow-runtime`,
   `prepare-local-runtime`, `setup-ow`, `update`). The source text
   is authoritative — never invent skill content by hand.
3. **Write project-local `ow-*` snapshots.** Snapshot paths per client, all
   project-local: Claude Code `.claude/commands/ow-<name>.md`; OpenCode
   `.opencode/commands/ow-<name>.md`; Codex
   `.agents/skills/ow-<name>/SKILL.md`; VS Code/Copilot
   `.github/skills/ow-<name>/SKILL.md`. Exact-diff + human approval before
   every write: byte-identical → skip silently; tool-owned unmodified but
   stale → overwrite verbatim and report the diff; personally-edited snapshot
   → show the diff and let the user decide, never overwrite silently.
4. **Verify and report.** Run `ow --version` and `ow doctor`; success means
   the install is healthy. Report: client
   + scope files, snapshots written, verification result, next human action,
   in 120 words or fewer.

## AGENTS.md note (marker-block rule)

Propose the AGENTS.md note inside the marker block only: replace content
between the markers, leave everything outside byte-identical. Idempotent
re-paste: an existing block is replaced, never duplicated.

## Safety

Project-local only; user-wide/global scope needs a separate explicit ask.
Tokens never in chat, repo, or config. No silent overwrites of
personally-edited snapshots. Show the exact diff for any file write. Jira is
optional — discuss Atlassian MCP only if the user uses Jira. Delete installed
`ow-*` copies to return to checkout-served prompts; refresh later via the
update skill's byte-compare (`/ow-update`).
